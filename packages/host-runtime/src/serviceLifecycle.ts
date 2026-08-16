export type HostServiceStateName =
  | "disabled"
  | "stopped"
  | "starting"
  | "ready"
  | "degraded"
  | "crash-loop"
  | "incompatible"
  | "unauthorized"
  | "manager-unavailable";

export type HostServiceManagerObservation = "available" | "unavailable";
export type HostServiceOwnerObservation =
  | "none"
  | "starting"
  | "ready"
  | "degraded"
  | "incompatible"
  | "unauthorized";

export interface HostServiceStateInput {
  readonly enabled: boolean;
  readonly manager: HostServiceManagerObservation;
  readonly owner: HostServiceOwnerObservation;
  readonly crashLoop?: boolean;
}

export interface HostServiceState {
  readonly state: HostServiceStateName;
  readonly actionable: ReadonlyArray<string>;
}

const ACTIONS: Record<HostServiceStateName, ReadonlyArray<string>> = {
  disabled: ["Enable automatic startup or run the foreground server explicitly."],
  stopped: ["Start the configured per-user service."],
  starting: ["Wait for the matching owner receipt to become ready."],
  ready: ["No action is required."],
  degraded: ["Inspect bounded diagnostics and logs before retrying."],
  "crash-loop": ["Inspect bounded logs, then stop or repair the service before retrying."],
  incompatible: ["Use a matching Octant server version or upgrade the service artifact."],
  unauthorized: ["Run the command as the owning local user and repair owner permissions."],
  "manager-unavailable": [
    "Install or start the per-user service manager; foreground run remains available.",
  ],
};

export function deriveHostServiceState(input: HostServiceStateInput): HostServiceState {
  let state: HostServiceStateName;
  if (!input.enabled) state = "disabled";
  else if (input.manager === "unavailable") state = "manager-unavailable";
  else if (input.crashLoop === true) state = "crash-loop";
  else state = input.owner === "none" ? "stopped" : input.owner;
  return { state, actionable: ACTIONS[state] };
}

export interface RestartBackoffInput {
  readonly failures: number;
  readonly now: number;
}

export interface RestartBackoff {
  readonly delayMs: number;
  readonly retryAt: number;
  readonly crashLoop: boolean;
}

const RESTART_BASE_DELAY_MS = 1_000;
const RESTART_MAX_DELAY_MS = 30_000;
const CRASH_LOOP_FAILURES = 5;

export function nextRestartBackoff(input: RestartBackoffInput): RestartBackoff {
  const failures = Number.isSafeInteger(input.failures) && input.failures >= 0 ? input.failures : 0;
  const delayMs =
    failures >= CRASH_LOOP_FAILURES
      ? RESTART_MAX_DELAY_MS
      : RESTART_BASE_DELAY_MS * 2 ** Math.min(failures, 4);
  return {
    delayMs,
    retryAt: input.now + delayMs,
    crashLoop: failures >= CRASH_LOOP_FAILURES,
  };
}
