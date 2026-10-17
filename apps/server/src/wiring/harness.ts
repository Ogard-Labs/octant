import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { realpath, stat as statFromDisk } from "node:fs/promises";
import { join } from "node:path";
import {
  AggregateId,
  decodeCodeThreadId,
  LOCAL_HOST_ID,
  type OctantMode,
  ToolEgressLaunchId,
} from "@octant/contracts";
import { Schema } from "effect";
import { ResearchRouter } from "../chat/research/researchRouter";
import { SearxngClient } from "../chat/research/searxngClient";
import { ThreadWorkService } from "../chat/threadWorkService";
import { GoalLoopService } from "../goal/goalLoopService";
import { codeTurnExecutionPolicyReader } from "../code/codeTurnExecutionPolicy";
import { RepositoryTestProcessPort } from "../code/repositoryTestProcessPort";
import { nativeHarnessRecoveryBlockers } from "../harness/nativeHarnessRecovery";
import { readThreadExternalContentTaint } from "../context/externalContentTaintProjection";
import { createNativeHarnessAuthority } from "../harness/nativeHarnessAuthority";
import {
  createNativeHarnessComposition,
  type HarnessEgressScope,
} from "../harness/nativeHarnessComposition";
import { createNativeHarnessSecondOpinionPort } from "../harness/nativeHarnessSecondOpinion";
import { createNativeHarnessShell } from "../harness/nativeHarnessShell";
import { createNativeHarnessDelegatePort } from "../harness/nativeHarnessDelegatePort";
import { NativeHarnessLeadFallbackService } from "../harness/nativeHarnessLeadFallback";
import { createNativeHarnessRoutingRouteHandler } from "../harness/nativeHarnessRoutingRoutes";
import {
  createFollowUp,
  type FollowUpCreationDependencies,
} from "../followUps/followUpSuggestionCreation";
import {
  createFollowUpSuggestionRouteHandler,
  type FollowUpSuggestionActionDependencies,
} from "../followUps/followUpSuggestionRoutes";
import { createSideTaskRouteHandler } from "../sideTasks/sideTaskRoutes";
import { createNativeHarnessSessionRouteHandler } from "../harness/nativeHarnessSessionRoutes";
import { createNativeHarnessEgressRouteHandler } from "../harness/nativeHarnessEgressRoutes";
import { NativeHarnessTurnObserver } from "../harness/nativeHarnessTurnObserver";
import { fetchPublicUrl, PublicFetchRefused } from "../harness/nativeHarnessWebFetch";
import { searxngHarnessWebSearch } from "../harness/nativeHarnessWebSearch";
import { deriveToolHostId } from "../browser/browserAuthorityResolver";
import { isNativeHarnessDriverKind } from "@octant/domain";
import { type AgentRunsWiring, authorizeAgentRunParentThread } from "./agentRuns";
import { makeConfiguredProviderDriver, type ProvidersWiring } from "./providers";
import type { ServerStart } from "./serverShape";
import type { LateBindings } from "./lateBindings";
import type { AuthorityWiring } from "./authority";
import type { FoundationsWiring } from "./foundations";
import type { IntegrationsWiring } from "./integrations";
import type { WorkspaceWiring } from "./workspace";
import type { CodeRuntimeWiring } from "./codeRuntime";
import type { HarnessStateWiring } from "./harnessState";

export type HarnessDependencies = Pick<ServerStart, "persistence"> & {
  /** Cells settled by a later wiring call; read per use, never at construction. */
  readonly late: Pick<
    LateBindings,
    | "nativeHarnessComposition"
    | "nativeHarnessLeadFallback"
    | "nativeHarnessObserver"
    | "runningWorkTurnAccess"
  >;
} & Pick<
    AuthorityWiring,
    | "agentRunParentAuthority"
    | "agentRunPersistence"
    | "codeSessionAuthority"
    | "windowAuthorityStore"
  > &
  Pick<
    AgentRunsWiring,
    | "agentRunAdmission"
    | "nativeHarnessRouter"
    | "nativeHarnessRoutingStore"
    | "agentRunEligibleTargets"
    | "agentRunOrchestration"
    | "externalContentIngestionStore"
    | "sideTasks"
    | "threadFollowUpSuggestions"
  > &
  Pick<IntegrationsWiring, "toolEgressRules"> &
  Pick<WorkspaceWiring, "contextHarness" | "goalService"> &
  Pick<
    ProvidersWiring,
    "configuredDriverOptions" | "nativeHarnessEndpoints" | "providerDataDirectory"
  > &
  Pick<CodeRuntimeWiring, "codeOperationRuntime"> &
  Pick<
    HarnessStateWiring,
    | "agentRunInteractions"
    | "nativeHarnessApprovals"
    | "nativeHarnessQuestions"
    | "nativeHarnessSessions"
  > & {
    /** Wired by wireWork; read only after startup. */
    readonly goalLoopService: () => GoalLoopService;
  } & Pick<FoundationsWiring, "workThreadProjection">;

export function wireHarness(deps: HarnessDependencies) {
  const {
    late,
    agentRunAdmission,
    agentRunEligibleTargets,
    agentRunInteractions,
    agentRunOrchestration,
    agentRunPersistence,
    codeOperationRuntime,
    codeSessionAuthority,
    configuredDriverOptions,
    contextHarness,
    externalContentIngestionStore,
    goalLoopService,
    goalService,
    nativeHarnessApprovals,
    nativeHarnessEndpoints,
    nativeHarnessQuestions,
    nativeHarnessRouter,
    nativeHarnessRoutingStore,
    nativeHarnessSessions,
    persistence,
    providerDataDirectory,
    sideTasks,
    threadFollowUpSuggestions,
    toolEgressRules,
    windowAuthorityStore,
    workThreadProjection,
  } = deps;

  const researchRouter = new ResearchRouter({
    searxngClient: {
      search: async (input) => {
        const settings = persistence.readChatSettings()?.settings;
        if (settings?.searxngBaseUrl === undefined) {
          throw new Error("SearXNG is not configured.");
        }
        return new SearxngClient({ baseUrl: settings.searxngBaseUrl }).search(input);
      },
    },
  });
  const threadWork = new ThreadWorkService({
    persistence,
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
  });
  // The harness `bash` tool runs through the same owned-process-group,
  // Seatbelt-confined port repository tests use, with its own receipt and
  // work directories so a command's leftovers never mix with a test's.
  const harnessWorkDirectory = join(providerDataDirectory, "harness", "work");
  mkdirSync(harnessWorkDirectory, { recursive: true, mode: 0o700 });
  // Pending command scripts live outside every directory a confined command
  // may write; each launch reads only its own script's subdirectory, so one
  // command cannot swap the script another thread is about to run.
  const harnessScriptDirectory = join(providerDataDirectory, "harness", "scripts");
  mkdirSync(harnessScriptDirectory, { recursive: true, mode: 0o700 });
  const harnessProcessPort = new RepositoryTestProcessPort({
    receiptDirectory: join(providerDataDirectory, "harness", "receipts"),
    temporaryDirectory: harnessWorkDirectory,
    harnessShellScriptDirectory: harnessScriptDirectory,
  });
  // A child admitted without network authority runs its commands here. Its
  // writable temporary root is its own: a shared one would let it leave
  // files a networked command later picks up and acts on with the network
  // open.
  const harnessOfflineWorkDirectory = join(providerDataDirectory, "harness", "work-offline");
  mkdirSync(harnessOfflineWorkDirectory, { recursive: true, mode: 0o700 });
  const harnessOfflineProcessPort = new RepositoryTestProcessPort({
    receiptDirectory: join(providerDataDirectory, "harness", "receipts"),
    temporaryDirectory: harnessOfflineWorkDirectory,
    networkEgress: "none",
    harnessShellScriptDirectory: harnessScriptDirectory,
  });
  // Approval-gated and auto-accept-edits Code commands run on `proxied`
  // network: each command gets its own egress proxy listener, on loopback
  // on macOS and as a Unix socket in a private directory on Linux, and
  // reaches only the hosts the thread's rules name. Other platforms have no
  // owned process groups, so no command runs there at all.
  const harnessEgressSocketDirectory = join(providerDataDirectory, "harness", "egress");
  const harnessEgressEndpoint =
    process.platform === "darwin"
      ? ({ kind: "loopback" } as const)
      : process.platform === "linux"
        ? ({ kind: "unix-socket", parentDirectory: harnessEgressSocketDirectory } as const)
        : undefined;
  if (harnessEgressEndpoint?.kind === "unix-socket") {
    mkdirSync(harnessEgressSocketDirectory, { recursive: true, mode: 0o700 });
  }
  const decodeEgressAggregateId = Schema.decodeUnknownSync(AggregateId);
  const decodeEgressLaunchId = Schema.decodeUnknownSync(ToolEgressLaunchId);
  const harnessProxiedShell =
    harnessEgressEndpoint === undefined
      ? undefined
      : (scope: HarnessEgressScope) =>
          createNativeHarnessShell({
            process: harnessProcessPort,
            scriptDirectory: harnessScriptDirectory,
            egress: {
              scope: {
                threadId: decodeEgressAggregateId(scope.threadId),
                projectId: decodeEgressAggregateId(scope.projectId),
                ...(scope.parentThreadId === undefined
                  ? {}
                  : { parentThreadId: decodeEgressAggregateId(scope.parentThreadId) }),
              },
              startLaunch: (launch, confirmed) =>
                toolEgressRules.startLaunch({
                  launch,
                  endpoint: harnessEgressEndpoint,
                  confirmed,
                }),
              launchId: () => decodeEgressLaunchId(randomUUID()),
            },
          });
  const nativeHarnessRoutingRoutes = createNativeHarnessRoutingRouteHandler({
    windowAuthorityStore,
    store: nativeHarnessRoutingStore,
  });
  const followUpCreation: { current: FollowUpCreationDependencies | undefined } = {
    current: undefined,
  };
  const createFollowUpOnHost = (input: Parameters<typeof createFollowUp>[1]) =>
    followUpCreation.current === undefined
      ? Promise.resolve({
          kind: "refused" as const,
          message: "Follow-up creation is unavailable on this host.",
        })
      : createFollowUp(followUpCreation.current, input);
  const followUpActions: FollowUpSuggestionActionDependencies = {
    store: threadFollowUpSuggestions,
    createFollowUp: createFollowUpOnHost,
  };
  // Bound once the Chat, Work, and Code turn services exist, like the creator.
  const sideTaskFirstMessage: {
    current:
      | ((input: {
          readonly windowId: string;
          readonly mode: OctantMode;
          readonly threadId: string;
          readonly prompt: string;
        }) => Promise<boolean>)
      | undefined;
  } = { current: undefined };
  const authorizeFollowUpThread = ({
    threadId,
    windowId,
  }: {
    readonly threadId: string;
    readonly windowId: string;
  }) =>
    authorizeAgentRunParentThread({
      persistence,
      workThreadProjection,
      parentThreadId: threadId as never,
      windowId,
    });
  const followUpSuggestionRoutes = createFollowUpSuggestionRouteHandler({
    ...followUpActions,
    windowAuthorityStore,
    authorizeThread: authorizeFollowUpThread,
  });
  const sideTaskRoutes = createSideTaskRouteHandler({
    store: sideTasks,
    windowAuthorityStore,
    authorizeThread: authorizeFollowUpThread,
    create: createFollowUpOnHost,
    sendFirstMessage: (input) => sideTaskFirstMessage.current?.(input) ?? Promise.resolve(false),
    clock: () => new Date().toISOString(),
  });
  const nativeHarnessEgressRoutes = createNativeHarnessEgressRouteHandler({
    windowAuthorityStore,
    rules: toolEgressRules,
    authorizeThread: authorizeFollowUpThread,
  });
  const nativeHarnessSessionRoutes = createNativeHarnessSessionRouteHandler({
    windowAuthorityStore,
    store: {
      read: (threadId) => {
        nativeHarnessApprovals.expireOverdue();
        nativeHarnessQuestions.expireOverdue();
        const view = nativeHarnessSessions.read(threadId);
        const suggestions = threadFollowUpSuggestions.read(threadId);
        return view === undefined || suggestions === undefined
          ? view
          : {
              ...view,
              followUps: suggestions.followUps,
              activatedFollowUpIds: suggestions.activatedFollowUpIds,
            };
      },
      pause: (...args) => nativeHarnessSessions.pause(...args),
      resume: (...args) => nativeHarnessSessions.resume(...args),
      turnInFlight: (threadId) => nativeHarnessSessions.turnInFlight(threadId),
    },
    // A goal loop schedules its own rounds, so a pause must stop it too;
    // it stays paused until a person resumes the loop itself.
    onPaused: ({ threadId }) => {
      const loop = goalLoopService().read(threadId).loop;
      if (loop?.status !== "running") return;
      void goalLoopService()
        .execute({ kind: "pause-goal-loop", threadId, expectedVersion: loop.version })
        .catch(() => undefined);
    },
    onRecoveryLifted: ({ threadId, mode }) => {
      if (mode === "code") codeOperationRuntime?.settleCutOffTurns?.(threadId);
    },
    recoveryBlockers: async ({ threadId }) => {
      const view = nativeHarnessSessions.read(threadId);
      if (view === undefined) return [];
      return nativeHarnessRecoveryBlockers(
        {
          providerInstance: (id) => persistence.readProviderInstance(id),
          codeCheckout: (id) => {
            try {
              const thread = persistence.readCodeThread(decodeCodeThreadId(id));
              return thread === undefined
                ? undefined
                : persistence.readCodeCheckout(thread.checkoutId);
            } catch {
              return undefined;
            }
          },
          project: (id) => persistence.readProject(id),
          directory: async (path) => {
            const isDirectory = await statFromDisk(path)
              .then((entry) => entry.isDirectory())
              .catch(() => false);
            return isDirectory ? await realpath(path).catch(() => undefined) : undefined;
          },
        },
        view,
      );
    },
    followUps: followUpActions,
    answerQuestion: ({ threadId, questionId, answer }) =>
      nativeHarnessQuestions.answer(threadId, questionId, answer),
    decideApproval: ({ threadId, approvalId, decision, answer }) =>
      nativeHarnessApprovals.decide(threadId, approvalId, decision, answer),
    steer: ({ threadId, command }) => {
      if (command.kind === "clear") {
        nativeHarnessSessions.clearSteering(threadId, "all");
        return "cleared";
      }
      if (command.kind === "take") {
        return { taken: nativeHarnessSessions.takeSteering(threadId) };
      }
      return nativeHarnessSessions.queueSteering(threadId, {
        id: command.noteId ?? randomUUID(),
        text: command.text,
        status: "queued",
        at: new Date().toISOString() as never,
      });
    },
    authorizeThread: authorizeFollowUpThread,
  });
  const nativeHarnessObserver = new NativeHarnessTurnObserver({
    sessions: nativeHarnessSessions,
    router: nativeHarnessRouter,
    isHarnessProvider: (providerInstanceId) => {
      const instance = persistence.readProviderInstance(providerInstanceId);
      return instance !== undefined && isNativeHarnessDriverKind(instance.driverKind);
    },
    resolveDriver: (providerInstanceId) => {
      const instance = persistence.readProviderInstance(providerInstanceId);
      if (instance === undefined || !instance.enabled) return undefined;
      try {
        return makeConfiguredProviderDriver(instance, configuredDriverOptions);
      } catch {
        return undefined;
      }
    },
    hostId: String(LOCAL_HOST_ID),
    scratchRoot: harnessWorkDirectory,
    contextHarness,
    readGoal: (threadId) => goalService.read(threadId).goal ?? undefined,
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
  });
  late.nativeHarnessObserver.current = nativeHarnessObserver;
  const nativeHarnessLeadFallback = new NativeHarnessLeadFallbackService({
    router: nativeHarnessRouter,
    sessions: nativeHarnessSessions,
    hostId: String(LOCAL_HOST_ID),
    // Building the driver is what registers its endpoint, so a fallback onto an
    // instance no turn has used yet since boot still finds it.
    endpointFor: (providerInstanceId) => {
      const instance = persistence.readProviderInstance(providerInstanceId as never);
      if (instance === undefined || !instance.enabled) return undefined;
      try {
        makeConfiguredProviderDriver(instance, configuredDriverOptions);
      } catch {
        return undefined;
      }
      return nativeHarnessEndpoints.get(instance.id);
    },
  });
  late.nativeHarnessLeadFallback.current = nativeHarnessLeadFallback;
  const nativeHarnessComposition = createNativeHarnessComposition({
    goals: goalService,
    questions: nativeHarnessQuestions,
    approvals: nativeHarnessApprovals,
    childInteractions: (run) => agentRunInteractions.toolsFor(run) ?? {},
    isChildAuthorityCurrent: (run) => agentRunInteractions.isCurrent(run) === true,
    activity: nativeHarnessSessions,
    secondOpinion: (scope) =>
      createNativeHarnessSecondOpinionPort(
        {
          router: nativeHarnessRouter,
          sessions: nativeHarnessSessions,
          resolveDriver: (providerInstanceId) => {
            const instance = persistence.readProviderInstance(providerInstanceId);
            if (instance === undefined || !instance.enabled) return undefined;
            try {
              return makeConfiguredProviderDriver(instance, configuredDriverOptions);
            } catch {
              return undefined;
            }
          },
          scratchRoot: harnessWorkDirectory,
          uuid: randomUUID,
        },
        scope,
      ),
    delegate: (scope) =>
      createNativeHarnessDelegatePort(
        {
          admission: agentRunAdmission,
          orchestration: agentRunOrchestration,
          persistence: agentRunPersistence,
          listTargets: () => agentRunEligibleTargets(scope.projectId),
          isTainted: () =>
            readThreadExternalContentTaint(persistence.connection, scope.parentThreadId)
              .externalContentIngested,
          router: nativeHarnessRouter,
          sessions: nativeHarnessSessions,
          uuid: randomUUID,
        },
        scope,
      ),
    authority: createNativeHarnessAuthority({
      hostId: deriveToolHostId(providerDataDirectory),
      persistence,
      workThreads: workThreadProjection,
      runningWorkTurnAccess: (threadId) => late.runningWorkTurnAccess.current?.(threadId),
      readThreadTaint: (threadId) =>
        readThreadExternalContentTaint(persistence.connection, threadId),
    }),
    isHarnessProvider: (providerInstanceId) => {
      const instance = persistence.readProviderInstance(providerInstanceId);
      return instance !== undefined && isNativeHarnessDriverKind(instance.driverKind);
    },
    tasks: nativeHarnessSessions,
    shell: createNativeHarnessShell({
      process: harnessProcessPort,
      scriptDirectory: harnessScriptDirectory,
    }),
    offlineShell: createNativeHarnessShell({
      process: harnessOfflineProcessPort,
      scriptDirectory: harnessScriptDirectory,
    }),
    ...(harnessProxiedShell === undefined
      ? {}
      : {
          proxiedShell: harnessProxiedShell,
          commandHosts: (threadId: string) => toolEgressRules.commandConfirmationHosts(threadId),
        }),
    // The posture a command's network follows is the one its turn may use:
    // the window's session grant, clamped to the running turn's posture, so
    // a thread widened mid-turn keeps that turn's commands on `proxied`.
    readCodeExecutionPolicy: codeTurnExecutionPolicyReader({
      readCodeThread: (threadId) => persistence.readCodeThread(threadId),
      codeSessionAuthority,
      codeOperationRuntime,
    }),
    resolveWebSearch: () =>
      searxngHarnessWebSearch({
        readBaseUrl: () => persistence.readChatSettings()?.settings.searxngBaseUrl,
      }),
    webFetch: async (input) => {
      try {
        return await fetchPublicUrl(input);
      } catch (error) {
        if (error instanceof PublicFetchRefused) return { refused: error.reason };
        throw error;
      }
    },
    contextHarness,
    hostId: deriveToolHostId(providerDataDirectory),
    readThreadTaint: (threadId) =>
      readThreadExternalContentTaint(persistence.connection, threadId).externalContentIngested,
    recordExternalContentIngestion: (input) => externalContentIngestionStore.record(input),
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
  });
  late.nativeHarnessComposition.current = nativeHarnessComposition;
  return {
    followUpCreation,
    followUpSuggestionRoutes,
    nativeHarnessComposition,
    nativeHarnessEgressRoutes,
    nativeHarnessRoutingRoutes,
    nativeHarnessSessionRoutes,
    researchRouter,
    sideTaskFirstMessage,
    sideTaskRoutes,
    threadWork,
  };
}

export type HarnessWiring = ReturnType<typeof wireHarness>;
