import type { ProviderToolDefinition } from "@octant/contracts";

export type { CodeToolContribution } from "@octant/contracts/code-tool-contribution";

export interface CodeToolResult {
  readonly result: unknown;
  readonly isError?: boolean;
}

export interface CodeToolOperationEntry {
  readonly id: string;
  readonly label: string;
  readonly reason: string;
}

export interface CodeToolSavedCommandEntry {
  readonly id: string;
  readonly label: string;
}

/** A turn-scoped capability. The host retains all definitions, approval and execution. */
export interface CodeToolHostPort {
  readonly operations: () => ReadonlyArray<CodeToolOperationEntry> | undefined;
  readonly savedCommands: () => ReadonlyArray<CodeToolSavedCommandEntry> | undefined;
  readonly request: (id: string, signal?: AbortSignal) => Promise<CodeToolResult>;
  readonly runSaved: (id: string, signal?: AbortSignal) => Promise<CodeToolResult>;
  readonly close: () => Promise<void>;
}

export interface CodeToolSet {
  readonly definitions: ReadonlyArray<ProviderToolDefinition>;
  readonly execute: (input: {
    readonly name: string;
    readonly inputJson: string;
    readonly signal?: AbortSignal;
  }) => Promise<CodeToolResult>;
  readonly close: () => Promise<void>;
}
