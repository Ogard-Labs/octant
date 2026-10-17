import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { ReplayCursor, type WindowId } from "@octant/contracts";
import { Effect, Schema } from "effect";
import { hydrateWorkSettingsFromJournal } from "../work/workThreadProjection";
import { createThemeRouteHandler } from "../theme/themeRoutes";
import { createGoalRouteHandler } from "../goal/goalRoutes";
import { createShipRouteHandler } from "../ship/shipRoutes";
import { ShipEventStore } from "../ship/shipEventStore";
import { ShipService } from "../ship/shipService";
import { createPlanRouteHandler } from "../plan/planRoutes";
import { PlanService } from "../plan/planService";
import { JournalPlanStore } from "../plan/journalPlanStore";
import { GoalService } from "../goal/goalService";
import { JournalGoalStore } from "../goal/journalGoalStore";
import { ThemeService } from "../theme/themeService";
import { resolveConnectedGitHubRepository } from "../code/connectedRepository";
import { createCodeBoardPlanProgressSource } from "../code/codeBoardPlanProgress";
import { ContextHarnessService } from "../context/contextHarnessService";
import { GitEnvironmentPort } from "../gitEnvironmentPort";
import { GitObservationPort } from "../code/gitObservationPort";
import { GhRepositoryObservationPort } from "../github/ghRepositoryObservationPort";
import { createOwnedGitContext, ManagedCloneProcessPort } from "../github/managedCloneProcessPort";
import { ManagedCloneService } from "../github/managedCloneService";
import { ManagedRepositoryInventory } from "../github/managedRepositoryInventory";
import { createGithubCloneRouteHandler } from "../githubCloneRoutes";
import { createProjectBindingRouteHandler } from "../projectBindingRoutes";
import { ProjectService } from "../projectService";
import { ProjectRootPort } from "../projectRootPort";
import { WorkProjectStatusFiles } from "../work/workProjectStatusFiles";
import { WorkProjectStatusReader } from "../work/workProjectStatusReader";
import { createShellRouteHandler } from "../shellRoutes";
import { OCTANT_LOCAL_ACTOR_ID, ShellService } from "../shellService";
import { notMeasuredProvider, SpendCeilingService } from "../spendCeilingService";
import { requireJournalHydration } from "../persistence/journalHydration";
import { MAX_JSON_REQUEST_BODY_SIZE, type ServerStart } from "./serverShape";
import type { AuthorityWiring } from "./authority";
import type { AgentRunsWiring } from "./agentRuns";
import type { IntegrationsWiring } from "./integrations";
import type { FoundationsWiring } from "./foundations";

export type WorkspaceDependencies = Pick<ServerStart, "options" | "persistence"> &
  Pick<AuthorityWiring, "bindingReceiptStore" | "onWindowRevoked" | "windowAuthorityStore"> &
  Pick<AgentRunsWiring, "spendCeilingHolder"> &
  Pick<IntegrationsWiring, "githubCapabilityService" | "githubIntegrationIsEffective"> &
  Pick<FoundationsWiring, "providerRuntimeRegistry" | "workThreadProjection">;

export function wireWorkspace(deps: WorkspaceDependencies) {
  const {
    bindingReceiptStore,
    githubCapabilityService,
    githubIntegrationIsEffective,
    onWindowRevoked,
    options,
    persistence,
    providerRuntimeRegistry,
    spendCeilingHolder,
    windowAuthorityStore,
    workThreadProjection,
  } = deps;
  return Effect.gen(function* () {
    const projectRootPort = new ProjectRootPort();
    const managedRepositoryInventory = new ManagedRepositoryInventory({
      inventoryPath: join(homedir(), "Octant", "Repositories"),
    });
    const managedCloneProcessPort = new ManagedCloneProcessPort({
      ghExecutable: options.ghExecutable ?? "gh",
      gitExecutable: "git",
      context: createOwnedGitContext(),
    });
    const githubRepositoryObservationPort = new GhRepositoryObservationPort(
      options.ghExecutable === undefined ? {} : { ghExecutable: options.ghExecutable },
    );
    const managedCloneService = new ManagedCloneService({
      journal: persistence.journal,
      projection: persistence.githubCloneProjection,
      inventory: managedRepositoryInventory,
      process: managedCloneProcessPort,
      observation: githubRepositoryObservationPort,
      snapshot: (signal) => githubCapabilityService.snapshot(signal),
      projectRootPort,
      bindingReceiptStore,
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    yield* Effect.promise(() => managedCloneService.recover());
    const githubCloneRoutes = createGithubCloneRouteHandler({
      windowAuthorityStore,
      service: managedCloneService,
      isEffective: githubIntegrationIsEffective,
    });
    const contextHarness = new ContextHarnessService({
      persistence,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    const spendCeilingService = new SpendCeilingService({
      connection: persistence.connection,
      journal: persistence.journal,
      clock: () => new Date().toISOString(),
      uuid: randomUUID,
      agentRuns: persistence.agentRunProjection,
      threadExists: (input) => {
        if (input.threadType === "chat-thread") {
          return persistence.readChatThread(input.threadId as never) !== undefined;
        }
        if (input.threadType === "code-thread") {
          return persistence.readCodeThread(input.threadId as never) !== undefined;
        }
        return workThreadProjection.read(input.threadId as never) !== undefined;
      },
      projectExists: (projectId) => persistence.readProject(projectId as never) !== undefined,
      notMeasuredProvider: (providerInstanceId) =>
        notMeasuredProvider(
          {
            readProviderInstances: () => persistence.readProviderInstances(),
            observedState: (instanceId) => providerRuntimeRegistry.observedState(instanceId),
          },
          providerInstanceId,
        ),
    });
    spendCeilingHolder.service = spendCeilingService;
    requireJournalHydration(
      hydrateWorkSettingsFromJournal({
        replay: (cursor) =>
          persistence.journal.replayAggregateType({
            ...Schema.decodeUnknownSync(ReplayCursor)({
              afterSequence: cursor.afterSequence,
              limit: cursor.limit,
            }),
            aggregateType: cursor.aggregateType ?? "work-settings",
          }),
        projection: workThreadProjection,
      }),
      "Work settings",
    );
    const shellService = new ShellService({
      persistence,
      readWorkThread: (threadId) => workThreadProjection.read(threadId),
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    onWindowRevoked((windowId) => shellService.revokeWindow(windowId));
    const allowedRendererHttpOrigin = options.allowedRendererHttpOrigin;
    const shellRoutes = createShellRouteHandler(shellService, {
      windowAuthorityStore,
      now: Date.now,
      ...(allowedRendererHttpOrigin === undefined ? {} : { allowedRendererHttpOrigin }),
    });
    const themeService = new ThemeService({
      persistence,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    });
    // Publishing to a target the person owns. Octant runs no deployment
    // infrastructure and holds no service account: a target names a remote the
    // checkout already has, and the only thing this host can do is push the
    // reviewed revision to it. Targets arrive from extensions rather than being
    // built in; with none installed the list is empty and nothing publishes.
    const shipEvents = new ShipEventStore({
      journal: persistence.journal,
      uuid: randomUUID,
      clock: () => new Date().toISOString() as never,
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    });
    const shipTargets = new Map<string, import("@octant/contracts").ShipTarget>();
    const shipService = new ShipService({
      listTargets: () => [...shipTargets.values()],
      writeTarget: (target) => {
        shipTargets.set(String(target.id), target);
      },
      checkout: (threadId) => {
        let thread;
        try {
          thread = persistence.readCodeThread(threadId as never);
        } catch {
          return undefined;
        }
        if (thread === undefined || thread.lifecycle !== "active") return undefined;
        const checkout = persistence.readCodeCheckout(thread.checkoutId);
        if (checkout === undefined || checkout.availability !== "available") return undefined;
        const head = checkout.head;
        return {
          checkoutRoot: String(thread.checkoutId),
          // A publication is refused on unproven work, so the host states what
          // it can observe rather than assuming: without a live observation the
          // checkout is treated as dirty and the revision as unreviewed, which
          // fails in the safe direction.
          clean: false,
          headRevision: head.kind === "branch" ? head.oid : "",
          reviewedRevision: undefined,
          executionPolicy: thread.executionPolicy,
        };
      },
      // The host has no build it watched being produced yet, so it vouches for
      // nothing. Refusing here is the record's evidence rule doing its job, not
      // a placeholder: a ship claims a build happened only when this host saw
      // it happen.
      observedArtifact: async () => undefined,
      credentialHandle: async () => undefined,
      publish: async () => ({
        outcome: "failed",
        detail: "This host has no publication path bound for that target.",
      }),
      // Publishing is approved one act at a time, against the exact target,
      // revision, and build. Nothing on this host issues such an approval yet,
      // and a standing grant must never stand in for one.
      approval: () => undefined,
      journal: shipEvents,
      uuid: randomUUID,
      clock: () => new Date().toISOString() as never,
    });
    const shipRoutes = createShipRouteHandler({
      service: shipService,
      windowAuthorityStore,
      authorizeThread: ({ threadId, windowId }) => {
        const workspace = persistence.readWindowWorkspace(windowId)?.workspace;
        if (workspace === undefined) return false;
        const context = workspace.contextByMode.code;
        if (context.mode !== "code") return false;
        let thread;
        try {
          thread = persistence.readCodeThread(threadId as never);
        } catch {
          return false;
        }
        if (thread === undefined || thread.lifecycle !== "active") return false;
        return String(context.projectId) === String(thread.projectId);
      },
    });
    const themeRoutes = createThemeRouteHandler({ service: themeService, windowAuthorityStore });
    // Goals persist through the journal, so they survive a restart and
    // rebuild by replay. The in-memory view advances only after the append
    // commits, so a failed write leaves both the journal and the served
    // aggregate on the last durable state.
    // A Goal and its loop both belong to a Work thread, so the window must
    // currently be in Work on the Project that owns the thread. Read the
    // window's own workspace, never a scope the caller supplied.
    const authorizeWorkThreadForWindow = ({
      threadId,
      windowId,
    }: {
      readonly threadId: string;
      readonly windowId: WindowId;
    }): boolean => {
      const workspace = persistence.readWindowWorkspace(windowId)?.workspace;
      if (workspace === undefined) return false;
      const context = workspace.contextByMode.work;
      if (context.mode !== "work") return false;
      let thread;
      try {
        thread = workThreadProjection.read(threadId as never);
      } catch {
        return false;
      }
      if (thread === undefined || thread.lifecycle !== "active") return false;
      return String(context.projectId) === String(thread.projectId);
    };
    const goalService = new GoalService({
      store: new JournalGoalStore({ journal: persistence.journal, uuid: randomUUID }),
    });
    // A Code thread's plan or goal is reached only from a window currently in
    // Code on the Project that owns the thread: read the window's own
    // workspace, never a scope the caller supplied.
    const authorizeCodeThreadForWindow = ({
      threadId,
      windowId,
    }: {
      readonly threadId: string;
      readonly windowId: WindowId;
    }): boolean => {
      const workspace = persistence.readWindowWorkspace(windowId)?.workspace;
      if (workspace === undefined) return false;
      const context = workspace.contextByMode.code;
      if (context.mode !== "code") return false;
      let thread;
      try {
        thread = persistence.readCodeThread(threadId as never);
      } catch {
        return false;
      }
      if (thread === undefined || thread.lifecycle !== "active") return false;
      return String(context.projectId) === String(thread.projectId);
    };
    const goalRoutes = createGoalRouteHandler({
      service: goalService,
      windowAuthorityStore,
      // A Goal belongs to a Work or Code thread, so the window must currently
      // be in that mode on the Project that owns the thread. A Code thread's
      // goal is the one a harness lead can verify with goal-check.
      authorizeThread: (input) =>
        authorizeWorkThreadForWindow(input) || authorizeCodeThreadForWindow(input),
    });
    // Hoisted so the Code board can read the same durable state (0051) instead
    // of standing up a second plan store.
    const planService = new PlanService({
      store: new JournalPlanStore({ journal: persistence.journal, uuid: randomUUID }),
    });
    const codeBoardPlanProgressSource = createCodeBoardPlanProgressSource(planService);
    const planRoutes = createPlanRouteHandler({
      service: planService,
      windowAuthorityStore,
      authorizeThread: authorizeCodeThreadForWindow,
    });
    const projectBindingRoutes = createProjectBindingRouteHandler({
      desktopBridgeSecret: options.desktopBridgeSecret,
      windowAuthorityStore,
      bindingReceiptStore,
      projectRootPort,
      maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
    });
    const workProjectStatusFiles = new WorkProjectStatusFiles();
    const workProjectStatusReader = new WorkProjectStatusReader({
      files: workProjectStatusFiles,
      clock: () => new Date().toISOString(),
    });
    const gitEnvironmentPort = options.gitEnvironmentPort ?? new GitEnvironmentPort();
    const gitObservationPort = new GitObservationPort();
    const projectService = new ProjectService({
      persistence,
      bindingReceiptStore,
      projectRootPort,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      observeCodeProjectRepository: async (canonicalRoot) => {
        const remotes = await gitObservationPort.observeRemotes(canonicalRoot);
        if (remotes === undefined) return undefined;
        return resolveConnectedGitHubRepository(remotes);
      },
      seedWorkProjectStatusFile: async (canonicalRoot, name, today) => {
        await workProjectStatusFiles.seed(canonicalRoot, name, today);
      },
    });
    return {
      authorizeWorkThreadForWindow,
      codeBoardPlanProgressSource,
      contextHarness,
      gitEnvironmentPort,
      gitObservationPort,
      githubCloneRoutes,
      githubRepositoryObservationPort,
      goalRoutes,
      goalService,
      managedCloneProcessPort,
      managedCloneService,
      planRoutes,
      projectBindingRoutes,
      projectRootPort,
      projectService,
      shellRoutes,
      shellService,
      shipRoutes,
      spendCeilingService,
      themeRoutes,
      workProjectStatusFiles,
      workProjectStatusReader,
    };
  });
}

export type WorkspaceWiring = Effect.Effect.Success<ReturnType<typeof wireWorkspace>>;
