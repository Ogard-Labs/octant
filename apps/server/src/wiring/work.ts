import { decodeComputerUseOwner } from "@octant/contracts/computer-use-plugin";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  decodeAgentRunParentThreadId,
  decodeChatThreadId,
  decodeCodeOperationId,
  decodeCodeThreadId,
  decodeContextSubjectRef,
  decodeProviderSessionId,
  decodeThreadMessageQueueScope,
  decodeWindowId,
  decodeWorkThreadId,
  decodeWorkTurnId,
  decodeWorkTurnRequestId,
  LOCAL_HOST_ID,
  type ProjectId,
  type WorkThreadId,
  type WorkStatusDatedItem,
} from "@octant/contracts";
import { Effect } from "effect";
import { ThreadMessageQueueService } from "../messageQueue/threadMessageQueueService";
import { createThreadMessageQueuePort } from "../messageQueue/threadMessageQueuePorts";
import { createThreadMessageQueueAttachments } from "../messageQueue/threadMessageQueueAttachments";
import { createThreadMessageQueueRouteHandler } from "../messageQueue/threadMessageQueueRoutes";
import { startEventLoopLagDetector } from "../eventLoopLag";
import { admittedParentWorkContext } from "../agentRun/agentRunParentContext";
import { WorkTurnFileObserver } from "../work/workTurnFileObserver";
import { WorkThreadService } from "../work/workThreadService";
import { WorkTurnService } from "../work/workTurnService";
import { withWorkflowLifecycle } from "../work/workThreadWorkflowHook";
import { WorkflowEventStore } from "../work/workflowEventStore";
import { WorkflowProjection } from "../work/workflowProjection";
import { WorkflowService } from "../work/workflowService";
import { resolveThreadWorkingDirectory } from "../threadWorkingDirectoryAuthority";
import { attachWorkRequestRuntime } from "../work/workRequestRuntime";
import { createGoalLoopRouteHandler } from "../goal/goalLoopRoutes";
import { GoalLoopEventStore } from "../goal/goalLoopEventStore";
import { GoalLoopService } from "../goal/goalLoopService";
import { GoalLoopScheduler } from "../goal/goalLoopScheduler";
import { createGoalLoopWorkRoundRunner } from "../goal/goalLoopWorkRoundRunner";
import { WorkTurnUsageStore } from "../work/workTurnUsageStore";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { threadMentionContextResolver } from "../chat/threadMentionService";
import { createFileMentionRouteHandler } from "../fileMentionRoutes";
import { pinFileMentionRoot } from "../fileMentionIo";
import { fileMentionContextBlocks, FileMentionService } from "../fileMentionService";
import {
  createThreadExportRouteHandler,
  createThreadHandOffRouteHandler,
} from "../threadExportRoutes";
import { ThreadExportService } from "../threadExportService";
import { makeThreadHandOffCompletion } from "../threadHandOffCompletion";
import { ThreadHandOffService } from "../threadHandOffService";
import { createBrowserAppManagedTools } from "../browser/browserAppManagedTools";
import { readThreadExternalContentTaint } from "../context/externalContentTaintProjection";
import { createSideTaskTools } from "../sideTasks/sideTaskTools";
import {
  defaultShellSettings,
  enabledModes,
  isAgentRunActiveStatus,
  THREAD_MENTION_UNREADABLE_CONTEXT,
} from "@octant/domain";
import {
  boardRuntimeActivityFromTurnsAndSignals,
  type WorkBoardRuntimeActivity,
} from "../work/workThreadBoardService";
import { createCanvasAgentTools } from "../canvas/canvasAgentTools";
import { combineAppManagedToolSets } from "../providers/appManagedToolSet";
import { makeConfiguredProviderDriver, type ProvidersWiring } from "./providers";
import { MAX_JSON_REQUEST_BODY_SIZE, type ServerStart } from "./serverShape";
import type { AuthorityWiring } from "./authority";
import type { FoundationsWiring } from "./foundations";
import type { AgentRunsWiring } from "./agentRuns";
import type { IntegrationsWiring } from "./integrations";
import type { ComputerUseWiring } from "./computerUse";
import type { WorkspaceWiring } from "./workspace";
import type { CodeWiring } from "./code";
import type { BrowserWiring } from "./browser";
import type { CodeRuntimeWiring } from "./codeRuntime";
import type { HarnessWiring } from "./harness";
import type { ChatWiring } from "./chat";
import type { CanvasWiring } from "./canvas";
import type { HarnessStateWiring } from "./harnessState";
import type { WorkRequestStateWiring } from "./workRequestState";

export type WorkDependencies = Pick<ServerStart, "persistence"> &
  Pick<
    AuthorityWiring,
    | "agentRunPersistence"
    | "browserCaptures"
    | "browserModelBindings"
    | "codeSessionAuthority"
    | "liveTurns"
    | "onWindowRevoked"
    | "windowAuthorityStore"
  > &
  Pick<
    AgentRunsWiring,
    | "agentsManagedToolsFor"
    | "externalContentIngestionStore"
    | "managedWorktreeReceipts"
    | "runtimeOutsideContentMarks"
    | "sideTasks"
    | "spendCeiling"
    | "threadAwaitsHarnessApproval"
  > &
  Pick<HarnessStateWiring, "threadAwaitsHarnessQuestion"> &
  Pick<WorkRequestStateWiring, "runningWorkTurns" | "workRequestRuntime" | "workRequestService"> &
  Pick<
    IntegrationsWiring,
    | "consumeCreateFromIssueFramed"
    | "githubIssueContextService"
    | "linearIssueContextService"
    | "peekCreateFromIssueFramed"
    | "threadOutsideContentMarks"
  > &
  Pick<ComputerUseWiring, "computerToolsFor" | "computerUseTools"> &
  Pick<
    WorkspaceWiring,
    | "authorizeWorkThreadForWindow"
    | "contextHarness"
    | "goalService"
    | "projectService"
    | "workProjectStatusFiles"
    | "workProjectStatusReader"
  > &
  Pick<
    CodeWiring,
    | "canAccessCodeProject"
    | "codeAttachments"
    | "codeWorkingDirectoryProbePath"
    | "roots"
    | "workAttachments"
  > &
  Pick<
    ProvidersWiring,
    | "chatAttachmentStore"
    | "configuredDriverOptions"
    | "imageJobService"
    | "probeProviderForThreads"
    | "refreshStandaloneSkills"
    | "resolveSelectedExtensions"
    | "pinnedExtensionIds"
  > &
  Pick<
    BrowserWiring,
    "browserAutomationService" | "browserToolApprovalService" | "windowHoldsProject"
  > &
  Pick<CodeRuntimeWiring, "codeService" | "routeCodeService"> &
  Pick<
    HarnessWiring,
    | "followUpCreation"
    | "nativeHarnessComposition"
    | "nativeHarnessHooks"
    | "onHarnessPausedByPerson"
    | "sideTaskFirstMessage"
  > &
  Pick<ChatWiring, "chatService" | "guardChatAttachmentPurge" | "threadMentionService"> &
  Pick<CanvasWiring, "canvasAgentToolPort" | "canvasService" | "resolveCanvasWorkspace"> &
  Pick<
    FoundationsWiring,
    | "browserAuthority"
    | "providerRuntimeRegistry"
    | "workArtifactProjection"
    | "workThreadProjection"
    | "workTurnProjection"
  >;

export function wireWork(deps: WorkDependencies) {
  const {
    agentRunPersistence,
    agentsManagedToolsFor,
    authorizeWorkThreadForWindow,
    browserAuthority,
    browserAutomationService,
    browserCaptures,
    browserModelBindings,
    browserToolApprovalService,
    canAccessCodeProject,
    canvasAgentToolPort,
    canvasService,
    chatAttachmentStore,
    chatService,
    guardChatAttachmentPurge,
    codeAttachments,
    codeService,
    codeSessionAuthority,
    codeWorkingDirectoryProbePath,
    computerToolsFor,
    computerUseTools,
    configuredDriverOptions,
    consumeCreateFromIssueFramed,
    contextHarness,
    externalContentIngestionStore,
    followUpCreation,
    githubIssueContextService,
    goalService,
    imageJobService,
    linearIssueContextService,
    liveTurns,
    managedWorktreeReceipts,
    nativeHarnessComposition,
    nativeHarnessHooks,
    onHarnessPausedByPerson,
    onWindowRevoked,
    peekCreateFromIssueFramed,
    persistence,
    probeProviderForThreads,
    projectService,
    providerRuntimeRegistry,
    refreshStandaloneSkills,
    resolveCanvasWorkspace,
    resolveSelectedExtensions,
    pinnedExtensionIds,
    roots,
    routeCodeService,
    runningWorkTurns,
    runtimeOutsideContentMarks,
    sideTaskFirstMessage,
    sideTasks,
    spendCeiling,
    threadAwaitsHarnessApproval,
    threadAwaitsHarnessQuestion,
    threadMentionService,
    threadOutsideContentMarks,
    windowAuthorityStore,
    windowHoldsProject,
    workArtifactProjection,
    workAttachments,
    workProjectStatusFiles,
    workProjectStatusReader,
    workRequestRuntime,
    workRequestService,
    workThreadProjection,
    workTurnProjection,
  } = deps;
  return Effect.gen(function* () {
    const workTurnUsageStore = new WorkTurnUsageStore();
    // The navigation poll runs about once a second while a date in STATUS.md
    // moves at day granularity, so each Project's file is re-read at most this
    // often; the inbox reminder freshens within the same window.
    const workDueReminderCache = new Map<
      string,
      { readonly at: number; readonly item: WorkStatusDatedItem | undefined }
    >();
    const projectDueReminder = async (
      projectId: ProjectId,
      canonicalRoot: string,
    ): Promise<WorkStatusDatedItem | undefined> => {
      const key = String(projectId);
      const cached = workDueReminderCache.get(key);
      const now = Date.now();
      if (cached !== undefined && now - cached.at < 30_000) return cached.item;
      const item = await workProjectStatusReader.dueReminder(projectId, canonicalRoot);
      workDueReminderCache.set(key, { at: now, item });
      return item;
    };
    const observeWorkThreadRuntime = (threadId: WorkThreadId): WorkBoardRuntimeActivity => {
      const thread = workThreadProjection.read(threadId);
      const pendingRequests = thread
        ? workRequestService
            .listForThread(thread.projectId, threadId)
            .filter((request) => request.status === "pending")
        : [];
      const pendingRequest = pendingRequests.at(0);
      const childRuns = persistence.agentRunProjection.parentSummary(
        decodeAgentRunParentThreadId(String(threadId)),
      );
      return boardRuntimeActivityFromTurnsAndSignals({
        turns: workTurnProjection.listForThread(threadId),
        pendingRequest: pendingRequest !== undefined,
        ...(pendingRequest === undefined ? {} : { pendingRequestKind: pendingRequest.detail.kind }),
        leadApprovalWaiting: threadAwaitsHarnessApproval(String(threadId)),
        leadQuestionWaiting: threadAwaitsHarnessQuestion(String(threadId)),
        childActive: childRuns.filter(
          (run) => isAgentRunActiveStatus(run.lifecycleStatus) && run.lifecycleStatus !== "waiting",
        ).length,
        childWaiting: childRuns.filter((run) => run.lifecycleStatus === "waiting").length,
      });
    };
    const workThreadService = new WorkThreadService({
      persistence,
      recordExternalContentIngestion: (input) => externalContentIngestionStore.record(input),
      projects: projectService,
      projection: workThreadProjection,
      turnProjection: workTurnProjection,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      workingDirectories: { resolve: resolveThreadWorkingDirectory },
      onWorkingDirectoryChanged: async () => refreshStandaloneSkills(),
      probeProvider: (providerInstanceId) => probeProviderForThreads(providerInstanceId),
      observeRuntime: (threadId) => ({
        ...observeWorkThreadRuntime(threadId),
        ...liveTurns.read(String(threadId)),
      }),
      projectDueReminder,
      readProviderModel: (providerInstanceId, modelId) =>
        persistence
          .readProviderCatalog?.(providerInstanceId)
          ?.models.find((model) => String(model.id) === String(modelId)),
      issueContext: githubIssueContextService,
      linearIssueContext: linearIssueContextService,
    });
    const workTurnService = new WorkTurnService({
      liveTurns,
      runningAccess: runningWorkTurns,
      outsideContentMarks: runtimeOutsideContentMarks,
      usageStore: workTurnUsageStore,
      agentRuns: agentRunPersistence,
      contextHarness,
      resolveSelectedExtensions,
      pinnedExtensionIds,
      spendCeiling,
      onTurnRequested: (threadId) => workThreadService.noteTurnRequested(threadId),
      onRequestSettled: (input, release) => workRequestService.onSettled(input, release),
      persistence: {
        ...persistence,
        readProviderModel: (providerInstanceId, modelId) =>
          persistence
            .readProviderCatalog?.(providerInstanceId)
            ?.models.find((model) => String(model.id) === String(modelId)),
      },
      resolveAppManagedTools: (input) => {
        const observed = providerRuntimeRegistry.observedState(input.thread.providerInstanceId);
        const browserSupported =
          observed?.capabilities.appManagedTools === "supported" ||
          observed?.verifiedToolModelIds?.some(
            (candidate) => String(candidate) === String(input.thread.modelId),
          ) === true;
        const native = nativeHarnessComposition?.forWork(input);
        const browser = !browserSupported
          ? undefined
          : createBrowserAppManagedTools({
              windowId: input.windowId,
              threadId: input.thread.id as never,
              mode: "work",
              modelId: String(input.thread.modelId),
              resolveModelId: (threadId) => {
                const current = workThreadProjection.read(threadId as never);
                return current === undefined ? undefined : String(current.modelId);
              },
              modelBindings: browserModelBindings,
              executionPolicy: "approval-gated",
              resolveAuthority: (threadId, mode) => browserAuthority.resolve(threadId, mode),
              browser: {
                inspectThread: (ownerWindowId, threadId) =>
                  browserAutomationService.inspectThread(ownerWindowId, threadId),
                create: (command) => browserAutomationService.create(command),
                act: (command) => browserAutomationService.act(command),
                releaseThread: (ownerWindowId, threadId) =>
                  browserAutomationService.releaseThread(ownerWindowId, threadId),
              },
              approvals: browserToolApprovalService,
              uuid: randomUUID,
            });
        const sideTaskTools = !browserSupported
          ? undefined
          : createSideTaskTools({
              store: sideTasks,
              threadId: String(input.thread.id),
              mode: "work",
              projectId: input.thread.projectId,
              suggestedBy: input.thread,
              uuid: randomUUID,
              clock: () => new Date().toISOString(),
            });
        const agentsTools = !browserSupported
          ? undefined
          : agentsManagedToolsFor({
              windowId: input.windowId,
              parentThreadId: String(input.thread.id),
              mode: "work",
              projectId: input.thread.projectId,
            });
        const canvasTools = !browserSupported
          ? undefined
          : createCanvasAgentTools({
              windowId: input.windowId,
              mode: "work",
              thread: {
                id: String(input.thread.id),
                projectId: String(input.thread.projectId),
                providerInstanceId: input.thread.providerInstanceId,
                modelId: input.thread.modelId,
              },
              port: canvasAgentToolPort,
            });
        const computerOwner = decodeComputerUseOwner({
          windowId: input.windowId,
          threadId: input.thread.id,
          mode: "work",
          providerInstanceId: input.thread.providerInstanceId,
          modelId: input.thread.modelId,
          executionPolicy: "approval-gated",
        });
        const computer =
          input.computerUseSelection === undefined
            ? browserSupported
              ? computerUseTools?.unattachedToolSet(computerOwner)
              : undefined
            : computerToolsFor(computerOwner, input.computerUseSelection);
        if (
          native === undefined &&
          browser === undefined &&
          sideTaskTools === undefined &&
          agentsTools === undefined &&
          computer === undefined &&
          canvasTools === undefined
        )
          return undefined;
        return combineAppManagedToolSets(
          native,
          browser,
          computer,
          sideTaskTools,
          agentsTools,
          canvasTools,
        );
      },
      nativeHarness: nativeHarnessHooks,
      turnFileObserver: new WorkTurnFileObserver(),
      projectStatusFiles: workProjectStatusFiles,
      threads: workThreadService,
      peekIssueContextFramed: peekCreateFromIssueFramed,
      consumeIssueContextFramed: consumeCreateFromIssueFramed,
      projects: projectService,
      projection: workTurnProjection,
      workingDirectories: { resolve: resolveThreadWorkingDirectory },
      resolveDriver: (providerInstanceId) => {
        const instance = persistence.readProviderInstance(providerInstanceId);
        if (instance === undefined) return undefined;
        return attachWorkRequestRuntime(
          makeConfiguredProviderDriver(instance, configuredDriverOptions),
          () => workRequestRuntime,
        );
      },
      attachments: workAttachments,
      supportsModelSwitch: (providerInstanceId) =>
        providerRuntimeRegistry.observedState(providerInstanceId)?.capabilities.modelSwitch ===
        "supported",
      selectConversationHandoff: (thread) =>
        admittedParentWorkContext({
          threadId: thread.id,
          purpose: "provider-switch",
          externalContentIngested: readThreadExternalContentTaint(
            persistence.connection,
            String(thread.id),
          ).externalContentIngested,
          readThread: (id) => workThreadProjection.read(id),
          readTurns: (id) => workTurnProjection.listForThread(id),
        }),
      supportsAttachments: (thread) => {
        const observed = providerRuntimeRegistry.observedState(thread.providerInstanceId);
        if (observed?.capabilities.nativeAttachments !== "supported") return false;
        return observed.models.some(
          (model) =>
            String(model.id) === String(thread.modelId) && model.inputModalities.includes("image"),
        );
      },
      resolveThreadMentionContext: async ({ threadMentionIds, readerThreadId, windowId }) => {
        const resolved = await threadMentionContextResolver(
          () => threadMentionService,
          threadOutsideContentMarks,
        )({
          threadMentionIds,
          readerThreadId,
          windowId,
        });
        return resolved.map((mention) => ({
          kind: "user-message" as const,
          text: mention.kind === "resolved" ? mention.text : THREAD_MENTION_UNREADABLE_CONTEXT,
        }));
      },
      resolveFileMentionContext: async ({ fileMentionPaths, windowId, threadId }) =>
        fileMentionContextBlocks(fileMentionService, {
          windowId,
          scope: { mode: "work", threadId },
          paths: fileMentionPaths,
        }),
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    const fileMentionService = new FileMentionService({
      authority: {
        resolveCodeRoot: async (windowId, threadId, checkoutId) => {
          try {
            const view = await codeService.read(windowId, decodeCodeThreadId(threadId));
            if (String(view.checkout.id) !== checkoutId) return { kind: "unauthorized" };
            const rooted = await roots.resolve(
              windowId,
              view.thread,
              view.checkout,
              codeWorkingDirectoryProbePath,
            );
            if (rooted !== undefined) {
              return {
                kind: "ok",
                rootPath: rooted.rootPath,
                rootIdentity: rooted.rootIdentity,
              };
            }
            // ADR 0017: a Code Project may bind a non-Git folder. Mention
            // confinement follows the authorized checkout directory rather
            // than requiring a Git observation.
            const project = persistence.readProject(view.thread.projectId);
            const revision = project?.type === "code" ? project.bindingHistory.at(-1) : undefined;
            if (
              project?.type !== "code" ||
              project.lifecycle !== "active" ||
              revision?.revisionId !== view.thread.bindingRevisionId
            ) {
              return { kind: "unauthorized" };
            }
            let rootPath: string;
            if (view.checkout.kind !== "managed-worktree") {
              rootPath = project.binding.canonicalRoot;
            } else {
              const receipt = await managedWorktreeReceipts.load(view.checkout.ownershipReceiptId);
              if (
                receipt === undefined ||
                receipt.state !== "ready" ||
                receipt.canonicalWorktreePath === undefined
              ) {
                return { kind: "unavailable" };
              }
              rootPath = receipt.canonicalWorktreePath;
            }
            const metadata = await lstat(rootPath, { bigint: true });
            if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
              return { kind: "unavailable" };
            }
            return {
              kind: "ok",
              rootPath,
              rootIdentity: {
                device: metadata.dev.toString(10),
                inode: metadata.ino.toString(10),
              },
            };
          } catch {
            return { kind: "unauthorized" };
          }
        },
        resolveWorkRoot: async (windowId, threadId) => {
          try {
            const bootstrap = await workThreadService.bootstrap(windowId);
            const thread = bootstrap.threads.find((candidate) => String(candidate.id) === threadId);
            if (thread === undefined) return { kind: "not-found" };
            const project = persistence.readProject(thread.projectId);
            if (
              project === undefined ||
              project.type !== "work" ||
              project.lifecycle !== "active"
            ) {
              return { kind: "unauthorized" };
            }
            const latest = project.bindingHistory.at(-1);
            if (
              thread.bindingRevisionId === undefined ||
              latest === undefined ||
              String(thread.bindingRevisionId) !== String(latest.revisionId)
            ) {
              return { kind: "unauthorized" };
            }
            return pinFileMentionRoot(project.binding.canonicalRoot);
          } catch {
            return { kind: "unavailable" };
          }
        },
      },
    });
    const fileMentionRoutes = createFileMentionRouteHandler({
      service: fileMentionService,
      windowAuthorityStore,
      maxJsonBodySize: MAX_JSON_REQUEST_BODY_SIZE,
    });
    const threadExportService = new ThreadExportService({
      hostId: LOCAL_HOST_ID,
      clock: () => new Date().toISOString(),
      chat: {
        read: (threadId) => {
          try {
            return chatService.read(decodeChatThreadId(threadId));
          } catch {
            return undefined;
          }
        },
      },
      work: {
        read: async (windowId, threadId) => {
          try {
            const id = decodeWorkThreadId(threadId);
            const turns = await workTurnService.turns(windowId, id);
            const bootstrap = await workThreadService.bootstrap(windowId);
            const thread = bootstrap.threads.find((candidate) => String(candidate.id) === threadId);
            if (thread === undefined) return undefined;
            return { thread, turns };
          } catch {
            return undefined;
          }
        },
      },
      code: {
        readThread: async (windowId, threadId) => {
          try {
            const view = await routeCodeService.read(windowId, decodeCodeThreadId(threadId));
            return {
              threadId: String(view.thread.id),
              title: view.thread.title,
              projectId: view.thread.projectId,
              version: view.thread.version,
              lastSequence: view.lastSequence,
              providerInstanceId: view.thread.providerInstanceId,
              modelId: view.thread.modelId,
              createdAt: view.thread.createdAt,
              updatedAt: view.thread.updatedAt,
              ...(view.thread.forkedFrom === undefined
                ? {}
                : { forkedFrom: { threadId: String(view.thread.forkedFrom.threadId) } }),
            };
          } catch {
            return undefined;
          }
        },
        conversation: async (windowId, threadId, afterCursor, limit) => {
          const read = routeCodeService.conversation;
          if (read === undefined) throw new Error("Code conversation is unavailable.");
          return await read(windowId, threadId, afterCursor, limit);
        },
        readEvidence: async (windowId, threadId, operationId, contentId) => {
          const read = routeCodeService.readOperationContent;
          if (read === undefined) throw new Error("Code operation evidence is unavailable.");
          return await read(windowId, threadId, operationId, contentId);
        },
      },
      canvases: persistence.canvasProjection,
      generatedImages: {
        listByScope: (scopeId) => imageJobService.listByScope(scopeId),
      },
      browserCaptures,
    });
    const threadExportRoutes = createThreadExportRouteHandler({
      service: threadExportService,
      windowAuthorityStore,
    });
    // Hand-off starts from the export cut and keeps its document as a Canvas
    // of the thread, resolved from the thread the way an authoring agent's
    // Canvas is — never from whichever Project the window happens to show.
    const threadHandOffService = new ThreadHandOffService({
      exports: threadExportService,
      provider: {
        readiness: (providerInstanceId) => {
          const instance = persistence.readProviderInstance(providerInstanceId);
          if (instance === undefined || !instance.enabled) return undefined;
          return providerRuntimeRegistry.observedState(providerInstanceId)?.readiness;
        },
        complete: makeThreadHandOffCompletion({
          resolveDriver: (providerInstanceId) => {
            const instance = persistence.readProviderInstance(providerInstanceId);
            if (instance === undefined || !instance.enabled) return undefined;
            try {
              return makeConfiguredProviderDriver(instance, configuredDriverOptions);
            } catch {
              return undefined;
            }
          },
          scratchRoot: (threadId) => {
            const root = join(persistence.dataDirectory, "hand-off-scratch", threadId);
            mkdirSync(root, { recursive: true, mode: 0o700 });
            return root;
          },
          uuid: randomUUID,
        }),
      },
      documents: {
        save: async ({ windowId, mode, threadId, projectId, title, blocks }) => {
          const bootstrap = await projectService.bootstrap(windowId);
          const project = bootstrap.active.find(
            (candidate) => String(candidate.id) === String(projectId),
          );
          if (project === undefined || project.lifecycle !== "active" || project.type !== mode) {
            return { kind: "refused", message: "The thread's Project is unavailable." };
          }
          // The scope is derived by the resolver the Canvas surfaces already
          // use, not built alongside it. A hand-built scope disagreed with the
          // resolver on all three modes, and `validateCanvasRefreshRequest`
          // compares the two, so a handed-off Canvas could refuse its own
          // refresh as a scope mismatch.
          //
          // It also answers with `undefined` rather than throwing: the provider
          // call before this is bounded at 180 seconds, and the thread can be
          // archived or its checkout can go away while that runs.
          const workspace = resolveCanvasWorkspace({ mode, threadId });
          if (workspace === undefined) {
            return { kind: "refused", message: "The thread's workspace is unavailable." };
          }
          const created = canvasService.create(
            {
              schemaVersion: 1,
              kind: "canvas-create",
              requestId: randomUUID(),
              intent: "blank",
              hostId: LOCAL_HOST_ID,
              mode,
              workspace,
              originThreadId: threadId,
              title,
              sourceManifest: [],
              // A hand-off is a document: it reads nothing and runs nothing.
              requestedAuthority: {
                filesystem: false,
                shell: false,
                git: false,
                network: false,
                tools: false,
                subagents: false,
                executionPolicy: "plan",
                permissionPersistence: "current-session",
              },
            },
            { mode, projectId: String(projectId) },
            { id: String(project.id), type: mode, lifecycle: "active" },
            blocks,
          );
          if (created.kind !== "accepted") {
            return { kind: "refused", message: created.message };
          }
          return {
            kind: "saved",
            canvasId: String(created.card.canvasId),
            versionId: String(created.card.versionId),
          };
        },
      },
    });
    const threadHandOffRoutes = createThreadHandOffRouteHandler({
      service: threadHandOffService,
      windowAuthorityStore,
    });
    // Work workflow projection: a downstream side channel driven by
    // already-authorized Work thread lifecycle facts, never an independent
    // authority source. `withWorkflowLifecycle` wraps the thread route
    // service so every successful create/lifecycle-change also feeds the
    // rebuildable workflow projection Overview reads from.
    // A goal loop keeps working on a Work thread's goal without a person
    // watching. It runs ordinary Work turns through the same service a person's
    // turn goes through, so it adds no place work happens and no authority the
    // thread did not already have; everything it may or may not do is decided
    // by the domain and journaled here.
    // What a Work turn is fixed at, stated once. Work has no shell, Git, or
    // reach outside the Project: every provider driver withholds them from a
    // Work session rather than asking. File writes inside the Project are
    // approval-gated unless the thread's access auto-accepts edits (see
    // workTurnPosture). This is a fact about the mode and not a grant anyone
    // can change.
    const WORK_TURN_POSTURE = {
      filesystem: true,
      shell: false,
      git: false,
      network: false,
      tools: true,
      subagents: false,
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
    } as const;
    const workTurnPosture = (threadId: string) => {
      const thread = workThreadProjection.read(threadId as never);
      if (thread === undefined || thread.lifecycle !== "active") return undefined;
      return {
        ...WORK_TURN_POSTURE,
        executionPolicy:
          thread.access === "auto-accept-edits"
            ? ("auto-accept-edits" as const)
            : ("approval-gated" as const),
      };
    };
    // A goal-loop round runs as the host, so no window stands in for the
    // shell's mode switch: a loop whose Work was turned off pauses, and a
    // round already being prepared is refused at its turn's admission.
    const goalLoopWorkEnabled = (): boolean =>
      enabledModes(persistence.readShellSettings()?.settings ?? defaultShellSettings()).includes(
        "work",
      );
    const goalLoopEvents = new GoalLoopEventStore({
      journal: persistence.journal,
      uuid: randomUUID,
      clock: () => new Date().toISOString() as never,
      actor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
    });
    const goalLoopScheduler = new GoalLoopScheduler({
      advance: (threadId) => goalLoopService.advance(threadId),
    });
    const goalLoopService = new GoalLoopService({
      readGoal: (threadId) => goalService.read(threadId).goal,
      recordUsage: async ({ threadId, goal, tokensSpent, elapsedMs, evidence, complete }) => {
        // The round's own turn may have moved the goal — a harness lead runs
        // goal checks, and the last passing one completes it. Charge the round
        // against the goal as it is now; a goal its own checks completed is
        // finished and takes no further spend.
        const current = goalService.read(threadId).goal ?? goal;
        if (current.status === "complete") return;
        const recorded = await goalService.execute({
          kind: "record-thread-goal-usage",
          threadId,
          expectedVersion: current.version,
          goalId: goal.id,
          deltaTokens: tokensSpent,
          deltaElapsedMs: elapsedMs,
          deltaTurns: 1,
        });
        if (!complete) return;
        await goalService.execute({
          kind: "complete-thread-goal",
          threadId,
          expectedVersion: recorded.goal.version,
          goalId: goal.id,
          evidence: evidence.slice(0, 16),
        });
      },
      threadAuthority: (threadId) => {
        if (!goalLoopWorkEnabled()) return undefined;
        try {
          return workTurnPosture(threadId);
        } catch {
          return undefined;
        }
      },
      // What a Work turn is fixed at. There is no per-turn grant to narrow, so
      // a ceiling asking for less than this is refused when the loop starts
      // rather than quietly ignored on every round.
      modePosture: (threadId) => workTurnPosture(threadId) ?? WORK_TURN_POSTURE,
      // Between rounds a Work thread has nothing pending. Its approvals are
      // asked inside a running turn, and a turn's open requests are
      // interrupted when its provider session ends, so each round's requests
      // end with that round. Shell and Git never ask in Work.
      pendingApproval: () => undefined,
      // A Work folder has no checkpoint to mark. Checkpoints anchor a Chat turn
      // or a Code operation; a Work turn records which paths changed, never
      // their contents, so it cannot restore the folder, and Work holds no
      // Git. Asking the checkpoint service anyway was refused every time and
      // paused every loop before its first round. The policy runs a round
      // without one only when a person approves every write it makes.
      markCheckpoint: async () => undefined,
      runRound: createGoalLoopWorkRoundRunner({
        turns: workTurnService,
        usage: workTurnUsageStore,
        workEnabled: goalLoopWorkEnabled,
        command: ({ threadId, objective }) => {
          const thread = workThreadProjection.read(threadId as never);
          if (thread === undefined) {
            throw new Error("The Work thread this goal loop runs in is unavailable.");
          }
          return {
            kind: "start-work-thread-turn",
            requestId: randomUUID(),
            threadId,
            turnId: randomUUID(),
            prompt: objective,
            authority: {
              hostId: LOCAL_HOST_ID,
              projectId: thread.projectId,
              bindingRevisionId: thread.bindingRevisionId,
              workingDirectory: ".",
              confinementPosture: "project-root-confined",
              providerInstanceId: thread.providerInstanceId,
              modelId: thread.modelId,
            },
          };
        },
        uuid: randomUUID,
      }),
      scheduleNextRound: (threadId) => goalLoopScheduler.schedule(threadId),
      scheduleFirstRound: (threadId) => goalLoopScheduler.schedule(threadId),
      journal: goalLoopEvents,
      uuid: randomUUID,
      clock: () => new Date().toISOString() as never,
    });
    const goalLoopRoutes = createGoalLoopRouteHandler({
      service: goalLoopService,
      windowAuthorityStore,
      authorizeThread: authorizeWorkThreadForWindow,
    });
    // A goal loop schedules its own rounds, so a person's pause of the
    // thread's harness session must stop it too; it stays paused until a
    // person resumes the loop itself.
    onHarnessPausedByPerson(({ threadId }) => {
      const loop = goalLoopService.read(threadId).loop;
      if (loop?.status !== "running") return;
      void goalLoopService
        .execute({ kind: "pause-goal-loop", threadId, expectedVersion: loop.version })
        .catch(() => undefined);
    });

    const workflowProjection = new WorkflowProjection();
    const workflowEventStore = new WorkflowEventStore({
      journal: persistence.journal,
      uuid: randomUUID,
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    });
    const workflowService = new WorkflowService({
      projection: workflowProjection,
      eventStore: workflowEventStore,
      threads: {
        listFacts: () => workThreadProjection.listLifecycleFacts(),
      },
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    workflowService.hydrate();
    const workThreadServiceWithWorkflows = withWorkflowLifecycle({
      threads: workThreadService,
      workflows: workflowService,
    });
    sideTaskFirstMessage.current = async ({ windowId, mode, threadId, prompt }) => {
      const window = decodeWindowId(windowId);
      if (mode === "chat") {
        const thread = persistence.readChatThread(threadId as never);
        if (thread === undefined) return false;
        // A Chat send settles when the reply ends; the side task is started
        // the moment the message is in, so the new thread opens right away.
        return await new Promise<boolean>((resolve) => {
          chatService
            .execute(
              {
                kind: "send-chat-turn",
                threadId: thread.id,
                expectedVersion: thread.version,
                prompt,
              },
              { windowId: window, onTurnAccepted: () => resolve(true) },
            )
            .then(
              () => resolve(true),
              () => resolve(false),
            );
        });
      }
      if (mode === "work") {
        const thread = workThreadProjection.read(decodeWorkThreadId(threadId));
        if (thread === undefined || thread.bindingRevisionId === undefined) return false;
        const result = await workTurnService.startFirstTurn(window, {
          kind: "start-work-thread-turn",
          requestId: decodeWorkTurnRequestId(randomUUID()),
          threadId: thread.id,
          turnId: decodeWorkTurnId(randomUUID()),
          prompt,
          authority: {
            hostId: LOCAL_HOST_ID,
            projectId: thread.projectId,
            bindingRevisionId: thread.bindingRevisionId,
            workingDirectory: ".",
            confinementPosture: "project-root-confined",
            providerInstanceId: thread.providerInstanceId,
            modelId: thread.modelId,
          },
        });
        return result.kind === "accepted";
      }
      const thread = persistence.readCodeThread(decodeCodeThreadId(threadId));
      if (
        thread === undefined ||
        routeCodeService.stageEvidence === undefined ||
        routeCodeService.executeOperation === undefined
      )
        return false;
      // The prompt is staged as evidence first, as the composer does, so the
      // turn records the bytes it was started with.
      const evidence = await routeCodeService.stageEvidence(window, thread.id, prompt);
      const result = await routeCodeService.executeOperation(window, {
        kind: "start-provider-turn",
        operationId: decodeCodeOperationId(randomUUID()),
        threadId: thread.id,
        checkoutId: thread.checkoutId,
        sessionId: decodeProviderSessionId(randomUUID()),
        prompt: evidence,
      });
      return (
        result.kind === "provider-turn-state" &&
        (result.state === "running" || result.state === "waiting")
      );
    };
    followUpCreation.current = {
      chat: chatService,
      work: workThreadServiceWithWorkflows,
      code: codeService,
      readCodeThread: (threadId) => persistence.readCodeThread(threadId),
      readProject: (projectId) => persistence.readProject(projectId),
      isMarkedWithOutsideContent: (threadId) =>
        readThreadExternalContentTaint(persistence.connection, threadId).externalContentIngested,
      hostId: LOCAL_HOST_ID,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    };
    const queueAttachments = createThreadMessageQueueAttachments({
      chatStore: chatAttachmentStore,
      codeStore: codeAttachments,
      workStore: workAttachments,
      readChatAttachment: (threadId, attachmentId) =>
        persistence
          .readChatThreadView(decodeChatThreadId(threadId))
          ?.attachments.find((attachment) => String(attachment.id) === String(attachmentId)),
      discardChatAttachment: (threadId, attachmentId) =>
        chatService.discardAttachment(threadId, attachmentId).then(() => undefined),
      isTurnOwned: (mode, threadId, attachmentId) => {
        if (mode === "chat")
          return (
            persistence
              .readChatThreadView(decodeChatThreadId(threadId))
              ?.turns.some((turn) =>
                turn.attachmentIds.some((id) => String(id) === String(attachmentId)),
              ) ?? false
          );
        if (mode === "work")
          return workTurnProjection
            .listForThread(decodeWorkThreadId(threadId))
            .some((turn) =>
              turn.attachments?.some(
                (attachment) => String(attachment.attachmentId) === String(attachmentId),
              ),
            );
        return (
          persistence.connection
            .prepare(`
          SELECT 1 FROM event_journal AS event,
            json_each(event.payload_json, '$.event.attachments') AS attachment
          WHERE event.event_name = 'code.operation-event-recorded@1'
            AND json_extract(event.payload_json, '$.threadId') = ?
            AND json_extract(event.payload_json, '$.event.kind') = 'conversation-turn-started'
            AND json_extract(attachment.value, '$.attachmentId') = ? LIMIT 1
        `)
            .get(String(threadId), String(attachmentId)) !== undefined
        );
      },
    });
    const threadMessageQueue = new ThreadMessageQueueService({
      connection: persistence.connection,
      journal: persistence.journal,
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      clock: () => new Date().toISOString(),
      port: createThreadMessageQueuePort({
        persistence,
        journal: persistence.journal,
        chat: chatService,
        work: {
          readThread: (id) => workThreadProjection.read(id),
          listTurns: (id) => workTurnProjection.listForThread(id),
          startFirstTurn: (windowId, command, admissionOptions) =>
            workTurnService.startFirstTurn(windowId, command, admissionOptions),
        },
        code: routeCodeService,
        compacting: (scope) =>
          contextHarness.compactionRunning(
            decodeContextSubjectRef({
              aggregateType: `${scope.mode}-thread`,
              aggregateId: scope.threadId,
            }),
          ),
        isModeEnabled: (mode) =>
          enabledModes(
            persistence.readShellSettings()?.settings ?? defaultShellSettings(),
          ).includes(mode),
        isWindowLive: (windowId) =>
          windowAuthorityStore.listWindowIds().some((id) => String(id) === String(windowId)),
        canAccess: (windowId, mode, projectId) => {
          if (mode === "chat")
            return projectId === undefined || persistence.readProject(projectId)?.type === "chat";
          if (projectId === undefined) return false;
          return mode === "code"
            ? canAccessCodeProject(windowId, projectId)
            : windowHoldsProject(windowId, projectId, mode);
        },
        effectiveCodeThread: (windowId, thread) =>
          codeSessionAuthority.effectiveThread(windowId, thread),
        attachments: queueAttachments,
      }),
    });
    yield* Effect.promise(() => threadMessageQueue.recover());
    onWindowRevoked((windowId) => {
      void threadMessageQueue
        .revokeWindow(windowId)
        .catch(() => console.error("Queued message authority could not be revoked."));
    });
    guardChatAttachmentPurge(async (threadId) => {
      const result = await threadMessageQueue.purgeThread(
        decodeThreadMessageQueueScope({ mode: "chat", threadId }),
      );
      if (result.status !== "released")
        throw new Error("Queued attachments could not be released.");
    });
    yield* Effect.promise(() => chatService.recoverPendingDeletions());
    // Accepted queue items retain images before draft recovery removes uploads
    // whose composer disappeared during the previous host process.
    yield* Effect.promise(() => chatService.recoverManagedAttachments());
    yield* Effect.promise(() => codeAttachments.recover());
    yield* Effect.promise(() => workAttachments.recover());
    const advanceMessageQueue = () => {
      void threadMessageQueue
        .tick()
        .catch(() => console.error("The message queue could not advance."));
    };
    const unsubscribeMessageQueue = persistence.journal.subscribeCommitted((append) => {
      void threadMessageQueue
        .onCommittedAppend(append)
        .catch(() => console.error("The message queue could not process a thread change."));
    });
    const messageQueueTimer = setInterval(advanceMessageQueue, 1000);
    const stopEventLoopLagDetector = startEventLoopLagDetector();
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        stopEventLoopLagDetector();
        clearInterval(messageQueueTimer);
        unsubscribeMessageQueue();
        threadMessageQueue.dispose();
        await threadMessageQueue.awaitIdle();
      }),
    );
    const threadMessageQueueRoutes = createThreadMessageQueueRouteHandler({
      service: threadMessageQueue,
      windowAuthorityStore,
    });
    return {
      fileMentionRoutes,
      fileMentionService,
      goalLoopRoutes,
      goalLoopService,
      threadExportRoutes,
      threadExportService,
      threadHandOffRoutes,
      threadMessageQueue,
      threadMessageQueueRoutes,
      workArtifactProjection,
      workThreadService,
      observeWorkThreadRuntime,
      workThreadServiceWithWorkflows,
      workTurnService,
      workflowService,
    };
  });
}

export type WorkWiring = Effect.Effect.Success<ReturnType<typeof wireWork>>;
