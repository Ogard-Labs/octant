import { createHash } from "node:crypto";
import {
  decodeChatThreadId,
  decodeCodeOperationCommand,
  decodeCodeOperationEventFrame,
  decodeCodeThreadId,
  decodeWorkThreadId,
  type CodeThread,
  type OctantMode,
  type ProjectId,
  type ThreadMessageQueueScope,
  type WindowId,
  type WorkThread,
  type WorkThreadId,
  type WorkTurnLookupResult,
  type WorkTurnState,
} from "@octant/contracts";
import { activeChatTurns } from "@octant/domain";
import type { ChatService, ChatServiceExecutionContext } from "../chat/chatService";
import type { CodeRouteService } from "../codeRoutes";
import type { Journal } from "../persistence/journal";
import type { PersistenceService } from "../persistence/persistenceService";
import { queueHoldReason } from "./threadMessageQueuePort";
import type {
  ThreadMessageQueueInspection,
  ThreadMessageQueueInspectionInput,
  ThreadMessageQueueModePort,
  ThreadMessageQueueResource,
  ThreadMessageQueueTail,
} from "./threadMessageQueuePort";

export interface ThreadMessageQueuePortDependencies {
  readonly persistence: Pick<
    PersistenceService,
    | "readChatThread"
    | "readChatThreadView"
    | "readCodeThread"
    | "readCodeRuntimeWorks"
    | "readCodeCheckout"
    | "readProject"
    | "readProviderInstance"
  >;
  readonly journal: Pick<Journal, "replayAggregate">;
  readonly chat: {
    readonly read: ChatService["read"];
    readonly execute: (command: unknown, context?: ChatServiceExecutionContext) => Promise<unknown>;
  };
  readonly work: {
    readonly readThread: (id: WorkThreadId) => WorkThread | undefined;
    readonly listTurns: (id: WorkThreadId) => ReadonlyArray<WorkTurnState>;
    readonly startFirstTurn: (
      windowId: WindowId,
      command: unknown,
      options?: { readonly admissionCurrent?: () => boolean },
    ) => Promise<WorkTurnLookupResult>;
  };
  readonly code: Pick<CodeRouteService, "stageEvidence" | "executeOperation">;
  readonly isModeEnabled: (mode: OctantMode) => boolean;
  readonly isWindowLive: (windowId: WindowId) => boolean;
  readonly canAccess: (
    windowId: WindowId,
    mode: OctantMode,
    projectId: ProjectId | undefined,
  ) => boolean;
  readonly effectiveCodeThread?: (windowId: WindowId, thread: CodeThread) => CodeThread;
  readonly attachments: Pick<ThreadMessageQueueModePort, "retain" | "commit" | "release"> & {
    readonly prepare: (input: ThreadMessageQueueResource) => Promise<boolean>;
  };
}

function tailStatus(status: string): ThreadMessageQueueTail["status"] {
  if (status === "completed") return "completed";
  if (status === "cancelled") return "cancelled";
  if (status === "failed" || status === "interrupted" || status === "ambiguous") return "failed";
  return "active";
}

function readFacts(
  deps: ThreadMessageQueuePortDependencies,
  scope: ThreadMessageQueueScope,
  windowId: WindowId,
) {
  if (scope.mode === "chat") {
    const id = decodeChatThreadId(scope.threadId);
    const thread = deps.persistence.readChatThread(id);
    if (thread === undefined) return undefined;
    const turn = activeChatTurns(deps.persistence.readChatThreadView(id)?.turns ?? []).at(-1);
    const attempt = turn?.attempts.at(-1);
    return {
      thread,
      binding: {
        providerInstanceId: thread.providerInstanceId,
        modelId: thread.modelId,
        modelOptionValues: thread.modelOptionValues,
        projectId: thread.projectId,
        researchEnabled: thread.researchEnabled,
        researchRouting: thread.researchRouting,
        personalityInstructions: thread.personalityInstructions,
        multiModelPool: thread.multiModelPool,
      },
      ...(attempt === undefined
        ? {}
        : { tail: { id: String(attempt.id), status: tailStatus(attempt.outcome) } }),
    };
  }
  if (scope.mode === "work") {
    const id = decodeWorkThreadId(scope.threadId);
    const thread = deps.work.readThread(id);
    if (thread === undefined) return undefined;
    const turn = deps.work.listTurns(id).at(-1);
    return {
      thread,
      binding: {
        providerInstanceId: thread.providerInstanceId,
        modelId: thread.modelId,
        modelOptionValues: thread.modelOptionValues,
        projectId: thread.projectId,
        bindingRevisionId: thread.bindingRevisionId,
        workingDirectory: thread.workingDirectory,
        access: thread.access,
      },
      ...(turn === undefined
        ? {}
        : { tail: { id: String(turn.turnId), status: tailStatus(turn.status) } }),
    };
  }
  const id = decodeCodeThreadId(scope.threadId);
  const stored = deps.persistence.readCodeThread(id);
  if (stored === undefined) return undefined;
  const thread = deps.effectiveCodeThread?.(windowId, stored) ?? stored;
  const latest = deps.persistence
    .readCodeRuntimeWorks(id)
    .filter(({ work }) => work.kind === "provider-turn")
    .at(-1)?.work;
  const checkout = deps.persistence.readCodeCheckout(thread.checkoutId);
  return {
    thread,
    binding: {
      providerInstanceId: thread.providerInstanceId,
      modelId: thread.modelId,
      modelOptionValues: thread.modelOptionValues,
      projectId: thread.projectId,
      bindingRevisionId: thread.bindingRevisionId,
      checkoutId: thread.checkoutId,
      executionPolicy: thread.executionPolicy,
      permissionPersistence: thread.permissionPersistence,
      checkoutKind: checkout?.kind,
      ownershipReceiptId:
        checkout?.kind === "managed-worktree" ? checkout.ownershipReceiptId : undefined,
    },
    ...(latest === undefined
      ? {}
      : { tail: { id: String(latest.id), status: tailStatus(latest.state) } }),
    checkoutAvailable: checkout?.availability === "available",
  };
}

export function createThreadMessageQueuePort(
  deps: ThreadMessageQueuePortDependencies,
): ThreadMessageQueueModePort {
  const inspect = (input: ThreadMessageQueueInspectionInput): ThreadMessageQueueInspection => {
    if (!deps.isWindowLive(input.windowId)) return { status: "held", reason: "authority-revoked" };
    if (!deps.isModeEnabled(input.scope.mode))
      return { status: "held", reason: "thread-unavailable" };
    const facts = readFacts(deps, input.scope, input.windowId);
    if (facts === undefined) return { status: "held", reason: "not-found" };
    if (!deps.canAccess(input.windowId, input.scope.mode, facts.thread.projectId))
      return { status: "held", reason: "unauthorized" };
    const project =
      facts.thread.projectId === undefined
        ? undefined
        : deps.persistence.readProject(facts.thread.projectId);
    const readOnly =
      input.intent === "read" || input.intent === "pause" || input.intent === "remove";
    if (
      !readOnly &&
      (facts.thread.lifecycle !== "active" ||
        facts.thread.completedAt !== undefined ||
        (facts.thread.projectId !== undefined && project?.lifecycle !== "active") ||
        ("checkoutAvailable" in facts && !facts.checkoutAvailable))
    )
      return { status: "held", reason: "thread-unavailable" };
    const provider = deps.persistence.readProviderInstance(facts.thread.providerInstanceId);
    const binding = createHash("sha256")
      .update(
        JSON.stringify({
          ...facts.binding,
          provider:
            provider === undefined
              ? undefined
              : {
                  id: provider.id,
                  driverKind: provider.driverKind,
                  configuration: provider.configuration,
                  enabled: provider.enabled,
                  environmentPolicy: provider.environmentPolicy,
                  dataTags: provider.dataTags,
                },
          providerPolicy:
            project !== undefined && "providerPolicy" in project
              ? project.providerPolicy
              : undefined,
        }),
      )
      .digest("hex");
    return {
      status: facts.tail?.status === "active" ? "busy" : "ready",
      binding,
      ...(facts.tail === undefined ? {} : { tail: facts.tail }),
    };
  };

  const reconcile: ThreadMessageQueueModePort["reconcile"] = async ({
    scope,
    messageId,
    codeOperationId,
  }) => {
    if (scope.mode === "chat") {
      const view = deps.persistence.readChatThreadView(decodeChatThreadId(scope.threadId));
      if (view === undefined) return { status: "unknown" };
      const turn = view.turns.find(
        (candidate) => String(candidate.submissionId) === String(messageId),
      );
      if (turn === undefined) return { status: "not-admitted" };
      const status = tailStatus(turn.attempts.at(-1)?.outcome ?? "queued");
      return { status: status === "active" ? "accepted" : status };
    }
    if (scope.mode === "work") {
      const id = decodeWorkThreadId(scope.threadId);
      if (deps.work.readThread(id) === undefined) return { status: "unknown" };
      const turn = deps.work
        .listTurns(id)
        .find((candidate) => String(candidate.requestId) === String(messageId));
      if (turn === undefined) return { status: "not-admitted" };
      const status = tailStatus(turn.status);
      return { status: status === "active" ? "accepted" : status };
    }
    const id = decodeCodeThreadId(scope.threadId);
    const operationId = codeOperationId ?? messageId;
    if (deps.persistence.readCodeThread(id) === undefined) return { status: "unknown" };
    const frames = deps.journal
      .replayAggregate({
        aggregateType: "code-operation",
        aggregateId: String(operationId),
        afterVersion: 0,
        limit: 256,
      })
      .map((event) => decodeCodeOperationEventFrame(event.payload));
    if (frames.some((frame) => String(frame.threadId) !== String(scope.threadId)))
      return { status: "unknown" };
    const result = frames.findLast((frame) => frame.event.kind === "operation-result")?.event;
    if (
      result?.kind === "operation-result" &&
      (result.result.kind === "operation-failed" || result.result.kind === "provider-turn-state") &&
      result.result.admission === "refused"
    )
      return { status: "not-admitted" };
    if (!frames.some((frame) => frame.event.kind === "conversation-turn-started")) {
      return {
        status:
          frames.length === 0 ||
          (result?.kind === "operation-result" && result.result.kind === "operation-failed")
            ? "not-admitted"
            : "unknown",
      };
    }
    const work = deps.persistence
      .readCodeRuntimeWorks(id)
      .find(({ work }) => String(work.id) === String(operationId))?.work;
    if (work !== undefined) {
      const status = tailStatus(work.state);
      return { status: status === "active" ? "accepted" : status };
    }
    if (result?.kind === "operation-result") {
      if (result.result.kind === "operation-failed") return { status: "failed" };
      if (result.result.kind === "provider-turn-state") {
        const status = tailStatus(result.result.state);
        if (status !== "active") return { status };
      }
    }
    return { status: "unknown" };
  };

  return {
    inspect: async (input) => inspect(input),
    reconcile,
    retain: deps.attachments.retain,
    commit: deps.attachments.commit,
    release: deps.attachments.release,
    admit: async (input) => {
      const inspection = await inspect({
        scope: input.scope,
        windowId: input.windowId,
        intent: "dispatch",
      });
      if (inspection.status === "held")
        return { status: "refused", reason: queueHoldReason(inspection.reason) };
      if (inspection.binding !== input.binding)
        return { status: "refused", reason: "binding-changed" };
      if (inspection.status === "busy" || input.signal.aborted)
        return { status: "refused", reason: "admission-refused" };
      if (input.scope.mode !== input.payload.mode)
        return { status: "refused", reason: "admission-refused" };
      if (!(await deps.attachments.prepare(input)))
        return { status: "refused", reason: "content-unavailable" };
      // Restoring attachment metadata can await disk reads. Recheck authority
      // after those reads rather than treating enqueue as a lasting grant.
      const current = await inspect({
        scope: input.scope,
        windowId: input.windowId,
        intent: "dispatch",
      });
      if (current.status === "held")
        return { status: "refused", reason: queueHoldReason(current.reason) };
      if (input.signal.aborted) return { status: "refused", reason: "authority-revoked" };
      if (current.binding !== input.binding)
        return { status: "refused", reason: "binding-changed" };
      if (current.status === "busy") return { status: "refused", reason: "admission-refused" };
      const admissionCurrent = (): boolean => {
        if (input.signal.aborted) return false;
        const latest = inspect({
          scope: input.scope,
          windowId: input.windowId,
          intent: "dispatch",
        });
        if (latest.status === "held" || latest.binding !== input.binding) return false;
        const ownTail =
          input.scope.mode === "chat"
            ? deps.persistence
                .readChatThreadView(decodeChatThreadId(input.scope.threadId))
                ?.turns.find((turn) => String(turn.submissionId) === String(input.messageId))
                ?.attempts.at(-1)?.id
            : input.scope.mode === "code"
              ? (input.codeOperationId ?? input.messageId)
              : input.messageId;
        if (latest.tail !== undefined && String(latest.tail.id) === String(ownTail))
          return latest.tail.status === "active";
        return latest.tail?.id === current.tail?.id && latest.tail?.status === current.tail?.status;
      };
      try {
        const { mode: _mode, ...message } = input.payload;
        if (input.scope.mode === "chat") {
          const { thread } = deps.chat.read(decodeChatThreadId(input.scope.threadId));
          return await new Promise((resolve) => {
            deps.chat
              .execute(
                {
                  kind: "send-chat-turn",
                  threadId: thread.id,
                  expectedVersion: thread.version,
                  submissionId: input.messageId,
                  ...message,
                },
                {
                  windowId: input.windowId,
                  admissionCurrent,
                  onTurnAccepted: () => resolve({ status: "accepted" }),
                },
              )
              .then(
                async () => {
                  try {
                    const state = await reconcile(input);
                    resolve(
                      state.status === "not-admitted"
                        ? { status: "refused", reason: "admission-refused" }
                        : state.status === "unknown"
                          ? { status: "unknown" }
                          : { status: "accepted" },
                    );
                  } catch {
                    resolve({ status: "unknown" });
                  }
                },
                () => resolve({ status: "unknown" }),
              );
          });
        }
        if (input.scope.mode === "work") {
          const thread = deps.work.readThread(decodeWorkThreadId(input.scope.threadId));
          if (thread?.bindingRevisionId === undefined)
            return { status: "refused", reason: "thread-unavailable" };
          const result = await deps.work.startFirstTurn(
            input.windowId,
            {
              kind: "start-work-thread-turn",
              requestId: input.messageId,
              turnId: input.messageId,
              threadId: thread.id,
              ...message,
              authority: {
                hostId: "local",
                projectId: thread.projectId,
                bindingRevisionId: thread.bindingRevisionId,
                workingDirectory: thread.workingDirectory ?? ".",
                confinementPosture: "project-root-confined",
                providerInstanceId: thread.providerInstanceId,
                modelId: thread.modelId,
              },
            },
            { admissionCurrent },
          );
          return result.kind === "accepted"
            ? { status: "accepted" }
            : { status: "refused", reason: "admission-refused" };
        }
        const thread = deps.persistence.readCodeThread(decodeCodeThreadId(input.scope.threadId));
        if (
          thread === undefined ||
          deps.code.stageEvidence === undefined ||
          deps.code.executeOperation === undefined
        )
          return { status: "refused", reason: "thread-unavailable" };
        const prompt = await deps.code.stageEvidence(input.windowId, thread.id, message.prompt);
        const finalInspection = await inspect({
          scope: input.scope,
          windowId: input.windowId,
          intent: "dispatch",
        });
        if (finalInspection.status === "held")
          return { status: "refused", reason: queueHoldReason(finalInspection.reason) };
        if (input.signal.aborted) return { status: "refused", reason: "authority-revoked" };
        if (finalInspection.binding !== input.binding)
          return { status: "refused", reason: "binding-changed" };
        if (finalInspection.status === "busy")
          return { status: "refused", reason: "admission-refused" };
        const result = await deps.code.executeOperation(
          input.windowId,
          decodeCodeOperationCommand({
            ...message,
            kind: "start-provider-turn",
            operationId: input.codeOperationId ?? input.messageId,
            sessionId: input.codeOperationId ?? input.messageId,
            threadId: thread.id,
            checkoutId: thread.checkoutId,
            prompt,
          }),
          { admissionCurrent },
        );
        if (
          (result.kind === "provider-turn-state" || result.kind === "operation-failed") &&
          result.admission === "refused"
        )
          return {
            status: "refused",
            reason:
              result.failure?.category === "unauthorized"
                ? "authority-revoked"
                : "admission-refused",
          };
        return result.kind === "provider-turn-state"
          ? { status: "accepted" }
          : { status: "refused", reason: "admission-refused" };
      } catch {
        return { status: "unknown" };
      }
    },
  };
}
