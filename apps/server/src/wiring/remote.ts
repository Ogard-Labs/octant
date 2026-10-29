import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import {
  decodeChatThreadId,
  decodeCodeThreadId,
  decodeImageGenerationScopeId,
  decodeProjectId,
  decodeThreadMessageQueueScope,
  decodeWorkThreadId,
  LOCAL_HOST_ID,
} from "@octant/contracts";
import { decodeBrowserThreadId } from "@octant/contracts/browser-automation";
import { managedWorktreeRoot } from "../code/managedWorktreeService";
import { purgeThreadArtifacts, removeMirrorFiles } from "../persistence/threadArtifactPurge";
import { readHostIdentity } from "../persistence/remoteAccessProjection";
import { createProviderCredentialRouteHandler } from "../providers/providerCredentialRoutes";
import { makeAppStoreConnectKeyBrokerClient } from "../providers/credentialBrokerClient";
import { createAppStoreConnectKeyRouteHandler } from "../apple/appStoreConnectKeyRoutes";
import { APPLE_DISTRIBUTION_ADMITTED } from "../apple/appleDeviceService";
import { ProviderServiceError } from "../providers/providerService";
import { providerKeyJournal, reconcileProviderKeyChanges } from "../providers/providerKeyJournal";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import {
  createExternalContentRouteHandler,
  threadStandingFromMessageQueue,
} from "../externalContentRoutes";
import { ExternalContentClearStore } from "../context/externalContentClearStore";
import { defaultShellSettings } from "@octant/domain";
import {
  createRemoteGateway,
  type RemoteGateway,
  type RemoteGatewayServices,
  type RemoteServerGrantGatewayPort,
} from "../remote/remoteGateway";
import type { PrivateListener } from "../privateListener";
import { resolvePrincipalRouteContext } from "../principalRouteContext";
import { createLocalDeviceAdministrationRouteHandler } from "../remote/localDeviceAdministrationRoutes";
import { createHostControlRouteHandler } from "../hostControlRoutes";
import { desktopCredentialStore } from "../hostDataMap";
import { ThreadRetentionService } from "../threadRetentionService";
import { createLiveHostExportService } from "../hostExportService";
import { createHubAdministrationRouteHandler } from "../hub/hubAdministrationRoutes";
import { createHubLinkRouteHandler } from "../hub/hubLinkRoutes";
import { createHubMembershipJournal } from "../hub/hubMembershipJournal";
import { HubService } from "../hub/hubService";
import { createHubStateStore } from "../hub/hubStateStore";
import { createPinnedHubTransport } from "../hub/pinnedHubTransport";
import { createRosterSigningKeyStore } from "../hub/rosterSigningKey";
import { deviceLifecycleAt, SpokeLinkService } from "../hub/spokeLinkService";
import {
  TailscaleCertificateService,
  createTailscaleCertificateSetting,
  createListenerCertificateSink,
} from "../hub/tailscaleCertificate";
import { createTailscaleCliDaemon, execTailscale } from "../hub/tailscaleCliDaemon";
import { createPrivateListenerLifecycleController } from "../remote/privateListenerLifecycleController";
import {
  resolvePrivateListenerHostIdentity,
  type PrivateListenerHostIdentity,
} from "../remote/privateListenerHostIdentity";
import { createPrivateListenerAdministrationRouteHandler } from "../remote/privateListenerAdministrationRoutes";
import { createPrivateListenerSetting } from "../remote/privateListenerSetting";
import { createSelfMadeListenerCertificateStore } from "../remote/selfMadeListenerCertificate";
import { createSshTargetAdministrationRouteHandler } from "../sshTarget/sshTargetAdministrationRoutes";
import { targetHoldsRunningTurn } from "../sshTarget/sshRemoteCodeThreads";
import { SshRemoteProjectService } from "../sshTarget/sshRemoteProjectService";
import { SshRemoteTerminalService } from "../sshTarget/sshRemoteTerminalService";
import type { SshTargetsWiring } from "./sshTargets";
import { boundHostRuntimeDiagnostics, type HostRuntimeDiagnostics } from "@octant/host-runtime";
import { MAX_JSON_REQUEST_BODY_SIZE, type ServerStart } from "./serverShape";
import type { AuthorityWiring } from "./authority";
import type { FoundationsWiring } from "./foundations";
import type { AgentRunsWiring } from "./agentRuns";
import type { IntegrationsWiring } from "./integrations";
import type { ComputerUseWiring } from "./computerUse";
import type { CodeWiring } from "./code";
import type { CodeRuntimeWiring } from "./codeRuntime";
import type { ProvidersWiring } from "./providers";
import type { CodeToolingWiring } from "./codeTooling";
import type { WorkWiring } from "./work";
import type { CanvasWiring } from "./canvas";
import type { AutomationWiring } from "./automation";
import type { RoutesWiring } from "./routes";

const CERTIFICATE_CHECK_MS = 24 * 60 * 60 * 1_000;
const STARTUP_CERTIFICATE_CHECK_MS = 60 * 1_000;

export type RemoteDependencies = Pick<
  ServerStart,
  "options" | "persistence" | "serve" | "startedAt" | "version"
> &
  Pick<AuthorityWiring, "browserCaptureStore" | "windowAuthorityStore"> &
  Pick<AgentRunsWiring, "externalContentIngestionStore"> &
  Pick<IntegrationsWiring, "agentMessageService" | "toolEgressRules"> &
  Pick<ComputerUseWiring, "webAssets"> &
  Pick<CodeWiring, "codeAttachments" | "codeProjectAccess" | "workAttachments"> &
  Pick<
    ProvidersWiring,
    | "chatAttachmentStore"
    | "credentialBroker"
    | "credentialResolver"
    | "generatedImageStore"
    | "providerDataDirectory"
    | "providerService"
  > &
  Pick<
    CodeToolingWiring,
    | "debugConfigurationApprovals"
    | "debugService"
    | "languageServerApprovals"
    | "remoteServerGrants"
  > &
  Pick<WorkWiring, "threadExportService" | "threadMessageQueue"> &
  Pick<CanvasWiring, "canvasRoutes" | "canvasPublicShareService"> &
  Pick<AutomationWiring, "pushNotificationTokenStore"> &
  Pick<RoutesWiring, "authenticatedProductDispatch"> &
  Pick<FoundationsWiring, "workThreadProjection"> &
  Pick<FoundationsWiring, "providerRuntimeRegistry"> &
  Pick<SshTargetsWiring, "sshTargetConnections" | "sshTargetStore"> &
  Pick<CodeRuntimeWiring, "codeOperationRuntime">;

export function wireRemote(deps: RemoteDependencies) {
  const {
    agentMessageService,
    authenticatedProductDispatch,
    browserCaptureStore,
    canvasPublicShareService,
    canvasRoutes,
    chatAttachmentStore,
    codeAttachments,
    codeProjectAccess,
    credentialBroker,
    credentialResolver,
    generatedImageStore,
    debugConfigurationApprovals,
    debugService,
    languageServerApprovals,
    options,
    persistence,
    providerDataDirectory,
    providerRuntimeRegistry,
    providerService,
    pushNotificationTokenStore,
    remoteServerGrants,
    serve,
    startedAt,
    threadExportService,
    threadMessageQueue,
    toolEgressRules,
    version,
    webAssets,
    windowAuthorityStore,
    workAttachments,
    workThreadProjection,
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
        hubLink: services.hubLink ?? ((request) => hubLinkRoutes(request)),
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
  const recordHubMembership = createHubMembershipJournal({
    journal: persistence.journal,
    connection: persistence.connection,
    hostId: () => String(resolveHubIdentity().hostId),
    localActorId: OCTANT_LOCAL_ACTOR_ID,
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
  });
  const hubService = new HubService({
    state: hubStateStore,
    rosterKey: createRosterSigningKeyStore(providerDataDirectory),
    identity: resolveHubIdentity,
    listener: () => privateListenerController.status(),
    pairing: () => {
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
      };
    },
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
      };
    },
    record: recordHubMembership,
    serverBuildVersion: version,
    now: Date.now,
  });
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
  const hubAdministrationRoutes = createHubAdministrationRouteHandler({
    desktopBridgeSecret: options.desktopBridgeSecret,
    windowAuthorityStore,
    hub: hubService,
    spoke: spokeLinkService,
    certificate: tailscaleCertificate,
    maxRequestBodySize: MAX_JSON_REQUEST_BODY_SIZE,
  });
  const hubLinkRoutes = createHubLinkRouteHandler({ hub: hubService, spoke: spokeLinkService });
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
  const appStoreConnectKeyRoutes = createAppStoreConnectKeyRouteHandler({
    desktopBridgeSecret: options.desktopBridgeSecret,
    windowAuthorityStore,
    macos: process.platform === "darwin",
    distributionEnabled: APPLE_DISTRIBUTION_ADMITTED,
    keys:
      options.credentialBrokerUrl === undefined || options.credentialBrokerToken === undefined
        ? undefined
        : makeAppStoreConnectKeyBrokerClient({
            url: options.credentialBrokerUrl,
            token: options.credentialBrokerToken,
          }),
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
  // SSH targets are administered from this machine alone, like the listener:
  // the routes sit on the loopback chain beside it, never in product dispatch.
  const { sshTargetStore, sshTargetConnections } = deps;
  const sshRemoteProjects = new SshRemoteProjectService({
    store: sshTargetStore,
    connections: sshTargetConnections,
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
  });
  const sshRemoteTerminals = new SshRemoteTerminalService({
    projects: sshRemoteProjects,
    connections: sshTargetConnections,
    store: sshTargetStore,
  });
  // A restart ended every session, and every remote shell with it.
  sshRemoteTerminals.reconcile();
  const sshTargetAdministrationRoutes = createSshTargetAdministrationRouteHandler({
    desktopBridgeSecret: options.desktopBridgeSecret,
    windowAuthorityStore,
    connections: sshTargetConnections,
    projects: sshRemoteProjects,
    terminals: sshRemoteTerminals,
    threadRunsOnTarget: (targetId) =>
      targetHoldsRunningTurn(
        {
          projects: () => sshTargetStore.listProjects(),
          threads: () => persistence.readCodeThreads(),
          turnInProgress: (threadId) =>
            deps.codeOperationRuntime?.turnInProgress?.(threadId) === true,
        },
        String(targetId),
      ),
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
  const hostControlRoutes = createHostControlRouteHandler({
    windowAuthorityStore,
    diagnostics: composeHostDiagnostics,
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
            ...(options.credentialBrokerUrl !== undefined && hostRuntimePlatform === "darwin"
              ? { credentialStore: desktopCredentialStore() }
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
      listProjects: () => [
        ...persistence.readProjects().map((project) => ({
          projectId: project.id,
          name: project.name,
          type: project.type,
          lifecycle: project.lifecycle,
          ...(project.type === "chat" ? {} : { canonicalRoot: project.binding.canonicalRoot }),
        })),
        // A remote-bound Code Project is exported as any Project is: its
        // identity, never its folder.
        ...sshTargetStore.listProjects().map((project) => ({
          projectId: project.id,
          name: project.name,
          type: "code" as const,
          lifecycle: "active" as const,
        })),
      ],
      listSshTargets: () => sshTargetStore.exportTargets(),
      listProjectIds: () => persistence.readProjects().map((project) => String(project.id)),
      readProjectMemory: (projectId) => persistence.readProjectMemory(decodeProjectId(projectId)),
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
    appStoreConnectKeyRoutes,
    composeHostDiagnostics,
    externalContentRoutes,
    hostControlRoutes,
    hubAdministrationRoutes,
    localDeviceAdministrationRoutes,
    privateListenerAdministrationRoutes,
    privateListenerController,
    privateListenerSetting,
    providerCredentialRoutes,
    remoteHost,
    sshRemoteTerminals,
    sshTargetAdministrationRoutes,
  };
}

export type RemoteWiring = ReturnType<typeof wireRemote>;
