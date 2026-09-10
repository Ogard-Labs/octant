import type {
  ComputerControlCommand,
  ComputerControlResult,
} from "@octant/contracts/computer-use-plugin";
import type { ProviderToolDefinition } from "@octant/contracts/providers";

/** A granted, task-bound capability. Plugins cannot choose the owner or driver. */
export interface ComputerUseHostPort {
  readonly execute: (
    command: ComputerControlCommand,
    signal?: AbortSignal,
  ) => Promise<ComputerControlResult>;
}

export interface ComputerUseToolPlugin {
  readonly definitions: ReadonlyArray<ProviderToolDefinition>;
  readonly execute: (input: {
    readonly name: string;
    readonly inputJson: string;
    readonly signal?: AbortSignal;
  }) => Promise<ComputerControlResult>;
}
