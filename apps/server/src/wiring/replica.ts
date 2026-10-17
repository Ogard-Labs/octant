import { randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import { LOCAL_HOST_ID, type OctantMode } from "@octant/contracts";
import { readHostIdentity } from "../persistence/remoteAccessProjection";
import {
  makeReplicaDeviceKeyBrokerClient,
  makeReplicaStoreCredentialBrokerClient,
} from "../providers/credentialBrokerClient";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { localHostDisplayName } from "../localHostDisplayName";
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
import { type ServerStart } from "./serverShape";
import type { AuthorityWiring } from "./authority";
import type { AgentRunsWiring } from "./agentRuns";
import type { FoundationsWiring } from "./foundations";
import type { CodeWiring } from "./code";
import type { CanvasWiring } from "./canvas";

export type ReplicaDependencies = Pick<ServerStart, "options" | "persistence"> &
  Pick<AuthorityWiring, "windowAuthorityStore"> &
  Pick<FoundationsWiring, "workThreadProjection"> &
  Pick<CodeWiring, "folderBrowseService"> &
  Pick<AgentRunsWiring, "externalContentIngestionStore"> &
  Pick<
    CanvasWiring,
    | "artifactLibraryService"
    | "canvasCommentService"
    | "canvasService"
    | "replicaArtifactSync"
    | "resolveCanvasWorkspace"
  >;

/**
 * Settings › Sync: the replica's store settings, membership, artifact sync,
 * and the synced artifacts a thread can take. Its routes are product routes,
 * so it is built ahead of the route dispatch the private listener serves.
 */
export function wireReplica(deps: ReplicaDependencies) {
  const {
    artifactLibraryService,
    canvasCommentService,
    canvasService,
    externalContentIngestionStore,
    folderBrowseService,
    options,
    persistence,
    replicaArtifactSync,
    resolveCanvasWorkspace,
    windowAuthorityStore,
    workThreadProjection,
  } = deps;

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
    replicaMembershipRoutes,
    replicaMembershipService,
    replicaStoreSettingsRoutes,
    replicaSyncStatusRoutes,
    syncedArtifactRoutes,
  };
}

export type ReplicaWiring = ReturnType<typeof wireReplica>;
