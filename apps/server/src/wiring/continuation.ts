import { randomUUID } from "node:crypto";
import {
  decodeChatSubmissionId,
  decodeChatThreadId,
  decodeContextSubjectRef,
  decodeProviderSessionId,
  decodeUtcTimestamp,
  decodeWorkThreadId,
  decodeWorkTurnId,
  decodeWorkTurnRequestId,
  LOCAL_HOST_ID,
  USAGE_RESUME_SETTLED,
  type HostRestartRecovery,
  type WorkThread,
  type WorkThreadId,
} from "@octant/contracts";
import { Effect } from "effect";
import {
  codeRestartResumability,
  continueCodeTurnsCutOffByRestart,
  createCodeRestartContinuationAttempts,
} from "../code/codeRestartContinuation";
import { CodeServiceError } from "../code/codeService";
import {
  releaseQueueBehindRestartContinuation,
  restartContinuationId,
} from "../harness/restartContinuation";
import {
  continueThreadTurnsCutOffByRestart,
  mergeRestartRecoveries,
} from "../harness/threadRestartContinuation";
import {
  ChatServiceError,
  type ChatAttemptCutOffByRestart,
  type ChatService,
} from "../chat/chatService";
import { WorkTurnServiceError, type WorkTurnService } from "../work/workTurnService";
import type { WorkTurnCutOffByRestart } from "../work/workTurnProjection";
import type { SqliteConnection } from "../persistence/sqlitePort";
import { ROUTINE_HOST_SCOPE_ID } from "../routineHostScope";
import type { HarnessWiring } from "./harness";
import { createChatAgentResultDeliveryPort } from "../chat/chatAgentResultDeliveryPort";
import { UsageResumeService } from "../usage/usageResumeService";
import { createUsageResumePorts } from "../usage/usageResumePorts";
import { AgentRunDependencyScheduler } from "../agentRun/agentRunDependencyScheduler";
import { AgentRunProviderSlotScheduler } from "../agentRun/agentRunProviderSlotScheduler";
import { AgentResultDeliveryService } from "../agentRun/agentResultDeliveryService";
import { recordAgentRunResultIngestion } from "../agentRun/agentRunDelegation";
import {
  createCodeAgentResultDeliveryPort,
  createWorkAgentResultDeliveryPort,
} from "../agentRun/agentResultDeliveryPorts";
import { defaultShellSettings, enabledModes } from "@octant/domain";
import type { ServerStart } from "./serverShape";
import type { AuthorityWiring } from "./authority";
import type { FoundationsWiring } from "./foundations";
import type { AgentRunsWiring } from "./agentRuns";
import type { WorkspaceWiring } from "./workspace";
import type { CodeRuntimeWiring } from "./codeRuntime";
import type { ChatWiring } from "./chat";
import type { WorkWiring } from "./work";

export type ContinuationDependencies = Pick<ServerStart, "persistence"> &
  Pick<AuthorityWiring, "agentRunParentAuthority" | "agentRunPersistence"> &
  Pick<
    AgentRunsWiring,
    "agentRunOrchestration" | "capacityScheduler" | "externalContentIngestionStore"
  > &
  Pick<WorkspaceWiring, "contextHarness"> &
  Pick<CodeRuntimeWiring, "codeOperationRuntime" | "routeCodeService"> &
  Pick<ChatWiring, "chatAttemptsCutOffByRestart" | "chatService"> &
  Pick<HarnessWiring, "liftRestartRecovery"> &
  Pick<WorkWiring, "threadMessageQueue" | "workTurnService"> &
  Pick<
    FoundationsWiring,
    | "codeBoardEventStore"
    | "workThreadProjection"
    | "workTurnProjection"
    | "workTurnsCutOffByRestart"
  >;

export function wireContinuation(deps: ContinuationDependencies) {
  const {
    agentRunOrchestration,
    agentRunParentAuthority,
    agentRunPersistence,
    capacityScheduler,
    chatService,
    contextHarness,
    externalContentIngestionStore,
    persistence,
    routeCodeService,
    workThreadProjection,
    workTurnProjection,
    workTurnService,
  } = deps;
  return Effect.gen(function* () {
    // Host-owned recovery for provider usage-limited stops: the journal record
    // is the opt-in, the projection rebuilds what is armed after a restart, and
    // every reset fires through the mode's ordinary turn admission.
    const usageResumeService = new UsageResumeService({
      journal: persistence.journal,
      connection: persistence.connection,
      clock: () => new Date(),
      uuid: randomUUID,
      ports: createUsageResumePorts({
        connection: persistence.connection,
        journal: persistence.journal,
        clock: () => new Date(),
        uuid: randomUUID,
        chat: {
          readThread: (threadId) => persistence.readChatThread(threadId),
          readThreadView: (threadId) => persistence.readChatThreadView(threadId),
          execute: (input, executionContext) => chatService.execute(input, executionContext),
          compacting: (threadId) =>
            contextHarness.compactionRunning(
              decodeContextSubjectRef({ aggregateType: "chat-thread", aggregateId: threadId }),
            ),
        },
        work: {
          compacting: (threadId) =>
            contextHarness.compactionRunning(
              decodeContextSubjectRef({ aggregateType: "work-thread", aggregateId: threadId }),
            ),
          isEnabled: () =>
            enabledModes(
              persistence.readShellSettings()?.settings ?? defaultShellSettings(),
            ).includes("work"),
          readThread: (threadId) => workThreadProjection.read(threadId),
          listTurns: (threadId) => workTurnProjection.listForThread(threadId),
          startFirstTurn: (windowId, input, options) =>
            workTurnService.startFirstTurn(windowId, input, options),
          applySettled: (usageResumePayload, threadUpdate) => {
            workThreadProjection.applyUsageResume({
              eventName: USAGE_RESUME_SETTLED,
              payload: usageResumePayload,
            });
            if (threadUpdate !== undefined) {
              workThreadProjection.apply(threadUpdate);
            }
          },
        },
        code: {
          readThread: (threadId) => persistence.readCodeThread(threadId),
          compacting: (threadId) =>
            contextHarness.compactionRunning(
              decodeContextSubjectRef({ aggregateType: "code-thread", aggregateId: threadId }),
            ),
          readRuntimeWorks: (threadId) => persistence.readCodeRuntimeWorks(threadId),
          ...(routeCodeService.readOperationContents === undefined
            ? {}
            : { readOperationContents: routeCodeService.readOperationContents }),
          ...(routeCodeService.stageEvidence === undefined
            ? {}
            : { stageEvidence: routeCodeService.stageEvidence }),
          ...(routeCodeService.executeOperation === undefined
            ? {}
            : { executeOperation: routeCodeService.executeOperation }),
        },
        agentRun: {
          readRun: (runId) => agentRunPersistence.getById(runId),
          liveAuthority: agentRunParentAuthority,
          resume: (runId, expectedVersion, liveAuthority) =>
            agentRunOrchestration.resume(runId, expectedVersion, liveAuthority, {
              resolveLiveAuthority: () => {
                const run = agentRunPersistence.getById(runId);
                return run === undefined ? undefined : agentRunParentAuthority(run);
              },
            }),
          applySettled: (settled) => agentRunPersistence.applyUsageResumeSettled(settled),
        },
      }),
      onError: (message, error) => console.error(`[usage-resume] ${message}`, error),
    });
    const unsubscribeUsageResume = persistence.journal.subscribeCommitted((append) =>
      usageResumeService.onCommittedAppend(append),
    );
    // Armed timers can sit hours out; both must go down with the server or a
    // late fire would read and append against a closed store.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        unsubscribeUsageResume();
        usageResumeService.stop();
      }),
    );
    usageResumeService.start();
    // A finished subagent run owes its parent thread a journaled turn carrying
    // its result. The service watches committed appends and dispatches through
    // each mode's ordinary turn admission — the mark on that turn is what
    // keeps a replayed delivery from minting a second one.
    const agentResultDeliveryService = new AgentResultDeliveryService({
      journal: persistence.journal,
      agentRuns: agentRunPersistence,
      clock: () => new Date(),
      recordResultIngestion: (run) =>
        recordAgentRunResultIngestion(
          (input) => externalContentIngestionStore.record(input),
          run,
          randomUUID,
        ),
      ports: {
        chat: createChatAgentResultDeliveryPort({
          readThread: (threadId) => persistence.readChatThread(threadId),
          chat: chatService,
        }),
        work: createWorkAgentResultDeliveryPort({
          uuid: randomUUID,
          resultText: (id) => agentRunPersistence.resultText(id),
          isEnabled: () =>
            enabledModes(
              persistence.readShellSettings()?.settings ?? defaultShellSettings(),
            ).includes("work"),
          readThread: (threadId) => workThreadProjection.read(threadId),
          startFirstTurn: (windowId, input) => workTurnService.startFirstTurn(windowId, input),
        }),
        code: createCodeAgentResultDeliveryPort({
          uuid: randomUUID,
          resultText: (id) => agentRunPersistence.resultText(id),
          readThread: (threadId) => persistence.readCodeThread(threadId),
          compacting: (threadId) =>
            contextHarness.compactionRunning(
              decodeContextSubjectRef({ aggregateType: "code-thread", aggregateId: threadId }),
            ),
          ...(routeCodeService.stageEvidence === undefined
            ? {}
            : { stageEvidence: routeCodeService.stageEvidence }),
          ...(routeCodeService.executeOperation === undefined
            ? {}
            : { executeOperation: routeCodeService.executeOperation }),
        }),
      },
      onError: (message, error) => console.error(`[agent-run-delivery] ${message}`, error),
    });
    const unsubscribeAgentResultDelivery = persistence.journal.subscribeCommitted((append) =>
      agentResultDeliveryService.onCommittedAppend(append),
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        unsubscribeAgentResultDelivery();
        agentResultDeliveryService.stop();
      }),
    );
    agentResultDeliveryService.start();
    const agentRunDependencyScheduler = new AgentRunDependencyScheduler({
      agentRuns: agentRunPersistence,
      orchestration: agentRunOrchestration,
      onError: (message, error) => console.error(`[agent-run-dependencies] ${message}`, error),
    });
    const unsubscribeAgentRunDependencies = persistence.journal.subscribeCommitted((append) =>
      agentRunDependencyScheduler.onCommittedAppend(append),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribeAgentRunDependencies()));
    agentRunDependencyScheduler.start();
    // A helper the provider had no free slot for waits and starts when one
    // frees, so it is asked again whenever a turn ends and while it waits.
    const agentRunProviderSlotScheduler = new AgentRunProviderSlotScheduler({
      orchestration: agentRunOrchestration,
      onCapacityFreed: (listener) => capacityScheduler.onCapacityFreed(listener),
      onError: (message, error) => console.error(`[agent-run-provider-slots] ${message}`, error),
    });
    const unsubscribeAgentRunProviderSlots = persistence.journal.subscribeCommitted((append) =>
      agentRunProviderSlotScheduler.onCommittedAppend(append),
    );
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        unsubscribeAgentRunProviderSlots();
        agentRunProviderSlotScheduler.stop();
      }),
    );
    agentRunProviderSlotScheduler.start();
    const restartRecovery = startRestartContinuation(deps);
    return { restartRecovery };
  });
}

/**
 * Continues, as the host, the turns the previous host was running when it
 * stopped, in every mode (docs/architecture.md, restart recovery). It runs
 * once per start, after the queues have recovered, and answers the summary
 * the restart notice reads.
 */
function startRestartContinuation(
  deps: ContinuationDependencies,
): () => HostRestartRecovery | undefined {
  if (
    deps.persistence.codeTurnsCutOffByRestart.length === 0 &&
    deps.chatAttemptsCutOffByRestart.length === 0 &&
    deps.workTurnsCutOffByRestart.length === 0
  )
    return () => undefined;
  let summary: HostRestartRecovery | undefined;
  const settled = <T>(promise: Promise<T>, mode: string) =>
    promise.catch((error: unknown) => {
      console.error(`[restart-continuation] ${mode} recovery did not finish.`, error);
      return undefined;
    });
  void (async () => {
    const code = await settled(continueCodeTurns(deps), "Code");
    const chat = await settled(
      continueChatTurns({
        cutOff: deps.chatAttemptsCutOffByRestart,
        chat: deps.chatService,
        enabled: () => deps.persistence.readChatSettings()?.settings.restartContinuation !== false,
        connection: deps.persistence.connection,
        releaseQueue: (threadId) =>
          releaseQueueBehindRestartContinuation(deps.threadMessageQueue, {
            scopeId: ROUTINE_HOST_SCOPE_ID,
            threadId,
            mode: "chat",
          }),
      }),
      "Chat",
    );
    const work = await settled(
      continueWorkTurns({
        cutOff: deps.workTurnsCutOffByRestart,
        work: deps.workTurnService,
        readThread: (threadId) => deps.workThreadProjection.read(threadId),
        enabled: () => deps.workThreadProjection.settings()?.restartContinuation !== false,
        modeEnabled: () =>
          enabledModes(
            deps.persistence.readShellSettings()?.settings ?? defaultShellSettings(),
          ).includes("work"),
        connection: deps.persistence.connection,
        releaseQueue: (threadId) =>
          releaseQueueBehindRestartContinuation(deps.threadMessageQueue, {
            scopeId: ROUTINE_HOST_SCOPE_ID,
            threadId,
            mode: "work",
          }),
      }),
      "Work",
    );
    summary = mergeRestartRecoveries(decodeUtcTimestamp(new Date().toISOString()), [
      code,
      chat,
      work,
    ]);
  })();
  return () => summary;
}

/** What continuing Chat answers after a restart reads and does. */
export interface ChatRestartContinuationDependencies {
  readonly cutOff: ReadonlyArray<ChatAttemptCutOffByRestart>;
  readonly chat: Pick<ChatService, "read" | "execute" | "restartContinuationReadiness">;
  /** Settings › Chat › Continue after restart. */
  readonly enabled: () => boolean;
  /** The store the crash-loop guard counts in. */
  readonly connection: SqliteConnection;
  readonly releaseQueue: (threadId: string) => Promise<void>;
}

/** Continues the Chat answers this start interrupted (docs/architecture.md, Chat restart recovery). */
export function continueChatTurns(deps: ChatRestartContinuationDependencies) {
  const { chat, cutOff } = deps;
  const byAttempt = new Map(cutOff.map((cut) => [String(cut.attemptId), cut] as const));
  return continueThreadTurnsCutOffByRestart({
    mode: "chat",
    cutOff: cutOff.map((cut) => ({
      threadId: String(cut.threadId),
      turnId: String(cut.attemptId),
    })),
    readiness: (turn) => {
      const cut = byAttempt.get(turn.turnId);
      return cut === undefined ? { kind: "settled" } : chat.restartContinuationReadiness(cut);
    },
    enabled: deps.enabled,
    attempts: createCodeRestartContinuationAttempts(deps.connection),
    // A host continuation is an ordinary send under its one submission
    // identity: a repeated recovery finds the turn the first one made, and
    // the send's own admission rechecks the thread's authority and spend.
    dispatch: (turn, continuation, prompt) =>
      new Promise((resolve) => {
        const refused = (detail: string) => resolve({ kind: "refused", detail });
        let thread;
        try {
          thread = chat.read(decodeChatThreadId(turn.threadId)).thread;
        } catch {
          refused("The thread is unavailable.");
          return;
        }
        chat
          .execute(
            {
              kind: "send-chat-turn",
              threadId: thread.id,
              expectedVersion: thread.version,
              prompt,
              submissionId: decodeChatSubmissionId(continuation),
            },
            { onTurnAccepted: () => resolve({ kind: "dispatched" }) },
          )
          .then(
            () => resolve({ kind: "dispatched" }),
            (error: unknown) =>
              refused(
                error instanceof ChatServiceError
                  ? error.failure.message
                  : "The continuation could not start.",
              ),
          );
      }),
    releaseQueue: deps.releaseQueue,
  });
}

/** What continuing Work turns after a restart reads and does. */
export interface WorkRestartContinuationDependencies {
  readonly cutOff: ReadonlyArray<WorkTurnCutOffByRestart>;
  readonly work: Pick<WorkTurnService, "startFirstTurn" | "restartContinuationReadiness">;
  readonly readThread: (threadId: WorkThreadId) => WorkThread | undefined;
  /** Settings › Work › Continue after restart. */
  readonly enabled: () => boolean;
  /** Whether Work is on at all; the Work turn path does not read the mode switch. */
  readonly modeEnabled: () => boolean;
  /** The store the crash-loop guard counts in. */
  readonly connection: SqliteConnection;
  readonly releaseQueue: (threadId: string) => Promise<void>;
}

/** Continues the Work turns this start settled as cut off (docs/architecture.md, Work restart recovery). */
export function continueWorkTurns(deps: WorkRestartContinuationDependencies) {
  const { cutOff, work } = deps;
  const byRequest = new Map(cutOff.map((cut) => [String(cut.requestId), cut] as const));
  return continueThreadTurnsCutOffByRestart({
    mode: "work",
    cutOff: cutOff.map((cut) => ({
      threadId: String(cut.threadId),
      turnId: String(cut.requestId),
    })),
    readiness: (turn) => {
      const cut = byRequest.get(turn.turnId);
      return cut === undefined
        ? { kind: "settled" }
        : work.restartContinuationReadiness(
            deps.readThread(decodeWorkThreadId(turn.threadId)),
            cut,
          );
    },
    enabled: deps.enabled,
    attempts: createCodeRestartContinuationAttempts(deps.connection),
    dispatch: async (turn, continuation, prompt) => {
      if (!deps.modeEnabled())
        return { kind: "refused", detail: "Work is turned off on this host." };
      const thread = deps.readThread(decodeWorkThreadId(turn.threadId));
      if (thread?.bindingRevisionId === undefined)
        return { kind: "refused", detail: "The thread has no bound project revision." };
      try {
        const result = await work.startFirstTurn(ROUTINE_HOST_SCOPE_ID, {
          kind: "start-work-thread-turn",
          requestId: decodeWorkTurnRequestId(continuation),
          turnId: decodeWorkTurnId(restartContinuationId(`turn:${continuation}`)),
          threadId: thread.id,
          prompt,
          authority: {
            hostId: LOCAL_HOST_ID,
            projectId: thread.projectId,
            bindingRevisionId: thread.bindingRevisionId,
            workingDirectory: thread.workingDirectory ?? ".",
            ...(thread.workingFolderId === undefined
              ? {}
              : { workingFolderId: thread.workingFolderId }),
            confinementPosture: "project-root-confined",
            providerInstanceId: thread.providerInstanceId,
            modelId: thread.modelId,
          },
        });
        return result.kind === "accepted"
          ? { kind: "dispatched" }
          : {
              kind: "refused",
              detail: "message" in result ? result.message : "The continuation was not admitted.",
            };
      } catch (error) {
        return {
          kind: "refused",
          detail:
            error instanceof WorkTurnServiceError
              ? error.failure.message
              : "The continuation could not start.",
        };
      }
    },
    releaseQueue: deps.releaseQueue,
  });
}

/** Continues the Code turns this start found cut off (docs/architecture.md, Code restart recovery). */
function continueCodeTurns(
  deps: ContinuationDependencies,
): Promise<HostRestartRecovery | undefined> {
  const {
    codeBoardEventStore,
    codeOperationRuntime,
    liftRestartRecovery,
    persistence,
    routeCodeService,
    threadMessageQueue,
  } = deps;
  if (persistence.codeTurnsCutOffByRestart.length === 0) return Promise.resolve(undefined);
  const refused = (detail: string) => ({ kind: "refused" as const, detail });
  return continueCodeTurnsCutOffByRestart({
    cutOff: persistence.codeTurnsCutOffByRestart,
    readThread: (threadId) => persistence.readCodeThread(threadId),
    runtimeWorks: (threadId) => persistence.readCodeRuntimeWorks(threadId),
    enabled: () => persistence.readCodeSettings()?.settings.restartContinuation !== false,
    attempts: createCodeRestartContinuationAttempts(persistence.connection),
    resumability: (thread, continuation, cutOffOperationId) =>
      codeRestartResumability(
        codeBoardEventStore.providerSessionForThread(thread.id, continuation),
        thread,
        cutOffOperationId,
      ),
    // What a window's first read does: the restart left every checkout
    // waiting until someone looks at it again.
    recoverCheckouts: async () => {
      await routeCodeService.bootstrap(ROUTINE_HOST_SCOPE_ID);
    },
    liftHarnessRecovery: (threadId) => liftRestartRecovery(String(threadId)),
    settleCutOffTurns: (threadId) => codeOperationRuntime?.settleCutOffTurns?.(String(threadId)),
    dispatch: async (thread, continuation, prompt) => {
      if (
        routeCodeService.stageEvidence === undefined ||
        routeCodeService.executeOperation === undefined
      )
        return refused("Code turns are unavailable on this host.");
      try {
        const staged = await routeCodeService.stageEvidence(
          ROUTINE_HOST_SCOPE_ID,
          thread.id,
          prompt,
        );
        const result = await routeCodeService.executeOperation(ROUTINE_HOST_SCOPE_ID, {
          kind: "start-provider-turn",
          operationId: continuation,
          threadId: thread.id,
          checkoutId: thread.checkoutId,
          sessionId: decodeProviderSessionId(restartContinuationId(`session:${continuation}`)),
          prompt: staged,
        });
        return result.kind === "provider-turn-state" &&
          (result.state === "running" || result.state === "waiting" || result.state === "completed")
          ? { kind: "dispatched" as const }
          : refused(
              result.kind === "provider-turn-state" && result.failure !== undefined
                ? result.failure.message
                : "The continuation was not admitted.",
            );
      } catch (error) {
        return refused(
          error instanceof CodeServiceError
            ? error.failure.message
            : "The continuation could not start.",
        );
      }
    },
    releaseQueue: (threadId) =>
      releaseQueueBehindRestartContinuation(threadMessageQueue, {
        scopeId: ROUTINE_HOST_SCOPE_ID,
        threadId: String(threadId),
        mode: "code",
      }),
    clock: () => new Date().toISOString(),
  });
}
