import { randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import {
  decodeChatThreadId,
  decodeCodeThreadId,
  decodeImageGenerationScopeId,
  decodeProjectId,
  decodeThreadMessageQueueScope,
  decodeWorkThreadId,
  LOCAL_HOST_ID,
  type OctantMode,
} from "@octant/contracts";
import { decodeBrowserThreadId } from "@octant/contracts/browser-automation";
import { managedWorktreeRoot } from "../code/managedWorktreeService";
import { purgeThreadArtifacts, removeMirrorFiles } from "../persistence/threadArtifactPurge";
import { readHostIdentity } from "../persistence/remoteAccessProjection";
import {
  makeReplicaDeviceKeyBrokerClient,
  makeReplicaStoreCredentialBrokerClient,
} from "../providers/credentialBrokerClient";
import { createProviderCredentialRouteHandler } from "../providers/providerCredentialRoutes";
import { ProviderServiceError } from "../providers/providerService";
import { providerKeyJournal, reconcileProviderKeyChanges } from "../providers/providerKeyJournal";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import {
  createExternalContentRouteHandler,
  threadStandingFromMessageQueue,
} from "../externalContentRoutes";
import { ExternalContentClearStore } from "../context/externalContentClearStore";
import { defaultShellSettings } from "@octant/domain";
import { localHostDisplayName } from "../localHostDisplayName";
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
import {
  createReplicaMembershipRouteHandler,
  createReplicaSyncStatusRouteHandler,
} from "../replica/replicaMembershipRoutes";
import { replicaComputerName, replicaMembershipView } from "../replica/replicaMembershipView";
import { createReplicaStoreSettingsRouteHandler } from "../replica/replicaStoreSettingsRoutes";
import { ReplicaStoreSettingsService } from "../replica/replicaStoreSettingsService";
import { ReplicaMembershipService } from "../replica/replicaMembershipService";
import {
  ReplicaArtifactImport,
  ReplicaArtifactSyncService,
} from "../replica/replicaArtifactSyncService";
import { SyncedArtifactService, type SyncedArtifactThread } from "../replica/syncedArtifactService";
import { createSyncedArtifactRouteHandler } from "../replica/syncedArtifactRoutes";
import { decideReplicaArtifactBinding } from "@octant/domain/replica-entry-policy";
import { createReplicaMembershipJournal } from "../replica/replicaMembershipProjection";
import {
  createReplicaDeviceKey,
  makeReplicaDeviceSigner,
  removeReplicaDeviceKey,
} from "../replica/replicaDeviceKeyService";
import { createHostResourceRouteHandler } from "../hostResourceRoutes";
import { desktopCredentialStore } from "../hostDataMap";
import { ThreadRetentionService } from "../threadRetentionService";
import { createLiveHostExportService } from "../hostExportService";
import { createPrivateListenerLifecycleController } from "../remote/privateListenerLifecycleController";
import { resolvePrivateListenerHostIdentity } from "../remote/privateListenerHostIdentity";
import { createPrivateListenerAdministrationRouteHandler } from "../remote/privateListenerAdministrationRoutes";
import { createPrivateListenerSetting } from "../remote/privateListenerSetting";
import { createSelfMadeListenerCertificateStore } from "../remote/selfMadeListenerCertificate";
import { boundHostRuntimeDiagnostics, type HostRuntimeDiagnostics } from "@octant/host-runtime";
import { MAX_JSON_REQUEST_BODY_SIZE, type ServerStart } from "./serverShape";
import type { AuthorityWiring } from "./authority";
import type { AgentRunsWiring } from "./agentRuns";
import type { IntegrationsWiring } from "./integrations";
import type { ComputerUseWiring } from "./computerUse";
import type { WorkspaceWiring } from "./workspace";
import type { CodeWiring } from "./code";
import type { ProvidersWiring } from "./providers";
import type { CodeToolingWiring } from "./codeTooling";
import type { ChatWiring } from "./chat";
import type { WorkWiring } from "./work";
import type { CanvasWiring } from "./canvas";
import type { AutomationWiring } from "./automation";
import type { RoutesWiring } from "./routes";

export type RemoteDependencies = Pick<
  ServerStart,
  "options" | "persistence" | "serve" | "startedAt" | "version"
> &
  Pick<AuthorityWiring, "browserCaptureStore" | "windowAuthorityStore"> &
  Pick<AgentRunsWiring, "externalContentIngestionStore"> &
  Pick<IntegrationsWiring, "agentMessageService" | "toolEgressRules"> &
  Pick<ComputerUseWiring, "webAssets"> &
  Pick<WorkspaceWiring, "workThreadProjection"> &
  Pick<
    CodeWiring,
    "codeAttachments" | "codeProjectAccess" | "folderBrowseService" | "workAttachments"
  > &
  Pick<
    ProvidersWiring,
    | "chatAttachmentStore"
    | "credentialBroker"
    | "credentialResolver"
    | "providerDataDirectory"
    | "providerRuntimeRegistry"
    | "providerService"
  > &
  Pick<CodeToolingWiring, "remoteServerGrants"> &
  Pick<ChatWiring, "generatedImageStore"> &
  Pick<WorkWiring, "threadExportService" | "threadMessageQueue"> &
  Pick<
    CanvasWiring,
    | "artifactLibraryService"
    | "canvasCommentService"
    | "canvasRoutes"
    | "canvasService"
    | "replicaArtifactSync"
    | "resolveCanvasWorkspace"
  > &
  Pick<AutomationWiring, "pushNotificationTokenStore"> &
  Pick<RoutesWiring, "authenticatedProductDispatch">;

export function wireRemote(deps: RemoteDependencies) {
  const {
    agentMessageService,
    artifactLibraryService,
    authenticatedProductDispatch,
    browserCaptureStore,
    canvasCommentService,
    canvasRoutes,
    canvasService,
    chatAttachmentStore,
    codeAttachments,
    codeProjectAccess,
    credentialBroker,
    credentialResolver,
    externalContentIngestionStore,
    folderBrowseService,
    generatedImageStore,
    options,
    persistence,
    providerDataDirectory,
    providerRuntimeRegistry,
    providerService,
    pushNotificationTokenStore,
    remoteServerGrants,
    replicaArtifactSync,
    resolveCanvasWorkspace,
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
        remoteServerGrants: services.remoteServerGrants ?? remoteServerGrantGatewayPort,
        serve: options.remoteServe ?? serve,
        config,
      });
      currentRemoteGateway = gateway;
      return gateway;
    },
    selfMadeCertificate: createSelfMadeListenerCertificateStore({
      dataDirectory: providerDataDirectory,
    }),
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
    forgetCanvases: (canvasIds) => {
      persistence.canvasProjection.evict(canvasIds);
      persistence.replicaArtifactProjection.evict(canvasIds);
    },
    purgeCanvasFiles: (canvasIds) => removeMirrorFiles(persistence.connection, canvasIds),
    forgetProjectData: (projectId) => toolEgressRules.forgetProject(projectId),
    purgeThreadArtifacts: async ({ mode, threadId }) => {
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
  const hostResourceRoutes = createHostResourceRouteHandler({
    windowAuthorityStore,
    dataDirectory: persistence.dataDirectory,
    hostId: () => readHostIdentity(persistence.connection)?.host_id,
  });
  // Settings › Sync reads membership from the journal alone: no store call,
  // so opening the page never reaches the store.
  const readReplicaMembershipView = () =>
    replicaMembershipView({
      state: persistence.replicaMembershipProjection.state(),
      now: Date.now(),
      computerName: replicaComputerName(hostname(), localHostDisplayName()),
      restore: replicaArtifactSync.service?.restoreProgress(),
      joinRead: replicaMembershipService.joinReadProgress(),
    });
  const replicaSyncStatusRoutes = createReplicaSyncStatusRouteHandler({
    windowAuthorityStore,
    hostId: () => readHostIdentity(persistence.connection)?.host_id,
    view: readReplicaMembershipView,
    ...(options.allowedRendererHttpOrigin === undefined
      ? {}
      : { allowedRendererHttpOrigin: options.allowedRendererHttpOrigin }),
  });
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
  // Replica membership reads its facts from the journal and keeps device
  // signing keys in their own namespace of the host credential store
  // (Keychain on macOS, Secret Service on Linux), reached through the
  // credential broker's device-key routes, never its provider routes.
  // Settings › Sync chooses the store; with sync off or no store chosen,
  // every command answers `not-configured` and makes no store call.
  const replicaDeviceKeys =
    options.credentialBrokerUrl === undefined || options.credentialBrokerToken === undefined
      ? undefined
      : makeReplicaDeviceKeyBrokerClient({
          url: options.credentialBrokerUrl,
          token: options.credentialBrokerToken,
        });
  const replicaStoreSettingsService = new ReplicaStoreSettingsService({
    journal: persistence.journal,
    uuid: randomUUID,
    actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    clock: () => new Date().toISOString() as never,
    home: homedir(),
    // The access-outside-project grant has no surface yet, so a sync folder
    // outside home fails closed, the same as the artifact mirror's folder.
    standingOutsideApproval: false,
    // A computer with a founder or joiner identity keeps its replica's store.
    memberOfReplica: () => persistence.replicaMembershipProjection.state().local !== undefined,
    // A bucket's key pair lives in a credential namespace of its own,
    // reached through the broker's bucket-key routes, so no provider
    // instance or device key with the same UUID can reach it. A host with no
    // broker cannot save one, and a bucket is refused there.
    credentials:
      options.credentialBrokerUrl === undefined || options.credentialBrokerToken === undefined
        ? undefined
        : makeReplicaStoreCredentialBrokerClient({
            url: options.credentialBrokerUrl,
            token: options.credentialBrokerToken,
          }),
  });
  const replicaStoreSettingsRoutes = createReplicaStoreSettingsRouteHandler({
    service: replicaStoreSettingsService,
    windowAuthorityStore,
    resolveFolderCandidate: (windowId, input) =>
      folderBrowseService.resolveCandidate(windowId, input),
    ...(options.allowedRendererHttpOrigin === undefined
      ? {}
      : { allowedRendererHttpOrigin: options.allowedRendererHttpOrigin }),
  });
  const replicaJournal = createReplicaMembershipJournal({
    journal: persistence.journal,
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
    actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
  });
  const replicaMembershipService = new ReplicaMembershipService({
    store: () => replicaStoreSettingsService.selection(),
    credentials: {
      create: async () => {
        if (replicaDeviceKeys === undefined) throw new Error("credential store unavailable");
        return createReplicaDeviceKey(replicaDeviceKeys);
      },
      sign: async (instanceId, payload) => {
        if (replicaDeviceKeys === undefined) return { status: "refused", reason: "unavailable" };
        return makeReplicaDeviceSigner(replicaDeviceKeys, instanceId).sign(payload);
      },
      remove: async (instanceId) => {
        if (replicaDeviceKeys === undefined) throw new Error("credential store unavailable");
        await removeReplicaDeviceKey(replicaDeviceKeys, instanceId);
      },
    },
    journal: replicaJournal,
    // A pull reconciles each valid artifact entry and journals what it did.
    artifacts: new ReplicaArtifactImport({
      membership: () => persistence.replicaMembershipProjection.state(),
      artifacts: () => persistence.replicaArtifactProjection.state(),
      localCanvasIds: () => [...persistence.canvasProjection.snapshot().keys()],
      journal: replicaJournal,
      // A comment another computer wrote joins the Canvas's comments here,
      // naming that computer.
      comments: {
        adopt: ({ canvasId, change, writer }) => {
          canvasCommentService.adoptReplicaChange({
            canvasId,
            change,
            writer: { instanceId: String(writer.instanceId), displayName: writer.displayName },
          });
        },
      },
    }),
    state: () => persistence.replicaMembershipProjection.state(),
    localHostId: LOCAL_HOST_ID,
    clock: () => Date.now(),
    restoreStopped: () => replicaArtifactSync.service?.restoreProgress()?.state === "stopped",
    // A computer that left its replica says so on the switch too.
    syncOff: () => replicaStoreSettingsService.turnSyncOff(),
  });
  // Publish and pull for artifacts. With sync off, or no identity in a
  // replica, nothing is queued and no store is called; a Code thread under
  // Plan mode publishes nothing, the same promise the mirror keeps.
  replicaArtifactSync.service = new ReplicaArtifactSyncService({
    membership: replicaMembershipService,
    store: () => replicaStoreSettingsService.selection(),
    membershipState: () => persistence.replicaMembershipProjection.state(),
    artifactState: () => persistence.replicaArtifactProjection.state(),
    journal: replicaJournal,
    uuid: randomUUID,
    canvas: (canvasId) => persistence.canvasProjection.getById(canvasId),
    projectName: (projectId) =>
      persistence.readProjects().find((project) => String(project.id) === projectId)?.name,
    planMode: (version) => {
      const provenance = version.definition.provenance;
      if (provenance.mode !== "code") return false;
      return persistence.readCodeThread(provenance.threadId)?.executionPolicy === "plan";
    },
    // Built just below; a pull only happens once the host is serving.
    afterPull: () => {
      syncedArtifactService.catchUp();
    },
  });
  const artifactSyncService = replicaArtifactSync.service;
  // Opening, keeping, merging, and restoring synced artifacts. A thread
  // takes one only when the binding policy finds it compatible from the
  // thread's own durable state, and its content enters that thread as
  // untrusted external content before the Canvas exists there.
  const projectRecord = (projectId: string | undefined) => {
    if (projectId === undefined) return undefined;
    const project = persistence.readProject(projectId as never);
    return project === undefined
      ? undefined
      : {
          id: String(project.id),
          type: project.type,
          lifecycle: project.lifecycle,
          name: project.name,
        };
  };
  const syncedArtifactThreads = (): ReadonlyArray<SyncedArtifactThread> => {
    const facts = (
      mode: OctantMode,
      thread: {
        readonly id: string;
        readonly title: string;
        readonly updatedAt: string;
        readonly projectId?: string | undefined;
        readonly active: boolean;
        readonly readOnly: boolean;
      },
    ): SyncedArtifactThread => {
      const project = projectRecord(thread.projectId);
      return {
        threadId: thread.id,
        title: thread.title,
        updatedAt: thread.updatedAt,
        projectId: project?.id,
        projectName: project?.name,
        facts: {
          mode,
          active: thread.active,
          projectActive: project?.lifecycle === "active" && project.type === mode,
          readOnly: thread.readOnly,
          workspaceResolved: resolveCanvasWorkspace({ mode, threadId: thread.id }) !== undefined,
        },
      };
    };
    return [
      ...persistence.readChatThreads().map((thread) =>
        facts("chat", {
          id: String(thread.id),
          title: thread.title,
          updatedAt: String(thread.updatedAt),
          projectId: thread.projectId === undefined ? undefined : String(thread.projectId),
          active: thread.lifecycle === "active",
          readOnly: false,
        }),
      ),
      ...workThreadProjection.list().map((thread) =>
        facts("work", {
          id: String(thread.id),
          title: thread.title,
          updatedAt: String(thread.updatedAt),
          projectId: String(thread.projectId),
          active: thread.lifecycle === "active",
          readOnly: false,
        }),
      ),
      ...persistence.readCodeThreads().map((thread) =>
        facts("code", {
          id: String(thread.id),
          title: thread.title,
          updatedAt: String(thread.updatedAt),
          projectId: String(thread.projectId),
          active: thread.lifecycle === "active",
          readOnly: thread.executionPolicy === "plan",
        }),
      ),
    ];
  };
  const syncedArtifactService = new SyncedArtifactService({
    artifacts: () => persistence.replicaArtifactProjection.state(),
    membership: () => persistence.replicaMembershipProjection.state(),
    sync: artifactSyncService,
    localCanvas: (canvasId) => {
      const entry = persistence.canvasProjection.getById(canvasId);
      if (entry === undefined) return undefined;
      const project = projectRecord(String(entry.currentVersion.definition.provenance.projectId));
      return {
        currentVersion: entry.currentVersion,
        versions: entry.versions,
        projectName: project?.name ?? "Project",
      };
    },
    threads: syncedArtifactThreads,
    ingest: ({ threadId, contentReference, sourceLabel }) => {
      const recorded = externalContentIngestionStore.record({
        threadId,
        provenance: { origin: "external-content", sourceLabel },
        contentReference,
        correlationId: randomUUID(),
        authorized: true,
      });
      return recorded.kind === "recorded" || recorded.kind === "already-recorded";
    },
    adopt: ({ canvasId, versionId, content, createdAt, threadId }) => {
      const held = persistence.canvasProjection.getById(canvasId);
      const provenance = held?.currentVersion.definition.provenance;
      const mode = provenance?.mode ?? content.provenance.mode;
      const bound =
        threadId ?? (provenance === undefined ? undefined : String(provenance.threadId));
      const thread = syncedArtifactThreads().find((candidate) => candidate.threadId === bound);
      if (thread === undefined) {
        return { kind: "denied", message: "That thread is not on this computer." };
      }
      // The thread is checked again here, at the commit, so a thread that
      // was archived or put in Plan mode since the person chose it refuses.
      const decision = decideReplicaArtifactBinding(mode, thread.facts);
      if (decision.kind === "incompatible") {
        return { kind: "denied", message: "That thread cannot take this artifact now." };
      }
      const project = projectRecord(thread.projectId);
      const adopted = canvasService.adoptVersion(
        { canvasId, versionId, content, createdAt },
        {
          mode,
          projectId: thread.projectId ?? null,
          hostId: String(LOCAL_HOST_ID),
          originThreadId: thread.threadId,
        },
        project,
      );
      return adopted.kind === "adopted"
        ? { kind: "committed", version: adopted.version }
        : { kind: "denied", message: adopted.message };
    },
    revise: ({ canvasId, blocks, prompt }) => {
      const entry = persistence.canvasProjection.getById(canvasId);
      if (entry === undefined) {
        return { kind: "denied", message: "That artifact is no longer available." };
      }
      const current = entry.currentVersion;
      const provenance = current.definition.provenance;
      const workspace = resolveCanvasWorkspace(provenance);
      if (workspace === undefined) {
        return {
          kind: "denied",
          message: "The Project or thread this artifact belongs to is no longer available.",
        };
      }
      const project = persistence.readProject(provenance.projectId);
      const result = canvasService.revise(
        {
          schemaVersion: 1,
          kind: "canvas-revise",
          requestId: randomUUID(),
          canvasId,
          expectedSequence: current.sequence,
          hostId: LOCAL_HOST_ID,
          mode: provenance.mode,
          workspace,
          originThreadId: provenance.threadId,
          prompt,
          actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
          providerInstanceId: provenance.providerInstanceId,
          modelId: provenance.modelId,
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
        {
          mode: provenance.mode,
          projectId: String(provenance.projectId),
          hostId: String(LOCAL_HOST_ID),
          workspace,
          originThreadId: String(provenance.threadId),
        },
        project === undefined
          ? undefined
          : { id: String(project.id), type: project.type, lifecycle: project.lifecycle },
        blocks,
      );
      if (result.kind !== "accepted") return { kind: "denied", message: result.message };
      const revised = persistence.canvasProjection.getById(canvasId)?.currentVersion;
      return revised === undefined
        ? { kind: "denied", message: "That artifact is no longer available." }
        : { kind: "committed", version: revised };
    },
    entry: (canvasId) => artifactLibraryService.entry(canvasId),
    uuid: randomUUID,
    clock: () => new Date().toISOString() as never,
  });
  const syncedArtifactRoutes = createSyncedArtifactRouteHandler({
    service: syncedArtifactService,
    windowAuthorityStore,
  });
  const replicaMembershipRoutes = createReplicaMembershipRouteHandler({
    service: replicaMembershipService,
    view: readReplicaMembershipView,
    restore: {
      stop: () => artifactSyncService.stopRestore(),
      resume: () => artifactSyncService.resumeRestore(),
    },
    windowAuthorityStore,
    ...(options.allowedRendererHttpOrigin === undefined
      ? {}
      : { allowedRendererHttpOrigin: options.allowedRendererHttpOrigin }),
  });
  return {
    artifactSyncService,
    composeHostDiagnostics,
    externalContentRoutes,
    hostControlRoutes,
    hostResourceRoutes,
    localDeviceAdministrationRoutes,
    privateListenerAdministrationRoutes,
    privateListenerController,
    privateListenerSetting,
    providerCredentialRoutes,
    remoteHost,
    replicaMembershipRoutes,
    replicaMembershipService,
    replicaStoreSettingsRoutes,
    replicaSyncStatusRoutes,
    syncedArtifactRoutes,
  };
}

export type RemoteWiring = ReturnType<typeof wireRemote>;
