import type { NativeHarnessSessionStatus } from "@octant/contracts";

/**
 * A harness session's status as every surface names it. One table, so the
 * app, the phone, and the terminal never describe the same state in three
 * different words.
 */
const LABELS: Readonly<Record<NativeHarnessSessionStatus, string>> = {
  idle: "Idle",
  running: "Running",
  "waiting-approval": "Waiting for approval",
  "paused-by-advisor": "Paused by the advisor",
  "paused-by-user": "Paused",
  "budget-limited": "Budget reached",
  failed: "Failed",
  "recovery-required": "Needs a check after restart",
};

export function nativeHarnessStatusLabel(status: NativeHarnessSessionStatus): string {
  return LABELS[status];
}

/** Whether the session holds new work until a person resumes it. */
export function nativeHarnessSessionHeld(status: NativeHarnessSessionStatus): boolean {
  return status !== "running" && status !== "idle";
}
