import { randomUUID } from "node:crypto";
import {
  decodeAgentRunParentThreadId,
  decodeCodeThreadId,
  decodeWindowId,
  decodeWorkThreadId,
  type WindowId,
  type WorkThreadId,
} from "@octant/contracts";
import { createWorkOverviewRouteHandler } from "../workOverviewRoutes";
import {
  boardRuntimeActivityFromTurnsAndSignals,
  composeWorkBoardEvidence,
  type WorkBoardRuntimeActivity,
  type WorkBoardThread,
  WorkThreadBoardService,
} from "../work/workThreadBoardService";
import { WorkPromotionApplicationService } from "../work/workPromotionApplicationService";
import { createWorkPromotionCodeThreadPort } from "../work/workPromotionCodeThreadPort";
import { WorkPromotionEventStore } from "../work/workPromotionEventStore";
import { createWorkPromotionProjectPort } from "../work/workPromotionProjectPort";
import { WorkPromotionProjection } from "../work/workPromotionProjection";
import { WorkPromotionService } from "../work/workPromotionService";
import { createWorkPromotionRouteHandler } from "../workPromotionRoutes";
import { WorkRequestApplicationService } from "../work/workRequestApplicationService";
import { WorkRequestEventStore } from "../work/workRequestEventStore";
import { WorkRequestProjection } from "../work/workRequestProjection";
import { WorkRequestRuntime } from "../work/workRequestRuntime";
import { WorkRequestService } from "../work/workRequestService";
import { createWorkRequestRouteHandler } from "../workRequestRoutes";
import { createFleetActivityRouteHandler } from "../fleetActivityRoutes";
import {
  FleetActivityService,
  runningThreadsFromNavigation,
  windowsBoundToAProject,
} from "../fleetActivityService";
import { createPendingRequestRouteHandler } from "../pendingRequestRoutes";
import { PendingRequestService } from "../pendingRequestService";
import { createWorkThreadRouteHandler } from "../workThreadRoutes";
import { createSidebarBackgroundRouteHandler } from "../theme/sidebarBackgroundRoutes";
import { SidebarBackgroundStore } from "../theme/backgroundStore";
import {
  listChildPendingRequests,
  windowMayListChildThread,
} from "../agentRun/childPendingRequests";
import { listWorkFolderTopLevel } from "../work/workProjectStatusReader";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { listWorkTurnDecisions, workTurnDecision } from "../turnDecisions/workTurnDecisions";
import {
  defaultShellSettings,
  isAgentRunActiveStatus,
  workProjectKeepsStatusFile,
} from "@octant/domain";
import {
  type AgentRunsWiring,
  resolveAgentRunParentThreadTitle,
  resolveHarnessThreadFacts,
} from "./agentRuns";
import { listLeadApprovalRequests } from "../harness/leadApprovalAttention";
import { MAX_JSON_REQUEST_BODY_SIZE, type ServerStart } from "./serverShape";
import type { LateBindings } from "./lateBindings";
import type { AuthorityWiring } from "./authority";
import type { WorkspaceWiring } from "./workspace";
import type { ProvidersWiring } from "./providers";
import type { CodeRuntimeWiring } from "./codeRuntime";
import type { HarnessWiring } from "./harness";
import type { ChatWiring } from "./chat";
import type { WorkWiring } from "./work";
import type { WorkFilesWiring } from "./workFiles";

export type WorkRequestsDependencies = Pick<ServerStart, "persistence"> & {
  /** Cells settled by a later wiring call; read per use, never at construction. */
  readonly late: Pick<
    LateBindings,
    "observeWorkThreadRuntime" | "workRequestRuntime" | "workRequestService"
  >;
} & Pick<AuthorityWiring, "agentRunPersistence" | "windowAuthorityStore"> &
  Pick<
    WorkspaceWiring,
    | "gitObservationPort"
    | "goalService"
    | "projectService"
    | "workProjectStatusReader"
    | "workThreadProjection"
  > &
  Pick<ProvidersWiring, "providerDataDirectory"> &
  Pick<
    CodeRuntimeWiring,
    "baseRouteCodeService" | "codeOperationRuntime" | "codeTurnDecisions" | "routeCodeService"
  > &
  Pick<
    HarnessWiring,
    "nativeHarnessApprovals" | "nativeHarnessQuestionsLive" | "nativeHarnessSessionsLive"
  > &
  Pick<ChatWiring, "chatService"> &
  Pick<AgentRunsWiring, "threadAwaitsHarnessApproval"> &
  Pick<
    WorkWiring,
    | "workArtifactProjection"
    | "workflowService"
    | "workThreadService"
    | "workThreadServiceWithWorkflows"
    | "workTurnProjection"
  > &
  Pick<WorkFilesWiring, "workResearchProjection">;

export function wireWorkRequests(deps: WorkRequestsDependencies) {
  const {
    threadAwaitsHarnessApproval,
    late,
    agentRunPersistence,
    baseRouteCodeService,
    chatService,
    codeOperationRuntime,
    codeTurnDecisions,
    gitObservationPort,
    goalService,
    nativeHarnessApprovals,
    nativeHarnessQuestionsLive,
    nativeHarnessSessionsLive,
    persistence,
    projectService,
    providerDataDirectory,
    routeCodeService,
    windowAuthorityStore,
    workArtifactProjection,
    workflowService,
    workProjectStatusReader,
    workResearchProjection,
    workThreadProjection,
    workThreadService,
    workThreadServiceWithWorkflows,
    workTurnProjection,
  } = deps;

  const workPromotionProjection = new WorkPromotionProjection();
  const workPromotionEventStore = new WorkPromotionEventStore({
    journal: persistence.journal,
    uuid: randomUUID,
    actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
  });
  const workPromotionWindowScope: { current: WindowId | undefined } = { current: undefined };
  const workPromotionProjectPort = createWorkPromotionProjectPort({
    persistence,
    projects: projectService,
    artifacts: workArtifactProjection,
    gitObservation: gitObservationPort,
    clock: () => new Date().toISOString(),
  });
  const workPromotionService = new WorkPromotionService({
    projects: workPromotionProjectPort,
    codeThreads: createWorkPromotionCodeThreadPort({
      codeService: routeCodeService,
      clock: () => new Date().toISOString(),
    }),
    projection: workPromotionProjection,
    eventStore: workPromotionEventStore,
    actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    clock: () => new Date().toISOString(),
    authenticatedWindowId: () => workPromotionWindowScope.current,
  });
  workPromotionService.hydrate();
  const workPromotionApplication = new WorkPromotionApplicationService({
    promotion: workPromotionService,
    projection: workPromotionProjection,
    projects: {
      bootstrap: (windowId) => projectService.bootstrap(windowId),
      listArtifactRefs: workPromotionProjectPort.listArtifactRefs,
      resolveDeliveryTarget: workPromotionProjectPort.resolveDeliveryTarget,
    },
    windowScope: workPromotionWindowScope,
  });
  const workPromotionRoutes = createWorkPromotionRouteHandler({
    service: workPromotionApplication,
    windowAuthorityStore,
    maxJsonBodySize: MAX_JSON_REQUEST_BODY_SIZE,
  });
  const workRequestProjection = new WorkRequestProjection();
  const workRequestEventStore = new WorkRequestEventStore({
    journal: persistence.journal,
    uuid: randomUUID,
  });
  const workRequestService = new WorkRequestService({
    projects: {
      projectType: (projectId) => persistence.readProject(projectId)?.type ?? "unknown",
      isActiveWorkProject: (projectId) => {
        const project = persistence.readProject(projectId);
        return project?.type === "work" && project.lifecycle === "active";
      },
      workCanonicalRoot: (projectId) => {
        const project = persistence.readProject(projectId);
        if (project === undefined || project.type !== "work") return undefined;
        const root = project.binding.canonicalRoot;
        return root.length > 0 ? root : undefined;
      },
      threadProjectId: (threadId) => workThreadProjection.read(threadId)?.projectId,
      threadProviderInstanceId: (threadId) =>
        workThreadProjection.read(threadId)?.providerInstanceId,
    },
    projection: workRequestProjection,
    eventStore: workRequestEventStore,
    providerSessions: {
      answerApproval: (input) => {
        if (late.workRequestRuntime.current === undefined) {
          return Promise.reject(new Error("Work provider session runtime is unavailable."));
        }
        return late.workRequestRuntime.current.answerApproval(input);
      },
      answerUserInput: (input) => {
        if (late.workRequestRuntime.current === undefined) {
          return Promise.reject(new Error("Work provider session runtime is unavailable."));
        }
        return late.workRequestRuntime.current.answerUserInput(input);
      },
      cancel: (input) => {
        if (late.workRequestRuntime.current === undefined) {
          return Promise.reject(new Error("Work provider session runtime is unavailable."));
        }
        return late.workRequestRuntime.current.cancel(input);
      },
    },
    actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    clock: () => new Date().toISOString(),
  });
  late.workRequestService.current = workRequestService;
  const workRequestRuntime = new WorkRequestRuntime({
    requests: workRequestService,
    uuid: randomUUID,
  });
  late.workRequestRuntime.current = workRequestRuntime;
  workRequestService.hydrate();
  workRequestService.interruptOnRestart();
  workRequestService.reconcileUnavailableRequests();
  const observeWorkThreadRuntime:
    | ((threadId: WorkThreadId) => WorkBoardRuntimeActivity)
    | undefined = (threadId) => {
    const thread = workThreadProjection.read(threadId);
    const pendingRequests = thread
      ? workRequestService
          .listForThread(thread.projectId, threadId)
          .filter((request) => request.status === "pending")
      : [];
    const pendingRequest = pendingRequests.at(0);
    const leadApprovalWaiting = threadAwaitsHarnessApproval(String(threadId));
    const childRuns = persistence.agentRunProjection.parentSummary(
      decodeAgentRunParentThreadId(String(threadId)),
    );
    return boardRuntimeActivityFromTurnsAndSignals({
      turns: workTurnProjection.listForThread(threadId),
      pendingRequest: pendingRequest !== undefined || leadApprovalWaiting,
      ...(pendingRequest !== undefined
        ? { pendingRequestKind: pendingRequest.detail.kind }
        : leadApprovalWaiting
          ? { pendingRequestKind: "approval" as const }
          : {}),
      childActive: childRuns.filter(
        (run) => isAgentRunActiveStatus(run.lifecycleStatus) && run.lifecycleStatus !== "waiting",
      ).length,
      childWaiting: childRuns.filter((run) => run.lifecycleStatus === "waiting").length,
    });
  };
  late.observeWorkThreadRuntime.current = observeWorkThreadRuntime;
  projectService.onWorkProjectArchived((project) => {
    workRequestService.interruptProject(project.id);
  });
  const workRequestApplication = new WorkRequestApplicationService({
    requests: workRequestService,
    projects: projectService,
    threads: workThreadService,
  });
  const workRequestRoutes = createWorkRequestRouteHandler({
    service: workRequestApplication,
    windowAuthorityStore,
    maxJsonBodySize: MAX_JSON_REQUEST_BODY_SIZE,
  });
  // Whether a window may open a Work or Code parent: the project binding, not
  // the harness session route, which also requires the thread to be the open
  // surface and would hide the row everywhere except the thread already open.
  const windowMayOpenWorkOrCodeThread = (input: {
    readonly threadId: string;
    readonly windowId: string;
  }) =>
    windowMayListChildThread(
      {
        purged: (threadId) =>
          persistence.connection
            .prepare("SELECT 1 FROM thread_purge_tombstone WHERE thread_id = ?")
            .get(threadId) !== undefined,
        codeThread: (threadId) => {
          try {
            return persistence.readCodeThread(decodeCodeThreadId(threadId));
          } catch {
            // A Work thread id is not a Code thread id.
            return undefined;
          }
        },
        workThread: (threadId) => {
          try {
            return workThreadProjection.read(decodeWorkThreadId(threadId));
          } catch {
            // Neither mode owns this id.
            return undefined;
          }
        },
        workspace: (windowId) =>
          persistence.readWindowWorkspace(decodeWindowId(windowId))?.workspace,
        hasActiveProject: (projectId, mode) => projectService.hasActiveProject(projectId, mode),
      },
      input,
    );
  // Rows that find a request a thread's agent or subagent is waiting on: the
  // answer stays on the harness session route, which checks the window and
  // the principal, so these rows carry no way to answer.
  const childPendingForWindow = async (windowId: WindowId) => [
    ...(await listChildPendingRequests(
      {
        approvals: nativeHarnessApprovals,
        questions: nativeHarnessQuestionsLive,
        readSession: (threadId) => nativeHarnessSessionsLive.read(threadId),
        getRun: (id) => agentRunPersistence.getById(id),
        parentThreadTitle: (run) =>
          resolveAgentRunParentThreadTitle({
            persistence,
            workThreadProjection,
            parentThreadId: run.parentThreadId,
            mode: run.routingReceipt.mode,
          }),
        authorizeThread: windowMayOpenWorkOrCodeThread,
      },
      String(windowId),
    )),
    ...(await listLeadApprovalRequests(
      {
        approvals: nativeHarnessApprovals,
        sessions: nativeHarnessSessionsLive,
        threadFacts: ({ threadId, mode }) =>
          resolveHarnessThreadFacts({ persistence, workThreadProjection, threadId, mode }),
        authorizeThread: ({ threadId, mode, windowId: asking }) =>
          mode === "chat"
            ? chatService.listsActiveThread(threadId)
            : windowMayOpenWorkOrCodeThread({ threadId, windowId: asking }),
      },
      String(windowId),
    )),
  ];
  const pendingRequestService = new PendingRequestService({
    readSettings: () => persistence.readShellSettings()?.settings ?? defaultShellSettings(),
    work: async (windowId) => [
      ...(await workRequestApplication.listPendingForWindow(windowId)),
      ...(await listWorkTurnDecisions(
        {
          projects: (id) => projectService.bootstrap(id),
          threads: async (id) => await workThreadServiceWithWorkflows.navigation(id),
          turns: (threadId) => workTurnProjection.listForThread(threadId),
        },
        windowId,
      )),
    ],
    code: async (windowId) => [
      ...((await codeOperationRuntime?.pendingRequests?.(windowId)) ?? []),
      ...(await codeTurnDecisions.listForWindow(windowId)),
    ],
    chat: () => chatService.listPendingQuestions(),
    children: childPendingForWindow,
  });
  const pendingRequestRoutes = createPendingRequestRouteHandler({
    service: pendingRequestService,
    windowAuthorityStore,
  });
  // The menu bar's roster: needs-you is the pending-request read, plus the
  // Code requests and subagent waits each persisted local window could
  // already open. The menu bar's own window binds no Project. Nothing here
  // reads a terminal's screen.
  const fleetActivityRoutes = createFleetActivityRouteHandler({
    service: new FleetActivityService({
      readSettings: () => persistence.readShellSettings()?.settings ?? defaultShellSettings(),
      pending: (windowId) => pendingRequestService.list(windowId),
      boundCodeWindows: () =>
        persistence
          .readWindowWorkspaces()
          .filter(({ workspace }) => workspace.contextByMode.code.projectId != null)
          .map(({ workspace }) => workspace.windowId),
      codePending: async (windowId) => [
        ...((await codeOperationRuntime?.pendingRequests?.(windowId)) ?? []),
        ...(await codeTurnDecisions.listForWindow(windowId)),
      ],
      boundProjectWindows: () => windowsBoundToAProject(persistence.readWindowWorkspaces()),
      childPending: childPendingForWindow,
      chat: () =>
        chatService
          .navigation()
          .threads.filter((thread) => thread.executing)
          .map((thread) => ({
            threadId: String(thread.id),
            title: thread.title,
            ...(thread.projectId === undefined ? {} : { projectId: thread.projectId }),
            ...(thread.turnStartedAt === undefined ? {} : { turnStartedAt: thread.turnStartedAt }),
          })),
      work: async (windowId) =>
        runningThreadsFromNavigation(await workThreadServiceWithWorkflows.navigation(windowId)),
      code: async (windowId) =>
        runningThreadsFromNavigation(await baseRouteCodeService.navigation(windowId)),
      projectName: (projectId) => persistence.readProject(projectId)?.name,
    }),
    windowAuthorityStore,
  });
  const workThreadRoutes = createWorkThreadRouteHandler({
    service: {
      bootstrap: (windowId) => workThreadServiceWithWorkflows.bootstrap(windowId),
      navigation: (windowId) => workThreadServiceWithWorkflows.navigation(windowId),
      execute: (windowId, command) => workThreadServiceWithWorkflows.execute(windowId, command),
      queryBoard: async (windowId, query) => {
        const bootstrap = await workThreadServiceWithWorkflows.bootstrap(windowId);
        const projects = await projectService.bootstrap(windowId);
        const projectById = new Map(
          projects.active.map((project) => [String(project.id), project] as const),
        );
        const openThreads = bootstrap.threads.filter(
          (thread) => thread.lifecycle !== "archived" && thread.completedAt === undefined,
        );
        // A due date in the STATUS.md of a Project that keeps one raises the
        // follow-up mark on that Project's most recent open thread: the
        // reminder belongs to the work, and that thread is where the person
        // would pick it up.
        const dueByProject = new Map<string, boolean>();
        await Promise.all(
          [...new Set(openThreads.map((thread) => String(thread.projectId)))].map(
            async (projectId) => {
              const project = projectById.get(projectId);
              if (project?.type !== "work" || !workProjectKeepsStatusFile(project)) return;
              dueByProject.set(
                projectId,
                await workProjectStatusReader.hasDueItems(
                  project.id,
                  project.binding.canonicalRoot,
                ),
              );
            },
          ),
        );
        const newestByProject = new Map<string, string>();
        for (const thread of openThreads) {
          const key = String(thread.projectId);
          const current = openThreads.find((c) => String(c.id) === newestByProject.get(key));
          if (current === undefined || current.updatedAt < thread.updatedAt) {
            newestByProject.set(key, String(thread.id));
          }
        }
        const boardThreads: WorkBoardThread[] = openThreads.map((thread) => {
          const project = projectById.get(String(thread.projectId));
          const currentRevisionId =
            project !== undefined && project.type === "work"
              ? project.bindingRevisionId
              : undefined;
          return {
            thread,
            project: { id: thread.projectId, name: project?.name ?? thread.title },
            projectProjectionPresent: project !== undefined,
            bindingRevisionCurrent:
              thread.bindingRevisionId === undefined ||
              (currentRevisionId !== undefined &&
                String(currentRevisionId) === String(thread.bindingRevisionId)),
            followUp:
              dueByProject.get(String(thread.projectId)) === true &&
              newestByProject.get(String(thread.projectId)) === String(thread.id),
          };
        });
        const board = new WorkThreadBoardService({
          threads: { list: () => boardThreads },
          evidence: {
            forThread: (entry) =>
              composeWorkBoardEvidence({
                turns: workTurnProjection.listForThread(entry.thread.id),
                pendingRequests: workRequestService.listForThread(
                  entry.thread.projectId,
                  entry.thread.id,
                ),
                artifacts: [...workArtifactProjection.snapshot().values()].filter(
                  (artifact) =>
                    String(artifact.projectId) === String(entry.thread.projectId) &&
                    !artifact.deleted,
                ),
                citations: [...workResearchProjection.snapshot().values()]
                  .filter(
                    (brief) => String(brief.brief.projectId) === String(entry.thread.projectId),
                  )
                  .flatMap((brief) => [...brief.sources.values()]),
                goal: goalService.read(String(entry.thread.id)).goal,
                childRuns: persistence.agentRunProjection.parentSummary(
                  decodeAgentRunParentThreadId(String(entry.thread.id)),
                ),
              }),
          },
          runtime: {
            observe: (threadId) => {
              const activity = observeWorkThreadRuntime?.(threadId) ?? {
                executing: false,
                awaitingInput: false,
                interrupted: false,
              };
              const thread = workThreadProjection.read(threadId);
              return thread === undefined
                ? activity
                : {
                    ...activity,
                    decisionPending:
                      workTurnDecision(thread, workTurnProjection.listForThread(threadId)) !==
                      undefined,
                  };
            },
          },
          clock: () => new Date().toISOString(),
        });
        return board.query(query);
      },
    },
    windowAuthorityStore,
    maxJsonBodySize: MAX_JSON_REQUEST_BODY_SIZE,
  });
  const workOverviewRoutes = createWorkOverviewRouteHandler({
    artifacts: workArtifactProjection,
    threads: workThreadService,
    workflows: workflowService,
    projects: projectService,
    requests: workRequestService,
    windowAuthorityStore,
    status: workProjectStatusReader,
    folder: listWorkFolderTopLevel,
  });
  const sidebarBackgroundStore = new SidebarBackgroundStore({
    dataDirectory: providerDataDirectory,
  });
  const sidebarBackgroundRoutes = createSidebarBackgroundRouteHandler({
    store: sidebarBackgroundStore,
    windowAuthorityStore,
    currentSidebarBackground: () =>
      persistence.readShellSettings()?.settings.sidebarBackground ?? null,
    currentAppBackground: () => persistence.readThemeSettings()?.settings.appBackground ?? null,
  });
  return {
    fleetActivityRoutes,
    pendingRequestRoutes,
    sidebarBackgroundRoutes,
    workOverviewRoutes,
    workPromotionRoutes,
    workRequestRoutes,
    workThreadRoutes,
  };
}

export type WorkRequestsWiring = ReturnType<typeof wireWorkRequests>;
