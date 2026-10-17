import { randomUUID } from "node:crypto";
import { decodeContextSubjectRef, USAGE_RESUME_SETTLED } from "@octant/contracts";
import { Effect } from "effect";
import { createChatAgentResultDeliveryPort } from "../chat/chatAgentResultDeliveryPort";
import { UsageResumeService } from "../usage/usageResumeService";
import { createUsageResumePorts } from "../usage/usageResumePorts";
import { AgentRunDependencyScheduler } from "../agentRun/agentRunDependencyScheduler";
import { AgentRunProviderSlotScheduler } from "../agentRun/agentRunProviderSlotScheduler";
import { AgentResultDeliveryService } from "../agentRun/agentResultDeliveryService";
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
  Pick<CodeRuntimeWiring, "routeCodeService"> &
  Pick<ChatWiring, "chatService"> &
  Pick<WorkWiring, "workTurnService"> &
  Pick<FoundationsWiring, "workThreadProjection" | "workTurnProjection">;

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
      recordResultIngestion: (run) => {
        try {
          return (
            externalContentIngestionStore.record({
              threadId: String(run.parentThreadId),
              provenance: { origin: "tool-result", sourceLabel: "subagent-result" },
              contentReference: `agent-run-result-${String(run.id)}-${run.generation ?? 1}`,
              correlationId: randomUUID(),
              authorized: true,
            }).kind !== "refused"
          );
        } catch {
          return false;
        }
      },
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
  });
}
