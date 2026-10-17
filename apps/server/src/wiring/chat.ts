import { decodeComputerUseOwner } from "@octant/contracts/computer-use-plugin";
import { randomUUID } from "node:crypto";
import {
  type ChatThread,
  type ChatThreadId,
  decodeAgentRunParentThreadId,
  decodeChatThreadId,
  decodeCodeThreadId,
  decodeImageGenerationScopeId,
  decodeLayoutNodeId,
  decodeMentionableThreadId,
  decodePaneId,
  decodeProjectId,
  decodeWorkspaceTabId,
  decodeWorkThreadId,
  type ProjectId,
  ReplayCursor,
  type WindowId,
  type WorkThreadId,
} from "@octant/contracts";
import { ExtensionProviderFamily } from "@octant/contracts/extensions";
import { Effect, Schema } from "effect";
import { ChatService } from "../chat/chatService";
import { createChatRouteHandler } from "../chatRoutes";
import { createScaffoldRouteHandler } from "../scaffoldRoutes";
import { filterSkillCatalogForScope } from "@octant/plugin-host";
import { createWorkspacePresetRouteHandler } from "../workspacePresetRoutes";
import { CURATED_WORKSPACE_PRESETS } from "../workspacePresets/curatedWorkspacePresets";
import { createThreadCheckpointRouteHandler } from "../threadCheckpointRoutes";
import {
  createCheckpointChatPort,
  createCheckpointCodePort,
} from "../checkpoint/threadCheckpointPorts";
import { ThreadCheckpointService } from "../checkpoint/threadCheckpointService";
import { WorkFileListingService } from "../work/workFileListingService";
import { liveWorkFilesystem } from "../work/workFilesystemPort";
import { WorkThreadService } from "../work/workThreadService";
import { WorkTurnService } from "../work/workTurnService";
import { attachWorkRequestRuntime } from "../work/workRequestRuntime";
import { JournalNavigatorAssistantBindingStore } from "../navigatorAssistant/navigatorAssistantBindingStore";
import { MAX_CHAT_ATTACHMENT_BYTES } from "../chat/chatAttachmentStore";
import { createImageAgentTools } from "../image/imageAgentTools";
import { createLinkedThreadRouteHandler } from "../linkedThread/linkedThreadRoutes";
import { createLinkedThreadRuntime } from "../linkedThread/linkedThreadRuntime";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { childAgentTools } from "../chat/sideChatDelegation";
import { SideChatSidecarStore } from "../chat/sideChatSidecarStore";
import {
  createChatSideChatThreadFactory,
  createChatThreadMentionDirectory,
  createCodeThreadMentionDirectory,
  createWorkThreadMentionDirectory,
  threadMentionContextResolver,
  ThreadMentionService,
} from "../chat/threadMentionService";
import { ThreadDialogueService } from "../chat/threadDialogueService";
import {
  createSideChatSourceStateReader,
  resolveSideChatSourceContext,
} from "../chat/sideChatSource";
import {
  createSideChatSourceTools,
  createSideChatWorkFileReader,
  type SideChatFileSource,
} from "../chat/sideChatSourceTools";
import { createThreadMentionRouteHandler } from "../threadMentionRoutes";
import {
  createExtensionChatResolver,
  createStoredExtensionMaterialLoader,
} from "../extensions/extensionChatResolver";
import { CURATED_SCAFFOLDS, curatedScaffoldTools } from "../scaffold/curatedScaffoldCatalog";
import { resolveAvailableTools } from "../scaffold/scaffoldFilesystem";
import { hydrateAgentMessageProjectionFromJournal } from "../agentMessage/agentMessageProjection";
import { createSideTaskTools } from "../sideTasks/sideTaskTools";
import { defaultShellSettings, findWorkspacePresetTarget } from "@octant/domain";
import { createCanvasAgentTools } from "../canvas/canvasAgentTools";
import type { AppManagedToolSet } from "../chat/chatTurnRunner";
import { combineAppManagedToolSets } from "../providers/appManagedToolSet";
import { taintAppManagedToolResults } from "../providers/appManagedToolTaint";
import { requireJournalHydration } from "../persistence/journalHydration";
import { makeConfiguredProviderDriver, type ProvidersWiring } from "./providers";
import { MAX_JSON_REQUEST_BODY_SIZE, type ServerStart } from "./serverShape";
import type { AuthorityWiring } from "./authority";
import type { FoundationsWiring } from "./foundations";
import type { AgentRunsWiring } from "./agentRuns";
import type { IntegrationsWiring } from "./integrations";
import type { ComputerUseWiring } from "./computerUse";
import type { WorkspaceWiring } from "./workspace";
import type { WorkRequestStateWiring } from "./workRequestState";
import type { CodeWiring } from "./code";
import type { CodeRuntimeWiring } from "./codeRuntime";
import type { HarnessWiring } from "./harness";
import type { CanvasWiring } from "./canvas";

/**
 * Largest Work file a Side Chat will read. The tool returns at most a few
 * hundred lines of it, so anything past this is refused as too large rather
 * than loaded whole to show a sliver.
 */
const SIDE_CHAT_WORK_READ_MAX_BYTES = 2 * 1024 * 1024;

export type ChatDependencies = Pick<ServerStart, "options" | "persistence"> &
  Pick<
    AuthorityWiring,
    | "agentRunPersistence"
    | "browserCaptures"
    | "liveTurns"
    | "machineChangeFeed"
    | "windowAuthorityStore"
  > &
  Pick<
    AgentRunsWiring,
    | "agentsManagedToolsFor"
    | "capacityScheduler"
    | "externalContentIngestionStore"
    | "nativeHarnessHooks"
    | "runtimeOutsideContentMarks"
    | "sideTasks"
    | "spendCeiling"
    | "threadAwaitsHarnessApproval"
  > &
  Pick<
    IntegrationsWiring,
    | "agentMessageProjection"
    | "agentMessageService"
    | "githubIssueContextService"
    | "linearIssueContextService"
    | "threadOutsideContentMarks"
  > &
  Pick<ComputerUseWiring, "computerToolsFor" | "computerUseTools"> &
  Pick<WorkspaceWiring, "contextHarness" | "shellService"> &
  Pick<WorkRequestStateWiring, "workRequestRuntime"> &
  Pick<CodeWiring, "environmentService"> &
  Pick<
    ProvidersWiring,
    | "agentPluginMcpSessionManager"
    | "chatAttachmentStore"
    | "chatDataDirectory"
    | "configuredDriverOptions"
    | "extensionActivationService"
    | "extensionApiService"
    | "extensionPackageStore"
    | "imageJobService"
    | "reviewedModelManifest"
    | "skillDiscoveryService"
  > &
  Pick<CodeRuntimeWiring, "codeService" | "routeCodeService"> &
  Pick<CanvasWiring, "canvasAgentToolPort"> &
  Pick<HarnessWiring, "nativeHarnessComposition" | "researchRouter" | "threadWork"> & {
    /** Wired by wireWorkFiles; read only after startup. */
    readonly workFileListingService: () => WorkFileListingService;
    /** Wired by wireWork; read only after startup. */
    readonly workThreadService: () => WorkThreadService;
    /** Wired by wireWork; read only after startup. */
    readonly workTurnService: () => WorkTurnService;
  } & Pick<FoundationsWiring, "providerRuntimeRegistry">;

export function wireChat(deps: ChatDependencies) {
  const {
    threadAwaitsHarnessApproval,
    agentMessageProjection,
    agentMessageService,
    agentPluginMcpSessionManager,
    agentRunPersistence,
    agentsManagedToolsFor,
    browserCaptures,
    canvasAgentToolPort,
    capacityScheduler,
    chatAttachmentStore,
    chatDataDirectory,
    codeService,
    computerToolsFor,
    computerUseTools,
    configuredDriverOptions,
    contextHarness,
    environmentService,
    extensionActivationService,
    extensionApiService,
    extensionPackageStore,
    externalContentIngestionStore,
    githubIssueContextService,
    imageJobService,
    linearIssueContextService,
    liveTurns,
    machineChangeFeed,
    nativeHarnessComposition,
    nativeHarnessHooks,
    options,
    persistence,
    providerRuntimeRegistry,
    researchRouter,
    reviewedModelManifest,
    routeCodeService,
    runtimeOutsideContentMarks,
    shellService,
    sideTasks,
    skillDiscoveryService,
    spendCeiling,
    threadOutsideContentMarks,
    threadWork,
    windowAuthorityStore,
    workFileListingService,
    workThreadService,
    workTurnService,
    workRequestRuntime,
  } = deps;
  return Effect.gen(function* () {
    let threadDialogueService: ThreadDialogueService | undefined;
    // Side Chat sidecars are ordinary Chat threads that must not appear in
    // Recents/Unfiled/Project listings; the store is the single source of which
    // ids stay hidden, while read() still opens them for the Side Chat tab.
    const sideChatSidecars = new SideChatSidecarStore(chatDataDirectory);
    yield* Effect.promise(() => sideChatSidecars.hydrate());
    // The host-owned Navigator conversation is an ordinary Chat thread that
    // must stay out of every listing, so it rides the same hidden-thread seam
    // as a Side Chat sidecar rather than a second hiding mechanism. Its
    // binding is journaled, so the conversation survives a restart.
    const navigatorAssistantBindings = new JournalNavigatorAssistantBindingStore({
      journal: persistence.journal,
      uuid: randomUUID,
    });
    // The Work folder a Side Chat's source thread reads from, re-derived on the
    // caller's window each time: the thread must be among the window's Work
    // threads, its Project active, and the thread on the Project's current
    // binding, the same checks an `@file` mention makes before it reads.
    const sideChatWorkFolder = async (windowId: WindowId, threadId: WorkThreadId) => {
      const bootstrap = await workThreadService().bootstrap(windowId);
      const thread = bootstrap.threads.find(
        (candidate) => String(candidate.id) === String(threadId),
      );
      if (thread === undefined) return undefined;
      const project = persistence.readProject(thread.projectId);
      if (project === undefined || project.type !== "work" || project.lifecycle !== "active") {
        return undefined;
      }
      const latest = project.bindingHistory.at(-1);
      if (
        thread.bindingRevisionId === undefined ||
        latest === undefined ||
        String(thread.bindingRevisionId) !== String(latest.revisionId)
      ) {
        return undefined;
      }
      return {
        projectId: project.id,
        projectName: project.name,
        canonicalRoot: project.binding.canonicalRoot,
        ...(thread.workingDirectory === undefined
          ? {}
          : { workingDirectory: String(thread.workingDirectory) }),
      };
    };
    const sideChatSourceState = createSideChatSourceStateReader({
      code: {
        readThread: async (windowId, threadId) =>
          (await routeCodeService.read(windowId, threadId)).thread,
        observeCheckout: (windowId, projectId, threadId) =>
          environmentService.observeThreadChanges(windowId, projectId, threadId),
        conversation: async (windowId, threadId, afterCursor, limit) => {
          const read = routeCodeService.conversation;
          if (read === undefined) throw new Error("Code conversation is unavailable.");
          return await read(windowId, threadId, afterCursor, limit);
        },
      },
      work: { readFolder: sideChatWorkFolder },
      subagents: (parentThreadId) =>
        agentRunPersistence.parentSummary(decodeAgentRunParentThreadId(parentThreadId)),
    });
    /**
     * The read-only file tools for a Side Chat turn, or `undefined` when the
     * thread is not a sidecar or its source has no files (Chat). Which tools
     * exist is fixed by the sidecar's recorded source mode; whether a call may
     * run is decided again at the call.
     */
    const sideChatFileTools = (windowId: WindowId, threadId: ChatThreadId) => {
      const sidecar = sideChatSidecars.findBySidecarThread(threadId);
      if (sidecar === undefined || sidecar.sourceMode === "chat") return undefined;
      const authorize = async () =>
        sideChatSidecars.findBySidecarThread(threadId) !== undefined &&
        (await threadMentionService.openableThread(windowId, sidecar.sourceThreadId)) !== undefined;
      let source: SideChatFileSource;
      if (sidecar.sourceMode === "code") {
        source = {
          mode: "code",
          threadId: decodeCodeThreadId(String(sidecar.sourceThreadId)),
          reads: {
            checkoutOf: async (codeThreadId) => {
              const view = await routeCodeService.read(windowId, codeThreadId);
              return {
                checkoutId: view.thread.checkoutId,
                availability: view.checkout.availability,
              };
            },
            listFiles: async (input) => {
              const list = routeCodeService.listFiles;
              if (list === undefined) {
                return {
                  status: "failed",
                  failure: { category: "unavailable", message: "File listing is unavailable." },
                };
              }
              return await list(windowId, input);
            },
            searchFiles: async (input) => {
              const search = routeCodeService.searchFiles;
              if (search === undefined) {
                return {
                  status: "failed",
                  failure: { category: "unavailable", message: "File search is unavailable." },
                };
              }
              return await search(windowId, input);
            },
            readFile: async (input) => {
              const read = routeCodeService.readFile;
              if (read === undefined) return { status: "unavailable" };
              return await read(windowId, input);
            },
          },
        };
      } else {
        const workThreadId = decodeWorkThreadId(String(sidecar.sourceThreadId));
        source = {
          mode: "work",
          threadId: workThreadId,
          reads: {
            listFiles: async (input) => {
              const folder = await sideChatWorkFolder(windowId, input.threadId);
              if (folder === undefined) {
                return {
                  status: "failed",
                  failure: {
                    category: "unauthorized",
                    message: "This Project's folder is not available.",
                  },
                };
              }
              return await workFileListingService().list({
                threadId: input.threadId,
                projectId: folder.projectId,
                rootPath: folder.canonicalRoot,
                ...(input.directory === undefined ? {} : { directory: input.directory }),
                ...(input.signal === undefined ? {} : { signal: input.signal }),
              });
            },
            readFile: createSideChatWorkFileReader({
              filesystem: liveWorkFilesystem,
              resolveRoot: async (id) => (await sideChatWorkFolder(windowId, id))?.canonicalRoot,
              maximumBytes: SIDE_CHAT_WORK_READ_MAX_BYTES,
            }),
          },
        };
      }
      return createSideChatSourceTools({ source, authorize });
    };
    // Areas built after Chat contribute to it here, so Chat never holds them:
    // a guard that must settle before a thread's attachments are purged, and
    // a source of app-managed tools for a thread's turns.
    const attachmentPurgeGuards: Array<(threadId: ChatThreadId) => Promise<void>> = [];
    const guardChatAttachmentPurge = (guard: (threadId: ChatThreadId) => Promise<void>): void => {
      attachmentPurgeGuards.push(guard);
    };
    const chatToolContributors: Array<
      (windowId: WindowId, thread: ChatThread) => AppManagedToolSet | undefined
    > = [];
    const contributeChatTools = (
      contributor: (windowId: WindowId, thread: ChatThread) => AppManagedToolSet | undefined,
    ): void => {
      chatToolContributors.push(contributor);
    };
    const chatService = new ChatService({
      liveTurns,
      awaitsHarnessApproval: threadAwaitsHarnessApproval,
      recordExternalContentIngestion: (input) => externalContentIngestionStore.record(input),
      outsideContentMarks: runtimeOutsideContentMarks,
      attachmentStore: chatAttachmentStore,
      beforeAttachmentPurge: async (threadId) => {
        if (attachmentPurgeGuards.length === 0)
          throw new Error("Queued attachment cleanup is not available.");
        for (const guard of attachmentPurgeGuards) await guard(threadId);
      },
      agentRuns: agentRunPersistence,
      resolveComputerUseTools: ({ windowId, thread, selection }) =>
        computerToolsFor(
          decodeComputerUseOwner({
            windowId,
            threadId: thread.id,
            mode: "chat",
            providerInstanceId: thread.providerInstanceId,
            modelId: thread.modelId,
            executionPolicy: "approval-gated",
          }),
          selection,
        ),
      resolveUnattachedComputerUseTools: ({ windowId, thread }) => {
        const observed = providerRuntimeRegistry.observedState(thread.providerInstanceId);
        const supported =
          observed?.capabilities.appManagedTools === "supported" ||
          observed?.verifiedToolModelIds?.some(
            (candidate) => String(candidate) === String(thread.modelId),
          ) === true;
        if (!supported) return undefined;
        return computerUseTools?.unattachedToolSet(
          decodeComputerUseOwner({
            windowId,
            threadId: thread.id,
            mode: "chat",
            providerInstanceId: thread.providerInstanceId,
            modelId: thread.modelId,
            executionPolicy: "approval-gated",
          }),
        );
      },
      spendCeiling,
      persistence,
      issueContext: githubIssueContextService,
      linearIssueContext: linearIssueContextService,
      reviewedModelManifest,
      hiddenThreadIds: () => {
        const hidden = new Set(sideChatSidecars.hiddenThreadIds());
        for (const threadId of navigatorAssistantBindings.hiddenThreadIds()) hidden.add(threadId);
        return hidden;
      },
      // A Side Chat sidecar is a lane *about* one source thread, so that
      // thread rides every one of its turns without the user having to add a
      // `#thread` chip. The host resolves it: the link comes from the sidecar
      // registry, and the transcript and state come back through reads an
      // Open would take, re-derived on this send's own window. The renderer
      // therefore cannot name a different source or widen what the sidecar
      // reads. `threadMentionService` is declared below; this closure only
      // runs at send time.
      resolveSideChatSourceContext: ({ sidecarThreadId, windowId, readToolNames }) =>
        resolveSideChatSourceContext(
          {
            findSidecar: (id) => sideChatSidecars.findBySidecarThread(decodeChatThreadId(id)),
            resolveSource: (sourceWindowId, sourceThreadId) =>
              threadMentionService.resolveSideChatSource(sourceWindowId, sourceThreadId),
            readState: sideChatSourceState,
            marks: threadOutsideContentMarks,
            uuid: randomUUID,
          },
          {
            sidecarThreadId: String(sidecarThreadId),
            ...(windowId === undefined ? {} : { windowId }),
            readToolNames: readToolNames ?? [],
          },
        ),
      resolveThreadMentionContext: threadMentionContextResolver(
        () => threadMentionService,
        threadOutsideContentMarks,
      ),
      dataDirectory: chatDataDirectory,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      driver: (providerInstanceId) => {
        const instance = persistence.readProviderInstance(providerInstanceId);
        if (instance === undefined) {
          throw new Error("Provider instance is unavailable.");
        }
        return attachWorkRequestRuntime(
          makeConfiguredProviderDriver(instance, configuredDriverOptions),
          () => workRequestRuntime,
        );
      },
      contextHarness,
      capacityScheduler,
      researchRouter,
      threadWork,
      providerRuntimeRegistry: providerRuntimeRegistry,
      nativeHarness: nativeHarnessHooks,
      resolveAppManagedTools: ({ windowId, thread, threadMentionIds, coordinationDepth }) => {
        const sideChat = sideChatSidecars.findBySidecarThread(thread.id) !== undefined;
        return combineAppManagedToolSets(
          taintAppManagedToolResults({
            tools: combineAppManagedToolSets(
              nativeHarnessComposition?.forChat({
                thread,
                windowId,
                sideChat,
              }),
              ...chatToolContributors.map((contribute) => contribute(windowId, thread)),
              sideChatFileTools(windowId, thread.id),
              threadDialogueService?.forThread({
                windowId,
                sourceThreadId: thread.id,
                sourceTitle: thread.title,
                targetThreadIds: threadMentionIds ?? [],
                ...(coordinationDepth === undefined ? {} : { coordinationDepth }),
              }),
              createImageAgentTools({
                threadKind: "chat-thread",
                scopeId: decodeImageGenerationScopeId(String(thread.id)),
                port: {
                  listInstances: () => persistence.readProviderInstances(),
                  readImageGenerationCustomSources: () =>
                    (persistence.readShellSettings()?.settings ?? defaultShellSettings())
                      .imageGeneration.customSources,
                  enqueue: (input) => imageJobService.enqueue(input),
                  listJobs: (scopeId) => imageJobService.listByScope(scopeId),
                },
              }),
              createSideTaskTools({
                store: sideTasks,
                threadId: String(thread.id),
                mode: "chat",
                projectId: thread.projectId,
                suggestedBy: thread,
                uuid: randomUUID,
                clock: () => new Date().toISOString(),
              }),
            ),
            threadId: thread.id,
            recordExternalContentIngestion: (input) => externalContentIngestionStore.record(input),
            uuid: randomUUID,
          }),
          // Outside the taint wrapper: a Canvas marks its reader only when a
          // read or preview returns content from a Canvas that carries a mark,
          // the rule Work and Code follow, so describe and a clean read leave
          // the thread unmarked.
          createCanvasAgentTools({
            windowId,
            thread,
            port: canvasAgentToolPort,
          }),
          // Host-internal: its results are Octant's own answers, not external
          // content, and `delegate` itself refuses while the thread is tainted.
          childAgentTools({
            sideChat,
            tools: () =>
              agentsManagedToolsFor({
                windowId,
                parentThreadId: String(thread.id),
                mode: "chat",
                ...(thread.projectId === undefined ? {} : { projectId: thread.projectId }),
              }),
          }),
        );
      },
      resolveExtensionSelectionContext: createExtensionChatResolver({
        snapshot: () => extensionApiService.snapshot(),
        resolveEffectiveState: (snapshot, query) =>
          extensionActivationService.resolve(snapshot, query),
        reconcileEffectiveState: async (effective) => {
          await agentPluginMcpSessionManager.reconcile(effective);
          return agentPluginMcpSessionManager.projectEffectiveState(effective);
        },
        providerFamily: (thread) => {
          const instance = persistence.readProviderInstance(thread.providerInstanceId);
          if (instance === undefined) throw new Error("Provider instance is unavailable.");
          return instance.driverKind as ExtensionProviderFamily;
        },
        materialLoader: createStoredExtensionMaterialLoader(extensionPackageStore, {
          mcpToolsForComponent: ({ packageId, componentId, scope }) =>
            agentPluginMcpSessionManager.toolDefinitionsFor(packageId, componentId, scope),
        }),
        toolExecution:
          options.extensionToolExecution ?? agentPluginMcpSessionManager.createToolExecutionPort(),
      }),
    });
    const projectMentionLabel = (projectId: string) =>
      persistence.readProject(projectId as ProjectId)?.name;
    // One Code directory serves both a `#thread` mention and a sibling-threads
    // `read`, so an agent reads exactly what its window could mention.
    const codeThreadMentionDirectory = createCodeThreadMentionDirectory({
      bootstrap: async (windowId) => await routeCodeService.bootstrap(windowId),
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
      projectLabel: projectMentionLabel,
    });
    const threadMentionService = new ThreadMentionService({
      // Every mode contributes its own already-authorized listing, because a
      // mention resolves exactly what the principal can Open —
      // Chat alone would make a Work or Code thread unmentionable from any
      // composer, including its own.
      directories: [
        createChatThreadMentionDirectory({
          bootstrap: () => chatService.bootstrap(),
          read: (threadId) => chatService.read(threadId),
          projectLabel: projectMentionLabel,
        }),
        createWorkThreadMentionDirectory({
          // `workThreadService` and `workTurnService` are composed further
          // down; the directory only calls them per request, never at
          // construction.
          bootstrap: (windowId) => workThreadService().bootstrap(windowId),
          // Every turn, not the transcript route's newest window: the mention
          // bounds its own entries and reports `truncated` from what it saw.
          transcript: async (windowId, threadId) => ({
            turns: await workTurnService().turns(windowId, threadId),
          }),
          projectLabel: projectMentionLabel,
        }),
        codeThreadMentionDirectory,
      ],
      sidecars: sideChatSidecars,
      sideChatThreads: createChatSideChatThreadFactory({
        execute: (command) => chatService.execute(command),
        // A thread Chat refuses to open — missing, deleting, or deleted — is
        // absent for this purpose, so the claimed id is (re)created rather
        // than adopted as an existing sidecar.
        read: (threadId) => {
          try {
            return chatService.read(threadId);
          } catch {
            return undefined;
          }
        },
      }),
      clock: () => new Date().toISOString(),
      uuid: randomUUID,
    });
    threadDialogueService = new ThreadDialogueService({
      resolveChatTargets: (windowId, threadIds) =>
        threadMentionService.chatDialogueTargets(windowId, threadIds),
      readChatThread: (threadId) => chatService.read(threadId),
      executeChat: (command, context) => chatService.execute(command, context),
      // Unfinished claims count as sidecars too: the thread they name is
      // already a Side Chat, even before its selection is confirmed.
      isSideChat: (threadId) => sideChatSidecars.hiddenThreadIds().has(threadId),
    });
    const threadMentionRoutes = createThreadMentionRouteHandler({
      service: threadMentionService,
      windowAuthorityStore,
      maxJsonBodySize: MAX_JSON_REQUEST_BODY_SIZE,
    });
    yield* Effect.promise(() => chatService.reapStaleProviderSessions({ staleAfterMs: 0 }));
    yield* Effect.promise(() => browserCaptures.recover());
    const linkedThreadService = createLinkedThreadRuntime({
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      chat: chatService,
      readChatThreadView: (threadId) => {
        try {
          return chatService.read(threadId);
        } catch {
          return undefined;
        }
      },
    });
    const linkedThreadRoutes = createLinkedThreadRouteHandler({
      service: linkedThreadService,
      windowAuthorityStore,
      maxJsonBodySize: MAX_JSON_REQUEST_BODY_SIZE,
    });
    const chatRoutes = createChatRouteHandler({
      service: chatService,
      windowAuthorityStore,
      maxJsonBodySize: MAX_JSON_REQUEST_BODY_SIZE,
      maxAttachmentBodySize: MAX_CHAT_ATTACHMENT_BYTES,
      waitForThreadChange: (signal) => machineChangeFeed.waitFor("chat-navigation", signal),
    });
    // Checkpoints span Chat and Code, so the service owns only the marker and
    // delegates every thread it produces to the mode that owns the authority
    // for it: Chat branches, Code creates a managed-worktree thread.
    const threadCheckpointService = new ThreadCheckpointService({
      journal: persistence.journal,
      readCheckpoint: (checkpointId) => persistence.readThreadCheckpoint(checkpointId),
      readCheckpoints: (threadId) => persistence.readThreadCheckpoints(threadId),
      canAccess: async (_windowId, projectId) => {
        if (projectId === undefined) return true;
        try {
          return persistence.readProject(decodeProjectId(projectId))?.lifecycle === "active";
        } catch {
          return false;
        }
      },
      chat: createCheckpointChatPort({
        readChatThread: (threadId) => persistence.readChatThread(threadId),
        readChatThreadView: (threadId) => persistence.readChatThreadView(threadId),
        readProject: (projectId) => persistence.readProject(projectId),
        execute: (command) => chatService.execute(command),
      }),
      code: createCheckpointCodePort({
        readCodeThread: (threadId) => persistence.readCodeThread(threadId),
        readProject: (projectId) => persistence.readProject(projectId),
        readOperationStart: (operationId) =>
          persistence.journal.replayAggregate({
            aggregateType: "code-operation",
            aggregateId: String(operationId),
            afterVersion: 0,
            limit: 1,
          })[0],
        execute: (windowId, command) => codeService.execute(windowId, command),
        uuid: randomUUID,
        clock: () => new Date().toISOString(),
      }),
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    });
    const threadCheckpointRoutes = createThreadCheckpointRouteHandler({
      checkpoints: threadCheckpointService,
      windowAuthorityStore,
    });
    const scaffoldRoutes = createScaffoldRouteHandler({
      entries: CURATED_SCAFFOLDS,
      availableTools: () => resolveAvailableTools(curatedScaffoldTools()),
      windowAuthorityStore,
    });
    const workspacePresetRoutes = createWorkspacePresetRouteHandler(
      {
        presets: CURATED_WORKSPACE_PRESETS,
        windowAuthorityStore,
        // The thread and the pane both come from the window's own workspace,
        // never from the request, so a preset lands on a thread this window
        // already has open rather than one the caller merely named.
        resolveTarget: async (windowId, threadId) => {
          const found = findWorkspacePresetTarget(
            shellService.bootstrap(windowId).workspace.layouts.code,
            threadId,
          );
          return found === undefined
            ? undefined
            : {
                paneId: found.paneId,
                mentionableThreadId: decodeMentionableThreadId(String(threadId)),
                title: found.title,
              };
        },
        applyOperations: async (windowId, operations) => {
          let version = shellService.bootstrap(windowId).workspaceVersion;
          for (const operation of operations) {
            const result = shellService.execute({
              kind: "apply-workspace-operation",
              windowId,
              expectedVersion: version,
              operation,
            });
            if (result.kind !== "workspace-replaced") break;
            version = result.version;
          }
          return version;
        },
        // What the thread's own catalog leaves it able to use. A preset reads
        // this and reports; it never writes activation.
        resolveSkills: async (windowId, threadId) => {
          const thread = persistence.readCodeThread(threadId);
          const scoped = filterSkillCatalogForScope(skillDiscoveryService.snapshot(), {
            mode: "code",
            projectId: thread === undefined ? null : String(thread.projectId),
            threadRef: String(threadId),
          });
          return scoped.skills.map((record) => ({
            name: String(record.skill.name),
            enabled: record.effectiveState.kind === "effective",
          }));
        },
      },
      {
        mintTabId: () => decodeWorkspaceTabId(randomUUID()),
        mintPaneId: () => decodePaneId(randomUUID()),
        mintNodeId: () => decodeLayoutNodeId(randomUUID()),
      },
    );
    requireJournalHydration(
      hydrateAgentMessageProjectionFromJournal({
        replay: (cursor) =>
          persistence.journal.replayAggregateType({
            ...Schema.decodeUnknownSync(ReplayCursor)({
              afterSequence: cursor.afterSequence,
              limit: cursor.limit,
            }),
            aggregateType: cursor.aggregateType ?? "agent-message",
          }),
        projection: agentMessageProjection,
      }),
      "Agent message",
    );
    // A body lives only while its message waits for a turn. The sweep is a
    // disk bound, not a precondition: a host that cannot read the store still
    // starts.
    yield* Effect.promise(() => agentMessageService.reconcileStoredBodies().catch(() => undefined));
    return {
      chatRoutes,
      chatService,
      codeThreadMentionDirectory,
      contributeChatTools,
      guardChatAttachmentPurge,
      linkedThreadRoutes,
      navigatorAssistantBindings,
      scaffoldRoutes,
      threadCheckpointRoutes,
      threadMentionRoutes,
      threadMentionService,
      workspacePresetRoutes,
    };
  });
}

export type ChatWiring = Effect.Effect.Success<ReturnType<typeof wireChat>>;
