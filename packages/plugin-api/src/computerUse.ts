import type {
  ComputerControlCommand,
  ComputerControlResult,
} from "@octant/contracts/computer-use-plugin";
import type { ProviderToolDefinition } from "@octant/contracts/providers";

/** A granted, task-bound capability. Plugins cannot choose the owner or driver. */
export interface ComputerUseHostPort {
  /**
   * `reason` is the agent's own one-line account of why it acts, shown to the
   * person when the action asks. It is the agent's words, not a fact, and it
   * grants nothing.
   */
  readonly execute: (
    command: ComputerControlCommand,
    signal?: AbortSignal,
    request?: { readonly reason?: string },
  ) => Promise<ComputerControlResult>;
  /**
   * Present only when the send bound the task to one of its thread's
   * disposable desktops. The host reads, hashes, asks for, and journals the
   * file before the desktop receives it.
   */
  readonly disposableDesktop?: {
    readonly sendFile: (path: string, signal?: AbortSignal) => Promise<ComputerControlResult>;
  };
}

export interface ComputerUseToolPlugin {
  readonly definitions: ReadonlyArray<ProviderToolDefinition>;
  readonly execute: (input: {
    readonly name: string;
    readonly inputJson: string;
    readonly signal?: AbortSignal;
  }) => Promise<ComputerControlResult>;
}
