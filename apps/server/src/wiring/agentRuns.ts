import { observedChildren } from "../agentRun/agentObservedChildren";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type AgentRun,
  type AgentRunParentThreadId,
  type ChatThreadView,
  type CodeThreadId,
  decodeAgentRunId,
  decodeChatThreadId,
  decodeCodeThreadId,
  decodeMultiModelRoutingVendorId,
  decodeNativeHarnessTurnId,
  decodeProjectId,
  decodeWorkThreadId,
  effectiveAgentRunConcurrency,
  LOCAL_HOST_ID,
  MAX_AGENT_RUN_ADMITTED_CONTEXT_BLOCKS,
  MAX_AGENT_RUN_ADMITTED_CONTEXT_CHARACTERS,
  type MultiModelPoolCandidate,
  NATIVE_HARNESS_BUILT_IN_SLOTS,
  type OctantMode,
  type ProjectId,
  type ProviderContextBlock,
  type UtcTimestamp,
  type WindowId,
} from "@octant/contracts";
import {
  authorizeAgentRunCreation,
  layoutContainsAgentRunThread,
} from "../agentRun/authorizeAgentRunCreation";
import { ChatService } from "../chat/chatService";
import { WorkThreadProjection } from "../work/workThreadProjection";
import { awaitsLeadApproval } from "../harness/leadApprovalAttention";
import { ManagedWorktreeReceiptStore } from "../code/managedWorktreeReceiptStore";
import {
  makeProviderCapacityScheduler,
  makeUnobservedProviderCapacityFacts,
} from "../context/contextRuntime";
import { createAgentRunReviewCapture } from "../agentRun/agentRunReviewCapture";
import type { PersistenceService } from "../persistence/persistenceService";
import { readAgentRunAdmittedContext } from "../persistence/agentRunContentStore";
import {
  AgentRunOrchestrationService,
  createInMemoryCapacityPort,
} from "../agentRun/agentRunOrchestrationService";
import {
  type AgentRunRouteDependencies,
  createAgentRunRouteHandler,
} from "../agentRun/agentRunRoutes";
import type { AgentRunControlAdmissionDependencies } from "../agentRun/agentRunControlAdmission";
import { admittedParentWorkContext } from "../agentRun/agentRunParentContext";
import { createAgentsManagedTools } from "../agentRun/agentRunManagedTools";
import { agentRunEligibleTargets as eligibleAgentRunTargets } from "../agentRun/agentRunDelegation";
import {
  createAgentRunChildWorktreePort,
  resolveAgentRunChildWorktreeThreadId,
  resolveAgentRunCodeWorkspaceContext,
} from "../agentRun/agentRunChildWorktreePort";
import { AgentRunWorkspaceReceiptStore } from "../agentRun/agentRunWorkspaceReceiptStore";
import { AgentRunWorkspaceService } from "../agentRun/agentRunWorkspaceService";
import { AgentRunSettingsStore } from "../agentRun/agentRunSettingsStore";
import { createAgentRunSettingsRouteHandler } from "../agentRun/agentRunSettingsRoutes";
import {
  createAgentRunSessionRuntime,
  createRecordedAgentRunContextSnapshotPort,
} from "../agentRun/agentRunSessionRuntime";
import { AgentRunSessionSupervisor } from "../agentRun/agentRunSessionSupervisor";
import { recordAgentRunTurnUsage } from "../agentRun/agentRunUsageLedger";
import { AgentRunSessionStore } from "../agentRun/agentRunSessionStore";
import { createAgentRunClaudeResumeIdentityPort } from "../agentRun/agentRunClaudeResumeIdentity";
import { AgentRunLiveConversationStore } from "../agentRun/agentRunLiveConversationStore";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { toTurnMetricsRecord, type TurnEndSummary } from "../metrics/turnEnd";
import { TurnMetricsStore } from "../metrics/turnMetricsStore";
import { SpendCeilingService } from "../spendCeilingService";
import { ExternalContentIngestionStore } from "../context/externalContentIngestionStore";
import { RuntimeOutsideContentMarks } from "../context/runtimeOutsideContentMark";
import { readThreadExternalContentTaint } from "../context/externalContentTaintProjection";
import { NativeHarnessRouter } from "../harness/nativeHarnessRouter";
import { NativeHarnessRoutingStore } from "../harness/nativeHarnessRoutingStore";
import { FOLLOW_UP_SUGGESTION_INSTRUCTIONS } from "../followUps/followUpSuggestionInstructions";
import { turnDecisionInstructions } from "../turnDecisions/turnDecisionInstructions";
import { parseFollowUpSuggestions } from "../followUps/followUpSuggestionParsing";
import { ThreadFollowUpSuggestionStore } from "../followUps/threadFollowUpSuggestionStore";
import { SideTaskStore } from "../sideTasks/sideTaskStore";
import { effectiveAgentRunExecutionTarget } from "@octant/domain/agent-run-policy";
import { NativeHarnessTurnObserver } from "../harness/nativeHarnessTurnObserver";
import type { MultiModelCandidateRuntimeFacts } from "@octant/domain/multi-model-pool-policy";
import { activeChatTurns, chatTurnAnsweredAttempt } from "@octant/domain";
import { createChildCanvasAgentTools } from "../canvas/canvasAgentTools";
import { loadChildCanvasWorkspace } from "../canvas/childCanvasWorkspace";
import { type AppManagedToolSet, combineAppManagedToolSets } from "../providers/appManagedToolSet";
import { type ConfiguredProviderDriverOptions, makeConfiguredProviderDriver } from "./providers";
import type { ServerStart } from "./serverShape";
import type { LateBindings } from "./lateBindings";
import type { AuthorityWiring } from "./authority";
import type { FoundationsWiring } from "./foundations";
import type { HarnessStateWiring } from "./harnessState";

function authorizeAgentRunCancellation(input: {
  readonly persistence: PersistenceService;
  readonly workThreadProjection: WorkThreadProjection;
  readonly run: AgentRun;
  readonly windowId: string;
}): boolean {
  const workspace = input.persistence.readWindowWorkspace(input.windowId as WindowId)?.workspace;
  if (workspace === undefined) return false;
  const mode = input.run.routingReceipt.mode;
  const context = workspace.contextByMode[mode];
  if (
    context.mode !== mode ||
    String(context.host) !== String(input.run.routingReceipt.hostId) ||
    input.run.workspaceReceipt.mode !== mode
  ) {
    return false;
  }

  let threadProjectId: string | null | undefined;
  try {
    if (mode === "chat") {
      const thread = input.persistence.readChatThread(
        decodeChatThreadId(String(input.run.parentThreadId)),
      );
      if (thread === undefined) return false;
      threadProjectId = thread.projectId;
    } else if (mode === "work") {
      const thread = input.workThreadProjection.read(input.run.parentThreadId as never);
      if (thread === undefined) return false;
      threadProjectId = thread.projectId;
    } else {
      const thread = input.persistence.readCodeThread(
        decodeCodeThreadId(String(input.run.parentThreadId)),
      );
      if (thread === undefined) return false;
      threadProjectId = thread.projectId;
    }
  } catch {
    return false;
  }
  if (String(context.projectId) !== String(threadProjectId ?? null)) return false;
  if (
    input.run.routingReceipt.projectId !== undefined &&
    String(input.run.routingReceipt.projectId) !== String(threadProjectId)
  ) {
    return false;
  }
  if (
    input.run.workspaceReceipt.kind !== "chat-virtual" &&
    String(input.run.workspaceReceipt.projectId) !== String(threadProjectId)
  ) {
    return false;
  }
  return layoutContainsAgentRunThread(
    workspace.layouts[mode],
    String(input.run.parentThreadId),
    String(input.run.routingReceipt.hostId),
  );
}

/**
 * Authorizes a window to read a parent thread's AgentRuns (the parent summary,
 * which carries each completed child's reply, and result acknowledgements).
 *
 * Same shape as the cancellation check above, but resolved from a bare parent
 * thread id: the thread is looked up in this host's own stores across all
 * three modes — the parent-summary route serves Chat, Work, and Code — and
 * the window's own workspace must currently contain that thread on the
 * matching Project. Nothing the caller supplied is trusted as scope.
 */
export function authorizeAgentRunParentThread(input: {
  readonly persistence: PersistenceService;
  readonly workThreadProjection: WorkThreadProjection;
  readonly parentThreadId: AgentRunParentThreadId;
  readonly windowId: string;
}): boolean {
  const workspace = input.persistence.readWindowWorkspace(input.windowId as WindowId)?.workspace;
  if (workspace === undefined) return false;
  const threadId = String(input.parentThreadId);
  if (
    input.persistence.connection
      .prepare("SELECT 1 FROM thread_purge_tombstone WHERE thread_id = ?")
      .get(threadId) !== undefined
  )
    return false;

  const chatContext = workspace.contextByMode.chat;
  let chatThread;
  try {
    chatThread = input.persistence.readChatThread(decodeChatThreadId(threadId));
  } catch {
    chatThread = undefined;
  }
  if (
    chatThread !== undefined &&
    chatContext.mode === "chat" &&
    String(chatContext.projectId) === String(chatThread.projectId ?? null) &&
    layoutContainsAgentRunThread(workspace.layouts.chat, threadId, String(chatContext.host))
  ) {
    return true;
  }

  const workContext = workspace.contextByMode.work;
  let workThread;
  try {
    workThread = input.workThreadProjection.read(threadId as never);
  } catch {
    workThread = undefined;
  }
  if (
    workThread !== undefined &&
    workContext.mode === "work" &&
    String(workContext.projectId) === String(workThread.projectId) &&
    layoutContainsAgentRunThread(workspace.layouts.work, threadId, String(workContext.host))
  ) {
    return true;
  }

  const codeContext = workspace.contextByMode.code;
  let codeThread;
  try {
    codeThread = input.persistence.readCodeThread(decodeCodeThreadId(threadId));
  } catch {
    codeThread = undefined;
  }
  return (
    codeThread !== undefined &&
    codeContext.mode === "code" &&
    String(codeContext.projectId) === String(codeThread.projectId) &&
    layoutContainsAgentRunThread(workspace.layouts.code, threadId, String(codeContext.host))
  );
}

function resolveAgentRunCenterContext(input: {
  readonly persistence: PersistenceService;
  readonly workThreadProjection: WorkThreadProjection;
  readonly parentThreadId: AgentRunParentThreadId;
  readonly mode: OctantMode;
  readonly requestId: AgentRun["requestId"];
  readonly workspaceReceipt: AgentRun["workspaceReceipt"];
}): { readonly parentThreadTitle: string; readonly childThreadId?: CodeThreadId } {
  const threadId = String(input.parentThreadId);
  const title = resolveAgentRunParentThreadTitle(input);
  const thread =
    input.mode === "code"
      ? input.persistence.readCodeThread(decodeCodeThreadId(threadId))
      : undefined;
  const childThreadId =
    thread !== undefined &&
    input.workspaceReceipt.kind === "code-worktree" &&
    String(thread.projectId) === String(input.workspaceReceipt.projectId)
      ? resolveAgentRunChildWorktreeThreadId({
          parentThreadId: threadId,
          requestId: String(input.requestId),
          repositoryId: String(thread.repositoryId),
          workspace: input.workspaceReceipt,
        })
      : undefined;
  return {
    parentThreadTitle: title ?? "Thread",
    ...(childThreadId === undefined ? {} : { childThreadId }),
  };
}

/**
 * A thread's title and Project as its own record holds them now. A harness
 * session keeps the Project it started under, which a moved Chat thread has
 * left, so anything that names the thread's Project reads it here.
 */
export function resolveHarnessThreadFacts(input: {
  readonly persistence: PersistenceService;
  readonly workThreadProjection: WorkThreadProjection;
  readonly threadId: string;
  readonly mode: OctantMode;
}): { readonly title: string; readonly projectId?: ProjectId } | undefined {
  try {
    const thread =
      input.mode === "chat"
        ? input.persistence.readChatThread(decodeChatThreadId(input.threadId))
        : input.mode === "work"
          ? input.workThreadProjection.read(decodeWorkThreadId(input.threadId))
          : input.persistence.readCodeThread(decodeCodeThreadId(input.threadId));
    if (thread === undefined) return undefined;
    return {
      title: thread.title,
      ...(thread.projectId === undefined ? {} : { projectId: thread.projectId }),
    };
  } catch {
    // Not a thread id of this mode.
    return undefined;
  }
}

export function resolveAgentRunParentThreadTitle(input: {
  readonly persistence: PersistenceService;
  readonly workThreadProjection: WorkThreadProjection;
  readonly parentThreadId: AgentRunParentThreadId;
  readonly mode: OctantMode;
}): string | undefined {
  const threadId = String(input.parentThreadId);
  if (input.mode === "chat") {
    try {
      return input.persistence.readChatThread(decodeChatThreadId(threadId))?.title;
    } catch {
      return undefined;
    }
  }
  if (input.mode === "work") {
    try {
      return input.workThreadProjection.read(threadId as never)?.title;
    } catch {
      return undefined;
    }
  }
  try {
    return input.persistence.readCodeThread(decodeCodeThreadId(threadId))?.title;
  } catch {
    return undefined;
  }
}

/**
 * The bounded parent-thread selection a Chat child is admitted with.
 *
 * Superseded turns stay journaled but are no longer part of the conversation
 * the parent is having, so the selection is folded with `activeChatTurns`: an
 * abandoned branch must never ride along beside its replacement. For the same
 * reason only a `completed` attempt contributes an answer, because an attempt
 * that failed, was interrupted or cancelled, or has not finished arriving left
 * text the parent never accepted. The window is the most recent exchanges,
 * bounded by the contract, because a child is given the question it was created
 * from, not the parent's whole history.
 */
export function admittedParentChatContext(
  view: ChatThreadView,
): ReadonlyArray<ProviderContextBlock> {
  const bodies = new Map(view.contents.map((content) => [String(content.contentId), content.body]));
  const blocks: ProviderContextBlock[] = [];
  const admit = (kind: "user-message" | "assistant-message", body: string | undefined) => {
    const text = (body ?? "").trim().slice(0, MAX_AGENT_RUN_ADMITTED_CONTEXT_CHARACTERS).trim();
    if (text.length === 0) return;
    blocks.push({ kind, text });
  };
  for (const turn of activeChatTurns(view.turns)) {
    admit("user-message", bodies.get(String(turn.userMessageRef.contentId)));
    // Admitted before the block budget is spent, not after: an abandoned
    // fragment that reached `blocks` would occupy a slot the cap below then
    // charged for, pushing one of the parent's real exchanges out of the
    // window. A child briefed with a partial reply answers from text the
    // parent never accepted, and after a retry it would see the abandoned
    // fragment and the answer side by side with nothing to tell them apart.
    // No block kind can mark text as partial, so an unfinished attempt
    // contributes nothing, and a regeneration's replaced answer contributes
    // nothing the same way; the turn's prompt is still admitted above.
    const attempt = chatTurnAnsweredAttempt(turn);
    if (attempt === undefined) continue;
    for (const reference of attempt.responseRefs) {
      admit("assistant-message", bodies.get(String(reference.contentId)));
    }
  }
  return blocks.slice(-MAX_AGENT_RUN_ADMITTED_CONTEXT_BLOCKS);
}

export function createAgentRunControlWorkspace(
  workspace: AgentRunWorkspaceService,
  resolveParentCheckout: (threadId: string) => ReturnType<typeof resolveAgentRunParentCheckout>,
  resolvePrepareCode: (
    parent: Parameters<typeof resolveAgentRunPrepareCode>[2],
  ) => ReturnType<typeof resolveAgentRunPrepareCode>,
): NonNullable<AgentRunControlAdmissionDependencies["workspace"]> {
  return {
    prepare: async ({ requestId, windowId, parent, code }) =>
      workspace.prepare({
        requestId,
        windowId,
        parent:
          parent.mode === "code"
            ? {
                ...parent,
                ...(await resolveParentCheckout(parent.threadId)),
              }
            : parent,
        ...(code === undefined ? await resolvePrepareCode(parent) : { code: code }),
      }),
    confirm: async ({ requestId, windowId, parent, worktreeReceiptId }) =>
      workspace.confirm({
        requestId,
        windowId,
        worktreeReceiptId,
        parent:
          parent.mode === "code"
            ? { ...parent, ...(await resolveParentCheckout(parent.threadId)) }
            : parent,
      }),
    admit: async ({ requestId, windowId, requested, role, parent }) =>
      workspace.admit({
        requestId,
        windowId,
        requested,
        role,
        parent:
          parent.mode === "code"
            ? {
                ...parent,
                ...(await resolveParentCheckout(parent.threadId)),
              }
            : parent,
      }),
  };
}

async function resolveAgentRunParentCheckout(
  persistence: PersistenceService,
  receipts: ManagedWorktreeReceiptStore,
  parentThreadId: string,
): Promise<{ readonly checkoutRoot: string } | Record<string, never>> {
  try {
    const thread = persistence.readCodeThread(decodeCodeThreadId(parentThreadId));
    const project = thread === undefined ? undefined : persistence.readProject(thread.projectId);
    if (thread === undefined || project?.type !== "code") return {};
    const checkout = persistence.readCodeCheckout(thread.checkoutId);
    const context = await resolveAgentRunCodeWorkspaceContext({
      thread: {
        projectId: String(thread.projectId),
        bindingRevisionId: String(thread.bindingRevisionId),
        repositoryId: String(thread.repositoryId),
        checkoutId: String(thread.checkoutId),
      },
      repositoryRoot: project.binding.canonicalRoot,
      checkout,
      loadManagedReceipt: (receiptId) => receipts.load(receiptId),
    });
    return context === undefined ? {} : { checkoutRoot: context.parentCheckoutRoot };
  } catch {
    return {};
  }
}

async function resolveAgentRunPrepareCode(
  persistence: PersistenceService,
  receipts: ManagedWorktreeReceiptStore,
  parent: { readonly mode: string; readonly threadId: string },
): Promise<
  | { readonly code: NonNullable<Awaited<ReturnType<typeof resolveAgentRunCodeWorkspaceContext>>> }
  | Record<string, never>
> {
  if (parent.mode !== "code") return {};
  try {
    const thread = persistence.readCodeThread(decodeCodeThreadId(parent.threadId));
    const project = thread === undefined ? undefined : persistence.readProject(thread.projectId);
    if (thread === undefined || project?.type !== "code") return {};
    const checkout = persistence.readCodeCheckout(thread.checkoutId);
    const resolved = await resolveAgentRunCodeWorkspaceContext({
      thread: {
        projectId: String(thread.projectId),
        bindingRevisionId: String(thread.bindingRevisionId),
        repositoryId: String(thread.repositoryId),
        checkoutId: String(thread.checkoutId),
      },
      repositoryRoot: project.binding.canonicalRoot,
      checkout,
      loadManagedReceipt: (receiptId) => receipts.load(receiptId),
    });
    return resolved === undefined ? {} : { code: resolved };
  } catch {
    return {};
  }
}

export type AgentRunsDependencies = Pick<ServerStart, "options" | "persistence"> & {
  /** Cells settled by a later wiring call; read per use, never at construction. */
  readonly late: Pick<
    LateBindings,
    | "canvasAgentToolPort"
    | "nativeHarnessComposition"
    | "nativeHarnessLeadFallback"
    | "nativeHarnessObserver"
    | "snapshotCanvasImpl"
  >;
} & Pick<
    AuthorityWiring,
    | "agentRunPersistence"
    | "codeParentActiveTurn"
    | "codeSessionAuthority"
    | "onAgentRunExecutionAccepted"
    | "windowAuthorityStore"
  > &
  Pick<
    HarnessStateWiring,
    | "agentRunInteractions"
    | "nativeHarnessApprovals"
    | "nativeHarnessQuestions"
    | "nativeHarnessSessions"
  > &
  Pick<
    FoundationsWiring,
    | "codeBoardEventStore"
    | "isProjectPolicyTargetAllowed"
    | "providerRuntimeRegistry"
    | "selectCodeConversation"
    | "workThreadProjection"
    | "workTurnProjection"
  > & {
    /** Wired by wireChat; read only after startup. */
    readonly chatService: () => ChatService;
    /** Wired by wireProviders; read only after startup. */
    readonly configuredDriverOptions: () => ConfiguredProviderDriverOptions;
  };

export function wireAgentRuns(deps: AgentRunsDependencies) {
  const {
    late,
    agentRunInteractions,
    agentRunPersistence,
    chatService,
    codeBoardEventStore,
    codeParentActiveTurn,
    codeSessionAuthority,
    configuredDriverOptions,
    isProjectPolicyTargetAllowed,
    nativeHarnessApprovals,
    nativeHarnessQuestions,
    nativeHarnessSessions,
    onAgentRunExecutionAccepted,
    options,
    persistence,
    providerRuntimeRegistry,
    selectCodeConversation,
    windowAuthorityStore,
    workThreadProjection,
    workTurnProjection,
  } = deps;

  // The agent's own approval is the same wait a question is: the thread cannot
  // go on until a person decides, so every mode's sidebar, board, and Needs you
  // read treats it as parked on the person. Read per request, long after boot.
  const threadAwaitsHarnessApproval = (threadId: string): boolean =>
    awaitsLeadApproval(
      {
        approvals: nativeHarnessApprovals,
        sessions: nativeHarnessSessions,
      },
      threadId,
    );
  // Follow-up suggestions ride the same per-turn hooks as the harness, but
  // on every provider: any model can end a reply with the block, and the
  // chips it becomes are the thread's, not the harness session's.
  const threadFollowUpSuggestions = new ThreadFollowUpSuggestionStore({
    journal: persistence.journal,
    uuid: randomUUID,
    actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    clock: () => new Date().toISOString(),
  });
  // Every turn on every provider, so its usage and speed outlive the host.
  const turnMetrics = new TurnMetricsStore({
    journal: persistence.journal,
    uuid: randomUUID,
    actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    clock: () => new Date().toISOString(),
  });
  const sideTasks = new SideTaskStore({
    journal: persistence.journal,
    uuid: randomUUID,
    actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    clock: () => new Date().toISOString(),
  });
  const nativeHarnessHooks = {
    answerQuestion: (threadId: string, questionId: string, answer: string) => {
      nativeHarnessQuestions.answer(threadId, questionId, answer);
    },
    contextFor: (scope: Parameters<NativeHarnessTurnObserver["contextFor"]>[0]) => [
      ...(late.nativeHarnessObserver.current?.contextFor(scope) ?? []),
      ...turnDecisionInstructions(scope.mode),
      FOLLOW_UP_SUGGESTION_INSTRUCTIONS,
    ],
    admitTurn: (scope: Parameters<NativeHarnessTurnObserver["admitTurn"]>[0]) =>
      late.nativeHarnessObserver.current?.admitTurn(scope) ?? { kind: "admitted" as const },
    turnStarted: (scope: Parameters<NativeHarnessTurnObserver["turnStarted"]>[0]) => {
      late.nativeHarnessObserver.current?.turnStarted(scope);
      late.nativeHarnessLeadFallback.current?.turnStarted(scope);
    },
    // The session view carries the retry notice the terminal footer and the
    // phone panel read; the transcript has its own copy from the turn stream.
    noteRetry: (
      scope: Parameters<NativeHarnessTurnObserver["noteRetry"]>[0],
      notice: Parameters<NativeHarnessTurnObserver["noteRetry"]>[1],
    ) => {
      late.nativeHarnessObserver.current?.noteRetry(scope, notice);
    },
    clearRetry: (scope: Parameters<NativeHarnessTurnObserver["clearRetry"]>[0]) => {
      late.nativeHarnessObserver.current?.clearRetry(scope);
    },
    turnEnded: (
      scope: Parameters<NativeHarnessTurnObserver["turnEnded"]>[0],
      turn?: TurnEndSummary,
    ) => {
      late.nativeHarnessObserver.current?.turnEnded(scope, turn);
      late.nativeHarnessLeadFallback.current?.turnEnded(scope);
      if (turn === undefined) return;
      try {
        turnMetrics.record(toTurnMetricsRecord(scope, turn));
      } catch {
        // A turn whose figures the journal refused still ended for the user.
      }
    },
    turnCompleted: async (input: Parameters<NativeHarnessTurnObserver["turnCompleted"]>[0]) => {
      try {
        threadFollowUpSuggestions.recordReply({
          threadId: input.threadId,
          mode: input.mode,
          projectId: input.projectId,
          suggestedBy: { providerInstanceId: input.providerInstanceId, modelId: input.modelId },
          followUps: parseFollowUpSuggestions({
            text: input.text,
            turnId: decodeNativeHarnessTurnId(randomUUID()),
            uuid: randomUUID,
          }),
        });
      } catch {
        // A set the journal refused leaves the reply itself untouched.
      }
      await late.nativeHarnessObserver.current?.turnCompleted(input);
    },
  };
  const agentRunSettingsStore = new AgentRunSettingsStore({
    journal: persistence.journal,
    uuid: randomUUID,
    actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    clock: () => new Date().toISOString(),
  });
  // Managed worktree receipts are required to admit Code children with a
  // verified isolated sandbox. Constructed early so AgentRun routes
  // can resolve receipt ids before the broader Code service graph starts.
  const managedWorktreeReceipts = new ManagedWorktreeReceiptStore({
    dataDirectory: persistence.dataDirectory,
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
  });
  const agentRunWorkspaceReceipts = new AgentRunWorkspaceReceiptStore({
    dataDirectory: persistence.dataDirectory,
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
  });
  const agentRunChildWorktree: {
    current: ReturnType<typeof createAgentRunChildWorktreePort> | undefined;
  } = {
    current: undefined,
  };
  const agentRunWorkspace = new AgentRunWorkspaceService({
    receipts: agentRunWorkspaceReceipts,
    childWorktree: {
      prepare: (input) =>
        agentRunChildWorktree.current?.prepare(input) ??
        Promise.resolve({ status: "refused", reason: "unavailable" }),
      confirm: (input) =>
        agentRunChildWorktree.current?.confirm(input) ??
        Promise.resolve({ status: "refused", reason: "unavailable" }),
    },
  });
  const capacityScheduler = makeProviderCapacityScheduler({
    now: () => Date.now(),
    random: Math.random,
    maxRetryJitterMs: 250,
    ambiguousReservationTtlMs: 60_000,
  });
  const spendCeilingHolder: { service?: SpendCeilingService } = {};
  const spendCeiling = {
    admit: ((request: Parameters<SpendCeilingService["admit"]>[0]) =>
      spendCeilingHolder.service!.admit(request)) as SpendCeilingService["admit"],
    settle: ((input: Parameters<SpendCeilingService["settle"]>[0]) =>
      spendCeilingHolder.service!.settle(input)) as SpendCeilingService["settle"],
  };
  const agentRunSessionStore = new AgentRunSessionStore({
    connection: persistence.connection,
    getById: (runId) => agentRunPersistence.getById(runId),
  });
  const agentRunLiveConversations = new AgentRunLiveConversationStore({
    persistence: agentRunSessionStore.conversations,
  });
  const externalContentIngestionStore = new ExternalContentIngestionStore({
    journal: persistence.journal,
    connection: persistence.connection,
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
    actor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
  });
  const runtimeOutsideContentMarks = new RuntimeOutsideContentMarks((input) =>
    externalContentIngestionStore.record(input),
  );
  // Managed subagent execution. A managed child runs as an in-process
  // provider session, not a spawned process, so authority is re-derived from
  // the run rather than inherited from the parent thread at execution time.
  const agentRunSessionSupervisor = new AgentRunSessionSupervisor({
    port: createAgentRunSessionRuntime({
      reviewCapture: createAgentRunReviewCapture(),
      outsideContentMarks: runtimeOutsideContentMarks,
      canCaptureReview: (run) => {
        const thread = persistence.readCodeThread(decodeCodeThreadId(String(run.parentThreadId)));
        return thread?.lifecycle === "active" && thread.executionPolicy !== "plan";
      },
      capacityScheduler,
      spendCeiling,
      recordUsage: (input) =>
        recordAgentRunTurnUsage(
          {
            connection: persistence.connection,
            journal: persistence.journal,
            clock: () => new Date().toISOString(),
            uuid: randomUUID,
          },
          {
            runId: input.run.id,
            providerInstanceId: input.providerInstanceId,
            modelId: input.modelId,
            ...(input.usage === undefined ? {} : { usage: input.usage }),
          },
        ),
      sessionStore: agentRunSessionStore.sessions,
      verifyCodeWorkspace: async ({ run, signal }) => {
        const workspace = run.workspaceReceipt;
        const refused = {
          status: "refused",
          reason:
            "The child's managed Code workspace is unavailable or its parent binding changed.",
        } as const;
        if (workspace.kind !== "code-worktree" || agentRunChildWorktree.current === undefined)
          return refused;
        const thread = persistence.readCodeThread(decodeCodeThreadId(String(run.parentThreadId)));
        const project =
          thread === undefined ? undefined : persistence.readProject(thread.projectId);
        if (
          thread?.lifecycle !== "active" ||
          project?.type !== "code" ||
          project.lifecycle !== "active" ||
          String(project.id) !== String(workspace.projectId) ||
          project.binding.canonicalRoot !== workspace.checkoutRoot ||
          String(project.bindingHistory.at(-1)?.revisionId) !== String(thread.bindingRevisionId)
        )
          return refused;
        const { code } = await resolveAgentRunPrepareCode(persistence, managedWorktreeReceipts, {
          mode: "code",
          threadId: String(run.parentThreadId),
        });
        if (code === undefined) return refused;
        return agentRunChildWorktree.current.verifyExecution({
          requestId: String(run.requestId),
          parentThreadId: String(run.parentThreadId),
          repositoryId: code.repositoryId,
          repositoryRoot: code.repositoryRoot,
          parentCheckoutRoot: code.parentCheckoutRoot,
          worktreeRoot: workspace.worktreeRoot,
          signal,
        });
      },
      resolveModelOptionValues: (run) => {
        const target = effectiveAgentRunExecutionTarget(run.routingReceipt);
        const reasoning = run.routingReceipt.rawReasoning;
        if (reasoning === undefined) return undefined;
        const model = providerRuntimeRegistry
          .observedState(target.providerInstanceId)
          ?.models.find((model) => String(model.id) === String(target.modelId));
        const supported = model?.options.filter(
          (option) =>
            option.kind === "selection" &&
            (option.id === "reasoning" || option.id === "effort") &&
            option.values.includes(reasoning),
        );
        const option = supported?.length === 1 ? supported[0] : undefined;
        return option === undefined ? undefined : { [option.id]: reasoning };
      },
      supportsResume: (providerInstanceId) =>
        providerRuntimeRegistry.observedState(providerInstanceId)?.capabilities.resume ===
        "supported",
      appManagedTools: (input) => {
        const native = late.nativeHarnessComposition.current?.forAgentRun(input);
        const target = effectiveAgentRunExecutionTarget(input.run.routingReceipt);
        const canvas =
          late.canvasAgentToolPort.current === undefined
            ? undefined
            : createChildCanvasAgentTools({
                port: {
                  ...late.canvasAgentToolPort.current,
                  resolveChildWorkspace: (query) =>
                    loadChildCanvasWorkspace(
                      {
                        readRun: (runId) => {
                          try {
                            return agentRunPersistence.getById(decodeAgentRunId(runId));
                          } catch {
                            return undefined;
                          }
                        },
                        readProject: (projectId) => {
                          try {
                            const project = persistence.readProject(decodeProjectId(projectId));
                            if (project === undefined) return undefined;
                            if (project.type === "chat") {
                              return {
                                id: String(project.id),
                                type: project.type,
                                lifecycle: project.lifecycle,
                              };
                            }
                            return {
                              id: String(project.id),
                              type: project.type,
                              lifecycle: project.lifecycle,
                              binding: project.binding,
                              bindingHistory: project.bindingHistory,
                            };
                          } catch {
                            return undefined;
                          }
                        },
                        readCodeThread: (threadId) => {
                          try {
                            return persistence.readCodeThread(decodeCodeThreadId(threadId));
                          } catch {
                            return undefined;
                          }
                        },
                        findManagedWorktreeReceipt: (lookup) =>
                          managedWorktreeReceipts.findActive(lookup),
                      },
                      query.runId,
                    ),
                },
                run: {
                  id: String(input.run.id),
                  parentThreadId: String(input.run.parentThreadId),
                  mode: input.run.routingReceipt.mode,
                  ...("projectId" in input.run.workspaceReceipt
                    ? { projectId: String(input.run.workspaceReceipt.projectId) }
                    : {}),
                  providerInstanceId: target.providerInstanceId,
                  modelId: target.modelId,
                },
              });
        if (native === undefined && canvas === undefined) return undefined;
        return combineAppManagedToolSets(native, canvas);
      },
      appManagedToolTransport: ({ providerInstanceId, modelId }) => {
        const observed = providerRuntimeRegistry.observedState(providerInstanceId);
        const supported =
          observed?.capabilities.appManagedTools === "supported" ||
          observed?.verifiedToolModelIds?.some(
            (candidate: unknown) => String(candidate) === String(modelId),
          ) === true;
        if (supported) return "supported" as const;
        return observed === undefined ? ("unavailable" as const) : ("unsupported" as const);
      },
      interactions: {
        approve: (input) => agentRunInteractions.approve(input),
        askUser: (input) => agentRunInteractions.askUser(input),
      },
      // A Work or Code child answers to the Project its workspace recorded; a
      // missing or retyped Project fails closed rather than lifting the policy.
      isTargetAllowedByProjectPolicy: ({ run, providerInstanceId, modelId }) => {
        if (run.workspaceReceipt.kind === "chat-virtual") return true;
        const project = persistence.readProject(run.workspaceReceipt.projectId);
        if (project?.type !== run.workspaceReceipt.mode) return false;
        return isProjectPolicyTargetAllowed(project, providerInstanceId, modelId);
      },
      // `configuredDriverOptions` is declared later in this scope; the closure
      // only runs when a child starts, long after boot, so the reference is safe.
      resolveDriver: (providerInstanceId, run) => {
        const instance = persistence.readProviderInstance(providerInstanceId);
        if (instance === undefined || !instance.enabled) return undefined;
        try {
          return makeConfiguredProviderDriver(instance, {
            ...configuredDriverOptions(),
            ...(instance.driverKind === "claude"
              ? {
                  claudeResumeIdentityPort: createAgentRunClaudeResumeIdentityPort({
                    run,
                    store: agentRunSessionStore,
                    isProviderAvailable: (id) => {
                      const current = persistence.readProviderInstance(id);
                      return current?.enabled === true && current.driverKind === "claude";
                    },
                  }),
                }
              : {}),
          });
        } catch {
          return undefined;
        }
      },
      // The admitted selection is resolved from the run's own journaled
      // admission and the store that holds the blocks it named. An unknown
      // run, a mismatched snapshot id, or blocks purged with a deleted parent
      // thread fails the start closed instead of executing under a selection
      // nobody admitted.
      context: createRecordedAgentRunContextSnapshotPort({
        getById: (childRunId) => agentRunPersistence.getById(childRunId),
        readAdmittedContext: (input) => readAgentRunAdmittedContext(persistence.connection, input),
        readResultText: (dependencyId) => agentRunPersistence.resultText(dependencyId),
      }),
      uuid: randomUUID,
      scratchRoot: (run) => {
        const root = join(persistence.dataDirectory, "agent-run-scratch", String(run.id));
        mkdirSync(root, { recursive: true, mode: 0o700 });
        return root;
      },
      // Starting a child observes no provider limits of its own, so it never
      // replaces limits an ordinary turn observed on the shared scheduler. A
      // known wait therefore applies to the child as it does to any other
      // work, and unrelated turns keep the real limits.
      serviceLimits: makeUnobservedProviderCapacityFacts({
        scheduler: capacityScheduler,
        now: () => new Date().toISOString() as UtcTimestamp,
      }),
      // `agentRunOrchestration` is declared below; this closure runs only
      // once a child's session has started.
      onSessionRunning: ({ runId }) => void agentRunOrchestration.onSessionRunning(runId),
      onSessionStarted: ({ runId, resumed }) =>
        agentRunLiveConversations.begin(runId, { resume: resumed }),
      onUserMessage: ({ runId, kind, text, occurredAt }) =>
        agentRunLiveConversations.appendStatus(runId, `${kind}: ${text}`, occurredAt),
      onChildActivity: ({ run, event }) =>
        agentRunLiveConversations.appendChildActivity(run.id, event, run.generation ?? 1),
      onTextDelta: ({ runId, text, occurredAt }) =>
        agentRunLiveConversations.appendText(runId, text, occurredAt),
      onSessionSettled: ({ runId, outcome }) => {
        if (outcome.kind === "completed") {
          agentRunLiveConversations.complete(runId);
        } else {
          agentRunLiveConversations.markStale(
            runId,
            outcome.kind === "failed"
              ? outcome.failure.message
              : "The child session ended before a complete transcript was retained.",
          );
        }
      },
    }),
    // A settled managed session is the only signal that a child finished, so
    // orchestration records its terminal state durably. `agentRunOrchestration`
    // is declared below; this closure runs only when a child settles.
    onSessionSettled: (settled) => agentRunOrchestration.onSessionSettled(settled),
    persistedActiveRunIds: () =>
      [...agentRunPersistence.snapshot().values()]
        .filter((run) => run.lifecycleStatus === "starting" || run.lifecycleStatus === "running")
        .map((run) => run.id),
  });
  const agentRunProcessSupervisor = options.agentRunProcessSupervisor ?? agentRunSessionSupervisor;
  const agentRunOrchestration = new AgentRunOrchestrationService({
    persistence: agentRunPersistence,
    capacity: createInMemoryCapacityPort(() =>
      effectiveAgentRunConcurrency(agentRunSettingsStore.current()),
    ),
    worktree: {
      isVerifiedIsolation: (workspace) =>
        workspace.verified && workspace.worktreeRoot !== workspace.checkoutRoot,
      isParentCheckout: (workspace) => workspace.worktreeRoot === workspace.checkoutRoot,
    },
    workBinding: {
      isCurrent: (workspace) => {
        const project = persistence.readProject(workspace.projectId);
        if (project?.type !== "work" || project.lifecycle !== "active") return false;
        const revision = project.bindingHistory.at(-1);
        return (
          revision !== undefined &&
          String(revision.revisionId) === String(workspace.bindingRevisionId) &&
          project.binding.canonicalRoot === workspace.canonicalRoot
        );
      },
    },
    approvals: { isCurrent: () => true },
    processes: agentRunProcessSupervisor,
    parentSessions: {
      // The same rule `delegate` refuses by: a paused session, or one a
      // restart left needing a check, starts no child until it is resumed.
      isHeld: (parentThreadId) => {
        const status = nativeHarnessSessions.read(String(parentThreadId))?.session.status;
        return (
          status === "paused-by-user" ||
          status === "paused-by-advisor" ||
          status === "recovery-required"
        );
      },
    },
  });
  // Admits the subagents a thread's agent delegates through the Octant
  // Harness `delegate` tool. No HTTP route starts a subagent: a child a
  // person started by hand had no agent to hand its result back to.
  const agentRunAdmission: AgentRunControlAdmissionDependencies = {
    onExecutionAccepted: onAgentRunExecutionAccepted,
    persistence: agentRunPersistence,
    orchestration: agentRunOrchestration,
    settings: agentRunSettingsStore,
    providerReadiness: {
      isReady: ({ providerInstanceId, modelId }) => {
        const instance = persistence.readProviderInstance(providerInstanceId as never);
        if (instance === undefined || !instance.enabled) return false;
        const observed = providerRuntimeRegistry.observedState(providerInstanceId as never);
        return (
          observed?.readiness === "ready" &&
          observed.models.some((model) => String(model.id) === modelId)
        );
      },
    },
    nativeEvidence: ({ parent }) => {
      const observed = providerRuntimeRegistry.observedState(
        parent.parentRoute.providerInstanceId as never,
      );
      const capabilities = observed?.capabilities;
      return {
        claimedNativeSupport: capabilities?.nativeChildAgents ?? "unavailable",
        // Native execution is an optimization this host only honors when a
        // native child adapter is wired. Workspace and authority still clamp
        // on the managed path; they are not evidenced for provider-native
        // children until that adapter exists.
        workspace: false,
        authority: false,
        observability:
          capabilities?.streaming === "supported" && capabilities?.toolActivity === "supported",
        cancellation: capabilities?.interruption === "supported",
        steering: capabilities?.userQuestions === "supported",
        recovery: capabilities?.resume === "supported",
      };
    },
    authorizeCreation: ({ parentThreadId, windowId }) =>
      authorizeAgentRunCreation({
        persistence,
        workThreadProjection: workThreadProjection,
        parentThreadId,
        windowId,
        codeSessionAuthority,
        activeTurn: codeParentActiveTurn,
      }),
    poolRouting: ({ request }) => {
      if (request.pool === undefined) return undefined;
      // Prefer the parent mode's persisted route as the mixed-vendor binding.
      let parentThread:
        | ReturnType<PersistenceService["readChatThread"]>
        | ReturnType<PersistenceService["readCodeThread"]>;
      try {
        parentThread = persistence.readChatThread(
          decodeChatThreadId(String(request.parentThreadId)),
        );
      } catch {
        parentThread = undefined;
      }
      if (parentThread === undefined) {
        try {
          parentThread = persistence.readCodeThread(
            decodeCodeThreadId(String(request.parentThreadId)),
          );
        } catch {
          parentThread = undefined;
        }
      }
      if (parentThread === undefined) return undefined;
      const parentCandidate: MultiModelPoolCandidate = {
        hostId: LOCAL_HOST_ID,
        providerInstanceId: parentThread.providerInstanceId,
        modelId: parentThread.modelId,
      } as unknown as MultiModelPoolCandidate;
      const factsByKey = new Map<string, MultiModelCandidateRuntimeFacts>();
      for (const candidate of [...request.pool.candidates, parentCandidate]) {
        const key = `${candidate.hostId}:${candidate.providerInstanceId}:${candidate.modelId}`;
        if (!factsByKey.has(key)) {
          factsByKey.set(key, agentRunPoolCandidateFacts(candidate));
        }
      }
      return { parentCandidate, runtimeFacts: [...factsByKey.values()] };
    },
    workspace: createAgentRunControlWorkspace(
      agentRunWorkspace,
      (threadId) => resolveAgentRunParentCheckout(persistence, managedWorktreeReceipts, threadId),
      (parent) => resolveAgentRunPrepareCode(persistence, managedWorktreeReceipts, parent),
    ),
    parentContext: {
      resolve: ({ parentThreadId, mode }) => {
        try {
          if (mode === "chat")
            return admittedParentChatContext(
              chatService().read(decodeChatThreadId(String(parentThreadId))),
            );
          const externalContentIngested = readThreadExternalContentTaint(
            persistence.connection,
            String(parentThreadId),
          ).externalContentIngested;
          const selection =
            mode === "work"
              ? admittedParentWorkContext({
                  threadId: decodeWorkThreadId(String(parentThreadId)),
                  externalContentIngested,
                  readThread: (id) => workThreadProjection.read(id),
                  readTurns: (id) => workTurnProjection.listForThread(id),
                })
              : selectCodeConversation(decodeCodeThreadId(String(parentThreadId)));
          return selection.status === "available"
            ? selection.blocks
            : { unavailable: selection.reason };
        } catch {
          return undefined;
        }
      },
    },
    uuid: randomUUID,
  };
  const agentRunEligibleTargets = (projectId: ProjectId | undefined) =>
    eligibleAgentRunTargets({
      project: projectId === undefined ? undefined : persistence.readProject(projectId),
      instances: persistence.readProviderInstances(),
      observedState: (instanceId) => providerRuntimeRegistry.observedState(instanceId),
      // Deferred: the policy check is declared later in this scope.
      isTargetAllowed: (project, instanceId, modelId) =>
        isProjectPolicyTargetAllowed(project, instanceId, modelId),
    });
  const nativeHarnessRoutingStore = new NativeHarnessRoutingStore({
    journal: persistence.journal,
    uuid: randomUUID,
    actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    clock: () => new Date().toISOString(),
  });
  const nativeHarnessRouter = new NativeHarnessRouter({
    store: nativeHarnessRoutingStore,
    isReady: (candidate) =>
      agentRunAdmission.providerReadiness.isReady({
        providerInstanceId: String(candidate.providerInstanceId),
        modelId: String(candidate.modelId),
      }),
  });
  // Every turn's `octant_agents` tool set binds to the calling thread: the
  // delegation and the cancellation authority it petitions are the same ones
  // the Agents dock uses, so a tool call and a click are the same request.
  const agentsManagedToolsFor = (input: {
    readonly windowId: string;
    readonly parentThreadId: string;
    readonly mode: OctantMode;
    readonly projectId?: ProjectId;
  }): AppManagedToolSet =>
    createAgentsManagedTools({
      admission: agentRunAdmission,
      orchestration: agentRunOrchestration,
      persistence: agentRunPersistence,
      mode: input.mode,
      windowId: input.windowId,
      parentThreadId: input.parentThreadId,
      listTargets: () => agentRunEligibleTargets(input.projectId),
      routing: {
        router: { resolve: (request) => nativeHarnessRouter.resolve(request) },
        recordDecision: (parent, decision) => {
          nativeHarnessSessions.ensure({
            threadId: input.parentThreadId,
            mode: parent.parentMode,
            projectId:
              parent.parentRoute.projectId === undefined
                ? undefined
                : decodeProjectId(parent.parentRoute.projectId),
            leadSlotId: NATIVE_HARNESS_BUILT_IN_SLOTS.default,
            lead: {
              hostId: LOCAL_HOST_ID,
              providerInstanceId: parent.parentRoute.providerInstanceId,
              modelId: parent.parentRoute.modelId,
              ...(parent.parentRoute.reasoning === undefined
                ? {}
                : { reasoning: parent.parentRoute.reasoning }),
            },
          });
          nativeHarnessSessions.recordRouteDecision(input.parentThreadId, decision);
        },
      },
      isPaused: () => {
        const status = nativeHarnessSessions.read(input.parentThreadId)?.session.status;
        return (
          status === "paused-by-user" ||
          status === "paused-by-advisor" ||
          status === "recovery-required"
        );
      },
      isTainted: () =>
        readThreadExternalContentTaint(persistence.connection, input.parentThreadId)
          .externalContentIngested,
      authorizeCancel: (run) =>
        authorizeAgentRunCancellation({
          persistence,
          workThreadProjection: workThreadProjection,
          run,
          windowId: input.windowId,
        }),
      uuid: randomUUID,
    });
  const agentRunRouteDependencies: AgentRunRouteDependencies = {
    readObservations: ({ parentThreadId }) => {
      const chat = persistence.readChatThread(decodeChatThreadId(String(parentThreadId)));
      const work = workThreadProjection.read(decodeWorkThreadId(String(parentThreadId)));
      const code = persistence.readCodeThread(decodeCodeThreadId(String(parentThreadId)));
      if ([chat, work, code].filter((thread) => thread !== undefined).length !== 1) {
        return { observations: [], observationsTruncated: false };
      }
      if (chat !== undefined) {
        const view = persistence.readChatThreadView(chat.id);
        return observedChildren({
          parentThreadId,
          mode: "chat",
          states:
            view?.turns
              .slice(-64)
              .flatMap((turn) =>
                turn.attempts.flatMap((attempt) =>
                  attempt.childObservations === undefined ? [] : [attempt.childObservations],
                ),
              ) ?? [],
          truncated: (view?.turns.length ?? 0) > 64,
        });
      }
      if (work !== undefined) {
        const turns = workTurnProjection.listForThread(work.id);
        return observedChildren({
          parentThreadId,
          mode: "work",
          states: turns
            .slice(-64)
            .flatMap((turn) =>
              turn.childObservations === undefined ? [] : [turn.childObservations],
            ),
          truncated: turns.length > 64,
        });
      }
      const history = codeBoardEventStore.historyForThread(
        decodeCodeThreadId(String(parentThreadId)),
      );
      return observedChildren({
        parentThreadId,
        mode: "code",
        truncated: history.status !== "ok",
        events:
          history.status !== "ok"
            ? []
            : history.frames.flatMap((frame) =>
                frame.event.kind === "child-activity" && frame.event.observation !== undefined
                  ? [frame.event.observation]
                  : [],
              ),
      });
    },
    listTargets: (parent) =>
      agentRunEligibleTargets(
        parent.parentRoute.projectId === undefined
          ? undefined
          : decodeProjectId(parent.parentRoute.projectId),
      ),
    onExecutionAccepted: onAgentRunExecutionAccepted,
    windowAuthorityStore,
    persistence: agentRunPersistence,
    liveConversations: agentRunLiveConversations,
    orchestration: agentRunOrchestration,
    authorizeCreation: agentRunAdmission.authorizeCreation,
    authorizeCancellation: ({ run, windowId }) =>
      authorizeAgentRunCancellation({
        persistence,
        workThreadProjection: workThreadProjection,
        run,
        windowId,
      }),
    // Parent-summary reads and result acknowledgements are gated the same
    // way as cancellation: the parent thread is resolved from this host's
    // own thread stores and the window's own workspace, never from a scope
    // the caller supplied. `workThreadProjection` is declared later in
    // this scope; the closure runs per request, long after boot.
    authorizeParentThread: ({ parentThreadId, windowId }) =>
      authorizeAgentRunParentThread({
        persistence,
        workThreadProjection: workThreadProjection,
        parentThreadId,
        windowId,
      }),
    resolveCenterContext: ({ parentThreadId, mode, requestId, workspaceReceipt }) =>
      resolveAgentRunCenterContext({
        persistence,
        workThreadProjection: workThreadProjection,
        parentThreadId,
        mode,
        requestId,
        workspaceReceipt,
      }),
    snapshotCanvas: (input) => late.snapshotCanvasImpl.current(input),
  };
  const agentRunRoutes = createAgentRunRouteHandler(agentRunRouteDependencies);
  /**
   * Synchronous per-candidate runtime facts for child pool routing,
   * mirroring ChatService's probe semantics but reading only the already
   * observed provider state (the same source as the readiness gate above):
   * an unconfigured, disabled, foreign-host, or not-yet-observed candidate
   * is honestly ineligible rather than probed at request time.
   */
  function agentRunPoolCandidateFacts(
    candidate: MultiModelPoolCandidate,
  ): MultiModelCandidateRuntimeFacts {
    const ineligible = (
      routingVendorId: string,
      configured: boolean,
    ): MultiModelCandidateRuntimeFacts => ({
      candidate,
      routingVendorId: decodeMultiModelRoutingVendorId(routingVendorId),
      configured,
      readiness: "unavailable",
      modelAvailable: false,
      compatibleModes: [],
      projectAllowed: true,
      profileAllowed: true,
      supportedCapabilities: [],
      authorityAllowed: false,
    });
    if (String(candidate.hostId) !== String(LOCAL_HOST_ID)) {
      return ineligible("foreign-host", false);
    }
    const instance = persistence.readProviderInstance(candidate.providerInstanceId as never);
    if (instance === undefined) return ineligible("unconfigured", false);
    if (!instance.enabled) return ineligible(instance.driverKind, true);
    const observed = providerRuntimeRegistry.observedState(candidate.providerInstanceId as never);
    return {
      candidate,
      routingVendorId: decodeMultiModelRoutingVendorId(instance.driverKind),
      configured: true,
      readiness: observed?.readiness ?? "unavailable",
      modelAvailable:
        observed?.models.some((model) => String(model.id) === String(candidate.modelId)) ?? false,
      compatibleModes: ["chat"],
      projectAllowed: true,
      profileAllowed: true,
      supportedCapabilities: [],
      authorityAllowed: true,
    };
  }
  const agentRunSettingsRoutes = createAgentRunSettingsRouteHandler({
    windowAuthorityStore,
    store: agentRunSettingsStore,
  });
  return {
    agentRunAdmission,
    agentRunChildWorktree,
    agentRunEligibleTargets,
    agentRunLiveConversations,
    agentRunOrchestration,
    agentRunProcessSupervisor,
    agentRunRoutes,
    agentRunSessionStore,
    agentRunSettingsRoutes,
    agentsManagedToolsFor,
    capacityScheduler,
    externalContentIngestionStore,
    managedWorktreeReceipts,
    nativeHarnessHooks,
    nativeHarnessRouter,
    nativeHarnessRoutingStore,
    runtimeOutsideContentMarks,
    sideTasks,
    spendCeiling,
    spendCeilingHolder,
    threadAwaitsHarnessApproval,
    threadFollowUpSuggestions,
    turnMetrics,
  };
}

export type AgentRunsWiring = ReturnType<typeof wireAgentRuns>;
