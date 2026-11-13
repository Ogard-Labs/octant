/**
 * The host's own continuation of the coordinator wakes a restart left open:
 * decided and journaled, but stopped before their turn started. It follows
 * the thread rule (harness/threadRestartContinuation.ts). Each open wake is
 * started once, as the host, through the coordinator's ordinary wake turn,
 * which reads the recipient's switches and idleness as they are now. A wake
 * is held for its person instead (journaled `held`, so no later start runs
 * it) when Settings › Code › Continue after restart or the thread's own switch
 * is off, when a person quit Octant, when Code restart recovery held the same
 * thread, or when its own continuations keep being cut off.
 *
 * It runs after Code restart recovery, so a thread whose cut-off turn was
 * continued is working and its wake is dropped rather than run beside it.
 */
import type { HostRestartRecovery } from "@octant/contracts";
import {
  MAX_RESTART_CONTINUATIONS_CUT_OFF,
  QUIT_HOLD_DETAIL,
  type CodeRestartContinuationAttempts,
} from "../code/codeRestartContinuation";
import { restartContinuationId } from "../harness/restartContinuation";
import type { CoordinatorService } from "./coordinatorService";
import type { OpenCoordinatorWake } from "./coordinatorWakeJournal";

type Entries = Pick<HostRestartRecovery, "continued" | "held">;

export interface CoordinatorWakeRestartContinuationPorts {
  /** The previous host stopped because a person quit it (personQuit.ts). */
  readonly quitByPerson: boolean;
  readonly open: ReadonlyArray<OpenCoordinatorWake>;
  /** Settings › Code › Continue after restart. */
  readonly enabled: () => boolean;
  /** Whether Code is on at all; the Code turn path a wake starts through does not read the mode switch. */
  readonly modeEnabled: () => boolean;
  readonly optedOut: (threadId: string) => boolean;
  /** Threads Code restart recovery held this start; their wakes wait with them. */
  readonly heldByCode: ReadonlySet<string>;
  readonly attempts: CodeRestartContinuationAttempts;
  readonly coordinator: Pick<
    CoordinatorService,
    "continueWakeAfterRestart" | "holdWakeAfterRestart"
  >;
}

const HOLD_DETAIL = {
  "turned-off": "Continue after restart is off in Settings, so this thread's wake waits for you.",
  "opted-out": "Continue after restart is off for this thread, so its wake waits for you.",
  "crash-loop":
    "Octant stopped twice while starting this thread's wake by itself. Check it before continuing.",
} as const;

/** The crash-loop count's key: one row per wake, beside the thread rows. */
function attemptsKey(wake: OpenCoordinatorWake): string {
  return `coordinator-wake:${wake.wakeId}`;
}

export async function continueCoordinatorWakesAfterRestart(
  ports: CoordinatorWakeRestartContinuationPorts,
): Promise<Entries> {
  const continued: Array<Entries["continued"][number]> = [];
  const held: Array<Entries["held"][number]> = [];
  for (const wake of ports.open) {
    const hold = (reason: Entries["held"][number]["reason"], detail: string) => {
      ports.coordinator.holdWakeAfterRestart(wake);
      held.push({ mode: "code", threadId: wake.threadId, reason, detail });
    };
    if (ports.heldByCode.has(wake.threadId)) {
      // Already named in the notice with Code's own reason.
      ports.coordinator.holdWakeAfterRestart(wake);
      continue;
    }
    if (!ports.enabled()) {
      hold("turned-off", HOLD_DETAIL["turned-off"]);
      continue;
    }
    if (ports.optedOut(wake.threadId)) {
      hold("opted-out", HOLD_DETAIL["opted-out"]);
      continue;
    }
    if (ports.quitByPerson) {
      hold("quit", QUIT_HOLD_DETAIL);
      continue;
    }
    const prior = ports.attempts.read(attemptsKey(wake))?.attempts ?? 0;
    if (prior >= MAX_RESTART_CONTINUATIONS_CUT_OFF) {
      hold("crash-loop", HOLD_DETAIL["crash-loop"]);
      continue;
    }
    if (!ports.modeEnabled()) {
      hold("refused", "Code is turned off on this host, so this thread's wake waits for you.");
      continue;
    }
    // Counted before the turn starts, so a start that takes the host down
    // with it is counted even though the wake stays open.
    ports.attempts.record(attemptsKey(wake), {
      operationId: restartContinuationId(`coordinator-wake:${wake.wakeId}`),
      attempts: prior + 1,
    });
    const outcome = await ports.coordinator
      .continueWakeAfterRestart(wake)
      .catch(() => ({ kind: "refused" as const, detail: "The wake's turn could not start." }));
    if (outcome.kind === "dispatched") continued.push({ mode: "code", threadId: wake.threadId });
    else if (outcome.kind === "refused")
      held.push({
        mode: "code",
        threadId: wake.threadId,
        reason: "refused",
        detail: outcome.detail,
      });
  }
  return { continued, held };
}
