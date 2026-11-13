/**
 * The host's own continuation of the subagent runs a restart cut off. It
 * follows the thread rule (harness/threadRestartContinuation.ts): each run the
 * start's reconciliation interrupted is resumed once, as the host, with the
 * message a person's Resume carries, through the ordinary run resume, which
 * rechecks the parent's live authority, the workspace, the saved conversation
 * and capacity as it admits it. A run is held for its person instead, still
 * Interrupted and resumable only by a person, when its parent mode's setting
 * or its parent thread's own switch is off, when a person quit Octant while
 * it ran, when its own continuations keep being cut off, or when the resume
 * refuses it.
 *
 * A run is its own provider session: resuming it never starts a turn on its
 * parent thread, and the resume refuses a run that is no longer Interrupted,
 * so a run never has two executions at once.
 */
import type { AgentRun, AgentRunCommandResult, HostRestartRecovery } from "@octant/contracts";
import {
  MAX_RESTART_CONTINUATIONS_CUT_OFF,
  QUIT_HOLD_DETAIL,
  type CodeRestartContinuationAttempts,
} from "../code/codeRestartContinuation";
import { RESTART_CONTINUATION_PROMPT, restartContinuationId } from "../harness/restartContinuation";
import { AGENT_RUN_RESTART_INTERRUPTED_REASON } from "./agentRunPersistenceService";

type Entries = Pick<HostRestartRecovery, "continued" | "held">;

export interface AgentRunRestartContinuationPorts {
  /** The previous host stopped because a person quit it (personQuit.ts). */
  readonly quitByPerson: boolean;
  /** The runs this start's reconciliation interrupted. */
  readonly cutOff: ReadonlyArray<AgentRun>;
  readonly readRun: (run: AgentRun) => AgentRun | undefined;
  /** The parent mode's Continue after restart setting. */
  readonly enabled: (mode: AgentRun["workspaceReceipt"]["mode"]) => boolean;
  /** The parent thread's own Continue after restart switch is off. */
  readonly parentOptedOut: (run: AgentRun) => boolean;
  /** The run version its latest journaled start or resume reached, if the journal says. */
  readonly latestStartVersion: (run: AgentRun) => number | undefined;
  readonly attempts: CodeRestartContinuationAttempts;
  /** The ordinary run resume, with the parent's live authority read at this moment. */
  readonly resume: (run: AgentRun, message: string) => Promise<AgentRunCommandResult>;
}

const HOLD_DETAIL = {
  "turned-off": "Continue after restart is off in Settings, so this subagent waits for you.",
  "opted-out": "Continue after restart is off for this thread, so its subagent waits for you.",
  "crash-loop":
    "Octant stopped twice while continuing this subagent by itself. Check it before resuming.",
} as const;

/** The crash-loop count's key: one row per run, beside the thread rows. */
function attemptsKey(run: AgentRun): string {
  return `agent-run:${String(run.id)}`;
}

/** The identity of the host's resume that moved a run to this start version. */
export function agentRunRestartContinuationId(run: AgentRun, startVersion: number): string {
  return restartContinuationId(`agent-run:${String(run.id)}:${startVersion}`);
}

/** Continues or holds every run the restart cut off, and names each under its parent thread. */
export async function continueAgentRunsCutOffByRestart(
  ports: AgentRunRestartContinuationPorts,
): Promise<Entries> {
  const continued: Array<Entries["continued"][number]> = [];
  const held: Array<Entries["held"][number]> = [];
  for (const cut of ports.cutOff) {
    const run = ports.readRun(cut);
    // A person may have acted on the run since the start interrupted it.
    if (
      run === undefined ||
      run.lifecycleStatus !== "interrupted" ||
      run.recoveryReason !== AGENT_RUN_RESTART_INTERRUPTED_REASON ||
      run.version !== cut.version
    )
      continue;
    const mode = run.workspaceReceipt.mode;
    const threadId = String(run.parentThreadId);
    const hold = (reason: Entries["held"][number]["reason"], detail: string) =>
      held.push({ mode, threadId, reason, detail });
    if (!ports.enabled(mode)) {
      hold("turned-off", HOLD_DETAIL["turned-off"]);
      continue;
    }
    if (ports.parentOptedOut(run)) {
      hold("opted-out", HOLD_DETAIL["opted-out"]);
      continue;
    }
    if (ports.quitByPerson) {
      hold("quit", QUIT_HOLD_DETAIL);
      continue;
    }
    // The chain goes on only while the run's latest start is the resume the
    // host itself made; a person's start, or a journal that cannot say which
    // start was last, leaves the stored count standing rather than clearing it.
    const last = ports.attempts.read(attemptsKey(run));
    const latestStart = ports.latestStartVersion(run);
    const prior =
      last === undefined
        ? 0
        : latestStart === undefined ||
            last.operationId === agentRunRestartContinuationId(run, latestStart)
          ? last.attempts
          : 0;
    if (prior >= MAX_RESTART_CONTINUATIONS_CUT_OFF) {
      hold("crash-loop", HOLD_DETAIL["crash-loop"]);
      continue;
    }
    // A resume moves the run one version on to Starting; counted before it
    // starts, so a resume that takes the host down with it is counted.
    ports.attempts.record(attemptsKey(run), {
      operationId: agentRunRestartContinuationId(run, run.version + 1),
      attempts: prior + 1,
    });
    let result: AgentRunCommandResult;
    try {
      result = await ports.resume(run, RESTART_CONTINUATION_PROMPT);
    } catch {
      hold("refused", "The subagent could not be resumed.");
      continue;
    }
    if (result.kind === "run-updated" && result.run.lifecycleStatus === "starting") {
      continued.push({ mode, threadId });
      continue;
    }
    hold(
      "refused",
      result.kind === "run-command-failed" ? result.message : "The subagent was not resumed.",
    );
  }
  return { continued, held };
}
