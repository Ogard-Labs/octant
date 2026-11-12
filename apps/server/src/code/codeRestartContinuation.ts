/**
 * The host's own continuation of the Code turns a restart cut off. A crash, a
 * force quit or a reboot ends the provider process mid-turn; restart
 * reconciliation leaves that turn `waiting`, and without this nothing would
 * ever pick it up again until a person typed "continue" into each thread.
 *
 * Each cut-off turn is continued once, as the host, with the same message a
 * person's Resume sends: inspect first, do not repeat what may already have
 * taken effect, ask again for approvals. A thread is held for its person
 * instead when continuing it could repeat or hide something: a push or pull
 * request step whose outcome nobody learned, a person who turned the
 * continuation off, a thread whose own continuations keep being cut off, or a
 * provider that cannot resume the session.
 */
import {
  decodeCodeOperationId,
  decodeUtcTimestamp,
  type CodeOperationId,
  type CodeThread,
  type CodeThreadId,
  type HostRestartRecovery,
  type HostRestartRecoveryHold,
} from "@octant/contracts";
import { RESTART_CONTINUATION_PROMPT, restartContinuationId } from "../harness/restartContinuation";
import type {
  CodeTurnCutOffByRestart,
  ProjectedCodeRuntimeWork,
} from "../persistence/codeProjection";
import type { SqliteConnection } from "../persistence/sqlitePort";
import type { CodeOperationEventStore } from "./codeOperationEventStore";

/**
 * A thread whose automatic continuations a restart has cut off this many
 * times is held: the continuation itself may be what stops the host.
 */
export const MAX_RESTART_CONTINUATIONS_CUT_OFF = 2;

/** The report's bound on each list; the host control wire refuses a longer one. */
const MAX_REPORTED_THREADS = 500;

/** The continuation the host last started on a thread, and how many of its chain it started. */
export interface CodeRestartContinuationAttempt {
  readonly operationId: string;
  readonly attempts: number;
}

export interface CodeRestartContinuationAttempts {
  readonly read: (threadId: string) => CodeRestartContinuationAttempt | undefined;
  readonly record: (threadId: string, attempt: CodeRestartContinuationAttempt) => void;
}

/**
 * The crash-loop guard's counts, in the host's own store (migration
 * `create_code_restart_continuation_store`). A purged thread's row goes with
 * the rest of its `thread_id` rows.
 */
export function createCodeRestartContinuationAttempts(
  connection: SqliteConnection,
): CodeRestartContinuationAttempts {
  return {
    read: (threadId) => {
      const row = connection
        .prepare(
          "SELECT operation_id, attempts FROM code_restart_continuation_store WHERE thread_id = ?",
        )
        .get(threadId);
      return typeof row === "object" &&
        row !== null &&
        "operation_id" in row &&
        typeof row.operation_id === "string" &&
        "attempts" in row &&
        typeof row.attempts === "number"
        ? { operationId: row.operation_id, attempts: row.attempts }
        : undefined;
    },
    record: (threadId, attempt) => {
      connection
        .prepare(
          `INSERT INTO code_restart_continuation_store (thread_id, operation_id, attempts)
           VALUES (?, ?, ?)
           ON CONFLICT(thread_id) DO UPDATE SET
             operation_id = excluded.operation_id, attempts = excluded.attempts`,
        )
        .run(threadId, attempt.operationId, attempt.attempts);
    },
  };
}

export type CodeRestartResumability =
  | { readonly kind: "resumable" }
  | { readonly kind: "held"; readonly detail: string };

/**
 * Whether the thread's next turn can take up the provider session the cut-off
 * turn ran in, read the way the turn's own start reads it. A session on the
 * thread's own provider and model without a resume cursor is refused there
 * rather than silently dropped, and a turn that never reached its provider
 * left no session at all; either way the host holds the thread and says so
 * instead of guessing.
 */
export function codeRestartResumability(
  recovered: ReturnType<CodeOperationEventStore["providerSessionForThread"]>,
  thread: CodeThread,
): CodeRestartResumability {
  if (recovered.status !== "ok")
    return { kind: "held", detail: "Octant could not read this thread's provider session." };
  const session = recovered.session;
  if (session === undefined)
    return {
      kind: "held",
      detail:
        "The turn stopped before its provider session started, so there is no session to continue.",
    };
  if (
    session.resumeCursor === undefined &&
    recovered.rewoundAfterSession === undefined &&
    String(session.providerInstanceId) === String(thread.providerInstanceId) &&
    String(session.modelId) === String(thread.modelId)
  )
    return {
      kind: "held",
      detail: "This thread's provider cannot resume the session the turn ran in.",
    };
  return { kind: "resumable" };
}

export interface CodeRestartContinuationPorts {
  /** The provider turns this start found the previous host still running. */
  readonly cutOff: ReadonlyArray<CodeTurnCutOffByRestart>;
  readonly readThread: (threadId: CodeThreadId) => CodeThread | undefined;
  readonly runtimeWorks: (threadId: CodeThreadId) => ReadonlyArray<ProjectedCodeRuntimeWork>;
  /** Settings › Code › Continue after restart. */
  readonly enabled: () => boolean;
  readonly attempts: CodeRestartContinuationAttempts;
  /** Whether the thread's provider can take up the session the cut-off turn ran in. */
  readonly resumability: (
    thread: CodeThread,
    continuation: CodeOperationId,
  ) => CodeRestartResumability;
  /** Restart left every checkout waiting; a turn runs only in an available one. */
  readonly recoverCheckouts: () => Promise<void>;
  /**
   * Lifts the thread's native harness session out of the recovery the
   * restart put it in, when it has one; `held` names what blocks it.
   */
  readonly liftHarnessRecovery: (
    threadId: CodeThreadId,
  ) => Promise<
    { readonly kind: "none" | "lifted" } | { readonly kind: "held"; readonly detail: string }
  >;
  /** Settles the thread's cut-off turn as interrupted, with the restart as its reason. */
  readonly settleCutOffTurns: (threadId: CodeThreadId) => void;
  /**
   * Starts the continuation as the host. Authority, posture and spend ceiling
   * are the turn admission's own checks, made at this moment.
   */
  readonly dispatch: (
    thread: CodeThread,
    continuation: CodeOperationId,
    prompt: string,
  ) => Promise<
    { readonly kind: "dispatched" } | { readonly kind: "refused"; readonly detail: string }
  >;
  /** Lets the thread's queued messages follow the continuation. */
  readonly releaseQueue: (threadId: CodeThreadId) => Promise<void>;
  readonly clock: () => string;
}

type Held = { readonly reason: HostRestartRecoveryHold; readonly detail: string };

/**
 * Continues or holds every Code turn this start found cut off, and says which.
 * Undefined when the restart cut nothing off.
 */
export async function continueCodeTurnsCutOffByRestart(
  ports: CodeRestartContinuationPorts,
): Promise<HostRestartRecovery | undefined> {
  const continued: Array<HostRestartRecovery["continued"][number]> = [];
  const held: Array<HostRestartRecovery["held"][number]> = [];
  const candidates: Array<{ readonly thread: CodeThread; readonly operationId: string }> = [];
  const seen = new Set<string>();
  for (const turn of ports.cutOff) {
    if (seen.has(String(turn.threadId))) continue;
    seen.add(String(turn.threadId));
    const thread = ports.readThread(turn.threadId);
    if (thread === undefined || thread.lifecycle !== "active") continue;
    const works = ports.runtimeWorks(thread.id);
    // Only the thread's newest turn is owed a continuation; an older one a
    // newer turn already followed is settled with the rest below.
    const latest = works.filter(({ work }) => work.kind === "provider-turn").at(-1);
    if (latest === undefined || String(latest.work.id) !== turn.operationId) {
      ports.settleCutOffTurns(thread.id);
      continue;
    }
    const hold = guard(ports, thread, turn.operationId, works);
    if (hold !== undefined) {
      ports.settleCutOffTurns(thread.id);
      held.push({ mode: "code", threadId: String(thread.id), ...hold });
      continue;
    }
    candidates.push({ thread, operationId: turn.operationId });
  }
  // A checkout that cannot be revalidated stays waiting, and that thread's
  // own admission then refuses it with the reason.
  if (candidates.length > 0) await ports.recoverCheckouts().catch(() => undefined);
  for (const { thread, operationId } of candidates) {
    const continuation = decodeCodeOperationId(restartContinuationId(operationId));
    const outcome = await continueThread(ports, thread, operationId, continuation);
    if (outcome === undefined) {
      continued.push({ mode: "code", threadId: String(thread.id) });
      // A queue that cannot be released keeps its restart hold for the person.
      await ports.releaseQueue(thread.id).catch(() => undefined);
    } else {
      held.push({ mode: "code", threadId: String(thread.id), ...outcome });
    }
  }
  return continued.length + held.length === 0
    ? undefined
    : {
        at: decodeUtcTimestamp(ports.clock()),
        continued: continued.slice(0, MAX_REPORTED_THREADS),
        held: held
          .slice(0, MAX_REPORTED_THREADS)
          .map((entry) => ({ ...entry, detail: boundedDetail(entry.detail) })),
      };
}

/** The summary carries a short reason; a refusal's own message can run longer. */
function boundedDetail(detail: string): string {
  const trimmed = detail.trim();
  if (trimmed.length === 0) return "The continuation could not start.";
  return trimmed.length <= 255 ? trimmed : `${trimmed.slice(0, 254).trimEnd()}…`;
}

function guard(
  ports: CodeRestartContinuationPorts,
  thread: CodeThread,
  operationId: string,
  works: ReadonlyArray<ProjectedCodeRuntimeWork>,
): Held | undefined {
  if (!ports.enabled())
    return {
      reason: "turned-off",
      detail: "Continue after restart is off in Settings, so this thread waits for you.",
    };
  if (thread.restartContinuationOff === true)
    return {
      reason: "opted-out",
      detail: "Continue after restart is off for this thread, so it waits for you.",
    };
  // Restart reconciliation marks a push or pull request step it cannot
  // account for `ambiguous`. A continuation could repeat it, or build on a
  // result that never landed, so the person checks the remote first.
  if (works.some(({ work }) => work.state === "ambiguous"))
    return {
      reason: "uncertain-external-action",
      detail:
        "A push or pull request may have reached the remote before Octant stopped. Check it, then continue.",
    };
  if (priorContinuationsCutOff(ports, thread.id, operationId) >= MAX_RESTART_CONTINUATIONS_CUT_OFF)
    return {
      reason: "crash-loop",
      detail:
        "Octant stopped twice while continuing this thread by itself. Check it before continuing.",
    };
  const continuation = decodeCodeOperationId(restartContinuationId(operationId));
  const resumable = ports.resumability(thread, continuation);
  return resumable.kind === "held"
    ? { reason: "cannot-resume", detail: resumable.detail }
    : undefined;
}

/**
 * How many continuations of this chain a restart already cut off. The chain
 * goes on only while the cut-off turn is the continuation the host itself
 * started last; any other turn starts a new chain.
 */
function priorContinuationsCutOff(
  ports: CodeRestartContinuationPorts,
  threadId: CodeThreadId,
  operationId: string,
): number {
  const last = ports.attempts.read(String(threadId));
  return last !== undefined && last.operationId === operationId ? last.attempts : 0;
}

async function continueThread(
  ports: CodeRestartContinuationPorts,
  thread: CodeThread,
  operationId: string,
  continuation: CodeOperationId,
): Promise<Held | undefined> {
  const lifted = await ports.liftHarnessRecovery(thread.id).catch(() => ({
    kind: "held" as const,
    detail: "The thread's harness session could not be resumed.",
  }));
  if (lifted.kind === "held") {
    ports.settleCutOffTurns(thread.id);
    return { reason: "refused", detail: lifted.detail };
  }
  // Counted before anything starts, so a continuation that takes the host
  // down with it is counted even though it never reports back.
  ports.attempts.record(String(thread.id), {
    operationId: String(continuation),
    attempts: priorContinuationsCutOff(ports, thread.id, operationId) + 1,
  });
  ports.settleCutOffTurns(thread.id);
  const current = ports.readThread(thread.id) ?? thread;
  const dispatched = await ports
    .dispatch(current, continuation, RESTART_CONTINUATION_PROMPT)
    .catch(() => ({
      kind: "refused" as const,
      detail: "The continuation could not start.",
    }));
  return dispatched.kind === "dispatched"
    ? undefined
    : { reason: "refused", detail: dispatched.detail };
}
