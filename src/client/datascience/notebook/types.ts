// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.

'use strict';

import { JSONObject } from '@phosphor/coreutils';
import type { CancellationToken } from 'vscode';
import type {
    NotebookCell,
    NotebookContentProvider as VSCodeNotebookContentProvider,
    NotebookDocument
} from 'vscode-proposed';

export const INotebookExecutionService = Symbol('INotebookExecutionService');
export interface INotebookExecutionService {
    cancelPendingExecutions(document: NotebookDocument): void;
    executeCell(
        document: NotebookDocument,
        cell: NotebookCell,
        token: CancellationToken,
        metadata: JSONObject
    ): Promise<void>;
    executeAllCells(document: NotebookDocument, token: CancellationToken, metadata: JSONObject): Promise<void>;
}

export const INotebookContentProvider = Symbol('INotebookContentProvider');
export interface INotebookContentProvider extends VSCodeNotebookContentProvider {
    /**
     * Notify VS Code that document has changed.
     * The change is not something that can be undone by using the `undo`.
     * E.g. updating execution count of a cell, or making a notebook readonly, or updating kernel info in ipynb metadata.
     */
    notifyChangesToDocument(document: NotebookDocument): void;
}
