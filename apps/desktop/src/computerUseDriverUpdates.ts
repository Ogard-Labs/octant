import {
  createManagedToolUpdates,
  isNewerManagedVersion,
  type ManagedToolUpdateState,
} from "./managedToolUpdates";

export interface ComputerDriverRelease {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
}

export interface StagedComputerDriver {
  readonly version: string;
  readonly path: string;
}

export type ComputerDriverUpdateState = ManagedToolUpdateState;

export function createComputerUseDriverUpdates(options: {
  readonly currentVersion: string;
  readonly check: (signal: AbortSignal) => Promise<ComputerDriverRelease | undefined>;
  /** Returns only after hash, publisher signature, architecture and version verification. */
  readonly stage: (
    release: ComputerDriverRelease,
    signal: AbortSignal,
  ) => Promise<StagedComputerDriver>;
  /** Owns rollback if the verified replacement fails its startup handshake. */
  readonly activate: (driver: StagedComputerDriver) => Promise<boolean>;
  readonly isBusy: () => boolean;
  readonly schedule?: (delayMs: number, callback: () => void) => () => void;
  readonly onState?: (state: ComputerDriverUpdateState) => void;
}) {
  return createManagedToolUpdates<ComputerDriverRelease, StagedComputerDriver>(options);
}

export function isNewerComputerDriver(candidate: string, current: string): boolean {
  return isNewerManagedVersion(candidate, current);
}
