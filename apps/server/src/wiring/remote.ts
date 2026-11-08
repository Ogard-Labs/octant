import { CodeService } from "../code/codeService";
import { randomUUID } from "node:crypto";
import { OwnerBrowserControlService } from "../browser/ownerBrowserControl";
import { createOwnerBrowserJournal } from "../browser/ownerBrowserJournal";
import { homedir } from "node:os";
import {
  AgentRunParentThreadId,
  type CodeThreadId,
  decodeChatThreadId,
  decodeCodeThreadId,
  decodeImageGenerationScopeId,
  decodeProjectId,
  decodeThreadMessageQueueScope,
  decodeWorkThreadId,
  LOCAL_HOST_ID,
  HubMemberId,
  ThreadRetentionThreadId,
  decodeCodeCommand,
} from "@octant/contracts";
import { Schema } from "effect";
import { decodeBrowserThreadId } from "@octant/contracts/browser-automation";
import { managedWorktreeRoot } from "../code/managedWorktreeService";
import { purgeThreadArtifacts, removeMirrorFiles } from "../persistence/threadArtifactPurge";
import { readHostIdentity } from "../persistence/remoteAccessProjection";
import { AgentProfileService } from "../agentProfileService";
import { createProvisionHostPorts } from "../hub/provisionHostPorts";
import { ProvisionService } from "../hub/provisionService";
import { SpokeProvisionService } from "../hub/spokeProvisionService";
import { createSignInHostPorts } from "../hub/signInHostPorts";
import { SignInService } from "../hub/signInService";
import { SpokeSignInService } from "../hub/spokeSignInService";
import { createProviderCredentialRouteHandler } from "../providers/providerCredentialRoutes";
import {
  makeProviderKeyReferenceReader,
  makePushPlatformCredentialBrokerClient,
} from "../providers/credentialBrokerClient";
import { ProviderServiceError } from "../providers/providerService";
import { providerKeyJournal, reconcileProviderKeyChanges } from "../providers/providerKeyJournal";
import { makeSecretStoreBrokerClient } from "../secretStores/secretStoreBrokerClient";
import { secretStoresJournal } from "../secretStores/secretStoresJournal";
import { createSecretStoresRouteHandler } from "../secretStores/secretStoresRoutes";
import { createSecretStoresService } from "../secretStores/secretStoresService";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import {
  createExternalContentRouteHandler,
  threadStandingFromMessageQueue,
} from "../externalContentRoutes";
import { ExternalContentClearStore } from "../context/externalContentClearStore";
import { readThreadExternalContentTaint } from "../context/externalContentTaintProjection";
import { ROUTINE_HOST_SCOPE_ID } from "../routineHostScope";
import { defaultShellSettings, enabledModes, rosterMemberWebOrigin } from "@octant/domain";
import {
  createRemoteGateway,
  type RemoteGateway,
  type RemoteGatewayServices,
  type RemoteServerGrantGatewayPort,
} from "../remote/remoteGateway";
import type { PrivateListener } from "../privateListener";
import { resolvePrincipalRouteContext } from "../principalRouteContext";
import {
  createLocalDeviceAdministrationRouteHandler,
  type LocalDeviceAdministrationPort,
} from "../remote/localDeviceAdministrationRoutes";
import { createHostControlRouteHandler } from "../hostControlRoutes";
import { createSupportBundleRouteHandler } from "../supportBundleRoutes";
import { readEventLoopLagCounters } from "../eventLoopLag";
import { slowStatementTally } from "../persistence/slowStatementLog";
import { desktopCredentialStore } from "../hostDataMap";
import { HostMemoryLimitsService } from "../hostMemoryLimitsService";
import { ThreadRetentionService } from "../threadRetentionService";
import { createLiveHostExportService } from "../hostExportService";
import { createAgentRemoteDelegation } from "../hub/agentRemoteDelegation";
import { createDelegationAdministrationRouteHandler } from "../hub/delegationAdministrationRoutes";
import { createDelegationJournal } from "../hub/delegationJournal";
import { createDelegationStateStore } from "../hub/delegationStateStore";
import { DelegatingSpokeService } from "../hub/delegatingSpokeService";
import { PeerDelegationService } from "../hub/peerDelegationService";
import { createPeerDelegationRouteHandler } from "../hub/peerDelegationRoutes";
import { createWorkDelegationHost } from "../hub/workDelegationHost";
import { createHubAdministrationRouteHandler } from "../hub/hubAdministrationRoutes";
import { createHubLinkRouteHandler } from "../hub/hubLinkRoutes";
import { createHubOwnerRouteHandler } from "../hub/hubOwnerRoutes";
import { OwnerCredentialCopyService } from "../hub/ownerCredentialCopy";
import { createProviderCredentialCopyBroker } from "../hub/ownerCredentialBroker";
import { createOwnerPostureHost } from "../hub/ownerPostureHost";
import { createPeerCredentialRouteHandler } from "../hub/peerCredentialRoutes";
import { createChatThreadMoveHost } from "../hub/chatThreadMoveHost";
import { createCodeThreadMoveHost } from "../hub/codeThreadMoveHost";
import { createWorkThreadMoveHost } from "../hub/workThreadMoveHost";
import { threadMoveHostsByMode } from "../hub/threadMoveHostsByMode";
import type { MovedThreadHistory } from "../hub/movedThreadHistory";
import type { ManagedWorktreeReceiptStore } from "../code/managedWorktreeReceiptStore";
import type { LiveTurnRegistry } from "../liveTurn/liveTurnRegistry";
import type { ThreadMoveHolds } from "../hub/threadMoveHolds";
import { createThreadMoveJournal } from "../hub/threadMoveJournal";
import { createThreadMoveRouteHandler } from "../hub/threadMoveRoutes";
import { createThreadMoveAdministrationRouteHandler } from "../hub/threadMoveAdministrationRoutes";
import { ThreadMoveService } from "../hub/threadMoveService";
import { ThreadHandovers } from "../hub/threadHandovers";
import { HandoverExchange } from "../hub/handoverExchange";
import { createHandoverRouteHandler } from "../hub/handoverRoutes";
import { readHandoverNote } from "../hub/codeThreadHandoverGit";
import { createThreadMoveSenders } from "../hub/threadMoveSenders";
import { createThreadMoveTicketClient } from "../hub/threadMoveTicketClient";
import { hostThreads, ThreadMovesFromWindow } from "../hub/threadMovesFromWindow";
import type { ThreadMoveStatePort } from "../hub/threadMoveStateStore";
import type { ChatService } from "../chat/chatService";
import { OwnerUnlockService } from "../hub/ownerUnlock";
import { PairedMergeUnlockService } from "../hub/pairedMergeUnlock";
import { createHubMembershipJournal } from "../hub/hubMembershipJournal";
import { FailoverService } from "../hub/failoverService";
import { HubService, type HubPairingPort } from "../hub/hubService";
import { createHubStateStore } from "../hub/hubStateStore";
import { createPinnedHubTransport } from "../hub/pinnedHubTransport";
import { createDirectPushGateway } from "../hub/directPushGateway";
import { createDirectPushRouteHandler } from "../hub/directPushRoutes";
import { createDirectPushSender } from "../hub/directPushSenders";
import { DirectPushService } from "../hub/directPushService";
import { PushService } from "../hub/pushService";
import { createRosterSigningKeyStore } from "../hub/rosterSigningKey";
import { deviceLifecycleAt, SpokeLinkService } from "../hub/spokeLinkService";
import { SpokePushService } from "../hub/spokePushService";
import {
  TailscaleCertificateService,
  createTailscaleCertificateSetting,
  createListenerCertificateSink,
} from "../hub/tailscaleCertificate";
import { createTailscaleCliDaemon, execTailscale } from "../hub/tailscaleCliDaemon";
import { SpokeWakeService } from "../hub/spokeWakeService";
import { createUdpWakeOnLanPort } from "../hub/wakeOnLan";
import { WakeService } from "../hub/wakeService";
import { createPrivateListenerLifecycleController } from "../remote/privateListenerLifecycleController";
import {
  resolvePrivateListenerHostIdentity,
  type PrivateListenerHostIdentity,
} from "../remote/privateListenerHostIdentity";
import { createPrivateListenerAdministrationRouteHandler } from "../remote/privateListenerAdministrationRoutes";
import { createPrivateListenerSetting } from "../remote/privateListenerSetting";
import { createSelfMadeListenerCertificateStore } from "../remote/selfMadeListenerCertificate";
import {
  boundHostRuntimeDiagnostics,
  createReleaseFeedVerifier,
  decodeKeychainServiceFamily,
  KEYCHAIN_SERVICE_FAMILY_ENVIRONMENT,
  type HostRuntimeDiagnostics,
} from "@octant/host-runtime";
import { MAX_JSON_REQUEST_BODY_SIZE, type ServerStart } from "./serverShape";
import type { AuthorityWiring } from "./authority";
import type { BrowserWiring } from "./browser";
import type { FoundationsWiring } from "./foundations";
import { type AgentRunsWiring, authorizeAgentRunParentThread } from "./agentRuns";
import type { HarnessWiring } from "./harness";
import type { HarnessStateWiring } from "./harnessState";
import { checkDelegationParent } from "../hub/delegationParentCheck";
import type { IntegrationsWiring } from "./integrations";
import type { ComputerUseWiring } from "./computerUse";
import type { CodeWiring } from "./code";
import type { CodeRuntimeWiring } from "./codeRuntime";
import type { ProvidersWiring } from "./providers";
import type { WorkspaceWiring } from "./workspace";
import type { CodeToolingWiring } from "./codeTooling";
import type { WorkWiring } from "./work";
import type { CanvasWiring } from "./canvas";
import type { AutomationWiring } from "./automation";
import type { RoutesWiring } from "./routes";

/** How often a hub member looks for the hub; the failover time itself is the hub's setting in the roster. */
const FAILOVER_LOOK_MS = 15_000;
/** How often the hub looks for an occurrence to wake a spoke for, and a spoke for a changed routine time to report. */
const WAKE_LOOK_MS = 15_000;
const WAKE_REPORT_MS = 30_000;
/** How often the push sender forgets old rate marks and hands standbys its switch. */
const PUSH_LOOK_MS = 60_000;
/** How often a spoke lets lapsed sign-in requests end and tells the hub any outcome word still owed. */
const SIGN_IN_LOOK_MS = 30_000;
const CERTIFICATE_CHECK_MS = 24 * 60 * 60 * 1_000;
const STARTUP_CERTIFICATE_CHECK_MS = 60 * 1_000;

export type RemoteDependencies = { readonly onSecretStoreLinkChange?: () => void } & Pick<
  ServerStart,
  "options" | "persistence" | "serve" | "startedAt" | "version"
> &
  Pick<HarnessWiring, "beginGoogleCliChange"> &
  Pick<AuthorityWiring, "browserCaptureStore" | "personMemory" | "windowAuthorityStore"> &
  Pick<
    AgentRunsWiring,
    "agentRunAdmission" | "externalContentIngestionStore" | "remoteDelegationHolder"
  > &
  Pick<HarnessStateWiring, "nativeHarnessSessions"> &
  Pick<IntegrationsWiring, "agentMessageService" | "toolEgressRules"> &
  Pick<ComputerUseWiring, "webAssets"> &
  Pick<CodeWiring, "codeAttachments" | "codeProjectAccess" | "workAttachments"> &
  Pick<
    ProvidersWiring,
    | "chatAttachmentStore"
    | "credentialBroker"
    | "credentialResolver"
    | "extensionApiService"
    | "generatedImageStore"
    | "providerDataDirectory"
    | "providerService"
  > &
  Pick<WorkspaceWiring, "shellService" | "projectService"> &
  Pick<
    BrowserWiring,
    | "browserAutomationService"
    | "browserExtensionService"
    | "browserFlowService"
    | "browserProfileService"
  > &
  Pick<
    CodeToolingWiring,
    | "debugConfigurationApprovals"
    | "debugService"
    | "languageServerApprovals"
    | "pairedMergeUnlockSlot"
    | "remoteServerGrants"
  > &
  Pick<
    WorkWiring,
    | "threadExportService"
    | "threadMessageQueue"
    | "onWorkTurnCancelled"
    | "workThreadServiceWithWorkflows"
    | "workTurnService"
  > &
  Pick<CanvasWiring, "canvasRoutes" | "canvasPublicShareService"> &
  Pick<
    AutomationWiring,
    | "automationCommandService"
    | "automationScheduler"
    | "hubPushHandoffSlot"
    | "pushGatewaySetting"
    | "pushNotificationTokenStore"
  > &
  Pick<RoutesWiring, "authenticatedProductDispatch"> &
  Pick<FoundationsWiring, "workThreadProjection"> &
  Pick<FoundationsWiring, "hostMemoryGuard" | "providerRuntimeRegistry"> &
  Pick<CodeRuntimeWiring, "codeOperationRuntime" | "codeService"> & {
    readonly chatService: ChatService;
    readonly liveTurns: LiveTurnRegistry;
    readonly managedWorktreeReceipts: ManagedWorktreeReceiptStore;
    readonly movedThreadHistory: MovedThreadHistory;
    /** Threads a move holds: frozen here while leaving, or arriving and not yet committed. */
    readonly threadMoveHolds: ThreadMoveHolds;
    readonly threadMoveState: ThreadMoveStatePort;
  };

const decodeAgentRunParentThreadId = Schema.decodeUnknownSync(AgentRunParentThreadId);

/** A paired device is active until revoked or expired; one this host no longer lists is not. */
function deviceIsActive(
  administration: Pick<LocalDeviceAdministrationPort, "listDevices">,
  deviceId: string,
): boolean {
  return administration
    .listDevices()
    .some((device) => device.deviceId === deviceId && device.state === "active");
}

export function wireRemote(deps: RemoteDependencies) {
  const {
    browserAutomationService,
    browserExtensionService,
    browserFlowService,
    browserProfileService,
    agentMessageService,
    agentRunAdmission,
    authenticatedProductDispatch,
    automationCommandService,
    automationScheduler,
    browserCaptureStore,
    personMemory,
    hubPushHandoffSlot,
    pairedMergeUnlockSlot,
    nativeHarnessSessions,
    remoteDelegationHolder,
    canvasPublicShareService,
    canvasRoutes,
    chatAttachmentStore,
    codeAttachments,
    codeProjectAccess,
    credentialBroker,
    credentialResolver,
    externalContentIngestionStore,
    extensionApiService,
    generatedImageStore,
    debugConfigurationApprovals,
    debugService,
    hostMemoryGuard,
    languageServerApprovals,
    onWorkTurnCancelled,
    options,
    persistence,
    providerDataDirectory,
    providerRuntimeRegistry,
    providerService,
    pushGatewaySetting,
    pushNotificationTokenStore,
    remoteServerGrants,
    serve,
    shellService,
    startedAt,
    threadExportService,
    threadMessageQueue,
    toolEgressRules,
    version,
    webAssets,
    windowAuthorityStore,
    workAttachments,
    workThreadProjection,
    workThreadServiceWithWorkflows,
    workTurnService,
  } = deps;

  // The proxy route's grant requests run under the paired device's own scope,
  // the same remote read rule product requests are judged by.
  const remoteServerGrantGatewayPort: RemoteServerGrantGatewayPort = {
    open: (input) => {
      const context = resolvePrincipalRouteContext({
        request: input.request,
        principal: input.principal,
        abortSignal: input.signal,
      });
      return codeProjectAccess.run(context, () =>
        remoteServerGrants.open({
          principal: {
            kind: "remote-device",
            deviceId: String(input.principal.deviceId),
            credentialGeneration: input.principal.credentialGeneration,
            sessionIdDigest: input.sessionIdDigest,
          },
          scopeId: context.scopeId,
          request: input.grantRequest,
          stillAuthorized: input.stillAuthorized,
          signal: input.signal,
        }),
      );
    },
    relay: (input) => {
      const context = resolvePrincipalRouteContext({
        request: input.request,
        principal: input.principal,
        abortSignal: input.signal,
      });
      return codeProjectAccess.run(context, () =>
        remoteServerGrants.relay({
          principal: {
            deviceId: String(input.principal.deviceId),
            credentialGeneration: input.principal.credentialGeneration,
            sessionIdDigest: input.sessionIdDigest,
            origin: input.principal.origin,
          },
          scopeId: context.scopeId,
          grantId: input.grantId,
          method: input.method,
          pathQuery: input.pathQuery,
          headers: input.headers,
          body: input.body,
          stillAuthorized: input.stillAuthorized,
          signal: input.signal,
        }),
      );
    },
    relayUpgrade: (input) => {
      const context = resolvePrincipalRouteContext({
        request: input.request,
        principal: input.principal,
        abortSignal: input.signal,
      });
      return codeProjectAccess.run(context, () =>
        remoteServerGrants.relayUpgrade({
          principal: {
            deviceId: String(input.principal.deviceId),
            credentialGeneration: input.principal.credentialGeneration,
            sessionIdDigest: input.sessionIdDigest,
            origin: input.principal.origin,
          },
          scopeId: context.scopeId,
          grantId: input.grantId,
          pathQuery: input.pathQuery,
          headers: input.headers,
          stillAuthorized: input.stillAuthorized,
          signal: input.signal,
        }),
      );
    },
    closeSession: (sessionIdDigest, reason) =>
      remoteServerGrants.closeSession(sessionIdDigest, reason),
    holdsOpenSockets: (sessionIdDigest) => remoteServerGrants.holdsOpenSockets(sessionIdDigest),
  };
  // The gateway service graph is either injected (test/smoke seam) or composed
  // from the server's own persistence graph and host identity for the packaged
  // desktop. Composition is lazy — it runs on the first enable, not at startup —
  // so a disabled-by-default server never touches host-identity key material.
  // The controller is always constructed so the packaged host controls reach a
  // real lifecycle authority instead of a 503 from an undefined controller.
  const injectedRemoteListenerServices = options.remoteListener?.services;
  const resolveRemoteGatewayServices = (): Omit<RemoteGatewayServices, "config" | "serve"> => {
    if (injectedRemoteListenerServices !== undefined) return injectedRemoteListenerServices;
    const identity = resolvePrivateListenerHostIdentity({
      connection: persistence.connection,
      dataDirectory: providerDataDirectory,
    });
    return {
      connection: persistence.connection,
      journal: persistence.journal,
      hostId: identity.hostId,
      displayName: identity.displayName,
      serverBuildVersion: version,
      signing: identity.signing,
      webAssets,
      productDispatch: authenticatedProductDispatch,
      // The page's ticket is its only authority, so the request reaches the
      // Canvas route as a loopback load carrying nothing but its address
      // and what the browser said it is loading.
      designPage: async (request) => {
        const source = new URL(request.url);
        const destination = request.headers.get("sec-fetch-dest");
        return await canvasRoutes(
          new Request(`http://127.0.0.1${source.pathname}${source.search}`, {
            method: request.method,
            headers: destination === null ? {} : { "sec-fetch-dest": destination },
            signal: request.signal,
          }),
        );
      },
      pushTokenStore: pushNotificationTokenStore,
      remoteServerGrants: remoteServerGrantGatewayPort,
    };
  };
  // The private gateway is rebuilt on every enable, so the newest generation
  // is held here for the local device administration routes and the returned
  // server shape. Callers read it through the accessors below.
  let currentRemoteGateway: RemoteGateway | undefined;
  let startupRemoteListener: PrivateListener | undefined;
  const remoteHost = {
    gateway: (): RemoteGateway | undefined => currentRemoteGateway,
    listener: (): PrivateListener | undefined => startupRemoteListener,
    /** Called once the startup enable has bound: the listener the host reports. */
    recordStartupListener: (): void => {
      startupRemoteListener = currentRemoteGateway?.listener();
    },
  };
  const privateListenerController = createPrivateListenerLifecycleController({
    createGateway: (config) => {
      const services = resolveRemoteGatewayServices();
      const gateway = createRemoteGateway({
        ...services,
        productDispatch: services.productDispatch ?? authenticatedProductDispatch,
        hubLink:
          services.hubLink ??
          (async (request, facts) =>
            (await hubLinkRoutes(request)) ??
            (await peerDelegationRoutes(request)) ??
            (await peerCredentialRoutes(request)) ??
            (await threadMoveRoutes(request)) ??
            (await handoverRoutes(request)) ??
            (await directPushRoutes(request, facts)) ??
            hubOwnerRoutes(request)),
        hubWebOrigin: services.hubWebOrigin ?? (() => spokeLinkService.hubWebOrigin()),
        spokeWebOrigins:
          services.spokeWebOrigins ??
          (() =>
            (hubService.status().roster?.roster.members ?? []).flatMap((member) => {
              const webOrigin = rosterMemberWebOrigin(member);
              return webOrigin === undefined ? [] : [webOrigin];
            })),
        remoteServerGrants: services.remoteServerGrants ?? remoteServerGrantGatewayPort,
        serve: options.remoteServe ?? serve,
        config,
      });
      currentRemoteGateway = gateway;
      // Guest devices a left hub could not revoke while no gateway existed.
      spokeLinkService.settlePendingRevocations();
      return gateway;
    },
    selfMadeCertificate: createSelfMadeListenerCertificateStore({
      dataDirectory: providerDataDirectory,
    }),
  });
  // The hub role and this host's hub membership. The private listener is where
  // members reach each other; the routes below are the loopback administration
  // of both and the signed member-to-member routes the gateway serves.
  let hostIdentity: PrivateListenerHostIdentity | undefined;
  const resolveHubIdentity = (): PrivateListenerHostIdentity => {
    hostIdentity ??= resolvePrivateListenerHostIdentity({
      connection: persistence.connection,
      dataDirectory: providerDataDirectory,
    });
    return hostIdentity;
  };
  const hubStateStore = createHubStateStore(providerDataDirectory);
  const hubTransport = createPinnedHubTransport();
  let ownerBrowserAuthorityChanged: (() => void) | undefined;
  const writeHubMembership = createHubMembershipJournal({
    journal: persistence.journal,
    connection: persistence.connection,
    hostId: () => String(resolveHubIdentity().hostId),
    localActorId: OCTANT_LOCAL_ACTOR_ID,
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
  });
  const recordHubMembership = (change: Parameters<typeof writeHubMembership>[0]): void => {
    try {
      writeHubMembership(change);
    } finally {
      ownerBrowserAuthorityChanged?.();
    }
  };
  const hubPairing = (): HubPairingPort | undefined => {
    const gateway = currentRemoteGateway;
    const administration = gateway?.localDeviceAdministration();
    if (gateway === undefined || administration === undefined) return undefined;
    return {
      createTicket: (sourceClass) => {
        const ticket = administration.createPairingTicket({ sourceClass });
        return {
          ticketId: String(ticket.ticketId),
          ticketProof: ticket.ticketProof,
          expiresAt: ticket.expiresAt,
        };
      },
      approvedDeviceFor: (ticket) => gateway.approvedPairingDevice(ticket),
      revokeDevice: (deviceId) => {
        administration.revokeDevice({ deviceId });
      },
      deviceKeyFingerprint: (deviceId) => gateway.pairedDeviceKeyFingerprint(deviceId),
      deviceActive: (deviceId) => deviceIsActive(administration, deviceId),
    };
  };
  const hubService = new HubService({
    state: hubStateStore,
    rosterKey: createRosterSigningKeyStore(providerDataDirectory),
    identity: resolveHubIdentity,
    listener: () => privateListenerController.status(),
    pairing: hubPairing,
    transport: hubTransport,
    record: recordHubMembership,
    now: Date.now,
  });
  const spokeLinkService = new SpokeLinkService({
    state: hubStateStore,
    identity: resolveHubIdentity,
    listener: () => privateListenerController.status(),
    transport: hubTransport,
    devices: () => {
      const gateway = currentRemoteGateway;
      const administration = gateway?.localDeviceAdministration();
      if (gateway === undefined || administration === undefined) return undefined;
      return {
        admitIntroducedDevice: (input) => gateway.admitIntroducedDevice(input),
        deviceLifecycle: (deviceId, now) =>
          deviceLifecycleAt(administration.listDevices(), deviceId, now),
        revokeDevice: (deviceId) => {
          administration.revokeDevice({ deviceId });
        },
        deviceActive: (deviceId) => deviceIsActive(administration, deviceId),
      };
    },
    record: recordHubMembership,
    serverBuildVersion: version,
    now: Date.now,
  });
  // A member that cannot reach the hub for the failover time tries the standbys,
  // and a named standby that sees no hub starts standing in. Off for a host that
  // is not a hub member: the look does nothing without a link.
  const failoverService = new FailoverService({
    state: hubStateStore,
    identity: resolveHubIdentity,
    listener: () => privateListenerController.status(),
    pairing: hubPairing,
    transport: hubTransport,
    spoke: spokeLinkService,
    record: recordHubMembership,
    now: Date.now,
    noteHubWakeGeneration: (generation) => spokeWakeService.noteHubWakeGeneration(generation),
  });
  setInterval(() => void failoverService.tick().catch(() => undefined), FAILOVER_LOOK_MS).unref();
  // The wake service is off until the person turns it on in the hub's window; its
  // looks do nothing while it is off. A spoke reports only if its hub grant ticks Wake.
  const wakeService = new WakeService({
    state: hubStateStore,
    identity: resolveHubIdentity,
    transport: hubTransport,
    wakeOnLan: createUdpWakeOnLanPort(),
    record: recordHubMembership,
    now: Date.now,
  });
  setInterval(() => void wakeService.tick().catch(() => undefined), WAKE_LOOK_MS).unref();
  const spokeWakeService = new SpokeWakeService({
    state: hubStateStore,
    identity: resolveHubIdentity,
    transport: hubTransport,
    spoke: spokeLinkService,
    // Only whether a routine is enabled and when it is next due leaves the automation projection.
    routines: () =>
      persistence.automationProjection.listDefinitions().map((definition) => ({
        id: String(definition.id),
        enabled: definition.lifecycle === "enabled",
        nextDueAt: definition.nextDueAt,
      })),
    scheduler: automationScheduler,
    hubUnreachable: () => failoverService.hubUnreachable(),
    record: recordHubMembership,
    now: Date.now,
  });
  setInterval(() => void spokeWakeService.tick().catch(() => undefined), WAKE_REPORT_MS).unref();
  // The push sender is off until the person turns it on in the hub's window. A
  // spoke hands the hub its sealed envelopes only if its hub grant ticks Push; the
  // hub forwards them to the gateway its own Notifications setting names.
  // A hub that sends directly is its own push gateway for a phone app its person built,
  // with the person's own Apple and Google credentials. Off until a window turns it on.
  const directPushService = new DirectPushService({
    state: hubStateStore,
    credentials:
      options.credentialBrokerUrl === undefined || options.credentialBrokerToken === undefined
        ? undefined
        : makePushPlatformCredentialBrokerClient({
            url: options.credentialBrokerUrl,
            token: options.credentialBrokerToken,
          }),
    record: recordHubMembership,
  });
  const directPushGateway = createDirectPushGateway({
    enabled: () => directPushService.enabled(),
    sealingKey: () => directPushService.sealingKey(),
    holdsCredential: (platform) => directPushService.holdsCredential(platform),
    sender: createDirectPushSender({
      credentials: directPushService.credentialSource(),
      environment: () => directPushService.environment(),
      now: Date.now,
    }),
    now: Date.now,
  });
  const directPushRoutes = createDirectPushRouteHandler({ gateway: directPushGateway });
  const pushService = new PushService({
    state: hubStateStore,
    identity: resolveHubIdentity,
    transport: hubTransport,
    gateway: pushGatewaySetting.current,
    direct: {
      enabled: () => directPushService.enabled(),
      deliver: (body, headers) => directPushGateway.deliver(body, headers),
    },
    record: recordHubMembership,
    now: Date.now,
  });
  setInterval(() => void pushService.tick().catch(() => undefined), PUSH_LOOK_MS).unref();
  const spokePushService = new SpokePushService({
    state: hubStateStore,
    identity: resolveHubIdentity,
    transport: hubTransport,
    spoke: spokeLinkService,
    hubUnreachable: () => failoverService.hubUnreachable(),
    record: recordHubMembership,
    now: Date.now,
  });
  hubPushHandoffSlot.bind({
    granted: () => spokePushService.granted(),
    hand: (delivery) => spokePushService.hand(delivery),
  });
  // Provisioning is off until the person turns it on in the hub's window, and a spoke
  // holds an offer only if its hub grant ticks Provision. Each kind applies through the
  // service the person would use themselves; a routine is built here from the Project
  // the person names, through the Automation command service, and left paused.
  const agentProfileService = new AgentProfileService({
    persistence,
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
  });
  const provisionService = new ProvisionService({
    state: hubStateStore,
    identity: resolveHubIdentity,
    transport: hubTransport,
    record: recordHubMembership,
    now: Date.now,
  });
  const spokeProvisionService = new SpokeProvisionService({
    state: hubStateStore,
    identity: resolveHubIdentity,
    transport: hubTransport,
    spoke: spokeLinkService,
    ports: createProvisionHostPorts({
      shell: {
        currentRing: () => persistence.readShellSettings()?.settings.releaseRing,
        setReleaseRing: (ring) => shellService.setReleaseRing(ring),
      },
      extensions: { execute: (command) => extensionApiService.execute(command) },
      profiles: agentProfileService,
      providers: providerService,
      userScopeRef: OCTANT_LOCAL_ACTOR_ID,
      uuid: randomUUID,
      verifyUpdateSignature: createReleaseFeedVerifier().verify,
      routine: {
        hostId: String(LOCAL_HOST_ID),
        actorId: OCTANT_LOCAL_ACTOR_ID,
        authorScopeId: ROUTINE_HOST_SCOPE_ID,
        workProject: (projectId) => {
          const project = persistence
            .readProjects()
            .find((candidate) => String(candidate.id) === projectId);
          if (project?.type !== "work" || project.lifecycle !== "active") return undefined;
          const bindingRevisionId = project.bindingHistory.at(-1)?.revisionId;
          if (bindingRevisionId === undefined) return undefined;
          return {
            projectId: String(project.id),
            name: project.name,
            projectVersion: project.version,
            bindingRevisionId: String(bindingRevisionId),
          };
        },
        profiles: () => agentProfileService.list(),
        workModel: () => {
          const settings = workThreadProjection.settings();
          return settings?.defaultProviderInstanceId === undefined ||
            settings.defaultModelId === undefined
            ? undefined
            : {
                instanceId: String(settings.defaultProviderInstanceId),
                modelId: String(settings.defaultModelId),
              };
        },
        automations: automationCommandService,
        clock: () => new Date().toISOString(),
      },
    }),
    record: recordHubMembership,
    now: Date.now,
  });
  // Hub-started sign-in: the hub only relays a question and keeps the outcome word. A spoke
  // holds it only if its hub grant ticks Sign-in, starts nothing until its person accepts,
  // and reads only whether the provider's own app is signed in.
  const signInService = new SignInService({
    state: hubStateStore,
    identity: resolveHubIdentity,
    transport: hubTransport,
    record: recordHubMembership,
    now: Date.now,
  });
  const spokeSignInService = new SpokeSignInService({
    state: hubStateStore,
    identity: resolveHubIdentity,
    transport: hubTransport,
    spoke: spokeLinkService,
    ports: createSignInHostPorts({ providers: providerService }),
    record: recordHubMembership,
    now: Date.now,
  });
  setInterval(() => void spokeSignInService.tick().catch(() => undefined), SIGN_IN_LOOK_MS).unref();
  const tailscaleCertificate = new TailscaleCertificateService({
    setting: createTailscaleCertificateSetting(providerDataDirectory),
    daemon: createTailscaleCliDaemon({
      dataDirectory: providerDataDirectory,
      exec: execTailscale,
      platform: process.platform,
    }),
    sink: createListenerCertificateSink(privateListenerController),
    listener: () => privateListenerController.status(),
    now: Date.now,
  });
  // Renewal is checked once a day. The service does nothing while the
  // certificate is off, and renews only inside the window the domain policy sets.
  // The listener serves the certificate from memory only, so a host that just
  // started asks once soon, after the listener had time to come up.
  const checkCertificate = () => void tailscaleCertificate.renewIfDue().catch(() => undefined);
  setInterval(checkCertificate, CERTIFICATE_CHECK_MS).unref();
  setTimeout(checkCertificate, STARTUP_CERTIFICATE_CHECK_MS).unref();
  // One unlock service answers both the owner route's challenges and a paired
  // client's merge, so a challenge issued there is the one the merge consumes.
  const ownerUnlock = new OwnerUnlockService({
    now: Date.now,
    hostMemberId: () => hubService.hubMemberId(),
  });
  const pairedMergeUnlock = new PairedMergeUnlockService({
    state: hubStateStore,
    hub: hubService,
    spoke: spokeLinkService,
    unlock: ownerUnlock,
    record: recordHubMembership,
  });
  pairedMergeUnlockSlot.bind(pairedMergeUnlock);
  const hubAdministrationRoutes = createHubAdministrationRouteHandler({
    desktopBridgeSecret: options.desktopBridgeSecret,
    windowAuthorityStore,
    hub: hubService,
    spoke: spokeLinkService,
    pairedMergeUnlock,
    failover: failoverService,
    wake: wakeService,
    spokeWake: spokeWakeService,
    push: pushService,
    spokePush: spokePushService,
    directPush: directPushService,
    provision: provisionService,
    spokeProvision: spokeProvisionService,
    signIn: signInService,
    spokeSignIn: spokeSignInService,
    certificate: tailscaleCertificate,
    maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
  });
  const hubLinkRoutes = createHubLinkRouteHandler({
    hub: hubService,
    spoke: spokeLinkService,
    failover: failoverService,
    wake: wakeService,
    spokeWake: spokeWakeService,
    push: pushService,
    spokePush: spokePushService,
    provision: provisionService,
    spokeProvision: spokeProvisionService,
    signIn: signInService,
    spokeSignIn: spokeSignInService,
  });
  // Delegation between spokes: the receiving side starts an ordinary Work
  // thread under this host's own scope, and the sending side checks this host's
  // rules for the parent thread before it asks another member.
  const delegationState = createDelegationStateStore(providerDataDirectory);
  const recordDelegation = createDelegationJournal({
    journal: persistence.journal,
    connection: persistence.connection,
    hostId: () => String(resolveHubIdentity().hostId),
    localActorId: OCTANT_LOCAL_ACTOR_ID,
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
  });
  const peerDelegationRoutes = createPeerDelegationRouteHandler({
    delegation: new PeerDelegationService({
      authenticate: (input) => spokeLinkService.authenticatePeer(input),
      currentPeer: (memberId) => spokeLinkService.currentPeer(memberId),
      host: createWorkDelegationHost({
        readProject: (projectId) => persistence.readProject(projectId),
        isWorkEnabled: () =>
          enabledModes(
            persistence.readShellSettings()?.settings ?? defaultShellSettings(),
          ).includes("work"),
        threads: {
          execute: async (scope, command) =>
            workThreadServiceWithWorkflows.execute(scope, command as never),
          bootstrap: async (scope) => workThreadServiceWithWorkflows.bootstrap(scope),
        },
        turns: {
          startFirstTurn: async (scope, command, startOptions) =>
            workTurnService.startFirstTurn(scope, command, startOptions),
          turns: async (scope, threadId) => workTurnService.turns(scope, threadId),
          cancelFirstTurn: async (scope, command) =>
            workTurnService.cancelFirstTurn(scope, command),
        },
        scope: ROUTINE_HOST_SCOPE_ID,
      }),
      state: delegationState,
      record: recordDelegation,
      now: Date.now,
    }),
  });
  const delegatingSpoke = new DelegatingSpokeService({
    state: delegationState,
    identity: resolveHubIdentity,
    target: (memberId) => spokeLinkService.memberTarget(memberId),
    transport: hubTransport,
    parent: {
      check: (input) =>
        checkDelegationParent(
          {
            creationPosture: () => agentRunAdmission.settings.current().creationPosture,
            authorizeCreation: ({ threadId, windowId }) =>
              agentRunAdmission.authorizeCreation({
                parentThreadId: decodeAgentRunParentThreadId(threadId),
                windowId,
              }),
            externalContentIngested: (threadId) =>
              readThreadExternalContentTaint(persistence.connection, threadId)
                .externalContentIngested,
            sessionStatus: (threadId) => nativeHarnessSessions.read(threadId)?.session.status,
          },
          input,
        ),
      ingest: ({ threadId, sourceLabel, contentReference, correlationId }) => {
        const recorded = externalContentIngestionStore.record({
          threadId,
          provenance: { origin: "tool-result", sourceLabel },
          contentReference,
          correlationId,
          authorized: true,
        });
        return recorded.kind === "recorded" || recorded.kind === "already-recorded"
          ? recorded.kind
          : "refused";
      },
    },
    record: recordDelegation,
    now: Date.now,
  });
  // An agent's helper request that names a member starts the same delegation.
  remoteDelegationHolder.port = createAgentRemoteDelegation({
    delegation: delegatingSpoke,
    readProject: (projectId) => persistence.readProject(decodeProjectId(projectId)),
    isWorkEnabled: () =>
      enabledModes(persistence.readShellSettings()?.settings ?? defaultShellSettings()).includes(
        "work",
      ),
  });
  // A result arrives without anyone asking for it: the host reads each open
  // delegation now and then. With none sent, a pass reads nothing.
  setInterval(() => void delegatingSpoke.trackOpen().catch(() => undefined), 5_000).unref();
  // A person stopping the parent thread's turn asks each target to stop the
  // children that thread started there. Only Work parents have remote children:
  // a Code request is refused by the target.
  onWorkTurnCancelled((threadId) => {
    void delegatingSpoke.cancelParent(String(threadId)).catch(() => undefined);
  });
  const delegationAdministrationRoutes = createDelegationAdministrationRouteHandler({
    desktopBridgeSecret: options.desktopBridgeSecret,
    windowAuthorityStore,
    delegation: delegatingSpoke,
    authorizeParent: ({ threadId, windowId }) =>
      authorizeAgentRunParentThread({
        persistence,
        workThreadProjection,
        parentThreadId: decodeAgentRunParentThreadId(threadId),
        windowId,
      }),
  });
  // A host with no credential broker has no sign-in to copy from or to.
  const ownerCredentialCopy = new OwnerCredentialCopyService({
    broker:
      credentialBroker === undefined || credentialResolver === undefined
        ? {
            read: async () => ({ status: "refused", kind: "unavailable" }),
            store: async () => ({ status: "refused", kind: "unavailable" }),
          }
        : createProviderCredentialCopyBroker({
            readProviderInstances: () => persistence.readProviderInstances(),
            credentials: {
              has: (id) => credentialResolver.has(id),
              set: (id, credential) => credentialResolver.set(id, credential),
              delete: (id) => credentialResolver.delete(id),
              readStored: (id) => credentialBroker.resolve(id),
            },
          }),
    identity: resolveHubIdentity,
    target: (memberId) => spokeLinkService.memberTarget(memberId),
    transport: hubTransport,
    authenticate: (request) => spokeLinkService.authenticatePeer(request),
    ownerIsCurrent: (ownerMemberId) => {
      const context = spokeLinkService.ownerContext();
      return (
        context !== undefined &&
        context.owners.some((owner) => String(owner.memberId) === ownerMemberId) &&
        !context.inactiveDeviceMemberIds.includes(ownerMemberId)
      );
    },
    record: recordHubMembership,
    now: Date.now,
  });
  const peerCredentialRoutes = createPeerCredentialRouteHandler({ copy: ownerCredentialCopy });
  // Moving a thread between the person's computers.
  const chatThreadMoveHost = createChatThreadMoveHost({
    readView: (threadId) => persistence.readChatThreadView(threadId),
    isBusy: (view) =>
      view.turns.some((turn) =>
        turn.attempts.some(
          (attempt) =>
            attempt.outcome === "queued" ||
            attempt.outcome === "streaming" ||
            attempt.outcome === "waiting",
        ),
      ),
    externalContentIngested: (threadId) =>
      readThreadExternalContentTaint(persistence.connection, threadId).externalContentIngested,
    importMovedThread: (input) => deps.chatService.importMovedThread(input),
    activeChatProject: (projectId) => {
      const project = persistence
        .readProjects()
        .find((candidate) => String(candidate.id) === projectId);
      return project?.type === "chat" && project.lifecycle === "active";
    },
    purge: async (threadId) => {
      await threadRetention.purge(
        {
          scope: { kind: "thread", mode: "chat", threadId: decodeRetentionThreadId(threadId) },
          confirm: true,
        },
        "local-window",
      );
    },
    holds: deps.threadMoveHolds,
  });
  // A moved thread continues on this host's own instance of the provider kind
  // it ran on, with the same model. Another kind cannot be assumed to know the
  // model, so a move to a computer without one is refused with its own reason.
  const resolveMovedProvider = (driverKind: string, modelId: string) => {
    const sameKind = persistence
      .readProviderInstances()
      .find((instance) => instance.enabled && instance.driverKind === driverKind);
    return sameKind === undefined
      ? undefined
      : { providerInstanceId: String(sameKind.id), modelId };
  };
  // Where a Code thread's files are: its managed worktree, or its Project's checkout.
  const codeCheckoutRoot = async (threadId: CodeThreadId): Promise<string | undefined> => {
    const thread = persistence.readCodeThread(threadId);
    if (thread === undefined) return undefined;
    const checkout = persistence.readCodeCheckout(thread.checkoutId);
    if (checkout?.kind === "managed-worktree") {
      return (await deps.managedWorktreeReceipts.load(String(checkout.ownershipReceiptId)))
        ?.canonicalWorktreePath;
    }
    if (checkout?.kind !== "existing-worktree") return undefined;
    const project = persistence.readProject(thread.projectId);
    return project?.type === "code" ? project.binding.canonicalRoot : undefined;
  };
  const codeThreadMoveHost = createCodeThreadMoveHost({
    readThread: (threadId) => persistence.readCodeThread(threadId),
    isBusy: (threadId) => deps.liveTurns.read(String(threadId)) !== undefined,
    checkoutRoot: codeCheckoutRoot,
    ownsManagedWorktree: (threadId) => {
      const thread = persistence.readCodeThread(threadId);
      return (
        thread !== undefined &&
        persistence.readCodeCheckout(thread.checkoutId)?.kind === "managed-worktree"
      );
    },
    providerDriverKind: (providerInstanceId) =>
      persistence
        .readProviderInstances()
        .find((instance) => String(instance.id) === providerInstanceId)?.driverKind,
    transcript: async (threadId) => {
      const exported = await deps.threadExportService.exportThread(
        ROUTINE_HOST_SCOPE_ID,
        "local-window",
        { mode: "code", threadId: String(threadId) },
      );
      // A thread that already moved here once carries its earlier history on.
      const earlier = deps.movedThreadHistory.history(String(threadId)) ?? [];
      if (exported.kind !== "exported") return earlier;
      return [
        ...earlier,
        ...exported.bundle.transcript.entries.map((entry) => ({
          role: entry.role === "user" ? ("person" as const) : ("assistant" as const),
          text: entry.text,
          occurredAt: entry.occurredAt,
        })),
      ];
    },
    externalContentIngested: (threadId) =>
      readThreadExternalContentTaint(persistence.connection, threadId).externalContentIngested,
    purge: async (threadId) => {
      await threadRetention.purge(
        {
          scope: { kind: "thread", mode: "code", threadId: decodeRetentionThreadId(threadId) },
          confirm: true,
        },
        "local-window",
      );
    },
    codeProject: (projectId) => {
      const project = persistence
        .readProjects()
        .find((candidate) => String(candidate.id) === projectId);
      if (project?.type !== "code" || project.lifecycle !== "active") return undefined;
      return {
        projectId,
        canonicalRoot: project.binding.canonicalRoot,
        repositoryId: projectId,
        // The Project's binding as it stands now: the newest revision it records.
        bindingRevisionId: String(
          project.bindingHistory[project.bindingHistory.length - 1]?.revisionId,
        ),
      };
    },
    resolveProvider: resolveMovedProvider,
    createThread: async (input) => {
      // Decoded by the Code service like any creation; only the files are host-resolved.
      const command = decodeCodeCommand({
        kind: "create-managed-code-thread",
        threadId: input.threadId,
        projectId: input.project.projectId,
        bindingRevisionId: input.project.bindingRevisionId,
        title: input.title,
        providerInstanceId: input.provider.providerInstanceId,
        modelId: input.provider.modelId,
        executionPolicy: "approval-gated",
        permissionPersistence: "current-session",
        deliveryTarget: {
          branchIntent: input.branchIntent,
          remoteName: "origin",
          proposedBaseRepository: input.project.repositoryId,
          proposedBaseBranch: input.sourceBranch,
          outcomeKind: "local-implementation",
          confirmedAt: new Date().toISOString(),
        },
        sourceBranch: input.sourceBranch,
        startFromOrigin: false,
        sourceRevision: input.head,
      });
      await deps.codeService.execute(ROUTINE_HOST_SCOPE_ID, command, undefined, {
        movedFiles: input.files,
        ...(input.inheritedMark === undefined ? {} : { inheritedMark: input.inheritedMark }),
      });
    },
    journalHistory: (input) => deps.movedThreadHistory.journalImported(input),
    holds: deps.threadMoveHolds,
  });
  const workThreadMoveHost = createWorkThreadMoveHost({
    readThread: (threadId) => {
      const thread = workThreadProjection.read(threadId);
      return thread === undefined
        ? undefined
        : {
            title: thread.title,
            active: thread.lifecycle === "active",
            providerInstanceId: String(thread.providerInstanceId),
            modelId: String(thread.modelId),
          };
    },
    // A turn still preparing its context has not reached the live registry
    // yet, but it is a turn all the same.
    isBusy: (threadId) =>
      deps.liveTurns.read(String(threadId)) !== undefined ||
      workTurnService.isTurnStarting(threadId),
    isDelegated: (threadId) =>
      delegationState.load().received.some((received) => received.threadId === String(threadId)),
    providerDriverKind: (providerInstanceId) =>
      persistence
        .readProviderInstances()
        .find((instance) => String(instance.id) === providerInstanceId)?.driverKind,
    transcript: async (threadId) => {
      const exported = await deps.threadExportService.exportThread(
        ROUTINE_HOST_SCOPE_ID,
        "local-window",
        { mode: "work", threadId: String(threadId) },
      );
      // A thread that already moved here once carries its earlier history on.
      const earlier = deps.movedThreadHistory.history(String(threadId)) ?? [];
      if (exported.kind !== "exported") return earlier;
      return [
        ...earlier,
        ...exported.bundle.transcript.entries.map((entry) => ({
          role: entry.role === "user" ? ("person" as const) : ("assistant" as const),
          text: entry.text,
          occurredAt: entry.occurredAt,
        })),
      ];
    },
    externalContentIngested: (threadId) =>
      readThreadExternalContentTaint(persistence.connection, threadId).externalContentIngested,
    purge: async (threadId) => {
      await threadRetention.purge(
        {
          scope: { kind: "thread", mode: "work", threadId: decodeRetentionThreadId(threadId) },
          confirm: true,
        },
        "local-window",
      );
    },
    activeWorkProject: (projectId) => {
      const project = persistence
        .readProjects()
        .find((candidate) => String(candidate.id) === projectId);
      return project?.type === "work" && project.lifecycle === "active";
    },
    resolveProvider: resolveMovedProvider,
    createThread: async (input) => {
      const project = persistence
        .readProjects()
        .find((candidate) => String(candidate.id) === input.projectId);
      if (project?.type !== "work") throw new Error("The Work Project is gone.");
      await deps.workThreadServiceWithWorkflows.execute(
        ROUTINE_HOST_SCOPE_ID,
        {
          kind: "create-work-thread",
          threadId: input.threadId,
          projectId: input.projectId,
          title: input.title,
          providerInstanceId: input.provider.providerInstanceId,
          modelId: input.provider.modelId,
          hostId: LOCAL_HOST_ID,
          bindingRevisionId: String(
            project.bindingHistory[project.bindingHistory.length - 1]?.revisionId,
          ),
        },
        input.inheritedMark === undefined ? undefined : { inheritedMark: input.inheritedMark },
      );
    },
    journalHistory: (input) => deps.movedThreadHistory.journalImported(input),
    holds: deps.threadMoveHolds,
  });
  // Each mode's adapter handles its own threads; the move service sees one host.
  const byMode = threadMoveHostsByMode({
    chat: chatThreadMoveHost,
    code: codeThreadMoveHost,
    work: workThreadMoveHost,
  });
  const threadMoveJournal = createThreadMoveJournal({
    journal: persistence.journal,
    connection: persistence.connection,
    localActorId: OCTANT_LOCAL_ACTOR_ID,
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
  });
  // A spoke and the hub each judge a move's sender and target by their own role.
  const threadMoveSenders = createThreadMoveSenders({
    spoke: spokeLinkService,
    hub: hubService,
    now: Date.now,
  });
  const threadMoves = new ThreadMoveService({
    state: deps.threadMoveState,
    source: byMode.source,
    destination: byMode.destination,
    record: threadMoveJournal,
    identity: resolveHubIdentity,
    target: threadMoveSenders.target,
    transport: hubTransport,
    authenticate: threadMoveSenders.authenticate,
    ownerIsCurrent: threadMoveSenders.ownerIsCurrent,
    projects: (mode) =>
      persistence
        .readProjects()
        .filter((project) => project.type === mode && project.lifecycle === "active")
        .map((project) => ({ projectId: project.id, title: project.name })),
    now: Date.now,
  });
  const threadMoveRoutes = createThreadMoveRouteHandler({ moves: threadMoves });
  // A person at a window starts a move from the thread's Environment tool.
  const threadMovesFromWindow = new ThreadMovesFromWindow({
    moves: threadMoves,
    state: deps.threadMoveState,
    tickets: createThreadMoveTicketClient({
      identity: resolveHubIdentity,
      target: threadMoveSenders.target,
      transport: hubTransport,
      now: Date.now,
    }),
    source: byMode.source,
    members: () => {
      const status = spokeLinkService.status();
      return status.membership === "member" ? status.roster.roster.members : [];
    },
    selfMemberId: () => hubService.hubMemberId(),
    listThreads: async () => {
      const lastEvent = persistence.connection.prepare(
        `SELECT e.occurred_at AS occurred_at FROM aggregate_heads h
         JOIN event_journal e ON e.global_sequence = h.last_sequence
         WHERE h.aggregate_id = ? ORDER BY h.last_sequence DESC LIMIT 1`,
      );
      const lastActivityAt = (threadId: string): number | undefined => {
        const row = lastEvent.get(threadId) as { readonly occurred_at?: unknown } | undefined;
        return typeof row?.occurred_at === "string" ? Date.parse(row.occurred_at) : undefined;
      };
      const projectNames = new Map(
        persistence.readProjects().map((project) => [String(project.id), project.name]),
      );
      const listed = hostThreads({
        chat: persistence.readChatThreads(),
        code: persistence.readCodeThreads(),
        work: workThreadProjection.list(),
      });
      const facts = await Promise.all(
        listed.map(async (entry) => {
          const reading = await byMode.source.read(entry.thread);
          const projectName =
            entry.projectId === undefined ? undefined : projectNames.get(entry.projectId);
          return {
            thread: entry.thread,
            title: entry.title,
            ...(projectName === undefined ? {} : { projectName }),
            busy: reading.status === "found" && reading.busy,
            delegated: reading.status === "found" && reading.delegated,
            // A thread its own host cannot read (being deleted) is not offered.
            open: entry.open && reading.status === "found",
            lastActivityAt: lastActivityAt(entry.thread.threadId),
            repositoryRemotes: reading.status === "found" ? reading.repositoryRemotes : [],
          };
        }),
      );
      return facts;
    },
    now: Date.now,
  });
  // Where a handover goes after its push: a notice to the chosen member, and
  // Continue handover there, which tells this host to erase its copy.
  const handoverExchange = new HandoverExchange({
    state: deps.threadMoveState,
    authenticate: threadMoveSenders.authenticate,
    send: (targetMemberId, path, body) => threadMoves.sendSigned(targetMemberId, path, body),
    memberName: (memberId) => {
      const target = threadMoveSenders.target(memberId);
      return target.status === "member" ? target.member.name : "another computer";
    },
    codeProjects: () =>
      persistence
        .readProjects()
        .filter((project) => project.type === "code" && project.lifecycle === "active")
        .map((project) => ({ projectId: project.id, title: project.name })),
    acceptsProject: (placement) => byMode.destination.acceptsProject(placement),
    resolveProvider: resolveMovedProvider,
    readNote: async ({ projectId, branch, handoverId }) => {
      const project = persistence.readProjects().find((entry) => String(entry.id) === projectId);
      if (project?.type !== "code") return undefined;
      return readHandoverNote({
        repositoryRoot: project.binding.canonicalRoot,
        branch,
        handoverId,
      });
    },
    createThread: async (input) => {
      const project = persistence
        .readProjects()
        .find((entry) => String(entry.id) === input.projectId);
      if (project?.type !== "code") throw new Error("The Code Project is gone.");
      const command = decodeCodeCommand({
        kind: "create-managed-code-thread",
        threadId: input.threadId,
        projectId: input.projectId,
        bindingRevisionId: String(
          project.bindingHistory[project.bindingHistory.length - 1]?.revisionId,
        ),
        title: input.title,
        providerInstanceId: input.provider.providerInstanceId,
        modelId: input.provider.modelId,
        executionPolicy: "approval-gated",
        permissionPersistence: "current-session",
        deliveryTarget: {
          branchIntent: input.branch,
          remoteName: "origin",
          proposedBaseRepository: input.projectId,
          proposedBaseBranch: input.branch,
          outcomeKind: "local-implementation",
          confirmedAt: new Date().toISOString(),
        },
        sourceBranch: input.branch,
        startFromOrigin: true,
        remoteName: "origin",
      });
      // The note came through a branch others may push to: the thread starts marked.
      await deps.codeService.execute(ROUTINE_HOST_SCOPE_ID, command, undefined, {
        inheritedMark: {
          sourceLabel: "handover-note",
          contentReference: `handover-${input.handoverId}`,
        },
      });
    },
    journalNote: ({ threadId, handoverId, note }) =>
      deps.movedThreadHistory.journalImported({
        threadId,
        moveId: handoverId,
        entries: [{ role: "assistant", text: note, occurredAt: new Date().toISOString() as never }],
        origin: "handover-note",
      }),
    source: byMode.source,
    clock: () => new Date().toISOString(),
  });
  const handoverRoutes = createHandoverRouteHandler({ exchange: handoverExchange });
  // A Code thread that cannot move hands over through its branch.
  const threadHandovers = new ThreadHandovers({
    source: byMode.source,
    code: {
      checkoutRoot: async (threadId) => {
        try {
          return await codeCheckoutRoot(decodeCodeThreadId(threadId));
        } catch {
          return undefined;
        }
      },
      provider: (threadId) => {
        let thread;
        try {
          thread = persistence.readCodeThread(decodeCodeThreadId(threadId));
        } catch {
          return undefined;
        }
        const driverKind = persistence
          .readProviderInstances()
          .find(
            (instance) => String(instance.id) === String(thread?.providerInstanceId),
          )?.driverKind;
        return thread === undefined || driverKind === undefined
          ? undefined
          : { driverKind, modelId: String(thread.modelId) };
      },
      latest: async (threadId) => {
        const exported = await deps.threadExportService.exportThread(
          ROUTINE_HOST_SCOPE_ID,
          "local-window",
          { mode: "code", threadId },
        );
        if (exported.kind !== "exported") return {};
        const entries = exported.bundle.transcript.entries;
        const instruction = entries.findLast((entry) => entry.role === "user")?.text;
        const answer = entries.findLast((entry) => entry.role !== "user")?.text;
        return {
          ...(instruction === undefined ? {} : { instruction }),
          ...(answer === undefined ? {} : { answer }),
        };
      },
    },
    record: threadMoveJournal,
    state: deps.threadMoveState,
    notify: (destinationMemberId, notice) => handoverExchange.notify(destinationMemberId, notice),
    originName: () => resolveHubIdentity().displayName,
    clock: () => new Date().toISOString(),
  });
  const threadMoveAdministrationRoutes = createThreadMoveAdministrationRouteHandler({
    desktopBridgeSecret: options.desktopBridgeSecret,
    windowAuthorityStore,
    moves: threadMovesFromWindow,
    handovers: threadHandovers,
    exchange: handoverExchange,
    state: deps.threadMoveState,
    authorizeThread: ({ thread, windowId }) =>
      authorizeAgentRunParentThread({
        persistence,
        workThreadProjection,
        parentThreadId: decodeAgentRunParentThreadId(thread.threadId),
        windowId,
      }),
  });
  // A move that was under way when this host stopped resumes from what its
  // destination holds; only a committed move erases the thread here.
  void threadMoves.recover().catch(() => undefined);
  const ownerBrowserControlService = new OwnerBrowserControlService({
    host: browserAutomationService.ownerBrowserHost({
      hostMemberId: () => Schema.decodeUnknownSync(HubMemberId)(hubService.hubMemberId()),
      threadTitle: (threadId) => {
        const thread = persistence.readCodeThread(decodeCodeThreadId(threadId));
        return thread?.lifecycle === "active" ? thread.title : undefined;
      },
    }),
    now: Date.now,
    timestamp: () => new Date().toISOString(),
    uuid: randomUUID,
    onReclaim: (listener) => browserAutomationService.onOwnerControlReclaimed(listener),
    onAuthorityChange: (listener) => {
      ownerBrowserAuthorityChanged = listener;
      const removeCommitted = persistence.journal.subscribeCommitted(listener);
      return () => {
        if (ownerBrowserAuthorityChanged === listener) ownerBrowserAuthorityChanged = undefined;
        removeCommitted();
      };
    },
    audit: createOwnerBrowserJournal({
      journal: persistence.journal,
      connection: persistence.connection,
      localActorId: OCTANT_LOCAL_ACTOR_ID,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
    }),
  });
  const hubOwnerRoutes = createHubOwnerRouteHandler({
    browser: ownerBrowserControlService,
    hub: hubService,
    spoke: spokeLinkService,
    unlock: ownerUnlock,
    postures: createOwnerPostureHost({
      readCodeThreads: () => persistence.readCodeThreads(),
      readProjects: () => persistence.readProjects(),
      readCheckout: (checkoutId) => persistence.readCodeCheckout(checkoutId),
      code: deps.codeService instanceof CodeService ? deps.codeService : undefined,
      projects: deps.projectService,
      readCodeThread: (threadId) => persistence.readCodeThread(threadId),
      readProject: (projectId) => persistence.readProject(projectId),
    }),
    credentials: ownerCredentialCopy,
    threadMoves,
    provision: spokeProvisionService,
    signIn: signInService,
    spokeSignIn: spokeSignInService,
    record: recordHubMembership,
  });
  const localDeviceAdministrationRoutes = createLocalDeviceAdministrationRouteHandler({
    desktopBridgeSecret: options.desktopBridgeSecret,
    windowAuthorityStore,
    control: () => currentRemoteGateway?.localDeviceAdministration(),
    maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
  });
  const providerKeyChangeJournal = providerKeyJournal({
    journal: persistence.journal,
    connection: persistence.connection,
    uuid: randomUUID,
    now: () => new Date().toISOString(),
  });
  // A host that stopped between a key request and its outcome settles the
  // request before it serves another key change: the snapshot is taken here,
  // ahead of the routes, so it never contains a change still in flight.
  if (credentialResolver !== undefined) {
    void reconcileProviderKeyChanges({
      journal: providerKeyChangeJournal,
      unsettled: providerKeyChangeJournal.unsettled(),
      readInstances: () => persistence.readProviderInstances(),
      deleteKey: (id) => credentialResolver.delete(id),
    }).catch(() => undefined);
  }
  const providerCredentialRoutes = createProviderCredentialRouteHandler({
    desktopBridgeSecret: options.desktopBridgeSecret,
    windowAuthorityStore,
    readProviderInstances: () => persistence.readProviderInstances(),
    readRemovedProviderInstanceIds: () => persistence.readRemovedProviderInstanceIds?.() ?? [],
    credentials:
      credentialBroker === undefined || credentialResolver === undefined
        ? undefined
        : { store: credentialResolver, readStored: (id) => credentialBroker.resolve(id) },
    journal: providerKeyChangeJournal,
    ...(options.credentialBrokerUrl === undefined || options.credentialBrokerToken === undefined
      ? {}
      : {
          readKeyReference: makeProviderKeyReferenceReader({
            url: options.credentialBrokerUrl,
            token: options.credentialBrokerToken,
          }),
        }),
    reprobe: async (windowId, instance) => {
      await providerService.probe(windowId, instance.id, { fresh: true });
    },
    removeProvider: async (windowId, instance) => {
      try {
        await providerService.execute(windowId, {
          kind: "remove-provider",
          instanceId: instance.id,
          expectedVersion: instance.version,
        });
        return { kind: "removed" };
      } catch (error) {
        if (error instanceof ProviderServiceError) {
          return { kind: "refused", message: error.failure.message };
        }
        throw error;
      }
    },
  });
  // Linked secret stores: the broker holds each pointer and follows it at use;
  // the host journals each link and each change to a key's reference.
  const secretStoresRoutes = createSecretStoresRouteHandler({
    service: createSecretStoresService({
      beginGoogleCliChange: deps.beginGoogleCliChange,
      ...(deps.onSecretStoreLinkChange === undefined
        ? {}
        : { onLinkChange: deps.onSecretStoreLinkChange }),
      broker:
        options.credentialBrokerUrl === undefined || options.credentialBrokerToken === undefined
          ? undefined
          : makeSecretStoreBrokerClient({
              url: options.credentialBrokerUrl,
              token: options.credentialBrokerToken,
            }),
      journal: secretStoresJournal({
        journal: persistence.journal,
        connection: persistence.connection,
        uuid: randomUUID,
        now: () => new Date().toISOString(),
      }),
      readProviderInstances: () => persistence.readProviderInstances(),
      reprobe: async (windowId, instance) => {
        await providerService.probe(windowId, instance.id, { fresh: true });
      },
    }),
    windowAuthorityStore,
    ...(options.allowedRendererHttpOrigin === undefined
      ? {}
      : { allowedRendererHttpOrigin: options.allowedRendererHttpOrigin }),
  });
  const privateListenerSetting = createPrivateListenerSetting(providerDataDirectory);
  const privateListenerAdministrationRoutes = createPrivateListenerAdministrationRouteHandler({
    desktopBridgeSecret: options.desktopBridgeSecret,
    windowAuthorityStore,
    hostIdentityFingerprint: () => readHostIdentity(persistence.connection)?.key_fingerprint,
    control: () => privateListenerController,
    setting: privateListenerSetting,
    maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
  });
  // One diagnostics composer is shared by the owner control socket (through
  // the returned server shape) and the authenticated local host-control
  // routes, so the web Settings host card and `octant server status`
  // can never disagree about the same host.
  const composeHostDiagnostics = (): HostRuntimeDiagnostics => {
    const status = persistence.status({ fresh: true });
    const capabilities = [
      "local-loopback",
      ...persistence
        .readProviderInstances()
        .filter((provider) => provider.enabled)
        .map((provider) => `provider:${provider.driverKind}`),
      ...(startupRemoteListener === undefined ? [] : ["private-listener"]),
      ...(options.platformCapabilities ?? []),
    ];
    return boundHostRuntimeDiagnostics({
      identity: {
        hostId: options.hostId ?? "unknown",
        instanceId: options.instanceId ?? "unknown",
        endpoint: options.controlEndpoint ?? "unknown",
        serviceMode: options.serviceMode ?? "foreground",
      },
      version: { server: version, wire: "1" },
      store: { state: status.state, integrity: status.integrity },
      replay: {
        journalHead: status.journalHead,
        projections: status.projections.length,
      },
      clients: { connected: windowAuthorityStore.size() },
      capabilities,
      work: {
        active: providerRuntimeRegistry.activeSessionTotal(),
        attentionRequired: providerRuntimeRegistry.attentionRequired(),
      },
      uptimeSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1_000)),
    });
  };
  // Registered on the loopback chain only — never inside
  // dispatchProductRoutes — so the remote gateway's product dispatch can
  // never reach host lifecycle authority even if route policy regressed.
  const threadRetention = new ThreadRetentionService({
    connection: persistence.connection,
    journal: persistence.journal,
    clock: () => new Date().toISOString(),
    uuid: randomUUID,
    listWorkThreads: () =>
      workThreadProjection.list().map((thread) => ({
        id: String(thread.id),
        projectId: thread.projectId,
        updatedAt: thread.updatedAt,
      })),
    forgetWorkThread: (threadId) => {
      workThreadProjection.forget(threadId as never);
    },
    // A purged thread's own Reply detail level goes with it. The purge has
    // already happened; a settings write that loses a race is left to the
    // 500-entry bound rather than failing the purge.
    forgetThreadPresentation: (threads) => {
      try {
        shellService.forgetThreadReplyDetails(
          threads.map((thread) => ({ mode: thread.mode, threadId: String(thread.threadId) })),
        );
      } catch (error) {
        console.warn(
          `Octant could not forget a purged thread's reply detail: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
    forgetCanvases: (canvasIds) => {
      persistence.canvasProjection.evict(canvasIds);
      persistence.replicaArtifactProjection.evict(canvasIds);
      // A purged Canvas's public links are withdrawn at the service too. The
      // owed revoke names only the link, so it survives the erase and is
      // retried until the service confirms the link is gone.
      canvasPublicShareService.revokeForPurge(canvasIds);
      canvasPublicShareService.forget(canvasIds);
    },
    purgeCanvasFiles: (canvasIds) => removeMirrorFiles(persistence.connection, canvasIds),
    forgetProjectData: (projectId) => {
      // The Project's Browser profile goes with its other data: its extensions
      // turn off, then its store is cleared.
      const profile = { kind: "project" as const, projectId: decodeProjectId(projectId) };
      void browserExtensionService
        .forgetProfile(profile)
        .then(() => browserProfileService.eraseProject(decodeProjectId(projectId)))
        .catch(() => undefined);
      browserFlowService.forget(decodeProjectId(projectId));
      toolEgressRules.forgetProject(projectId);
      languageServerApprovals.forgetProject(decodeProjectId(projectId));
      // The erase removed this Project's confirmations and session records;
      // its running sessions end now rather than at the next sweep.
      debugConfigurationApprovals.forgetProject(decodeProjectId(projectId));
      void debugService.endProject(decodeProjectId(projectId)).catch(() => undefined);
    },
    purgeThreadArtifacts: async ({ mode, threadId }) => {
      // A running debug session ends before the purge takes its records and
      // its checkout, so nothing it writes as it ends outlives the purge.
      if (mode === "code") await debugService.endThread(decodeCodeThreadId(String(threadId)));
      // Remote children the thread started are stopped while this host still
      // knows where they run, then what it kept of them (a result included)
      // goes with the thread.
      await delegatingSpoke.cancelParent(String(threadId)).catch(() => undefined);
      delegatingSpoke.forgetParent(String(threadId));
      const released = await threadMessageQueue.purgeThread(
        decodeThreadMessageQueueScope({ mode, threadId }),
      );
      if (released.status !== "released")
        throw new Error("Queued attachments could not be purged.");
      await purgeThreadArtifacts({
        connection: persistence.connection,
        dataDirectory: persistence.dataDirectory,
        mode,
        threadId: String(threadId),
        managedWorktreeRootPath: managedWorktreeRoot,
        purgeChatAttachments: (id) => chatAttachmentStore.purgeThread(decodeChatThreadId(id)),
        purgeWorkAttachments: (id) => workAttachments.purgeThread(decodeWorkThreadId(id)),
        purgeCodeAttachments: (id) => codeAttachments.purgeThread(decodeCodeThreadId(id)),
        purgeGeneratedImages: async (id) => {
          try {
            await generatedImageStore.purgeScope(decodeImageGenerationScopeId(id));
          } catch {
            // A thread id that is not a generated-image scope is not an image basin.
          }
        },
        purgeBrowserCaptures: async (id) => {
          let threadId;
          try {
            threadId = decodeBrowserThreadId(id);
          } catch {
            // A thread id that is not a browser thread has no capture basin.
            return;
          }
          await browserCaptureStore.purgeThread(threadId);
        },
        purgeAgentMessages: (id) => agentMessageService.purgeThread(id),
      });
    },
  });
  const hostRuntimePlatform =
    process.platform === "darwin" || process.platform === "linux" ? process.platform : undefined;
  // Loopback chain only, like host control: a person at this machine clears
  // a thread's outside-content mark, and nothing else holds this store.
  const externalContentRoutes = createExternalContentRouteHandler({
    windowAuthorityStore,
    clears: new ExternalContentClearStore({
      journal: persistence.journal,
      connection: persistence.connection,
      uuid: randomUUID,
      clock: () => new Date().toISOString(),
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    }),
    withThreadStanding: threadStandingFromMessageQueue(threadMessageQueue),
  });
  const hostMemoryLimits = new HostMemoryLimitsService({
    connection: persistence.connection,
    journal: persistence.journal,
    clock: () => new Date().toISOString(),
    uuid: randomUUID,
    // The guard reads the saved limits at every sample; this takes one now so
    // a lowered limit acts at once instead of at the next scheduled reading.
    onChanged: () => void hostMemoryGuard.sample().catch(() => undefined),
  });
  // Loopback administration chain only, beside host control: the bundle holds
  // host-wide facts, so no remote device ever reaches it.
  const supportBundleRoutes = createSupportBundleRouteHandler({
    windowAuthorityStore,
    ...(options.desktopBridgeSecret === undefined
      ? {}
      : { desktopBridgeSecret: options.desktopBridgeSecret }),
    sources: () => ({
      connection: persistence.connection,
      journal: persistence.journal,
      octantVersion: version,
      providers: () => ({
        instances: persistence.readProviderInstances(),
        observed: providerRuntimeRegistry.observedStates(),
      }),
      ...(options.hostControl?.readServiceLog === undefined
        ? {}
        : { readHostLog: options.hostControl.readServiceLog }),
      codeSettings: () => persistence.readCodeSettings()?.settings,
      codeThreadPolicies: () =>
        persistence.readCodeThreads().map((thread) => thread.executionPolicy),
      platformCapabilities: options.platformCapabilities ?? [],
      hostDiagnostics: composeHostDiagnostics,
      hostHealth: () => {
        const statements = slowStatementTally.read();
        const lag = readEventLoopLagCounters();
        return {
          slowStatementCount: statements.count,
          slowStatementWorstMs: statements.worstMs,
          eventLoopLagCount: lag.count,
          eventLoopLagWorstMs: lag.worstMs,
        };
      },
    }),
  });
  const hostControlRoutes = createHostControlRouteHandler({
    windowAuthorityStore,
    diagnostics: composeHostDiagnostics,
    memory: () => hostMemoryGuard.report(),
    memoryLimits: hostMemoryLimits,
    threadRetention,
    ...(options.hostControl?.servicePolicy === undefined
      ? {}
      : { servicePolicy: options.hostControl.servicePolicy }),
    ...(options.hostControl?.requestOwnerStop === undefined
      ? {}
      : { requestOwnerStop: options.hostControl.requestOwnerStop }),
    ...(hostRuntimePlatform === undefined
      ? {}
      : {
          dataMap: {
            dataDirectory: persistence.dataDirectory,
            homeDirectory: homedir(),
            platform: hostRuntimePlatform,
            ...(process.env.OCTANT_BROWSER_PROFILES_DIRECTORY === undefined
              ? {}
              : { browserProfilesDirectory: process.env.OCTANT_BROWSER_PROFILES_DIRECTORY }),
            ...(options.credentialBrokerUrl !== undefined && hostRuntimePlatform === "darwin"
              ? {
                  credentialStore: desktopCredentialStore(
                    decodeKeychainServiceFamily(process.env[KEYCHAIN_SERVICE_FAMILY_ENVIRONMENT]) ??
                      "octant",
                  ),
                }
              : {}),
            listProjects: () =>
              persistence.readProjects().map((project) => ({
                id: String(project.id),
                name: project.name,
                type: project.type,
                ...(project.type === "chat" ? {} : { boundRoot: project.binding.canonicalRoot }),
              })),
          },
        }),
    backup: (label) => {
      const receipt = persistence.createVerifiedBackup(label);
      return {
        label,
        migrationVersion: receipt.migrationVersion,
        journalHead: receipt.journalHead,
        byteLength: receipt.byteLength,
      };
    },
    hostExport: createLiveHostExportService({
      hostId: LOCAL_HOST_ID,
      clock: () => new Date().toISOString(),
      threads: threadExportService,
      connection: persistence.connection,
      listWorkThreadIds: () => workThreadProjection.list().map((thread) => String(thread.id)),
      listProjects: () =>
        persistence.readProjects().map((project) => ({
          projectId: project.id,
          name: project.name,
          type: project.type,
          lifecycle: project.lifecycle,
          ...(project.type === "chat" ? {} : { canonicalRoot: project.binding.canonicalRoot }),
        })),
      listProjectIds: () => persistence.readProjects().map((project) => String(project.id)),
      readProjectMemory: (projectId) => persistence.readProjectMemory(decodeProjectId(projectId)),
      personMemoryEntries: () => personMemory.view().entries,
      listCanvases: () =>
        [...persistence.canvasProjection.snapshot().values()].map((entry) => ({
          canvasId: entry.canvasId,
          projectId: entry.currentVersion.definition.provenance.projectId,
          mode: entry.currentVersion.definition.provenance.mode,
          title: entry.currentVersion.definition.title,
          updatedAt: entry.updatedAt,
          definition: entry.currentVersion.definition,
        })),
      readSettings: () => {
        const shell = persistence.readShellSettings()?.settings ?? defaultShellSettings();
        const themeMode = persistence.readThemeSettings()?.settings.mode;
        return {
          chatEnabled: shell.chatEnabled,
          workEnabled: shell.workEnabled,
          themeMode: themeMode ?? "unknown",
          ...(shell.streamReplies === undefined ? {} : { streamReplies: shell.streamReplies }),
        };
      },
    }),
  });
  return {
    ownerBrowserControlService,
    composeHostDiagnostics,
    delegationAdministrationRoutes,
    threadMoveAdministrationRoutes,
    externalContentRoutes,
    hostControlRoutes,
    supportBundleRoutes,
    hubAdministrationRoutes,
    localDeviceAdministrationRoutes,
    privateListenerAdministrationRoutes,
    privateListenerController,
    privateListenerSetting,
    providerCredentialRoutes,
    remoteHost,
    secretStoresRoutes,
  };
}

export type RemoteWiring = ReturnType<typeof wireRemote>;

const decodeRetentionThreadId = Schema.decodeUnknownSync(ThreadRetentionThreadId);
