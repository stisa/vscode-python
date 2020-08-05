// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import { nbformat } from '@jupyterlab/coreutils';
import { JSONObject } from '@phosphor/coreutils';
import { inject, injectable } from 'inversify';
import { Subscription } from 'rxjs';
import { CancellationToken, CancellationTokenSource } from 'vscode';
import type { NotebookCell, NotebookCellRunState, NotebookDocument } from 'vscode-proposed';
import { ICommandManager } from '../../common/application/types';
import { wrapCancellationTokens } from '../../common/cancellation';
import '../../common/extensions';
import { IDisposable } from '../../common/types';
import { createDeferred } from '../../common/utils/async';
import { noop } from '../../common/utils/misc';
import { StopWatch } from '../../common/utils/stopWatch';
import { IServiceContainer } from '../../ioc/types';
import { captureTelemetry, sendTelemetryEvent } from '../../telemetry';
import { Commands, Telemetry, VSCodeNativeTelemetry } from '../constants';
import { INotebookStorageProvider } from '../notebookStorage/notebookStorageProvider';
import { VSCodeNotebookModel } from '../notebookStorage/vscNotebookModel';
import { IDataScienceErrorHandler, INotebook, INotebookEditorProvider, INotebookProvider } from '../types';
import {
    handleUpdateDisplayDataMessage,
    hasTransientOutputForAnotherCell,
    updateCellExecutionCount,
    updateCellOutput,
    updateCellWithErrorStatus
} from './helpers/executionHelpers';
import {
    clearCellForExecution,
    getCellStatusMessageBasedOnFirstCellErrorOutput,
    updateCellExecutionTimes
} from './helpers/helpers';
import { NotebookEditor } from './notebookEditor';
import { INotebookContentProvider, INotebookExecutionService } from './types';
// tslint:disable-next-line: no-var-requires no-require-imports
const vscodeNotebookEnums = require('vscode') as typeof import('vscode-proposed');

/**
 * VSC will use this class to execute cells in a notebook.
 * This is where we hookup Jupyter with a Notebook in VSCode.
 */
@injectable()
export class NotebookExecutionService implements INotebookExecutionService {
    private readonly registeredIOPubListeners = new WeakSet<INotebook>();
    private _notebookProvider?: INotebookProvider;
    private readonly pendingExecutionCancellations = new Map<string, CancellationTokenSource[]>();
    private readonly tokensInterrupted = new WeakSet<CancellationToken>();
    private sentExecuteCellTelemetry: boolean = false;
    private get notebookProvider(): INotebookProvider {
        this._notebookProvider =
            this._notebookProvider || this.serviceContainer.get<INotebookProvider>(INotebookProvider);
        return this._notebookProvider!;
    }
    constructor(
        @inject(INotebookStorageProvider) private readonly notebookStorage: INotebookStorageProvider,
        @inject(IServiceContainer) private readonly serviceContainer: IServiceContainer,
        @inject(ICommandManager) private readonly commandManager: ICommandManager,
        @inject(IDataScienceErrorHandler) private readonly errorHandler: IDataScienceErrorHandler,
        @inject(INotebookContentProvider) private readonly contentProvider: INotebookContentProvider,
        @inject(INotebookEditorProvider) private readonly editorProvider: INotebookEditorProvider
    ) {}
    @captureTelemetry(Telemetry.ExecuteNativeCell, undefined, true)
    public async executeCell(
        document: NotebookDocument,
        cell: NotebookCell,
        token: CancellationToken,
        metadata: JSONObject
    ): Promise<void> {
        // Cannot execute empty cells.
        if (cell.document.getText().trim().length === 0) {
            return;
        }
        const stopWatch = new StopWatch();
        const notebookAndModel = this.getNotebookAndModel(document);

        // Mark cells as busy (this way there's immediate feedback to users).
        // If it does not complete, then restore old state.
        const oldCellState = cell.metadata.runState;
        cell.metadata.runState = vscodeNotebookEnums.NotebookCellRunState.Running;

        // If we cancel running cells, then restore the state to previous values unless cell has completed.
        token.onCancellationRequested(() => {
            if (cell.metadata.runState === vscodeNotebookEnums.NotebookCellRunState.Running) {
                cell.metadata.runState = oldCellState;
            }
        });

        await this.executeIndividualCell(notebookAndModel, document, cell, token, stopWatch, metadata);
    }
    @captureTelemetry(Telemetry.ExecuteNativeCell, undefined, true)
    @captureTelemetry(VSCodeNativeTelemetry.RunAllCells, undefined, true)
    public async executeAllCells(
        document: NotebookDocument,
        token: CancellationToken,
        metadata: JSONObject
    ): Promise<void> {
        const stopWatch = new StopWatch();
        const notebookAndModel = this.getNotebookAndModel(document);
        document.metadata.runState = vscodeNotebookEnums.NotebookRunState.Running;
        // Mark all cells as busy (this way there's immediate feedback to users).
        // If it does not complete, then restore old state.
        const oldCellStates = new WeakMap<NotebookCell, NotebookCellRunState | undefined>();
        document.cells.forEach((cell) => {
            if (
                cell.document.getText().trim().length === 0 ||
                cell.cellKind === vscodeNotebookEnums.CellKind.Markdown
            ) {
                return;
            }
            oldCellStates.set(cell, cell.metadata.runState);
            cell.metadata.runState = vscodeNotebookEnums.NotebookCellRunState.Running;
        });

        const restoreOldCellState = (cell: NotebookCell) => {
            if (
                oldCellStates.has(cell) &&
                cell.metadata.runState === vscodeNotebookEnums.NotebookCellRunState.Running
            ) {
                cell.metadata.runState = oldCellStates.get(cell);
            }
        };
        // If we cancel running cells, then restore the state to previous values unless cell has completed.
        token.onCancellationRequested(() => {
            document.metadata.runState = vscodeNotebookEnums.NotebookRunState.Idle;
            document.cells.forEach(restoreOldCellState);
        });

        let executingAPreviousCellHasFailed = false;
        await document.cells.reduce((previousPromise, cellToExecute) => {
            return previousPromise.then((previousCellState) => {
                // If a previous cell has failed or execution cancelled, the get out.
                if (
                    executingAPreviousCellHasFailed ||
                    token.isCancellationRequested ||
                    previousCellState === vscodeNotebookEnums.NotebookCellRunState.Error
                ) {
                    executingAPreviousCellHasFailed = true;
                    restoreOldCellState(cellToExecute);
                    return;
                }
                if (
                    cellToExecute.document.getText().trim().length === 0 ||
                    cellToExecute.cellKind === vscodeNotebookEnums.CellKind.Markdown
                ) {
                    return;
                }
                return this.executeIndividualCell(
                    notebookAndModel,
                    document,
                    cellToExecute,
                    token,
                    stopWatch,
                    metadata
                );
            });
        }, Promise.resolve<NotebookCellRunState | undefined>(undefined));

        document.metadata.runState = vscodeNotebookEnums.NotebookRunState.Idle;
    }
    public cancelPendingExecutions(document: NotebookDocument): void {
        this.pendingExecutionCancellations.get(document.uri.fsPath)?.forEach((cancellation) => cancellation.cancel()); // NOSONAR
    }
    private async getNotebookAndModel(
        document: NotebookDocument
    ): Promise<{ model: VSCodeNotebookModel; nb: INotebook }> {
        const model = await this.notebookStorage.getOrCreateModel(document.uri, undefined, undefined, true);
        const nb = await this.notebookProvider.getOrCreateNotebook({
            identity: document.uri,
            resource: document.uri,
            metadata: model.metadata,
            disableUI: false,
            getOnly: false
        });
        if (!nb) {
            throw new Error('Unable to get Notebook object to run cell');
        }
        if (!(model instanceof VSCodeNotebookModel)) {
            throw new Error('Notebook Model is not of type VSCodeNotebookModel');
        }
        return { model, nb };
    }
    private sendPerceivedCellExecute(runningStopWatch: StopWatch) {
        const props = { notebook: true };
        if (!this.sentExecuteCellTelemetry) {
            this.sentExecuteCellTelemetry = true;
            sendTelemetryEvent(Telemetry.ExecuteCellPerceivedCold, runningStopWatch.elapsedTime, props);
        } else {
            sendTelemetryEvent(Telemetry.ExecuteCellPerceivedWarm, runningStopWatch.elapsedTime, props);
        }
    }

    private async executeIndividualCell(
        notebookAndModel: Promise<{ model: VSCodeNotebookModel; nb: INotebook }>,
        document: NotebookDocument,
        cell: NotebookCell,
        token: CancellationToken,
        stopWatch: StopWatch,
        metadata: JSONObject
    ): Promise<NotebookCellRunState | undefined> {
        if (token.isCancellationRequested) {
            return;
        }

        const { model, nb } = await notebookAndModel;
        if (token.isCancellationRequested) {
            return;
        }

        const editor = this.editorProvider.editors.find((e) => e.model === model);
        if (!editor) {
            throw new Error('No editor for Model');
        }
        if (editor && !(editor instanceof NotebookEditor)) {
            throw new Error('Executing Notebook with another Editor');
        }
        // If we need to cancel this execution (from our code, due to kernel restarts or similar, then cancel).
        const cancelExecution = new CancellationTokenSource();
        if (!this.pendingExecutionCancellations.has(document.uri.fsPath)) {
            this.pendingExecutionCancellations.set(document.uri.fsPath, []);
        }
        // If kernel is restarted while executing, then abort execution.
        const cancelExecutionCancellation = new CancellationTokenSource();
        this.pendingExecutionCancellations.get(document.uri.fsPath)?.push(cancelExecutionCancellation); // NOSONAR

        // Replace token with a wrapped cancellation, which will wrap cancellation due to restarts.
        const wrappedToken = wrapCancellationTokens(token, cancelExecutionCancellation.token, cancelExecution.token);
        const disposable = nb?.onKernelRestarted(() => {
            cancelExecutionCancellation.cancel();
            disposable.dispose();
        });

        // tslint:disable-next-line: no-suspicious-comment
        // TODO: How can nb be null?
        // We should throw an exception or change return type to be non-nullable.
        // Else in places where it shouldn't be null we'd end up treating it as null (i.e. ignoring error conditions, like this).

        this.handleDisplayDataMessages(model, document, nb);

        const deferred = createDeferred<NotebookCellRunState>();
        wrappedToken.onCancellationRequested(() => {
            if (deferred.completed) {
                return;
            }

            // Interrupt kernel only if original cancellation was cancelled.
            // I.e. interrupt kernel only if user attempts to stop the execution by clicking stop button.
            if (token.isCancellationRequested && !this.tokensInterrupted.has(token)) {
                this.tokensInterrupted.add(token);
                this.commandManager.executeCommand(Commands.NotebookEditorInterruptKernel).then(noop, noop);
            }
        });

        // Ensure we clear the cell state and trigger a change.
        clearCellForExecution(cell);
        const executionStopWatch = new StopWatch();
        cell.metadata.runStartTime = new Date().getTime();
        this.contentProvider.notifyChangesToDocument(document);

        let subscription: Subscription | undefined;
        let modelClearedEventHandler: IDisposable | undefined;
        try {
            nb.clear(cell.uri.toString()); // NOSONAR
            editor.notifyExecution(cell.document.getText());
            await nb.setLaunchingFile(model.file.path);
            const observable = nb.executeObservable(
                cell.document.getText(),
                document.fileName,
                0,
                cell.uri.toString(),
                false,
                metadata
            );
            subscription = observable?.subscribe(
                (cells) => {
                    if (!modelClearedEventHandler) {
                        modelClearedEventHandler = model.changed((e) => {
                            if (e.kind === 'clear') {
                                // If cell output has been cleared, then clear the output in the observed executable cell.
                                // Else if user clears output while executing a cell, we add it back.
                                cells.forEach((c) => (c.data.outputs = []));
                            }
                        });
                    }
                    const rawCellOutput = cells
                        .filter((item) => item.id === cell.uri.toString())
                        .flatMap((item) => (item.data.outputs as unknown) as nbformat.IOutput[])
                        .filter((output) => !hasTransientOutputForAnotherCell(output));

                    // Set execution count, all messages should have it
                    if (
                        cells.length &&
                        'execution_count' in cells[0].data &&
                        typeof cells[0].data.execution_count === 'number'
                    ) {
                        const executionCount = cells[0].data.execution_count as number;
                        if (updateCellExecutionCount(cell, executionCount)) {
                            this.contentProvider.notifyChangesToDocument(document);
                        }
                    }

                    if (updateCellOutput(cell, rawCellOutput)) {
                        this.contentProvider.notifyChangesToDocument(document);
                    }
                },
                (error: Partial<Error>) => {
                    updateCellWithErrorStatus(cell, error);
                    this.contentProvider.notifyChangesToDocument(document);
                    this.errorHandler.handleError((error as unknown) as Error).ignoreErrors();
                    deferred.resolve(cell.metadata.runState);
                },
                () => {
                    cell.metadata.lastRunDuration = executionStopWatch.elapsedTime;
                    cell.metadata.runState = wrappedToken.isCancellationRequested
                        ? vscodeNotebookEnums.NotebookCellRunState.Idle
                        : vscodeNotebookEnums.NotebookCellRunState.Success;
                    cell.metadata.statusMessage = '';
                    updateCellExecutionTimes(cell, {
                        startTime: cell.metadata.runStartTime,
                        duration: cell.metadata.lastRunDuration
                    });

                    // If there are any errors in the cell, then change status to error.
                    if (cell.outputs.some((output) => output.outputKind === vscodeNotebookEnums.CellOutputKind.Error)) {
                        cell.metadata.runState = vscodeNotebookEnums.NotebookCellRunState.Error;
                        cell.metadata.statusMessage = getCellStatusMessageBasedOnFirstCellErrorOutput(cell.outputs);
                    }

                    this.contentProvider.notifyChangesToDocument(document);
                    deferred.resolve(cell.metadata.runState);
                }
            );
            await deferred.promise;
        } catch (ex) {
            updateCellWithErrorStatus(cell, ex);
            this.contentProvider.notifyChangesToDocument(document);
            this.errorHandler.handleError(ex).ignoreErrors();
        } finally {
            this.sendPerceivedCellExecute(stopWatch);
            modelClearedEventHandler?.dispose(); // NOSONAR
            subscription?.unsubscribe(); // NOSONAR
            // Ensure we remove the cancellation.
            const cancellations = this.pendingExecutionCancellations.get(document.uri.fsPath);
            const index = cancellations?.indexOf(cancelExecutionCancellation) ?? -1;
            if (cancellations && index >= 0) {
                cancellations.splice(index, 1);
            }
        }
        return cell.metadata.runState;
    }
    /**
     * Ensure we handle display data messages that can result in updates to other cells.
     */
    private handleDisplayDataMessages(model: VSCodeNotebookModel, document: NotebookDocument, nb?: INotebook) {
        if (nb && !this.registeredIOPubListeners.has(nb)) {
            this.registeredIOPubListeners.add(nb);
            //tslint:disable-next-line:no-require-imports
            const jupyterLab = require('@jupyterlab/services') as typeof import('@jupyterlab/services');
            nb.registerIOPubListener((msg) => {
                if (
                    jupyterLab.KernelMessage.isUpdateDisplayDataMsg(msg) &&
                    handleUpdateDisplayDataMessage(msg, model, document)
                ) {
                    this.contentProvider.notifyChangesToDocument(document);
                }
            });
        }
    }
}
