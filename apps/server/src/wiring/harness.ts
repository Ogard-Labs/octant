import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { realpath, stat as statFromDisk } from "node:fs/promises";
import { join } from "node:path";
import { queueSteeringWhereDelivered, withSteerable } from "../harness/nativeHarnessSteerability";
import { createHostShield, shieldRoutesApprovals } from "../shield/hostShield";
import { chosenAutoReviewer } from "@octant/domain/guardrail-policy";
import { readsSecretsThenEgress } from "@octant/domain/shield-judge-policy";
import { isProtectedSecretPath } from "../process/secretGuard";
import { recordShieldReviewUsage } from "../shield/shieldUsageLedger";
import { createRuntimeForgeChangeObserver } from "../shield/runtimeForgeChanges";
import {
  AggregateId,
  type CodeThread,
  decodeCodeThreadId,
  decodeNativeHarnessTurnId,
  LOCAL_HOST_ID,
  type OctantMode,
  type ProviderInstanceId,
  ToolEgressLaunchId,
  type ProviderRuntimeEvent,
} from "@octant/contracts";
import { Schema } from "effect";
import type { PersistenceService } from "../persistence/persistenceService";
import { ResearchRouter } from "../chat/research/researchRouter";
import { SearxngClient } from "../chat/research/searxngClient";
import { ThreadWorkService } from "../chat/threadWorkService";
import { codeTurnExecutionPolicyReader } from "../code/codeTurnExecutionPolicy";
import { RepositoryTestProcessPort } from "../code/repositoryTestProcessPort";
import { nativeHarnessRecoveryBlockers } from "../harness/nativeHarnessRecovery";
import { newestChatAttemptSession } from "../harness/nativeHarnessJournalLookup";
import {
  readShieldWatcherLabels,
  readThreadExternalContentTaint,
} from "../context/externalContentTaintProjection";
import { createNativeHarnessAuthority } from "../harness/nativeHarnessAuthority";
import {
  createNativeHarnessComposition,
  type HarnessEgressScope,
} from "../harness/nativeHarnessComposition";
import { createNativeHarnessSecondOpinionPort } from "../harness/nativeHarnessSecondOpinion";
import { createNativeHarnessShell } from "../harness/nativeHarnessShell";
import { createNativeHarnessDelegatePort } from "../harness/nativeHarnessDelegatePort";
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
import {
  createNativeHarnessSessionRouteHandler,
  type NativeHarnessSessionRouteDependencies,
} from "../harness/nativeHarnessSessionRoutes";
import { createNativeHarnessEgressRouteHandler } from "../harness/nativeHarnessEgressRoutes";
import { NativeHarnessTurnObserver } from "../harness/nativeHarnessTurnObserver";
import { toTurnMetricsRecord, type TurnEndSummary } from "../metrics/turnEnd";
import { FOLLOW_UP_SUGGESTION_INSTRUCTIONS } from "../followUps/followUpSuggestionInstructions";
import { turnDecisionInstructions } from "../turnDecisions/turnDecisionInstructions";
import { parseFollowUpSuggestions } from "../followUps/followUpSuggestionParsing";
import { fetchPublicUrl, PublicFetchRefused } from "../harness/nativeHarnessWebFetch";
import { searxngHarnessWebSearch } from "../harness/nativeHarnessWebSearch";
import { deriveToolHostId } from "../browser/browserAuthorityResolver";
import { isNativeHarnessDriverKind, workThreadAccessOf } from "@octant/domain";
import { type AgentRunsWiring, authorizeAgentRunParentThread } from "./agentRuns";
import { makeConfiguredProviderDriver, type ProvidersWiring } from "./providers";
import type { ServerStart } from "./serverShape";
import type { AuthorityWiring } from "./authority";
import type { FoundationsWiring } from "./foundations";
import { createThreadIsListed } from "./windowThreadListing";
import type { IntegrationsWiring } from "./integrations";
import type { WorkspaceWiring } from "./workspace";
import type { HarnessStateWiring } from "./harnessState";
import type { WorkRequestStateWiring } from "./workRequestState";
import { createShieldServerRouteHandler } from "../shield/shieldServerRoutes";
import { createServerProjectRouteHandler } from "../serverProjects/serverProjectRoutes";
import { serverProjectOf } from "../serverProjects/serverProjectThreads";
import { openServerSshAccessFor } from "../shield/serverSshAccess";
import { makeServerSshKeysBrokerClient } from "../shield/sshKeyBrokerClient";
import { RuntimeRemoteCommands } from "../shield/runtimeRemoteCommands";
import {
  personSshAgentSocket,
  readRunbookFile,
  ShieldServerStore,
} from "../shield/shieldServerStore";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";

export type HarnessDependencies = Pick<ServerStart, "options" | "persistence"> &
  Pick<
    AuthorityWiring,
    | "agentRunParentAuthority"
    | "agentRunPersistence"
    | "codeParentActiveTurn"
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
    | "contributeChildTools"
    | "externalContentIngestionStore"
    | "remoteDelegation"
    | "sideTasks"
    | "threadFollowUpSuggestions"
    | "turnMetrics"
  > &
  Pick<IntegrationsWiring, "toolEgressRules" | "safeNetworkStore"> &
  Pick<WorkspaceWiring, "contextHarness" | "goalService"> &
  Pick<
    ProvidersWiring,
    | "configuredDriverOptions"
    | "nativeHarnessLeadFallback"
    | "nativeHarnessTranscripts"
    | "providerDataDirectory"
  > &
  Pick<
    HarnessStateWiring,
    | "agentRunInteractions"
    | "serverProjectStore"
    | "serverRegistry"
    | "shieldHolder"
    | "nativeHarnessApprovals"
    | "nativeHarnessQuestions"
    | "nativeHarnessSessions"
  > &
  Pick<WorkRequestStateWiring, "runningWorkTurnAccess"> &
  Pick<
    FoundationsWiring,
    | "codeBoardEventStore"
    | "codeEvidence"
    | "providerRuntimeRegistry"
    | "workThreadProjection"
    | "workTurnProjection"
  > &
  Pick<AgentRunsWiring, "spendCeiling"> &
  Pick<WorkspaceWiring, "projectService">;

export function wireHarness(deps: HarnessDependencies) {
  const {
    safeNetworkStore,
    agentRunAdmission,
    agentRunEligibleTargets,
    agentRunInteractions,
    serverProjectStore,
    serverRegistry,
    agentRunOrchestration,
    agentRunPersistence,
    codeBoardEventStore,
    codeEvidence,
    codeParentActiveTurn,
    codeSessionAuthority,
    configuredDriverOptions,
    contextHarness,
    contributeChildTools,
    externalContentIngestionStore,
    goalService,
    nativeHarnessApprovals,
    providerRuntimeRegistry,
    shieldHolder,
    spendCeiling,
    nativeHarnessLeadFallback,
    nativeHarnessQuestions,
    nativeHarnessRouter,
    remoteDelegation,
    nativeHarnessRoutingStore,
    nativeHarnessSessions,
    nativeHarnessTranscripts,
    persistence,
    providerDataDirectory,
    runningWorkTurnAccess,
    sideTasks,
    threadFollowUpSuggestions,
    toolEgressRules,
    turnMetrics,
    windowAuthorityStore,
    workThreadProjection,
    workTurnProjection,
    options,
  } = deps;
  // The keys Octant keeps for servers that sign in with one, in the broker.
  const serverSshKeys =
    options.credentialBrokerUrl === undefined || options.credentialBrokerToken === undefined
      ? undefined
      : makeServerSshKeysBrokerClient({
          url: options.credentialBrokerUrl,
          token: options.credentialBrokerToken,
        });

  // Octant Shield's server registry: SSH to these servers is judged by their
  // profiles, and every remote command a harness shell runs is recorded.
  const shieldServerStore = new ShieldServerStore({
    journal: persistence.journal,
    personActor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    hostActor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
    readRunbook: readRunbookFile,
  });
  shieldServerStore.load();
  const sshAgentSocket = () => personSshAgentSocket(process.env.SSH_AUTH_SOCK);
  const shieldServerRoutes = createShieldServerRouteHandler({
    windowAuthorityStore,
    store: shieldServerStore,
    sshAgentAvailable: () => sshAgentSocket() !== undefined,
    ...(serverSshKeys === undefined ? {} : { sshKeys: serverSshKeys }),
    projectExists: (projectId) => persistence.readProject(projectId as never) !== undefined,
  });
  // Code Projects bound to a folder on one of those servers.
  serverRegistry.servers = () => shieldServerStore.servers();
  const serverProjectRoutes = createServerProjectRouteHandler({
    windowAuthorityStore,
    store: serverProjectStore,
  });
  const runtimeRemoteCommands = new RuntimeRemoteCommands((input) =>
    shieldServerStore.recordRemoteCommand(input),
  );
  /** The Project a Code or Work thread belongs to, whose own server list applies. */
  const threadProjectId = (threadId: string): string | undefined => {
    const projectId =
      persistence.readCodeThread(threadId as never)?.projectId ??
      workThreadProjection.read(threadId as never)?.projectId;
    return projectId === undefined ? undefined : String(projectId);
  };

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
  // Full access runs a command the way the providers' own apps do: outside
  // Octant's OS sandbox, network open. The owned process group, receipts and
  // output capture stay, so the command is still journaled and stoppable.
  const harnessFullAccessProcessPort = new RepositoryTestProcessPort({
    receiptDirectory: join(providerDataDirectory, "harness", "receipts"),
    temporaryDirectory: harnessWorkDirectory,
    harnessShellScriptDirectory: harnessScriptDirectory,
    confinement: { prepare: ({ executable, args }) => ({ command: executable, args }) },
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
            sshAgentSocket,
            // Below Full access a command reaches a registered server only
            // through the host's relays and agent socket, which Seatbelt
            // alone can open to it.
            ...(process.platform === "darwin"
              ? {
                  serverAccess: (command: string, folder: string) =>
                    openServerSshAccessFor(
                      command,
                      folder,
                      shieldServerStore.serversFor(scope.projectId),
                      { personAgentSocket: sshAgentSocket },
                    ),
                }
              : {}),
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
    authorizeListing: createThreadIsListed({
      persistence,
      workThreadProjection,
      projectService: deps.projectService,
    }),
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
  // A person's pause of a harness session reaches the areas that keep work
  // going on the thread by themselves (a Work goal loop), which subscribe here.
  const pausedByPersonListeners: Array<(input: { readonly threadId: string }) => void> = [];
  const onHarnessPausedByPerson = (
    listener: (input: { readonly threadId: string }) => void,
  ): void => {
    pausedByPersonListeners.push(listener);
  };
  // Recovery lets the Code runtime settle its orphaned turns. A continuation
  // does this while the session still holds dispatch, before queueing its next turn.
  const recoveryLiftedListeners: Array<
    (input: { readonly threadId: string; readonly mode: OctantMode }) => void
  > = [];
  const onHarnessRecoveryLifted = (
    listener: (input: { readonly threadId: string; readonly mode: OctantMode }) => void,
  ): void => {
    recoveryLiftedListeners.push(listener);
  };
  const restartContinuation: {
    current: NativeHarnessSessionRouteDependencies["continueRecovery"];
  } = { current: undefined };
  const leadDeliversSteering = (providerInstanceId: ProviderInstanceId): boolean => {
    const instance = persistence.readProviderInstance(providerInstanceId);
    return instance !== undefined && isNativeHarnessDriverKind(instance.driverKind);
  };
  const nativeHarnessSessionRoutes = createNativeHarnessSessionRouteHandler({
    windowAuthorityStore,
    store: {
      read: (threadId) => {
        nativeHarnessApprovals.expireOverdue();
        nativeHarnessQuestions.expireOverdue();
        const read = nativeHarnessSessions.read(threadId);
        const view = read === undefined ? undefined : withSteerable(read, leadDeliversSteering);
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
    onPaused: (input) => {
      for (const listener of pausedByPersonListeners) listener(input);
    },
    settleInterruptedTurns: (input) => {
      for (const listener of recoveryLiftedListeners) listener(input);
    },
    continueRecovery: (input) =>
      restartContinuation.current?.(input) ??
      Promise.resolve({
        kind: "refused",
        message: "Restart continuation is unavailable on this host.",
      }),
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
      return queueSteeringWhereDelivered(nativeHarnessSessions, leadDeliversSteering, threadId, {
        id: command.noteId ?? randomUUID(),
        text: command.text,
        status: "queued",
        at: new Date().toISOString() as never,
      });
    },
    authorizeThread: authorizeFollowUpThread,
  });
  const nativeHarnessObserver = new NativeHarnessTurnObserver({
    serverContext: (projectId) => shieldServerStore.context(projectId),
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
  // Every provider's turn passes through these hooks; a harness turn also
  // reaches the observer and the lead fallback.
  const nativeHarnessHooks = {
    answerQuestion: (threadId: string, questionId: string, answer: string) => {
      nativeHarnessQuestions.answer(threadId, questionId, answer);
    },
    observeRemoteCommand: (
      threadId: string,
      projectId: string | undefined,
      event: ProviderRuntimeEvent,
    ) => runtimeRemoteCommands.observe(threadId, projectId, event),
    contextFor: (scope: Parameters<NativeHarnessTurnObserver["contextFor"]>[0]) => [
      ...nativeHarnessObserver.contextFor(scope),
      ...nativeHarnessObserver.runtimeServerNotes(scope),
      ...turnDecisionInstructions(scope.mode),
      FOLLOW_UP_SUGGESTION_INSTRUCTIONS,
    ],
    admitTurn: (scope: Parameters<NativeHarnessTurnObserver["admitTurn"]>[0]) =>
      nativeHarnessObserver.admitTurn(scope),
    turnStarted: (scope: Parameters<NativeHarnessTurnObserver["turnStarted"]>[0]) => {
      nativeHarnessObserver.turnStarted(scope);
      nativeHarnessLeadFallback.turnStarted(scope);
    },
    // The session view carries the retry notice the terminal footer and the
    // phone panel read; the transcript has its own copy from the turn stream.
    noteRetry: (
      scope: Parameters<NativeHarnessTurnObserver["noteRetry"]>[0],
      notice: Parameters<NativeHarnessTurnObserver["noteRetry"]>[1],
    ) => {
      nativeHarnessObserver.noteRetry(scope, notice);
    },
    clearRetry: (scope: Parameters<NativeHarnessTurnObserver["clearRetry"]>[0]) => {
      nativeHarnessObserver.clearRetry(scope);
    },
    turnEnded: (
      scope: Parameters<NativeHarnessTurnObserver["turnEnded"]>[0],
      turn?: TurnEndSummary,
    ) => {
      nativeHarnessObserver.turnEnded(scope, turn);
      nativeHarnessLeadFallback.turnEnded(scope);
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
      await nativeHarnessObserver.turnCompleted(input);
    },
  };
  const resolveConfiguredDriver = (providerInstanceId: ProviderInstanceId) => {
    const instance = persistence.readProviderInstance(providerInstanceId);
    if (instance === undefined || !instance.enabled) return undefined;
    try {
      return makeConfiguredProviderDriver(instance, configuredDriverOptions);
    } catch {
      return undefined;
    }
  };
  const readTurnExecutionPolicy = codeTurnExecutionPolicyReader({
    readCodeThread: (threadId) => persistence.readCodeThread(threadId),
    codeSessionAuthority,
    codeOperationRuntime: { threadWithActiveTurnPosture: codeParentActiveTurn },
  });
  const hostShield = createHostShield({
    readCodeThread: (threadId) => persistence.readCodeThread(threadId),
    chosenReviewer: (thread) => {
      const project = persistence.readProject(thread.projectId);
      // A Work Project has no reviewer of its own; Settings' choice applies.
      return chosenAutoReviewer({
        project: project?.type === "code" ? project : undefined,
        settings: persistence.readCodeSettings()?.settings,
      });
    },
    chosenModel: () => persistence.readCodeSettings()?.settings.shieldModel,
    readTurnExecutionPolicy: (threadId) => readTurnExecutionPolicy(threadId),
    // Work threads are reviewed at Auto as Code threads are; a Work turn's
    // level is its running turn's, else the thread's own.
    readWorkThread: (threadId) => workThreadProjection.read(threadId),
    readWorkTurnAccess: (threadId) => runningWorkTurnAccess(threadId),
    // What the person wrote: each turn's prompt, leaving out the turns the host
    // itself accepted to deliver a subagent's result.
    workPersonMessages: (threadId, limit) =>
      workTurnProjection
        .listForThread(threadId)
        .filter((turn) => turn.delivery === undefined)
        .map((turn) => turn.prompt)
        .slice(-limit),
    providerCapabilities: (providerInstanceId) =>
      providerRuntimeRegistry.observedState(providerInstanceId)?.capabilities,
    routesApprovals: (providerInstanceId) => {
      const instance = persistence.readProviderInstance(providerInstanceId);
      return instance !== undefined && shieldRoutesApprovals(instance.driverKind);
    },
    catalog: (providerInstanceId) => persistence.readProviderCatalog?.(providerInstanceId)?.models,
    resolveDriver: resolveConfiguredDriver,
    tainted: (threadId) =>
      readThreadExternalContentTaint(persistence.connection, threadId).externalContentIngested,
    watcherLabels: (threadId) => readShieldWatcherLabels(persistence.connection, threadId),
    personMessages: (threadId, limit) =>
      codeBoardEventStore.personPromptsForThread(threadId, limit).flatMap((prompt) => {
        const text = codeEvidence.read(prompt);
        return text === undefined ? [] : [text];
      }),
    spendCeiling,
    recordUsage: ({ threadId, model, usage }) =>
      recordShieldReviewUsage(
        {
          connection: persistence.connection,
          journal: persistence.journal,
          clock: () => new Date().toISOString(),
          uuid: randomUUID,
        },
        {
          threadId,
          providerInstanceId: model.providerInstanceId,
          modelId: model.modelId,
          usage,
        },
      ),
    servers: (threadId) => shieldServerStore.serversFor(threadProjectId(threadId)),
    protectedSecretPath: (path) => isProtectedSecretPath(path),
    // Places count for Shield only while Network limits are on, as they do
    // for the proxies, so turning the switch off returns every call to the
    // thread's and Project's own rules.
    safePlaces: (projectId) =>
      safeNetworkStore.limitsOn() ? safeNetworkStore.placesFor(projectId) : [],
    scratchRoot: harnessWorkDirectory,
  });
  shieldHolder.port = hostShield;
  // A provider runtime's own shell reports a command only as it starts, so
  // its pushes and pull-request changes are recorded, never stopped.
  const runtimeForgeChanges = createRuntimeForgeChangeObserver({
    branches: (threadId) => codeThreadBranches(persistence, threadId),
    record: (input) => shieldServerStore.recordForgeChange(input),
  });
  const nativeHarnessComposition = createNativeHarnessComposition({
    forgeChanges: {
      branches: (threadId) => codeThreadBranches(persistence, threadId),
      record: (input) => shieldServerStore.recordForgeChange({ ...input, via: "octant-harness" }),
    },
    recordRemoteCommand: (input) =>
      shieldServerStore.recordRemoteCommand({
        ...input,
        projectId: threadProjectId(input.threadId),
      }),
    protectedSecretPath: (path) => isProtectedSecretPath(path),
    tagSecretEgress: ({ threadId, readerThreadIds, command, workingDirectory }) =>
      readsSecretsThenEgress({
        command,
        workingDirectory,
        protectedSecretPath: (path) => isProtectedSecretPath(path),
        threadReadSecret: readerThreadIds.some((reader) =>
          readShieldWatcherLabels(persistence.connection, reader).includes("secret-path-read"),
        ),
      })
        ? shieldServerStore.recordTag({ threadId, tag: "reads-secrets-then-egress", command })
        : "not-tagged",
    goals: goalService,
    questions: nativeHarnessQuestions,
    approvals: nativeHarnessApprovals,
    shield: hostShield,
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
          remote: remoteDelegation,
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
      runningWorkTurnAccess,
      readThreadTaint: (threadId) =>
        readThreadExternalContentTaint(persistence.connection, threadId),
      holdsServerCodeThread: (thread) => serverProjectOf(serverProjectStore, thread) !== undefined,
    }),
    isHarnessProvider: (providerInstanceId) => {
      const instance = persistence.readProviderInstance(providerInstanceId);
      return instance !== undefined && isNativeHarnessDriverKind(instance.driverKind);
    },
    tasks: nativeHarnessSessions,
    shell: createNativeHarnessShell({
      process: harnessProcessPort,
      scriptDirectory: harnessScriptDirectory,
      sshAgentSocket,
    }),
    offlineShell: createNativeHarnessShell({
      process: harnessOfflineProcessPort,
      scriptDirectory: harnessScriptDirectory,
      sshAgentSocket,
    }),
    fullAccessShell: createNativeHarnessShell({
      process: harnessFullAccessProcessPort,
      scriptDirectory: harnessScriptDirectory,
      sshAgentSocket,
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
    readWorkExecutionPolicy: (threadId) => {
      const access = runningWorkTurnAccess(threadId);
      return access === undefined ? undefined : workThreadAccessOf(access).executionPolicy;
    },
    readCodeExecutionPolicy: codeTurnExecutionPolicyReader({
      readCodeThread: (threadId) => persistence.readCodeThread(threadId),
      codeSessionAuthority,
      codeOperationRuntime: { threadWithActiveTurnPosture: codeParentActiveTurn },
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
    journal: {
      transcripts: nativeHarnessTranscripts,
      latestChatSession: (threadId) =>
        newestChatAttemptSession(persistence.readChatThreadView(threadId)?.turns ?? []),
      latestWorkSession: (threadId) => {
        const latest = workTurnProjection.latestForThread(threadId);
        return latest === undefined
          ? undefined
          : {
              providerInstanceId: latest.authority.providerInstanceId,
              resumeCursor: latest.resumeCursor,
            };
      },
      latestCodeSession: (threadId) => codeBoardEventStore.latestProviderSession(threadId),
    },
    hostId: deriveToolHostId(providerDataDirectory),
    readThreadTaint: (threadId) =>
      readThreadExternalContentTaint(persistence.connection, threadId).externalContentIngested,
    recordExternalContentIngestion: (input) => externalContentIngestionStore.record(input),
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
  });
  // A managed child's harness tools come first in its tool set, ahead of
  // what later areas add.
  contributeChildTools((input) => nativeHarnessComposition.forAgentRun(input));
  return {
    runtimeForgeChanges,
    followUpCreation,
    restartContinuation,
    followUpSuggestionRoutes,
    nativeHarnessComposition,
    nativeHarnessEgressRoutes,
    nativeHarnessRoutingRoutes,
    shieldServerRoutes,
    shieldServerStore,
    serverProjectRoutes,
    nativeHarnessHooks,
    nativeHarnessSessionRoutes,
    onHarnessPausedByPerson,
    onHarnessRecoveryLifted,
    researchRouter,
    sideTaskFirstMessage,
    sideTaskRoutes,
    hostShield,
    threadWork,
  };
}

export type HarnessWiring = ReturnType<typeof wireHarness>;

/**
 * A Code thread's own delivery branch and the branches the other active
 * threads of its Project work on, which its shell never pushes to. A Work
 * thread has no branch of its own and no Code threads beside it.
 */
export function codeThreadBranches(
  persistence: Pick<PersistenceService, "readCodeThread" | "readCodeThreads">,
  threadId: string,
): { readonly ownBranch?: string; readonly otherThreadBranches: ReadonlyArray<string> } {
  let thread: CodeThread | undefined;
  try {
    thread = persistence.readCodeThread(decodeCodeThreadId(threadId));
  } catch {
    thread = undefined;
  }
  if (thread === undefined) return { otherThreadBranches: [] };
  const own = thread;
  return {
    ownBranch: own.deliveryTarget.branchIntent,
    otherThreadBranches: persistence
      .readCodeThreads()
      .filter(
        (other) =>
          String(other.projectId) === String(own.projectId) &&
          String(other.id) !== String(own.id) &&
          other.lifecycle === "active",
      )
      .map((other) => other.deliveryTarget.branchIntent),
  };
}
