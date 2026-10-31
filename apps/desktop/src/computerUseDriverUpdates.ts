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

/**
 * The driver contract this build's SDK speaks. The driver is pre-1.0, so a new
 * minor can change the wire contract and only patch releases are accepted.
 * A driver that reports another minor is refused at startup and before a
 * staged update activates, however correctly it is signed.
 */
export const COMPUTER_DRIVER_CONTRACT = { major: 0, minor: 8 } as const;

export function isCompatibleComputerDriverContract(contractVersion: string): boolean {
  const match = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/.exec(contractVersion);
  return (
    match !== null &&
    Number(match[1]) === COMPUTER_DRIVER_CONTRACT.major &&
    Number(match[2]) === COMPUTER_DRIVER_CONTRACT.minor
  );
}
