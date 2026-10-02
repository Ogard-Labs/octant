/**
 * The mode adapters the usage-resume scheduler re-checks and dispatches
 * through. Each port re-reads the authoritative projection at fire time —
 * the opt-in is only as good as the stop it recorded, so a thread, turn,
 * provider, or reset fact that moved invalidates the resume rather than
 * resuming against stale evidence.
 */
import { Schema } from "effect";
import {
  decodeAggregateVersion,
  decodeAgentRunId,
  decodeChatAttemptId,
  decodeChatThread,
  decodeChatThreadId,
  decodeChatTurnId,
  decodeCodeOperationEventFrame,
  decodeCodeOperationId,
  decodeCodeThread,
  decodeCodeThreadId,
  decodeProviderSessionId,
  decodeWorkThread,
  decodeWorkThreadId,
  decodeWorkTurnId,
  decodeWorkTurnRequestId,
  UtcTimestamp,
  type AgentRun,
  type AgentRunAuthority,
  type AgentRunCommandResult,
  type AgentRunId,
  type ChatThread,
  type ChatThreadView,
  type CodeEvidenceBatchResponse,
  type CodeEvidenceContentId,
  type CodeEvidenceReference,
  type CodeOperationCommand,
  type CodeOperationEventFrame,
  type CodeOperationResult,
  type CodeThread,
  type CodeThreadId,
  type UsageResumeRecord,
  type UsageResumeSettled,
  type WindowId,
  type WorkThread,
  type WorkThreadId,
  type WorkTurnLookupResult,
  type WorkTurnState,
} from "@octant/contracts";
import { effectiveAgentRunExecutionTarget } from "@octant/domain";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import type { ChatServiceExecutionContext } from "../chat/chatService";
import type { CodeOperationExecuteOptions } from "../code/codeOperationService";
import type { Journal } from "../persistence/journal";
import { readAggregateVersion } from "../persistence/chatProjection";
import type { ProjectedCodeRuntimeWork } from "../persistence/codeProjection";
import type { SqliteConnection } from "../persistence/sqlitePort";
import type {
  UsageResumeModePort,
  UsageResumePorts,
  UsageResumeSettledOutcome,
} from "./usageResumeService";

const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);

/**
 * The settle update is the single place the host lifts the shelf mark it
 * owns: a dispatched resume consumes the snooze that was set against the
 * limit it just dispatched, and nothing else — a snooze the person set, or
 * one already lifted, stays untouched.
 */
function settledThread<
  T extends {
    readonly snooze?: { readonly origin?: "user" | "usage-limit" | undefined } | undefined;
  },
>(thread: T, outcome: UsageResumeSettledOutcome): T {
  if (outcome === "dispatched" && thread.snooze?.origin === "usage-limit") {
    const { snooze: _spent, ...rest } = thread;
    return rest as T;
  }
  return thread;
}

/**
 * What the ports need from the host. Every function is a narrow cut of the
 * service the mode already exposes — a resume is a normal send, so it goes
 * through the ordinary command path and inherits its authority checks.
 */
export interface UsageResumePortDependencies {
  readonly connection: SqliteConnection;
  readonly journal: Pick<Journal, "replayAggregate">;
  readonly clock: () => Date;
  readonly uuid: () => string;
  /** Any registered local window; the turn path rechecks access itself. */
  readonly windowId: () => WindowId | undefined;
  readonly chat: {
    readonly readThread: (threadId: ChatThread["id"]) => ChatThread | undefined;
    readonly readThreadView: (threadId: ChatThread["id"]) => ChatThreadView | undefined;
    readonly execute: (
      input: unknown,
      executionContext?: ChatServiceExecutionContext,
    ) => Promise<unknown>;
  };
  readonly work: {
    readonly readThread: (threadId: WorkThreadId) => WorkThread | undefined;
    readonly listTurns: (threadId: WorkThreadId) => ReadonlyArray<WorkTurnState>;
    readonly startFirstTurn: (
      windowId: WindowId,
      input: unknown,
      options?: { readonly limitRecovery?: boolean },
    ) => Promise<WorkTurnLookupResult>;
    /**
     * The live Work projection is kept in memory rather than rebuilt from a
     * journaled row, so a settle committed by the scheduler has to be folded
     * back into it or reads keep reporting `scheduled`.
     */
    readonly applySettled?: (
      usageResumePayload: unknown,
      threadUpdate: { readonly kind: "thread-updated"; readonly thread: WorkThread } | undefined,
    ) => void;
  };
  readonly agentRun: {
    readonly readRun: (runId: AgentRunId) => AgentRun | undefined;
    /**
     * The window-free live grant for a scheduled resume; undefined when the
     * parent thread's durable posture can no longer be read.
     */
    readonly liveAuthority: (run: AgentRun) => AgentRunAuthority | undefined;
    /** The ordinary run resume path — capacity, authority, workspace checks. */
    readonly resume: (
      runId: AgentRunId,
      expectedVersion: number,
      liveAuthority: AgentRunAuthority,
    ) => AgentRunCommandResult | Promise<AgentRunCommandResult>;
    /**
     * Folds a scheduler-committed settle into the in-memory run projection,
     * which the journal does not drive.
     */
    readonly applySettled?: (settled: UsageResumeSettled) => void;
  };
  readonly code: {
    readonly readThread: (threadId: CodeThreadId) => CodeThread | undefined;
    readonly readRuntimeWorks: (threadId: CodeThreadId) => ReadonlyArray<ProjectedCodeRuntimeWork>;
    readonly readOperationContents?: (
      windowId: WindowId,
      input: {
        readonly threadId: CodeThreadId;
        readonly items: ReadonlyArray<{
          readonly operationId: CodeOperationEventFrame["operationId"];
          readonly contentId: CodeEvidenceContentId;
        }>;
      },
    ) => Promise<CodeEvidenceBatchResponse> | CodeEvidenceBatchResponse;
    readonly stageEvidence?: (
      windowId: WindowId,
      threadId: CodeThreadId,
      text: string,
    ) => Promise<CodeEvidenceReference> | CodeEvidenceReference;
    readonly executeOperation?: (
      windowId: WindowId,
      command: CodeOperationCommand,
      options?: CodeOperationExecuteOptions,
    ) => Promise<CodeOperationResult> | CodeOperationResult;
  };
}

const invalid = (detail: string) => ({ kind: "invalid" as const, detail });
const refused = (detail: string) => ({ kind: "refused" as const, detail });
// The opt-in is still valid but cannot fire yet; the scheduler keeps it
// armed and re-checks instead of settling a durable record away.
const deferred = (detail: string) => ({ kind: "deferred" as const, detail });
const refusalDetail = (error: unknown): string =>
  error instanceof Error ? error.message : "The continuation could not be admitted.";

/**
 * The opt-in must still be the thread's one scheduled resume — same recorded
 * stop — or the settle it rides belongs to something else.
 */
const scheduledFor = (
  state: { readonly record: UsageResumeRecord; readonly status: string } | undefined,
  record: UsageResumeRecord,
): boolean =>
  state !== undefined &&
  state.status === "scheduled" &&
  String(state.record.turnId) === String(record.turnId) &&
  String(state.record.attemptId) === String(record.attemptId) &&
  String(state.record.providerInstanceId) === String(record.providerInstanceId) &&
  state.record.resetsAt === record.resetsAt;

function chatPort(deps: UsageResumePortDependencies): UsageResumeModePort {
  return {
    inspect: async (record) => {
      const threadId = decodeChatThreadId(record.threadId);
      const thread = deps.chat.readThread(threadId);
      if (thread === undefined || thread.lifecycle !== "active") {
        return invalid("The Chat thread is no longer active.");
      }
      if (String(thread.providerInstanceId) !== String(record.providerInstanceId)) {
        return invalid("The thread's provider changed.");
      }
      if (!scheduledFor(thread.usageResume, record)) {
        return invalid("The scheduled resume is no longer current.");
      }
      const view = deps.chat.readThreadView(threadId);
      const turn = view?.turns.at(-1);
      const attempt = turn?.attempts.at(-1);
      if (
        turn === undefined ||
        attempt === undefined ||
        String(turn.id) !== record.turnId ||
        String(attempt.id) !== String(record.attemptId)
      ) {
        return invalid("The recorded stop is no longer the conversation's tail.");
      }
      if (attempt.outcome !== "waiting" || attempt.usageLimit === undefined) {
        return invalid("The attempt is no longer waiting on a usage limit.");
      }
      if (attempt.usageLimit.resetsAt !== record.resetsAt) {
        return invalid("The provider moved the reset the opt-in was made against.");
      }
      if (attempt.resumeCursor === undefined) {
        return invalid("The attempt no longer carries provider resume state.");
      }
      return { kind: "ready" };
    },
    dispatch: async (record) => {
      const threadId = decodeChatThreadId(record.threadId);
      const attemptId = record.attemptId;
      if (attemptId === undefined) {
        return refused("The recorded stop names no attempt.");
      }
      try {
        // A limit retry must actually send: `resume-chat-turn` only reattaches
        // the provider session and persists another waiting attempt, while
        // `retry-chat-turn` is the admission path that runs a new attempt.
        await deps.chat.execute(
          {
            kind: "retry-chat-turn",
            threadId,
            expectedVersion: decodeAggregateVersion(
              readAggregateVersion(deps.connection, "chat-thread", String(threadId)),
            ),
            turnId: decodeChatTurnId(record.turnId),
            attemptId: decodeChatAttemptId(attemptId),
          },
          { limitRecovery: true },
        );
        return { kind: "dispatched" };
      } catch (error) {
        return refused(refusalDetail(error));
      }
    },
    settleUpdate: (record, outcome, detail, nextVersion) => {
      const thread = deps.chat.readThread(decodeChatThreadId(record.threadId));
      if (thread === undefined) return undefined;
      const next = settledThread(thread, outcome);
      return {
        eventName: "chat.thread-updated@1",
        payload: {
          kind: "thread-updated",
          thread: decodeChatThread({
            ...next,
            usageResume: {
              record,
              status: outcome,
              ...(detail === undefined ? {} : { detail }),
            },
            version: nextVersion,
            updatedAt: decodeTimestamp(deps.clock().toISOString()),
          }),
        },
      };
    },
  };
}

function workPort(deps: UsageResumePortDependencies): UsageResumeModePort {
  const stoppedTurn = (record: UsageResumeRecord) =>
    deps.work.listTurns(decodeWorkThreadId(record.threadId)).at(-1);
  return {
    inspect: async (record) => {
      const threadId = decodeWorkThreadId(record.threadId);
      const thread = deps.work.readThread(threadId);
      if (thread === undefined || thread.lifecycle !== "active") {
        return invalid("The Work thread is no longer active.");
      }
      if (String(thread.providerInstanceId) !== String(record.providerInstanceId)) {
        return invalid("The thread's provider changed.");
      }
      if (thread.bindingRevisionId === undefined) {
        return invalid("The thread has no bound project revision.");
      }
      if (!scheduledFor(thread.usageResume, record)) {
        return invalid("The scheduled resume is no longer current.");
      }
      const turn = stoppedTurn(record);
      if (turn === undefined || String(turn.turnId) !== record.turnId) {
        return invalid("The recorded stop is no longer the thread's latest turn.");
      }
      if (turn.status !== "waiting" || turn.failure?.usageLimit === undefined) {
        return invalid("The turn is no longer waiting on a usage limit.");
      }
      if (turn.failure.usageLimit.resetsAt !== record.resetsAt) {
        return invalid("The provider moved the reset the opt-in was made against.");
      }
      if (turn.resumeCursor === undefined) {
        return invalid("The turn no longer carries provider resume state.");
      }
      return { kind: "ready" };
    },
    dispatch: async (record) => {
      const windowId = deps.windowId();
      if (windowId === undefined) {
        return deferred("No local window is registered for this host.");
      }
      const thread = deps.work.readThread(decodeWorkThreadId(record.threadId));
      const turn = stoppedTurn(record);
      if (thread === undefined || turn === undefined || thread.bindingRevisionId === undefined) {
        return refused("The thread's recorded stop is unavailable.");
      }
      try {
        const result = await deps.work.startFirstTurn(
          windowId,
          {
            kind: "start-work-thread-turn",
            requestId: decodeWorkTurnRequestId(deps.uuid()),
            threadId: thread.id,
            turnId: decodeWorkTurnId(deps.uuid()),
            prompt: turn.prompt,
            ...(turn.extensionSelections === undefined
              ? {}
              : { extensionSelections: turn.extensionSelections }),
            authority: {
              hostId: LOCAL_HOST_ID,
              projectId: thread.projectId,
              bindingRevisionId: thread.bindingRevisionId,
              workingDirectory: ".",
              confinementPosture: "project-root-confined",
              providerInstanceId: thread.providerInstanceId,
              modelId: thread.modelId,
            },
          },
          { limitRecovery: true },
        );
        return result.kind === "accepted"
          ? { kind: "dispatched" }
          : refused("message" in result ? result.message : "The continuation was not admitted.");
      } catch (error) {
        return refused(refusalDetail(error));
      }
    },
    settleUpdate: (record, outcome, detail, nextVersion) => {
      const thread = deps.work.readThread(decodeWorkThreadId(record.threadId));
      if (thread === undefined) return undefined;
      const next = settledThread(thread, outcome);
      return {
        eventName: "work.thread-updated@1",
        payload: {
          kind: "thread-updated",
          thread: decodeWorkThread({
            ...next,
            usageResume: {
              record,
              status: outcome,
              ...(detail === undefined ? {} : { detail }),
            },
            version: nextVersion,
            updatedAt: decodeTimestamp(deps.clock().toISOString()),
          }),
        },
      };
    },
    settleApplied: (usageResumePayload, emitted) => {
      deps.work.applySettled?.(
        usageResumePayload,
        emitted === undefined
          ? undefined
          : (emitted.payload as {
              readonly kind: "thread-updated";
              readonly thread: WorkThread;
            }),
      );
    },
  };
}

/**
 * The provider-turn tail a Code thread recorded on the operation aggregate —
 * the journaled stop the opt-in binds to, re-read at fire time.
 */
const codeStoppedTurnState = (
  deps: UsageResumePortDependencies,
  operationId: string,
):
  | Extract<
      Extract<CodeOperationEventFrame["event"], { kind: "operation-result" }>["result"],
      { kind: "provider-turn-state" }
    >
  | undefined => {
  let latest:
    | Extract<
        Extract<CodeOperationEventFrame["event"], { kind: "operation-result" }>["result"],
        { kind: "provider-turn-state" }
      >
    | undefined;
  // A provider turn journals operation events as it streams, so a long turn
  // can outgrow one page; the recorded stop always sits at the stream's tail.
  const pageSize = 1_000;
  let afterVersion = 0;
  for (;;) {
    const page = deps.journal.replayAggregate({
      aggregateType: "code-operation",
      aggregateId: operationId,
      afterVersion,
      limit: pageSize,
    });
    for (const committed of page) {
      afterVersion = committed.aggregateVersion;
      if (committed.eventName !== "code.operation-event-recorded@1") continue;
      const frame = decodeCodeOperationEventFrame(committed.payload);
      if (
        frame.event.kind === "operation-result" &&
        frame.event.result.kind === "provider-turn-state"
      ) {
        latest = frame.event.result;
      }
    }
    if (page.length < pageSize) break;
  }
  return latest;
};

function codePort(deps: UsageResumePortDependencies): UsageResumeModePort {
  return {
    inspect: async (record) => {
      const threadId = decodeCodeThreadId(record.threadId);
      const thread = deps.code.readThread(threadId);
      if (thread === undefined || thread.lifecycle !== "active") {
        return invalid("The Code thread is no longer active.");
      }
      if (String(thread.providerInstanceId) !== String(record.providerInstanceId)) {
        return invalid("The thread's provider changed.");
      }
      if (!scheduledFor(thread.usageResume, record)) {
        return invalid("The scheduled resume is no longer current.");
      }
      const latest = deps.code
        .readRuntimeWorks(threadId)
        .filter(({ work }) => work.kind === "provider-turn")
        .at(-1);
      if (latest === undefined || String(latest.work.id) !== record.turnId) {
        return invalid("The recorded stop is no longer the thread's latest provider turn.");
      }
      const stopped = codeStoppedTurnState(deps, record.turnId);
      if (
        stopped === undefined ||
        stopped.state !== "waiting" ||
        stopped.failure?.usageLimit === undefined
      ) {
        return invalid("The provider turn is no longer waiting on a usage limit.");
      }
      if (stopped.failure.usageLimit.resetsAt !== record.resetsAt) {
        return invalid("The provider moved the reset the opt-in was made against.");
      }
      if (stopped.evidence === undefined) {
        return invalid("The turn preserved no provider prompt state.");
      }
      return { kind: "ready" };
    },
    dispatch: async (record) => {
      const windowId = deps.windowId();
      if (windowId === undefined) {
        return deferred("No local window is registered for this host.");
      }
      const threadId = decodeCodeThreadId(record.threadId);
      const thread = deps.code.readThread(threadId);
      const stopped = codeStoppedTurnState(deps, record.turnId);
      const evidence = stopped?.evidence;
      if (
        thread === undefined ||
        evidence === undefined ||
        deps.code.readOperationContents === undefined ||
        deps.code.stageEvidence === undefined ||
        deps.code.executeOperation === undefined
      ) {
        return refused("The recorded stop's preserved prompt is unavailable.");
      }
      try {
        const batch = await deps.code.readOperationContents(windowId, {
          threadId,
          items: [
            { operationId: decodeCodeOperationId(record.turnId), contentId: evidence.contentId },
          ],
        });
        const text = batch.items.at(0)?.text;
        if (text === undefined || text.trim().length === 0) {
          return refused("The recorded stop's preserved prompt is unavailable.");
        }
        const prompt = await deps.code.stageEvidence(windowId, threadId, text);
        const result = await deps.code.executeOperation(
          windowId,
          {
            kind: "start-provider-turn",
            operationId: decodeCodeOperationId(deps.uuid()),
            threadId: thread.id,
            checkoutId: thread.checkoutId,
            sessionId: decodeProviderSessionId(deps.uuid()),
            prompt,
          },
          { limitRecovery: true },
        );
        return result.kind === "provider-turn-state" &&
          (result.state === "running" || result.state === "waiting" || result.state === "completed")
          ? { kind: "dispatched" }
          : refused(
              result.kind === "provider-turn-state" && result.failure !== undefined
                ? result.failure.message
                : "The continuation was not admitted.",
            );
      } catch (error) {
        return refused(refusalDetail(error));
      }
    },
    settleUpdate: (record, outcome, detail, nextVersion) => {
      const thread = deps.code.readThread(decodeCodeThreadId(record.threadId));
      if (thread === undefined) return undefined;
      const next = settledThread(thread, outcome);
      return {
        eventName: "code.thread-updated@1",
        payload: {
          kind: "thread-updated",
          thread: decodeCodeThread({
            ...next,
            usageResume: {
              record,
              status: outcome,
              ...(detail === undefined ? {} : { detail }),
            },
            version: nextVersion,
            updatedAt: decodeTimestamp(deps.clock().toISOString()),
          }),
        },
      };
    },
  };
}

/**
 * A child run's resume is the ordinary resume path — the same start a
 * person-driven Resume takes — so capacity gating, live-authority clamps,
 * workspace checks, and the approvals freshness check all apply unchanged.
 * The opt-in's premise is the run's own journaled wait: still `waiting` on
 * the same disclosed reset, on the same execution provider the route
 * recorded, with the opt-in still current.
 */
function agentRunPort(deps: UsageResumePortDependencies): UsageResumeModePort {
  return {
    inspect: async (record) => {
      const run = deps.agentRun.readRun(decodeAgentRunId(record.threadId));
      if (run === undefined) {
        return invalid("The run no longer exists.");
      }
      if (run.lifecycleStatus !== "waiting") {
        return invalid("The run left its waiting stop.");
      }
      if (run.usageLimit === undefined) {
        return invalid("The run is no longer waiting on a usage limit.");
      }
      if (run.usageLimit.resetsAt !== record.resetsAt) {
        return invalid("The provider moved the reset the opt-in was made against.");
      }
      if (
        String(effectiveAgentRunExecutionTarget(run.routingReceipt).providerInstanceId) !==
        String(record.providerInstanceId)
      ) {
        return invalid("The run's execution provider changed.");
      }
      if (!scheduledFor(run.usageResume, record)) {
        return invalid("The scheduled resume is no longer current.");
      }
      return { kind: "ready" };
    },
    dispatch: async (record) => {
      const run = deps.agentRun.readRun(decodeAgentRunId(record.threadId));
      if (run === undefined) {
        return refused("The run no longer exists.");
      }
      const liveAuthority = deps.agentRun.liveAuthority(run);
      if (liveAuthority === undefined) {
        return refused("The run's parent thread grant is unavailable.");
      }
      try {
        const result = await deps.agentRun.resume(run.id, run.version, liveAuthority);
        return result.kind === "run-updated"
          ? { kind: "dispatched" }
          : refused(
              result.kind === "run-command-failed"
                ? result.message
                : "The resume did not start the run.",
            );
      } catch (error) {
        return refused(refusalDetail(error));
      }
    },
    settleApplied: (usageResumePayload) => {
      deps.agentRun.applySettled?.(usageResumePayload as UsageResumeSettled);
    },
  };
}

export function createUsageResumePorts(deps: UsageResumePortDependencies): UsageResumePorts {
  return {
    chat: chatPort(deps),
    work: workPort(deps),
    code: codePort(deps),
    agentRun: agentRunPort(deps),
  };
}
