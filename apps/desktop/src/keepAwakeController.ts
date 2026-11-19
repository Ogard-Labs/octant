import {
  DEFAULT_KEEP_AWAKE_POLICY,
  decodeDesktopAgentWorkSnapshot,
  type DesktopAgentWorkSnapshot,
  type KeepAwakePolicy,
} from "@octant/contracts";
import type { KeepAwakeStatus } from "./keepAwakeStatus";

export const DESKTOP_AGENT_WORK_ROUTE = "/api/desktop/agent-work";
export const KEEP_AWAKE_POLL_INTERVAL_MS = 5_000;
export const KEEP_AWAKE_RELEASE_DELAY_MS = 10_000;
export const KEEP_AWAKE_ROUTINE_LEAD_MS = 5 * 60_000;
const WORK_POLL_TIMEOUT_MS = 3_000;

export interface KeepAwakePowerSaveBlocker {
  readonly start: (type: "prevent-app-suspension") => number;
  readonly stop: (id: number) => void;
  readonly isStarted: (id: number) => boolean;
}

export interface KeepAwakePowerMonitor {
  readonly isOnBatteryPower?: () => boolean;
  on?(event: "on-ac", listener: () => void): unknown;
  on?(event: "on-battery", listener: () => void): unknown;
  removeListener?(event: "on-ac", listener: () => void): unknown;
  removeListener?(event: "on-battery", listener: () => void): unknown;
  off?(event: "on-ac", listener: () => void): unknown;
  off?(event: "on-battery", listener: () => void): unknown;
}

export interface KeepAwakeControllerOptions {
  readonly powerSaveBlocker: KeepAwakePowerSaveBlocker | undefined;
  readonly powerMonitor: KeepAwakePowerMonitor | undefined;
  readonly readWork: () => Promise<DesktopAgentWorkSnapshot | undefined>;
  readonly onStatusChanged?: (status: KeepAwakeStatus) => void;
  readonly now?: () => number;
  readonly pollIntervalMs?: number;
  readonly releaseDelayMs?: number;
  readonly routineLeadMs?: number;
}

export interface KeepAwakeWorkSummaryCounts {
  readonly totalTurns: number;
  readonly childRuns: number;
  readonly coordinatorWorkers: number;
  readonly routineDueSoon: boolean;
}

/**
 * Formats the honest live status line strictly from running-work counts and
 * routine proximity — never thread titles or paths.
 */
export function formatKeepAwakeSummary(counts: KeepAwakeWorkSummaryCounts): string {
  const parts: string[] = [];
  if (counts.totalTurns > 0) {
    parts.push(`${counts.totalTurns} ${counts.totalTurns === 1 ? "turn" : "turns"}`);
  }
  if (counts.childRuns > 0) {
    parts.push(`${counts.childRuns} ${counts.childRuns === 1 ? "child run" : "child runs"}`);
  }
  if (counts.coordinatorWorkers > 0) {
    parts.push(
      `${counts.coordinatorWorkers} ${counts.coordinatorWorkers === 1 ? "worker" : "workers"}`,
    );
  }
  if (counts.routineDueSoon) {
    parts.push("routine due soon");
  }
  if (parts.length === 0) {
    return "Kept awake: recent work";
  }
  if (parts.length === 1 && counts.totalTurns > 0) {
    return `Kept awake: ${parts[0]} running`;
  }
  return `Kept awake: ${parts.join(", ")}`;
}

function isRoutineDueSoon(
  nextRoutineDueAt: string | null,
  nowMs: number,
  routineLeadMs: number,
): boolean {
  if (nextRoutineDueAt === null) return false;
  const dueMs = Date.parse(nextRoutineDueAt);
  if (!Number.isFinite(dueMs)) return false;
  return dueMs <= nowMs + routineLeadMs;
}

function readOnBatteryPower(powerMonitor: KeepAwakePowerMonitor | undefined): boolean {
  if (powerMonitor?.isOnBatteryPower === undefined) return false;
  try {
    return powerMonitor.isOnBatteryPower() === true;
  } catch {
    // Where battery state cannot be read, the computer counts as on power.
    return false;
  }
}

function sameStatus(left: KeepAwakeStatus, right: KeepAwakeStatus): boolean {
  if (left.state !== right.state) return false;
  if (left.state === "active" && right.state === "active") return left.summary === right.summary;
  if (left.state === "idle" && right.state === "idle") return left.reason === right.reason;
  return true;
}

/**
 * Reads the server's loopback-only `/api/desktop/agent-work` signal using the
 * desktop bridge secret. Returns `undefined` when no host is running or the
 * poll fails.
 */
export async function readDesktopAgentWork(options: {
  readonly hostUrl: string | undefined;
  readonly brokerHeaders: Readonly<Record<string, string>>;
  readonly fetch: typeof globalThis.fetch;
  readonly timeoutMs?: number;
}): Promise<DesktopAgentWorkSnapshot | undefined> {
  if (options.hostUrl === undefined) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? WORK_POLL_TIMEOUT_MS);
  try {
    const response = await options.fetch(new URL(DESKTOP_AGENT_WORK_ROUTE, options.hostUrl), {
      method: "GET",
      headers: options.brokerHeaders,
      signal: controller.signal,
    });
    if (!response.ok) return undefined;
    return decodeDesktopAgentWorkSnapshot(await response.json());
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Desktop-owned sleep-prevention controller.
 *
 * Polls the local host's `/api/desktop/agent-work` counts every 5 s and holds
 * an Electron `prevent-app-suspension` assertion (never preventing display
 * sleep) while turns, child runs, coordinator workers, or a routine due within
 * 5 minutes are active, subject to the host's keep-awake policy and AC/battery
 * state. Releases 10 s after the last work ends, and releases immediately on
 * battery (under `on-power`), policy `never`, host stop, or desktop quit.
 */
export class KeepAwakeController {
  readonly #powerSaveBlocker: KeepAwakePowerSaveBlocker | undefined;
  readonly #powerMonitor: KeepAwakePowerMonitor | undefined;
  readonly #readWork: () => Promise<DesktopAgentWorkSnapshot | undefined>;
  readonly #onStatusChanged: ((status: KeepAwakeStatus) => void) | undefined;
  readonly #now: () => number;
  readonly #pollIntervalMs: number;
  readonly #releaseDelayMs: number;
  readonly #routineLeadMs: number;

  #started = false;
  #disposed = false;
  #onBattery = false;
  #blockerId: number | undefined;
  #pollTimer: ReturnType<typeof setInterval> | undefined;
  #releaseTimer: ReturnType<typeof setTimeout> | undefined;
  #inFlightPoll: Promise<KeepAwakeStatus> | undefined;
  #queuedPoll: Promise<KeepAwakeStatus> | undefined;
  #lastSnapshot: DesktopAgentWorkSnapshot | undefined;
  #hadActiveWork = false;
  #refusedForCurrentWork = false;
  #status: KeepAwakeStatus = Object.freeze({ state: "idle", reason: "no-work" });

  readonly #handleOnAc = (): void => {
    if (this.#disposed) return;
    this.#onBattery = false;
    this.#reconcile();
  };

  readonly #handleOnBattery = (): void => {
    if (this.#disposed) return;
    this.#onBattery = true;
    this.#reconcile();
  };

  constructor(options: KeepAwakeControllerOptions) {
    this.#powerSaveBlocker = options.powerSaveBlocker;
    this.#powerMonitor = options.powerMonitor;
    this.#readWork = options.readWork;
    this.#onStatusChanged = options.onStatusChanged;
    this.#now = options.now ?? Date.now;
    this.#pollIntervalMs = options.pollIntervalMs ?? KEEP_AWAKE_POLL_INTERVAL_MS;
    this.#releaseDelayMs = options.releaseDelayMs ?? KEEP_AWAKE_RELEASE_DELAY_MS;
    this.#routineLeadMs = options.routineLeadMs ?? KEEP_AWAKE_ROUTINE_LEAD_MS;
  }

  status(): KeepAwakeStatus {
    return this.#status;
  }

  start(): void {
    if (this.#disposed || this.#started) return;
    this.#started = true;
    this.#onBattery = readOnBatteryPower(this.#powerMonitor);
    this.#powerMonitor?.on?.("on-ac", this.#handleOnAc);
    this.#powerMonitor?.on?.("on-battery", this.#handleOnBattery);
    this.#pollTimer = setInterval(() => {
      if (this.#inFlightPoll === undefined) void this.#runPoll();
    }, this.#pollIntervalMs);
    this.#pollTimer.unref?.();
    void this.#runPoll();
  }

  /**
   * Forces a fresh read of `/api/desktop/agent-work` after any in-flight poll
   * finishes, so a caller that just changed the setting always sees the new
   * state rather than an earlier overlapping poll.
   */
  pollNow(): Promise<KeepAwakeStatus> {
    if (this.#disposed) return Promise.resolve(this.#status);
    if (this.#inFlightPoll !== undefined) {
      if (this.#queuedPoll === undefined) {
        this.#queuedPoll = this.#inFlightPoll
          .catch(() => this.#status)
          .then(() => {
            this.#queuedPoll = undefined;
            return this.#runPoll();
          });
      }
      return this.#queuedPoll;
    }
    return this.#runPoll();
  }

  #runPoll(): Promise<KeepAwakeStatus> {
    if (this.#disposed) return Promise.resolve(this.#status);
    let poll: Promise<KeepAwakeStatus> | undefined;
    poll = (async () => {
      try {
        let snapshot: DesktopAgentWorkSnapshot | undefined;
        try {
          snapshot = await this.#readWork();
        } catch {
          snapshot = undefined;
        }
        if (this.#disposed) return this.#status;
        this.#applySnapshot(snapshot);
        return this.#status;
      } finally {
        if (this.#inFlightPoll === poll) this.#inFlightPoll = undefined;
      }
    })();
    this.#inFlightPoll = poll;
    return poll;
  }

  /** Releases immediately when the local host stops so no assertion lingers. */
  hostStopped(): void {
    if (this.#disposed) return;
    this.#lastSnapshot = undefined;
    this.#hadActiveWork = false;
    this.#refusedForCurrentWork = false;
    this.#cancelReleaseTimer();
    this.#releaseBlocker();
    this.#setStatus({ state: "idle", reason: "no-work" });
  }

  /** Releases any held assertion synchronously and stops all timers and listeners. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#pollTimer !== undefined) {
      clearInterval(this.#pollTimer);
      this.#pollTimer = undefined;
    }
    this.#cancelReleaseTimer();
    this.#detachPowerMonitor();
    this.#releaseBlocker();
    this.#lastSnapshot = undefined;
    this.#hadActiveWork = false;
    this.#refusedForCurrentWork = false;
    this.#setStatus({ state: "idle", reason: "no-work" });
  }

  #detachPowerMonitor(): void {
    if (this.#powerMonitor === undefined) return;
    if (this.#powerMonitor.removeListener !== undefined) {
      this.#powerMonitor.removeListener("on-ac", this.#handleOnAc);
      this.#powerMonitor.removeListener("on-battery", this.#handleOnBattery);
    } else if (this.#powerMonitor.off !== undefined) {
      this.#powerMonitor.off("on-ac", this.#handleOnAc);
      this.#powerMonitor.off("on-battery", this.#handleOnBattery);
    }
  }

  #applySnapshot(snapshot: DesktopAgentWorkSnapshot | undefined): void {
    this.#lastSnapshot = snapshot;
    this.#reconcile();
  }

  #reconcile(): void {
    if (this.#disposed) return;
    const policy: KeepAwakePolicy = this.#lastSnapshot?.keepAwake ?? DEFAULT_KEEP_AWAKE_POLICY;
    const policyPermits = policy === "always" || (policy === "on-power" && !this.#onBattery);

    const totalTurns =
      this.#lastSnapshot === undefined
        ? 0
        : this.#lastSnapshot.turns.chat +
          this.#lastSnapshot.turns.work +
          this.#lastSnapshot.turns.code;
    const childRuns = this.#lastSnapshot?.childRuns ?? 0;
    const coordinatorWorkers = this.#lastSnapshot?.coordinatorWorkers ?? 0;
    const routineDueSoon = isRoutineDueSoon(
      this.#lastSnapshot?.nextRoutineDueAt ?? null,
      this.#now(),
      this.#routineLeadMs,
    );
    const hasWork = totalTurns > 0 || childRuns > 0 || coordinatorWorkers > 0 || routineDueSoon;

    if (hasWork && !this.#hadActiveWork) {
      // Work just started; allow trying the platform powerSaveBlocker again.
      this.#refusedForCurrentWork = false;
    }
    this.#hadActiveWork = hasWork;

    if (!policyPermits) {
      this.#cancelReleaseTimer();
      this.#releaseBlocker();
      this.#setStatus({
        state: "idle",
        reason: policy === "never" ? "disabled" : "on-battery",
      });
      return;
    }

    if (hasWork) {
      this.#cancelReleaseTimer();
      if (this.#blockerId !== undefined) {
        this.#setStatus({
          state: "active",
          summary: formatKeepAwakeSummary({
            totalTurns,
            childRuns,
            coordinatorWorkers,
            routineDueSoon,
          }),
        });
        return;
      }
      if (this.#refusedForCurrentWork) {
        this.#setStatus({ state: "unavailable" });
        return;
      }
      if (this.#acquireBlocker()) {
        this.#setStatus({
          state: "active",
          summary: formatKeepAwakeSummary({
            totalTurns,
            childRuns,
            coordinatorWorkers,
            routineDueSoon,
          }),
        });
      } else {
        this.#refusedForCurrentWork = true;
        this.#setStatus({ state: "unavailable" });
      }
      return;
    }

    if (this.#blockerId !== undefined) {
      this.#scheduleReleaseTimer();
      this.#setStatus({
        state: "active",
        summary: formatKeepAwakeSummary({
          totalTurns: 0,
          childRuns: 0,
          coordinatorWorkers: 0,
          routineDueSoon: false,
        }),
      });
      return;
    }

    this.#setStatus({ state: "idle", reason: "no-work" });
  }

  #acquireBlocker(): boolean {
    if (this.#powerSaveBlocker === undefined) return false;
    try {
      const id = this.#powerSaveBlocker.start("prevent-app-suspension");
      if (this.#powerSaveBlocker.isStarted(id)) {
        this.#blockerId = id;
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  #releaseBlocker(): void {
    const id = this.#blockerId;
    this.#blockerId = undefined;
    if (id === undefined || this.#powerSaveBlocker === undefined) return;
    try {
      this.#powerSaveBlocker.stop(id);
    } catch {
      // Best-effort release; never throw during battery switch or quit.
    }
  }

  #scheduleReleaseTimer(): void {
    if (this.#releaseTimer !== undefined) return;
    this.#releaseTimer = setTimeout(() => {
      this.#releaseTimer = undefined;
      if (this.#disposed) return;
      if (this.#hadActiveWork) return;
      this.#releaseBlocker();
      const policy: KeepAwakePolicy = this.#lastSnapshot?.keepAwake ?? DEFAULT_KEEP_AWAKE_POLICY;
      const reason =
        policy === "never"
          ? "disabled"
          : policy === "on-power" && this.#onBattery
            ? "on-battery"
            : "no-work";
      this.#setStatus({ state: "idle", reason });
    }, this.#releaseDelayMs);
    this.#releaseTimer.unref?.();
  }

  #cancelReleaseTimer(): void {
    if (this.#releaseTimer === undefined) return;
    clearTimeout(this.#releaseTimer);
    this.#releaseTimer = undefined;
  }

  #setStatus(next: KeepAwakeStatus): void {
    const frozen = Object.freeze(next);
    if (sameStatus(this.#status, frozen)) return;
    this.#status = frozen;
    this.#onStatusChanged?.(frozen);
  }
}
