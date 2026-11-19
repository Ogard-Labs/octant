import { configureSandboxNetworkSnapshot } from "../process/sandboxRuntimePolicy";
import { proxiedLaunchEnvironment } from "../process/proxiedNetworkEgress";
import { activeSandboxPolicy, configureSandboxToolNetwork } from "../process/sandboxRuntimePolicy";
import { RemoteSetupChecks } from "../serverProjects/remoteSetupChecks";
import { createRemoteSetupCheckRoutes } from "../serverProjects/remoteSetupCheckRoutes";
import { ServerPreviewTunnels } from "../serverProjects/serverPreviewTunnel";
import { createServerPreviewTunnelRoutes } from "../serverProjects/serverPreviewTunnelRoutes";
import { readOwnedProcessReceipts } from "../process/nodeOwnedProcessReceipt";
import { createCommandCredentialPreparation } from "../secretStores/commandCredentialPreparation";
import { serverWorkProjectOf } from "../serverProjects/serverWorkThreads";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { realpath, stat as statFromDisk } from "node:fs/promises";
import { join } from "node:path";
import { queueSteeringWhereDelivered, withSteerable } from "../harness/nativeHarnessSteerability";
import { createHostShield, shieldRoutesApprovals } from "../shield/hostShield";
import { chosenAutoReviewer, hostSandboxRefusal } from "@octant/domain/guardrail-policy";
import { readsSecretsThenEgress } from "@octant/domain/shield-judge-policy";
import { createAutomaticModelAccountCheck } from "../automaticModels/automaticModelAccount";
import { createPersonMemorySweep } from "../personMemory/personMemoryWiring";
import { createDecisionReviewModelPort } from "../turnDecisions/decisionReviewWiring";
import { isProtectedSecretPath } from "../process/secretGuard";
import { recordShieldReviewUsage } from "../shield/shieldUsageLedger";
import { createRuntimeForgeChangeObserver } from "../shield/runtimeForgeChanges";
import {
  AggregateId,
  type CodeThread,
  decodeCodeThreadId,
  decodeNativeHarnessTurnId,
  decodeWorkThreadId,
  LOCAL_HOST_ID,
  type OctantMode,
  type ProviderInstanceId,
  ToolEgressLaunchId,
  type ProviderRuntimeEvent,
} from "@octant/contracts";
import { Schema } from "effect";
import type { PersistenceService } from "../persistence/persistenceService";
import { ResearchRouter } from "../chat/research/researchRouter";
import { WebSearchSettingsService } from "../webSearch/webSearchSettingsService";
import { makeWebSearchCredentialBrokerClient } from "../providers/credentialBrokerClient";
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
import { createBenchmarkCheckCommands } from "../benchmarks/benchmarkCheckCommand";
import { createNativeHarnessShell } from "../harness/nativeHarnessShell";
import {
  createWindowsFullAccessShellPort,
  windowsScriptFileName,
  windowsScriptText,
} from "../harness/windowsFullAccessShell";
import { terminalShellFor } from "../code/terminalShell";
import { createNativeHarnessRoutingRouteHandler } from "../harness/nativeHarnessRoutingRoutes";
import { createHostImageDescriber, modelLabelOf, windowSeesProject } from "./imageDescriber";
import {
  createFollowUp,
  type FollowUpCreationDependencies,
} from "../followUps/followUpSuggestionCreation";
import {
  createFollowUpSuggestionRouteHandler,
  type FollowUpSuggestionActionDependencies,
} from "../followUps/followUpSuggestionRoutes";
import { createSideTaskRouteHandler } from "../sideTasks/sideTaskRoutes";
import { createFinishedReceiptRouteHandler } from "../finishedReceipts/finishedReceiptRoutes";
import type { SideTaskStartDependencies } from "../sideTasks/sideTaskStart";
import {
  createNativeHarnessSessionRouteHandler,
  type NativeHarnessSessionRouteDependencies,
} from "../harness/nativeHarnessSessionRoutes";
import { createNativeHarnessEgressRouteHandler } from "../harness/nativeHarnessEgressRoutes";
import { NativeHarnessTurnObserver } from "../harness/nativeHarnessTurnObserver";
import { openPromptDigester } from "../metrics/promptDigest";
import { toTurnMetricsRecord, type TurnEndSummary } from "../metrics/turnEnd";
import { followUpSuggestionInstructionsFor } from "../followUps/followUpSuggestionInstructions";
import { defaultShellSettings, nextMessageSuggestionsOn } from "@octant/domain/shell-policy";
import { octantOrientation } from "../orientation/octantOrientation";
import { turnDecisionInstructions } from "../turnDecisions/turnDecisionInstructions";
import { parseFollowUpSuggestions } from "../followUps/followUpSuggestionParsing";
import { fetchPublicUrl, PublicFetchRefused } from "../harness/nativeHarnessWebFetch";
import { harnessWebSearch } from "../harness/nativeHarnessWebSearch";
import { deriveToolHostId } from "../browser/browserAuthorityResolver";
import {
  isNativeHarnessDriverKind,
  providerOwnSearchOrigin,
  workThreadAccessOf,
} from "@octant/domain";
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
import { createServerResourceRoutes } from "../serverProjects/serverResourceRoutes";
import {
  createServerResourceReader,
  type ServerResourceRead,
} from "../serverProjects/serverResources";
import { createServerProjectRouteHandler } from "../serverProjects/serverProjectRoutes";
import { CloudMachineService } from "../cloudMachines/cloudMachineService";
import { createCloudMachineRouteHandler } from "../cloudMachines/cloudMachineRoutes";
import { serverProjectOf } from "../serverProjects/serverProjectThreads";
import { openServerSshAccessFor } from "../shield/serverSshAccess";
import { makeServerSshKeysBrokerClient } from "../shield/sshKeyBrokerClient";
import { RuntimeRemoteCommands } from "../shield/runtimeRemoteCommands";
import {
  personSshAgentSocket,
  readRunbookFile,
  ShieldServerStore,
} from "../shield/shieldServerStore";
import { createGoogleCliCommandCredentials } from "../secretStores/googleCliCommandCredentials";
import { awsCliEnvironment } from "../secretStores/awsCliEnvironment";
import { makeSecretStoreBrokerClient } from "../secretStores/secretStoreBrokerClient";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import type { ToolEffectLedger } from "../toolEffects/toolEffectLedger";

export type HarnessDependencies = Pick<ServerStart, "options" | "persistence"> &
  Pick<
    AuthorityWiring,
    | "agentRunParentAuthority"
    | "codeParentActiveTurn"
    | "codeSessionAuthority"
    | "personMemory"
    | "processAuthorityTime"
    | "toolEffectLedger"
    | "windowAuthorityStore"
  > &
  Pick<
    AgentRunsWiring,
    | "hostResourceBudget"
    | "nativeHarnessRouter"
    | "nativeHarnessRoutingStore"
    | "contributeChildTools"
    | "externalContentIngestionStore"
    | "sideTasks"
    | "finishedReceipts"
    | "threadFollowUpSuggestions"
    | "turnMetrics"
  > &
  Pick<IntegrationsWiring, "toolEgressRules" | "safeNetworkStore"> &
  Pick<WorkspaceWiring, "contextHarness" | "goalService"> &
  Pick<
    ProvidersWiring,
    | "configuredDriverOptions"
    | "effectiveSkills"
    | "nativeHarnessLeadFallback"
    | "nativeHarnessProviderSearchGrants"
    | "nativeHarnessTranscripts"
    | "providerDataDirectory"
    | "providerUsageLimitsService"
    | "providerAvailabilityMarks"
  > &
  Pick<
    HarnessStateWiring,
    | "agentRunInteractions"
    | "cloudMachineServers"
    | "serverConnection"
    | "serverProjectStore"
    | "serverRegistry"
    | "shieldHolder"
    | "nativeHarnessApprovals"
    | "nativeHarnessQuestions"
    | "nativeHarnessSessions"
  > &
  Pick<WorkRequestStateWiring, "runningWorkTurnAccess" | "runningWorkTurnSandbox"> &
  Pick<
    FoundationsWiring,
    | "resolveThreadStrict"
    | "codeBoardEventStore"
    | "codeEvidence"
    | "isProjectPolicyTargetAllowed"
    | "providerRuntimeRegistry"
    | "workThreadProjection"
    | "workTurnProjection"
  > &
  Pick<AgentRunsWiring, "spendCeiling"> &
  Pick<WorkspaceWiring, "projectService">;

export function wireHarness(deps: HarnessDependencies) {
  const {
    resolveThreadStrict,
    safeNetworkStore,
    agentRunInteractions,
    cloudMachineServers,
    serverConnection,
    serverProjectStore,
    serverRegistry,
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
    providerUsageLimitsService,
    shieldHolder,
    spendCeiling,
    nativeHarnessLeadFallback,
    nativeHarnessProviderSearchGrants,
    nativeHarnessQuestions,
    nativeHarnessRouter,
    nativeHarnessRoutingStore,
    nativeHarnessSessions,
    nativeHarnessTranscripts,
    options,
    persistence,
    processAuthorityTime,
    providerDataDirectory,
    runningWorkTurnAccess,
    runningWorkTurnSandbox,
    sideTasks,
    finishedReceipts,
    threadFollowUpSuggestions,
    toolEgressRules,
    turnMetrics,
    windowAuthorityStore,
    workThreadProjection,
    workTurnProjection,
    personMemory,
  } = deps;
  // Read on every turn, so a change in Settings applies to the next turn
  // without a restart.
  const predictsNextMessage = (mode: OctantMode): boolean =>
    nextMessageSuggestionsOn(
      persistence.readShellSettings()?.settings ?? defaultShellSettings(),
      mode,
    );
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
    projectsBoundTo: (serverId) =>
      serverProjectStore
        .projects()
        .filter((project) => String(project.serverId) === serverId)
        .map((project) => project.name),
  });
  shieldServerStore.load();
  const sshAgentSocket = () => personSshAgentSocket(process.env.SSH_AUTH_SOCK);
  // The AWS command line's short-lived session, when the person pointed its
  // key pair at a linked secret store; the long-lived pair stays in the broker.
  const secretStoreBroker =
    options.credentialBrokerUrl === undefined || options.credentialBrokerToken === undefined
      ? undefined
      : makeSecretStoreBrokerClient({
          url: options.credentialBrokerUrl,
          token: options.credentialBrokerToken,
        });
  const cloudCliEnvironment = () => awsCliEnvironment(secretStoreBroker);
  const shieldServerRoutes = createShieldServerRouteHandler({
    windowAuthorityStore,
    store: shieldServerStore,
    sshAgentAvailable: () => sshAgentSocket() !== undefined,
    ...(serverSshKeys === undefined ? {} : { sshKeys: serverSshKeys }),
    projectExists: (projectId) => persistence.readProject(projectId as never) !== undefined,
  });
  // Code Projects bound to a folder on one of those servers.
  serverRegistry.servers = () => shieldServerStore.servers();
  serverRegistry.serversFor = (projectId) => shieldServerStore.serversFor(projectId);
  const serverPreviewTunnels = new ServerPreviewTunnels({
    now: processAuthorityTime,
    address: (projectId) => {
      const project = serverProjectStore.project(projectId);
      const address = serverProjectStore.addressOf(projectId);
      if (project === undefined || address.kind !== "address") return undefined;
      return {
        server: address.server,
        identity: JSON.stringify([
          project.serverId,
          project.folder,
          project.boundAt,
          address.server,
        ]),
      };
    },
    ownerCurrent: (owner) =>
      windowAuthorityStore.listWindowIds().some((id) => String(id) === owner),
    agentSocket: sshAgentSocket,
    pinnedKnownHosts: (server) => serverConnection.pinnedKnownHostsFile(server),
    refuses: (server) => serverConnection.refusal(server),
    record: (record) => serverProjectStore.recordPreview(record),
  });
  const previewRoutes = createServerPreviewTunnelRoutes({
    windows: windowAuthorityStore,
    tunnels: serverPreviewTunnels,
  });
  // Machines in the person's own cloud account, each bound as a server
  // Project. Targets arrive only from cloud machine target plugins the person
  // installed, trusted and enabled; no such plugin ships and no stored package
  // may run one yet, so the list is empty and nothing is created. Octant runs
  // no machines of its own to fall back to.
  const cloudMachines = new CloudMachineService({
    journal: persistence.journal,
    personActor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
    now: Date.now,
    targets: () => [],
    credentialHandle: async () => undefined,
    servers: shieldServerStore,
    projects: serverProjectStore,
  });
  cloudMachines.load();
  cloudMachineServers.pinnedHostKeys = (server) => cloudMachines.pinnedHostKeys(server);
  cloudMachineServers.suspendedRefusal = (server) => cloudMachines.suspendedRefusal(server);
  const cloudMachineRoutes = createCloudMachineRouteHandler({
    windowAuthorityStore,
    service: cloudMachines,
  });
  const catalogRoutes = createServerProjectRouteHandler({
    windowAuthorityStore,
    store: serverProjectStore,
    cloudMachineOf: (projectId) => cloudMachines.machineForProject(projectId),
  });
  const serverResourceReaders = new Map<string, () => Promise<ServerResourceRead>>();
  const resourceRoutes = createServerResourceRoutes({
    windows: windowAuthorityStore,
    readerFor: (projectId) => {
      if (serverProjectStore.addressOf(projectId).kind !== "address") return undefined;
      let reader = serverResourceReaders.get(projectId);
      if (reader === undefined) {
        reader = createServerResourceReader({
          connection: serverConnection,
          // Read each call, so a server removed mid-session refuses the next read.
          address: () => {
            const address = serverProjectStore.addressOf(projectId);
            return address.kind === "address"
              ? { server: address.server, folder: address.folder }
              : undefined;
          },
        });
        serverResourceReaders.set(projectId, reader);
      }
      return reader;
    },
  });
  const setupCheckRoutes = createRemoteSetupCheckRoutes({
    windows: windowAuthorityStore,
    checks: new RemoteSetupChecks({
      servers: () => shieldServerStore.servers(),
      agentAvailable: () => sshAgentSocket() !== undefined,
      connection: serverConnection,
    }),
  });
  const serverProjectRoutes = async (request: Request) =>
    (await setupCheckRoutes(request)) ??
    (await previewRoutes(request)) ??
    (await resourceRoutes(request)) ??
    (await cloudMachineRoutes(request)) ??
    catalogRoutes(request);
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

  const webSearchSettings = new WebSearchSettingsService({
    connection: persistence.connection,
    journal: persistence.journal,
    clock: () => new Date().toISOString(),
    uuid: randomUUID,
    readChatSearxngBaseUrl: () => persistence.readChatSettings()?.settings.searxngBaseUrl,
    // Search keys sit in the broker's own namespace; a host with no broker
    // has none, and keyed vendors read as Needs key.
    ...(options.credentialBrokerUrl === undefined || options.credentialBrokerToken === undefined
      ? {}
      : {
          keys: makeWebSearchCredentialBrokerClient({
            url: options.credentialBrokerUrl,
            token: options.credentialBrokerToken,
          }),
        }),
  });
  const researchRouter = new ResearchRouter({ webSearch: webSearchSettings });
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
  const googleCliCommands = createGoogleCliCommandCredentials({
    broker: secretStoreBroker,
    scriptRoot: harnessScriptDirectory,
    configurationRoot: join(providerDataDirectory, "harness", "cloud-cli"),
  });
  const harnessProcessPort = new RepositoryTestProcessPort({
    resourceBudget: deps.hostResourceBudget,
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
    resourceBudget: deps.hostResourceBudget,
    receiptDirectory: join(providerDataDirectory, "harness", "receipts"),
    temporaryDirectory: harnessOfflineWorkDirectory,
    networkEgress: "none",
    harnessShellScriptDirectory: harnessScriptDirectory,
  });
  // Full access runs a command the way the providers' own apps do: outside
  // Octant's OS sandbox, network open. The owned process group, receipts and
  // output capture stay, so the command is still journaled and stoppable.
  const windowsHarnessShell = () =>
    terminalShellFor({
      platform: "win32",
      windowsShell: persistence.readCodeSettings()?.settings.windowsTerminalShell,
    });
  // On Windows harness commands run in the terminal shell Settings › Code
  // names; each keeps a receipt beside the other harness commands' so a
  // restart finds and stops what a crash left running.
  const windowsHarnessShellPort =
    process.platform === "win32"
      ? createWindowsFullAccessShellPort({
          shell: windowsHarnessShell,
          scriptDirectory: harnessScriptDirectory,
          receiptDirectory: join(providerDataDirectory, "harness", "receipts"),
        })
      : undefined;
  const harnessFullAccessProcessPort = new RepositoryTestProcessPort({
    resourceBudget: deps.hostResourceBudget,
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
  configureSandboxNetworkSnapshot((threadId, selection) => ({
    places: structuredClone(safeNetworkStore.placesFor(String(selection.context.projectId))),
    limitsOn: safeNetworkStore.limitsOn(),
    rules: structuredClone(
      toolEgressRules.sandboxRules({
        launchId: decodeEgressLaunchId(randomUUID()),
        threadId: decodeEgressAggregateId(threadId),
        projectId: decodeEgressAggregateId(String(selection.context.projectId)),
      }),
    ),
  }));
  configureSandboxToolNetwork(
    async (threadId, policy) => {
      if (harnessEgressEndpoint === undefined)
        throw new Error("This host cannot mediate the selected network policy.");
      const started = await toolEgressRules.startLaunch({
        launch: {
          launchId: decodeEgressLaunchId(randomUUID()),
          threadId: decodeEgressAggregateId(threadId),
          projectId: decodeEgressAggregateId(String(policy.context.projectId)),
        },
        endpoint: harnessEgressEndpoint,
      });
      if (started.status === "refused")
        throw new Error("The sandbox network broker is unavailable. No command was started.");
      return {
        permitsHostRequest: (host, port) => started.launch.proxy.permitsHostRequest(host, port),
        networkEgress: { kind: "proxied", endpoint: started.launch.proxy.endpoint },
        environment: proxiedLaunchEnvironment(
          started.launch.proxy.endpoint,
          started.launch.proxy.token,
        ),
        close: async () => {
          await started.launch.finish();
        },
      };
    },
    () => safeNetworkStore.limitsOn(),
  );
  const harnessProxiedShell =
    harnessEgressEndpoint === undefined
      ? undefined
      : (scope: HarnessEgressScope) =>
          createNativeHarnessShell({
            sandboxPolicy: () => activeSandboxPolicy(scope.threadId),
            process: harnessProcessPort,
            scriptDirectory: harnessScriptDirectory,
            sshAgentSocket,
            cloudCliEnvironment,
            googleCliCredentials: googleCliCommands.prepare,
            // Below Full access a command reaches a registered server only
            // through the host's relays and agent socket: ports Seatbelt
            // opens on macOS, sockets the capsule's forwarder dials on Linux.
            serverAccess: (command: string, folder: string) =>
              openServerSshAccessFor(
                command,
                folder,
                shieldServerStore.serversFor(scope.projectId),
                {
                  personAgentSocket: sshAgentSocket,
                  keys: serverSshKeys,
                  ...(harnessEgressEndpoint.kind === "unix-socket"
                    ? { relays: "unix-socket" as const }
                    : {}),
                },
              ),
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
  // Sees images: one describer for Code and Work, deciding on the same facts
  // a coordinator worker's choice reads.
  const imageDescriber = createHostImageDescriber({
    persistence,
    providerRuntimeRegistry,
    nativeHarnessRoutingStore,
    providerAvailabilityMarks: deps.providerAvailabilityMarks,
    providerUsageLimitsService,
    isProjectPolicyTargetAllowed: deps.isProjectPolicyTargetAllowed,
    configuredDriverOptions: () => configuredDriverOptions,
    providerDataDirectory,
    spendCeiling,
  });
  const nativeHarnessRoutingRoutes = createNativeHarnessRoutingRouteHandler({
    windowAuthorityStore,
    store: nativeHarnessRoutingStore,
    windowSeesProject: (windowId, projectId) =>
      windowSeesProject(
        {
          readProject: (id) => persistence.readProject(id),
          readWorkspace: (id) => persistence.readWindowWorkspace(id)?.workspace,
        },
        windowId,
        projectId,
      ),
    seesImages: (input) =>
      imageDescriber.available({
        projectId: input.projectId,
        threadModel: modelLabelOf(
          { persistence, providerRuntimeRegistry },
          input.providerInstanceId,
          input.modelId,
        ),
      }),
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
  // Bound once the Chat, Work, and Code turn services and the message queue
  // exist, like the creator.
  const sideTaskHost: {
    current:
      | Pick<SideTaskStartDependencies, "fork" | "offeringTurn" | "sendTurn" | "continueHere">
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
    fork: (input) =>
      sideTaskHost.current?.fork(input) ??
      Promise.resolve({ kind: "refused", message: "Forking is unavailable on this host." }),
    offeringTurn: (input) => sideTaskHost.current?.offeringTurn(input) ?? "not-found",
    sendTurn: (input) => sideTaskHost.current?.sendTurn(input) ?? Promise.resolve(false),
    continueHere: (input) =>
      sideTaskHost.current?.continueHere(input) ??
      Promise.resolve({ kind: "refused", message: "This thread cannot take a message now." }),
    clock: () => new Date().toISOString(),
  });
  const finishedReceiptRoutes = createFinishedReceiptRouteHandler({
    store: finishedReceipts,
    windowAuthorityStore,
    authorizeThread: authorizeFollowUpThread,
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
  const recoveryBlockers = async (threadId: string): Promise<ReadonlyArray<string>> => {
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
  };
  /**
   * The host's own Resume of a session a restart left needing recovery, for a
   * turn it continues by itself: the same blockers and the same settlement a
   * person's Resume with Continue takes, in the same order, so the cut-off
   * turn reads settled before the continuation starts.
   */
  const liftRestartRecovery = async (
    threadId: string,
  ): Promise<
    { readonly kind: "none" | "lifted" } | { readonly kind: "held"; readonly detail: string }
  > => {
    const view = nativeHarnessSessions.read(threadId);
    if (view?.session.status !== "recovery-required") return { kind: "none" };
    const blockers = await recoveryBlockers(threadId);
    if (blockers.length > 0)
      return { kind: "held", detail: `Not ready to resume: ${blockers.join(" ")}`.slice(0, 255) };
    for (const listener of recoveryLiftedListeners) listener({ threadId, mode: view.session.mode });
    return nativeHarnessSessions.resume(threadId)
      ? { kind: "lifted" }
      : { kind: "held", detail: "The thread's harness session could not be resumed." };
  };
  const leadDeliversSteering = (providerInstanceId: ProviderInstanceId): boolean => {
    const instance = persistence.readProviderInstance(providerInstanceId);
    return instance !== undefined && isNativeHarnessDriverKind(instance.driverKind);
  };
  const nativeHarnessSessionRoutes = createNativeHarnessSessionRouteHandler({
    mayAnswerChildFromDevice: agentRunInteractions.mayAnswerFromDevice,
    windowAuthorityStore,
    store: {
      read: (threadId) => {
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
    recoveryBlockers: ({ threadId }) => recoveryBlockers(threadId),
    followUps: followUpActions,
    answerQuestion: ({ threadId, questionId, answer, actor }) =>
      nativeHarnessQuestions.answer(threadId, questionId, answer, actor),
    decideApproval: ({ threadId, approvalId, decision, answer }) =>
      nativeHarnessApprovals.decide(threadId, approvalId, decision, answer),
    steer: ({ threadId, command, actor }) => {
      if (command.kind === "clear") {
        nativeHarnessSessions.clearSteering(threadId, "all", actor);
        return "cleared";
      }
      if (command.kind === "take") {
        return { taken: nativeHarnessSessions.takeSteering(threadId, actor) };
      }
      return queueSteeringWhereDelivered(
        nativeHarnessSessions,
        leadDeliversSteering,
        threadId,
        {
          id: command.noteId ?? randomUUID(),
          text: command.text,
          status: "queued",
          at: new Date().toISOString() as never,
        },
        actor,
      );
    },
    authorizeThread: authorizeFollowUpThread,
  });
  const nativeHarnessObserver = new NativeHarnessTurnObserver({
    windowsShell: () => persistence.readCodeSettings()?.settings.windowsTerminalShell,
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
  // Services wired after the harness (context's compaction rules) hear every
  // settled turn here rather than through a hook of their own in each mode.
  const turnEndedObservers = new Set<
    (scope: Parameters<NativeHarnessTurnObserver["turnEnded"]>[0], turn: TurnEndSummary) => void
  >();
  const observeTurnEnded = (
    observer: (
      scope: Parameters<NativeHarnessTurnObserver["turnEnded"]>[0],
      turn: TurnEndSummary,
    ) => void,
  ): (() => void) => {
    turnEndedObservers.add(observer);
    return () => {
      turnEndedObservers.delete(observer);
    };
  };
  // Keyed with a host-local key kept in the provider data folder; a host that
  // cannot keep the key records turns without digests.
  const promptDigest = openPromptDigester(
    join(providerDataDirectory, "metrics", "prompt-digest.key"),
  );
  const { toolEffectLedger } = deps;
  const nativeHarnessHooks = {
    toolEffects: (turn: Parameters<ToolEffectLedger["forTurn"]>[0]) =>
      toolEffectLedger.forTurn(turn),
    ...(promptDigest === undefined ? {} : { promptDigest }),
    answerQuestion: (threadId: string, questionId: string, answer: string) => {
      return nativeHarnessQuestions.answer(threadId, questionId, answer);
    },
    observeRemoteCommand: (
      threadId: string,
      projectId: string | undefined,
      event: ProviderRuntimeEvent,
    ) => runtimeRemoteCommands.observe(threadId, projectId, event),
    // Orientation first and the reply formats it introduces next, ahead of
    // each mode's own rules and tool notes, so every mode and provider opens
    // its instructions the same way.
    contextFor: (scope: Parameters<NativeHarnessTurnObserver["contextFor"]>[0]) => [
      octantOrientation(scope.mode),
      ...nativeHarnessObserver.contextFor(scope),
      ...nativeHarnessObserver.runtimeServerNotes(scope),
      ...turnDecisionInstructions(scope.mode),
      followUpSuggestionInstructionsFor(predictsNextMessage(scope.mode)),
    ],
    admitTurn: (scope: Parameters<NativeHarnessTurnObserver["admitTurn"]>[0]) =>
      nativeHarnessObserver.admitTurn(scope),
    turnStarted: (scope: Parameters<NativeHarnessTurnObserver["turnStarted"]>[0]) => {
      nativeHarnessObserver.turnStarted(scope);
      nativeHarnessLeadFallback.turnStarted(scope);
      try {
        threadFollowUpSuggestions.spendNextMessage(scope.threadId);
      } catch {
        // A spend the journal refused leaves an offer up; the turn still runs.
      }
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
      for (const observer of turnEndedObservers) {
        try {
          observer(scope, turn);
        } catch {
          // One observer's failure must not keep the turn's end from the rest.
        }
      }
    },
    turnCompleted: async (input: Parameters<NativeHarnessTurnObserver["turnCompleted"]>[0]) => {
      try {
        const offered = parseFollowUpSuggestions({
          text: input.text,
          turnId: decodeNativeHarnessTurnId(randomUUID()),
          uuid: randomUUID,
        });
        threadFollowUpSuggestions.recordReply({
          threadId: input.threadId,
          mode: input.mode,
          projectId: input.projectId,
          suggestedBy: { providerInstanceId: input.providerInstanceId, modelId: input.modelId },
          followUps: offered.followUps,
          // A prediction from a turn that began before the setting changed is
          // not kept, so switching a mode off empties its composer at once.
          nextMessage: predictsNextMessage(input.mode) ? offered.nextMessage : undefined,
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
  // The account the person chose for an automatic call is asked as it is: off,
  // not ready or at its limit, it is reported and no other account is tried.
  const automaticModelAccountUnavailable = createAutomaticModelAccountCheck({
    readProviderInstance: (id) => persistence.readProviderInstance(id),
    readiness: (id) => providerRuntimeRegistry.observedState(id)?.readiness,
    limits: () => providerUsageLimitsService.snapshot(),
  });
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
    chosenModelUnavailable: (choice) => automaticModelAccountUnavailable(choice.providerInstanceId),
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
    strict: (threadId) => resolveThreadStrict(threadId),
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
  const personMemorySweep = createPersonMemorySweep({
    persistence,
    store: personMemory,
    workThreads: {
      list: () =>
        workThreadProjection.list().map((thread) => ({
          id: String(thread.id),
          title: thread.title,
          projectId: String(thread.projectId),
          providerInstanceId: thread.providerInstanceId,
          modelId: thread.modelId,
          completedAt: thread.completedAt,
        })),
    },
    // What the person wrote: each turn's prompt, leaving out the turns the
    // host accepted to deliver a subagent's result.
    workPersonMessages: (threadId, limit) =>
      workTurnProjection
        .listForThread(decodeWorkThreadId(threadId))
        .filter((turn) => turn.delivery === undefined)
        .map((turn) => turn.prompt)
        .slice(-limit),
    codePersonMessages: (threadId, limit) =>
      codeBoardEventStore
        .personPromptsForThread(decodeCodeThreadId(threadId), limit)
        .flatMap((prompt) => {
          const text = codeEvidence.read(prompt);
          return text === undefined ? [] : [text];
        }),
    resolveDriver: resolveConfiguredDriver,
    accountUnavailable: automaticModelAccountUnavailable,
    scratchRoot: harnessWorkDirectory,
    protectedSecretPath: (path) => isProtectedSecretPath(path),
  });
  const decisionReviewModelPort = createDecisionReviewModelPort({
    persistence,
    store: personMemory,
    resolveDriver: resolveConfiguredDriver,
    accountUnavailable: automaticModelAccountUnavailable,
    scratchRoot: harnessWorkDirectory,
  });
  // A provider runtime's own shell reports a command only as it starts, so
  // its pushes and pull-request changes are recorded, never stopped.
  // A running turn keeps the sandbox it started with, so turning it off
  // never opens commands the turn has not run yet; turning it on applies
  // at once, since that only narrows.
  const threadKeepsSandbox = (threadId: string): boolean => {
    const code = persistence.readCodeThread(threadId as never);
    if (code !== undefined) {
      return (codeParentActiveTurn?.(code) ?? code).fullAccessSandbox === true;
    }
    const stored = workThreadProjection.read(threadId as never)?.fullAccessSandbox === true;
    return stored || runningWorkTurnSandbox(threadId) === true;
  };
  // Windows has no Octant sandbox, so every harness command there runs in the
  // terminal shell Settings › Code names, unconfined, at every level outside
  // Strict; the POSIX form runs `/bin/sh` inside a sandbox Windows lacks.
  const windowsHarnessCommandShell =
    windowsHarnessShellPort === undefined
      ? undefined
      : createNativeHarnessShell({
          process: windowsHarnessShellPort,
          scriptDirectory: harnessScriptDirectory,
          scriptFileName: () => windowsScriptFileName(windowsHarnessShell()),
          scriptText: (command) => windowsScriptText(windowsHarnessShell(), command),
        });
  const runtimeForgeChanges = createRuntimeForgeChangeObserver({
    branches: (threadId) => codeThreadBranches(persistence, threadId),
    record: (input) => shieldServerStore.recordForgeChange(input),
  });
  const finishedDefaultShell =
    windowsHarnessCommandShell ??
    createNativeHarnessShell({
      process: harnessProcessPort,
      scriptDirectory: harnessScriptDirectory,
      sshAgentSocket,
      cloudCliEnvironment,
      googleCliCredentials: googleCliCommands.prepare,
    });
  const finishedFullAccessShell =
    windowsHarnessCommandShell ??
    createNativeHarnessShell({
      process: harnessFullAccessProcessPort,
      scriptDirectory: harnessScriptDirectory,
      sshAgentSocket,
      cloudCliEnvironment,
      googleCliCredentials: googleCliCommands.prepare,
    });
  const finishedCheckShell = (fullAccess: boolean) =>
    fullAccess ? finishedFullAccessShell : finishedDefaultShell;
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
    skills: deps.effectiveSkills,
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
    authority: createNativeHarnessAuthority({
      hostId: deriveToolHostId(providerDataDirectory),
      persistence,
      workThreads: workThreadProjection,
      runningWorkTurnAccess,
      readThreadTaint: (threadId) =>
        readThreadExternalContentTaint(persistence.connection, threadId),
      holdsServerCodeThread: (thread) => serverProjectOf(serverProjectStore, thread) !== undefined,
      holdsServerWorkThread: (thread) =>
        serverWorkProjectOf(serverProjectStore, thread) !== undefined,
    }),
    isHarnessProvider: (providerInstanceId) => {
      const instance = persistence.readProviderInstance(providerInstanceId);
      return instance !== undefined && isNativeHarnessDriverKind(instance.driverKind);
    },
    tasks: nativeHarnessSessions,
    readsImages: ({ providerInstanceId, modelId }) =>
      providerRuntimeRegistry
        .observedState(providerInstanceId)
        ?.models.find((candidate) => String(candidate.id) === modelId)
        ?.inputModalities.includes("image") === true,
    shell:
      windowsHarnessCommandShell ??
      createNativeHarnessShell({
        process: harnessProcessPort,
        scriptDirectory: harnessScriptDirectory,
        sshAgentSocket,
        cloudCliEnvironment,
        googleCliCredentials: googleCliCommands.prepare,
      }),
    // A child without network authority runs its commands where the sandbox
    // closes the network; Windows has no such sandbox, so it runs none there.
    ...(windowsHarnessCommandShell === undefined
      ? {
          offlineShell: createNativeHarnessShell({
            process: harnessOfflineProcessPort,
            scriptDirectory: harnessScriptDirectory,
            sshAgentSocket,
            cloudCliEnvironment,
            googleCliCredentials: googleCliCommands.prepare,
          }),
        }
      : {
          // Under Strict, or with the sandbox kept, a Windows command would
          // need the sandbox it lacks, so it is refused before it is planned.
          hostCommandRefusal: ({ threadId, executionPolicy }) =>
            hostSandboxRefusal({
              platform: "win32",
              access: {
                executionPolicy: executionPolicy ?? "plan",
                fullAccessSandbox: threadKeepsSandbox(threadId),
              },
              strict: resolveThreadStrict(threadId),
            }),
        }),
    fullAccessShell:
      windowsHarnessCommandShell ??
      createNativeHarnessShell({
        process: harnessFullAccessProcessPort,
        scriptDirectory: harnessScriptDirectory,
        sshAgentSocket,
        cloudCliEnvironment,
        googleCliCredentials: googleCliCommands.prepare,
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
    readStrict: (threadId) => resolveThreadStrict(threadId),
    readFullAccessSandbox: threadKeepsSandbox,
    resolveWebSearch: () =>
      harnessWebSearch({
        readEligible: () => webSearchSettings.eligible(),
        search: (input) => webSearchSettings.search(input),
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
    providerSearchGrants: nativeHarnessProviderSearchGrants,
    providerWebSearchFacts: (providerInstanceId) => {
      const instance = persistence.readProviderInstance(providerInstanceId);
      if (instance === undefined) return undefined;
      return {
        origin: providerOwnSearchOrigin(instance),
        webSearchReady: webSearchSettings.eligible().length > 0,
      };
    },
    recordExternalContentIngestion: (input) => externalContentIngestionStore.record(input),
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
  });
  // A managed child's harness tools come first in its tool set, ahead of
  // what later areas add.
  contributeChildTools((input) => nativeHarnessComposition.forAgentRun(input));
  const prepareCredentialCommand = createCommandCredentialPreparation({
    readThread: (id) => persistence.readCodeThread(id),
    providerKind: (thread) =>
      persistence.readProviderInstance(thread.providerInstanceId)?.driverKind,
    ordinary: nativeHarnessComposition,
    egress: toolEgressRules,
    endpoint: harnessEgressEndpoint,
    fullAccessProcess: harnessFullAccessProcessPort,
    temporaryDirectory: harnessWorkDirectory,
    receiptDirectory: join(providerDataDirectory, "harness", "receipts"),
    uuid: randomUUID,
  });
  return {
    readHarnessProcessReceipts: async () =>
      (
        await readOwnedProcessReceipts({
          receiptDirectory: join(providerDataDirectory, "harness", "receipts"),
          supervisor: "repository-test-runner",
        })
      ).map((row) => row.receipt),

    beginGoogleCliChange: googleCliCommands.beginChange,
    // Awaited at startup, before any turn can run a command.
    recoverGoogleCliCommands: async () => {
      await windowsHarnessShellPort?.reconcile();
      await googleCliCommands.recover(() => harnessProcessPort.reconcile());
    },
    credentialCommandProcess: harnessFullAccessProcessPort,
    // The Seatbelt-confined, network-less launcher for Benchmarks check commands:
    // a port of its own that refuses setsid(), no cloud, SSH or Google
    // credentials, and a fresh private home and temp folder per cell.
    benchmarkCheckCommands: createBenchmarkCheckCommands({
      root: join(providerDataDirectory, "benchmarks", "checks"),
      scriptDirectory: harnessScriptDirectory,
      // The harness receipts, so a restart reaps a group a crash left.
      receiptDirectory: join(providerDataDirectory, "harness", "receipts"),
    }),
    prepareCredentialCommand,
    personMemorySweep,
    decisionReviewModelPort,
    runtimeForgeChanges,
    followUpCreation,
    restartContinuation,
    liftRestartRecovery,
    followUpSuggestionRoutes,
    nativeHarnessComposition,
    nativeHarnessEgressRoutes,
    nativeHarnessRoutingRoutes,
    imageDescriber,
    shieldServerRoutes,
    shieldServerStore,
    serverProjectRoutes,
    serverPreviewTunnels,
    nativeHarnessHooks,
    observeTurnEnded,
    nativeHarnessSessionRoutes,
    onHarnessPausedByPerson,
    onHarnessRecoveryLifted,
    researchRouter,
    webSearchSettings,
    sideTaskHost,
    sideTaskRoutes,
    finishedReceiptRoutes,
    finishedCheckShell,
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
