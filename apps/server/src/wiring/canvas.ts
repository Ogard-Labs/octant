import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CANVAS_REFRESH_MAX_SKILL_OPTIONS,
  type CanvasRefreshRequest,
  type CanvasRefreshSkill,
  decodeCanvasDefinition,
  decodeAgentRunId,
  decodeBrowserThreadId,
  decodeCanvasId,
  decodeChatThreadId,
  decodeCodeThreadId,
  decodeProjectId,
  LOCAL_HOST_ID,
  type OctantMode,
  type ProjectId,
  ThreadCreationRootId,
  type UtcTimestamp,
} from "@octant/contracts";
import type { StandaloneSkillRecord } from "@octant/contracts/extensions";
import { Schema } from "effect";
import { liveWorkFilesystem } from "../work/workFilesystemPort";
import { MAX_CHAT_ATTACHMENT_BYTES } from "../chat/chatAttachmentStore";
import { MAX_CODE_FILE_BODY_SIZE } from "../codeRoutes";
import { GitObservationPort } from "../code/gitObservationPort";
import { GitMutationPort } from "../code/gitMutationPort";
import { GitService } from "../code/gitService";
import { createGhGistCreationPort } from "../github/gistCreationPort";
import { createAgentRunForestCanvasSnapshot } from "../agentRun/agentRunCanvasSnapshot";
import type { AgentRunRouteDependencies } from "../agentRun/agentRunRoutes";
import { DEFAULT_FOLDER_ARTIFACTS_SUBFOLDER, effectiveDefaultFolder } from "../defaultFolder";
import { createArtifactLibraryRouteHandler } from "../artifactLibraryRoutes";
import { createArtifactMirrorRouteHandler } from "../artifactMirrorRoutes";
import { ArtifactLibraryService } from "../canvas/artifactLibraryService";
import { createCanvasRouteHandler, resolveCanvasActiveContext } from "../canvasRoutes";
import { CanvasEventStore } from "../canvas/canvasEventStore";
import { markCanvasReader } from "../canvas/canvasOutsideContentMark";
import { CanvasService, type CanvasServiceDependencies } from "../canvas/canvasService";
import { CanvasCommentService } from "../canvas/canvasCommentService";
import { CanvasShareEventStore } from "../canvas/canvasShareEventStore";
import { CanvasShareService } from "../canvas/canvasShareService";
import { CanvasExportEventStore } from "../canvas/canvasExportEventStore";
import { CanvasExportService } from "../canvas/canvasExportService";
import { createCanvasRefreshSourceResolver } from "../canvas/canvasRefreshSourceResolver";
import { readCanvasRefreshFile, resolveCanvasRefreshFile } from "../canvas/canvasRefreshFileRead";
import type {
  CanvasDesignAssetResolution,
  CanvasDesignBlock,
  CanvasProvenance,
} from "@octant/contracts/canvas";
import { CanvasDesignRunTickets } from "../canvas/canvasDesignPage";
import {
  type CanvasDesignAssetPorts,
  readCanvasDesignAssetFile,
  resolveCanvasDesignAssets,
} from "../canvas/canvasDesignAssets";
import { createCanvasSkillContributionResolver } from "../canvas/canvasSkillContributionResolver";
import {
  createCanvasSkillContributionLookup,
  offeredCanvasDocumentRecipes,
} from "../canvas/canvasSkillContributionLoader";
import { resolveConfinedPath } from "../preview/previewTargetRegistry";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { ArtifactMirrorEventStore } from "../canvas/artifactMirrorEventStore";
import {
  createArtifactMirrorFilePort,
  isInsideHomeDirectory,
} from "../canvas/artifactMirrorFilePort";
import { createArtifactMirrorCommitPort } from "../canvas/artifactMirrorCommitPort";
import { ArtifactMirrorService } from "../canvas/artifactMirrorService";
import { createCanvasExportFilePort } from "../canvas/canvasExportFilePort";
import { CanvasExportFolderService } from "../canvas/canvasExportFolderService";
import {
  canvasExportTargetBindings,
  type CanvasExportTargetRegistration,
} from "../canvas/canvasExportTargets";
import {
  authorizeCanvasInventoryAccess,
  chatThreadHoldsCanvas as threadLifecycleHoldsCanvas,
  defaultShellSettings,
} from "@octant/domain";
import { type CanvasAgentToolPort, createChildCanvasAgentTools } from "../canvas/canvasAgentTools";
import { loadChildCanvasWorkspace } from "../canvas/childCanvasWorkspace";
import { effectiveAgentRunExecutionTarget } from "@octant/domain/agent-run-policy";
import { createCanvasPreviewService } from "../canvas/canvasPreviewService";
import { createPlaywrightCanvasPreviewRenderer } from "../canvas/canvasPreviewRenderer";
import {
  ReplicaArtifactSyncService,
  replicaSyncedLibraryEntries,
} from "../replica/replicaArtifactSyncService";
import { localArtifactSyncFacts } from "../replica/syncedArtifactService";
import { resolveWebAssetsPath } from "./computerUse";
import type { ProvidersWiring } from "./providers";
import type { ServerStart } from "./serverShape";
import type { AuthorityWiring } from "./authority";
import type { FoundationsWiring } from "./foundations";
import type { AgentRunsWiring } from "./agentRuns";
import type { IntegrationsWiring } from "./integrations";
import type { WorkspaceWiring } from "./workspace";
import type { CodeWiring } from "./code";

/**
 * Does a Canvas's refresh request stand in the scope of this skill record?
 *
 * A Project-root skill carries no thread scope for a client to echo, so its
 * Project is checked against the Canvas itself: another Project's Canvas, or
 * a Chat Canvas, never sees it.
 */
export function sameCanvasSkillScope(
  record: Pick<StandaloneSkillRecord, "scope" | "projectScope">,
  recipeScope: CanvasRefreshSkill["scope"],
  request: Pick<CanvasRefreshRequest, "mode" | "workspace" | "originThreadId">,
): boolean {
  const projectScope = record.projectScope;
  if (
    projectScope !== undefined &&
    (projectScope.mode !== request.mode ||
      request.workspace.projectId === null ||
      String(projectScope.projectId) !== String(request.workspace.projectId))
  ) {
    return false;
  }
  const recordScope = record.scope;
  if (recordScope === undefined) return recipeScope === undefined;
  if (recipeScope === undefined || recipeScope.mode !== request.mode) return false;
  return (
    recordScope.mode === recipeScope.mode &&
    String(recordScope.projectId) === String(recipeScope.projectId) &&
    String(recordScope.threadRef) === String(recipeScope.threadRef) &&
    String(recipeScope.projectId) === String(request.workspace.projectId) &&
    String(recipeScope.threadRef) === String(request.originThreadId)
  );
}

export type CanvasDependencies = Pick<ServerStart, "options" | "persistence"> &
  Pick<AuthorityWiring, "agentRunPersistence" | "browserCaptures" | "windowAuthorityStore"> &
  Pick<AgentRunsWiring, "contributeChildTools" | "managedWorktreeReceipts"> &
  Pick<IntegrationsWiring, "gistConnection" | "threadOutsideContentMarks"> &
  Pick<WorkspaceWiring, "projectService" | "shellService"> &
  Pick<CodeWiring, "folderBrowseService"> &
  Pick<ProvidersWiring, "chatDataDirectory" | "extensionApiService" | "imageJobService"> &
  Pick<
    FoundationsWiring,
    "providerRuntimeRegistry" | "workArtifactProjection" | "workThreadProjection"
  >;

export function wireCanvas(deps: CanvasDependencies) {
  const {
    agentRunPersistence,
    browserCaptures,
    chatDataDirectory,
    contributeChildTools,
    extensionApiService,
    folderBrowseService,
    gistConnection,
    imageJobService,
    managedWorktreeReceipts,
    options,
    persistence,
    projectService,
    providerRuntimeRegistry,
    shellService,
    threadOutsideContentMarks,
    windowAuthorityStore,
    workArtifactProjection,
    workThreadProjection,
  } = deps;

  // A version written while its thread, or the child writing it, is marked
  // with outside content makes the Canvas carry that mark, whoever reads it
  // later and whatever a person clears on the writer afterwards.
  const canvasEventStore = new CanvasEventStore({
    journal: persistence.journal,
    uuid: randomUUID,
    actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    writerMarked: threadOutsideContentMarks.isMarked,
  });
  // Versions taken from another computer before they recorded their own
  // author still name the thread they landed in, which a Clear exempts.
  try {
    canvasEventStore.carryAdoptedVersionWriters({
      versionIdsOf: (canvasId) =>
        persistence.canvasProjection
          .getById(decodeCanvasId(canvasId))
          ?.versions.map((version) => String(version.versionId)),
      occurredAt: new Date().toISOString() as UtcTimestamp,
    });
  } catch {
    // The next start tries again; a read refuses when the mark is unreadable.
  }
  // One server-owned Canvas authority, shared by every Canvas mutation
  // including sharing, so a share can never be admitted under weaker checks
  // than a revise or a refresh.
  // A Chat thread in no Chat Project may own a Canvas of its own. Such a
  // Canvas is read wherever its thread is: a person's window in Chat may
  // reach it while the thread exists and is not being deleted, whatever
  // Project the window shows, because the thread itself has no Project
  // authority to match; an agent reaches it only from the thread that owns
  // it, since no Project makes it a neighbour's. Deleting the thread takes
  // the Canvas out of reach; the purge erases it with the thread. The shell
  // restores and opens such a Canvas's tab under the same lifecycle rule.
  const chatThreadHoldsCanvas = (threadId: string): boolean => {
    let thread;
    try {
      thread = persistence.readChatThread(decodeChatThreadId(threadId));
    } catch {
      return false;
    }
    return threadLifecycleHoldsCanvas(thread);
  };
  const authorizeCanvas: CanvasServiceDependencies["authorize"] = (entry, context, project) => {
    const provenance = entry.currentVersion.definition.provenance;
    if (provenance.projectId === null) {
      return (
        context.mode === "chat" &&
        (context.originThreadId === undefined ||
          context.originThreadId === String(provenance.threadId)) &&
        chatThreadHoldsCanvas(String(provenance.threadId))
      );
    }
    if (context.projectId === null || project === undefined || project.lifecycle !== "active") {
      return false;
    }
    let activeProjectId: ProjectId;
    try {
      activeProjectId = decodeProjectId(context.projectId);
    } catch {
      return false;
    }
    return (
      authorizeCanvasInventoryAccess({
        requestedProjectId: provenance.projectId,
        activeProjectId,
        activeMode: context.mode,
        projectMode: project.type,
      }) && provenance.mode === project.type
    );
  };
  // Resolved from the Canvas's own provenance and durable host state, so
  // the scope a client echoes is never the scope that authorizes it.
  // Takes only what it reads, so a caller that has a thread but no full
  // provenance — a hand-off, for one — derives its scope the same way
  // rather than building a parallel one.
  const resolveCanvasWorkspace = (provenance: {
    readonly mode: OctantMode;
    readonly threadId: string;
  }): import("@octant/contracts/canvas-cards").CanvasWorkspaceScope | undefined => {
    if (provenance.mode === "chat") {
      const thread = persistence.readChatThread(provenance.threadId as never);
      if (thread === undefined || thread.lifecycle !== "active") return undefined;
      return { kind: "chat-virtual", projectId: null };
    }
    if (provenance.mode === "work") {
      const thread = workThreadProjection.read(provenance.threadId as never);
      const project = thread === undefined ? undefined : persistence.readProject(thread.projectId);
      const revision = project?.type === "work" ? project.bindingHistory.at(-1) : undefined;
      if (
        thread === undefined ||
        thread.lifecycle !== "active" ||
        revision === undefined ||
        String(thread.bindingRevisionId) !== String(revision.revisionId)
      ) {
        return undefined;
      }
      return {
        kind: "work-root",
        projectId: thread.projectId,
        rootId: Schema.decodeUnknownSync(ThreadCreationRootId)(revision.revisionId),
      };
    }
    const thread = persistence.readCodeThread(provenance.threadId as never);
    if (thread === undefined || thread.lifecycle !== "active") return undefined;
    const project = persistence.readProject(thread.projectId);
    const revision = project?.type === "code" ? project.bindingHistory.at(-1) : undefined;
    const checkout = persistence.readCodeCheckout(thread.checkoutId);
    if (
      project?.type !== "code" ||
      project.lifecycle !== "active" ||
      revision === undefined ||
      String(revision.revisionId) !== String(thread.bindingRevisionId) ||
      checkout === undefined ||
      checkout.availability !== "available"
    ) {
      return undefined;
    }
    return {
      kind: "code-worktree",
      projectId: thread.projectId,
      repositoryId: thread.repositoryId,
      bindingRevisionId: thread.bindingRevisionId,
      checkoutId: thread.checkoutId,
      verified: true,
    };
  };

  /**
   * The checkout an active Code thread is bound to now: the Project's own
   * repository for an existing worktree, or a managed worktree only while
   * its ownership receipt still names this thread, checkout, and repository.
   * Undefined refuses.
   */
  const codeThreadCheckoutRoot = async (
    threadId: string,
    projectId: string,
  ): Promise<string | undefined> => {
    const thread = persistence.readCodeThread(threadId as never);
    if (
      thread === undefined ||
      String(thread.projectId) !== projectId ||
      thread.lifecycle !== "active"
    ) {
      return undefined;
    }
    const project = persistence.readProject(thread.projectId);
    if (project?.type !== "code" || project.lifecycle !== "active") return undefined;
    const checkout = persistence.readCodeCheckout(thread.checkoutId);
    if (checkout === undefined) return undefined;
    if (checkout.kind === "existing-worktree") return project.binding.canonicalRoot;
    if (checkout.kind !== "managed-worktree") return undefined;
    const receipt = await managedWorktreeReceipts.load(String(checkout.ownershipReceiptId));
    if (
      receipt === undefined ||
      receipt.state !== "ready" ||
      receipt.receiptId !== checkout.ownershipReceiptId ||
      receipt.threadId !== thread.id ||
      receipt.checkoutId !== checkout.id ||
      receipt.repositoryId !== thread.repositoryId ||
      receipt.repositoryId !== checkout.repositoryId ||
      receipt.canonicalRepositoryPath !== project.binding.canonicalRoot
    ) {
      return undefined;
    }
    return receipt.canonicalWorktreePath;
  };

  /**
   * Where a Canvas design's declared images are read from. Every call
   * re-derives authority from the Canvas version's provenance and durable
   * host state: a generated image only from a thread of the same Project,
   * a Work file only under the Project root while the thread is bound to its
   * current revision, and a Code file only under the thread's checkout.
   */
  const canvasDesignAssetPorts: CanvasDesignAssetPorts = {
    generatedImage: async ({ imageId, projectId, threadId, maximumBytes }) => {
      const job = imageJobService.completedJobFor(imageId);
      if (job === undefined) return { status: "unavailable", reason: "missing" };
      const artifact = job.artifacts.find(
        (candidate) => String(candidate.attachmentId) === String(imageId),
      );
      if (artifact === undefined) return { status: "unavailable", reason: "missing" };
      const owner =
        job.threadKind === "chat-thread"
          ? persistence.readChatThread(job.scopeId as never)
          : job.threadKind === "work-thread"
            ? workThreadProjection.read(job.scopeId as never)
            : job.threadKind === "code-thread"
              ? persistence.readCodeThread(job.scopeId as never)
              : undefined;
      // The host-wide image library belongs to no Project, so no Canvas
      // reaches it through a design.
      if (owner === undefined) return { status: "unavailable", reason: "refused" };
      if (owner.lifecycle === "deleted" || owner.lifecycle === "deleting") {
        return { status: "unavailable", reason: "missing" };
      }
      // A Canvas owned by its thread reaches only images that thread made;
      // a Project Canvas reaches those of any thread in its Project.
      if (projectId === null) {
        if (job.threadKind !== "chat-thread" || String(job.scopeId) !== threadId) {
          return { status: "unavailable", reason: "refused" };
        }
      } else if (owner.projectId === undefined || String(owner.projectId) !== projectId) {
        return { status: "unavailable", reason: "refused" };
      }
      if (artifact.size > maximumBytes) return { status: "unavailable", reason: "too-large" };
      // The attachment store throws when a finalized image's file is gone or
      // no longer matches its hash; that image is missing, and the design's
      // other assets still resolve.
      const read = await imageJobService
        .readArtifact(job.id, artifact.attachmentId)
        .catch(() => undefined);
      return read === undefined
        ? { status: "unavailable", reason: "missing" }
        : { status: "read", bytes: read.bytes };
    },
    browserCapture: async ({ captureId, threadId, maximumBytes }) => {
      // The service lists only the captures this thread kept, so another
      // thread's capture id is simply not found, and so is one already dropped.
      const kept = await browserCaptures
        .read(decodeBrowserThreadId(threadId), captureId)
        .catch(() => undefined);
      if (kept === undefined) return { status: "unavailable", reason: "missing" };
      if (kept.bytes.byteLength > maximumBytes) {
        return { status: "unavailable", reason: "too-large" };
      }
      return { status: "read", bytes: kept.bytes };
    },
    projectFile: async ({ mode, projectId, threadId, path, maximumBytes }) => {
      let root: string | undefined;
      if (mode === "code") {
        // The same binding-revision and checkout-availability checks as any
        // Canvas scope, so a rebound Project or a waiting checkout refuses.
        const workspace = resolveCanvasWorkspace({ mode: "code", threadId });
        root =
          workspace?.kind === "code-worktree" && String(workspace.projectId) === projectId
            ? await codeThreadCheckoutRoot(threadId, projectId)
            : undefined;
      } else {
        const workspace = resolveCanvasWorkspace({ mode: "work", threadId });
        const project = persistence.readProject(projectId as never);
        root =
          workspace?.kind === "work-root" &&
          String(workspace.projectId) === projectId &&
          project?.type === "work" &&
          project.lifecycle === "active"
            ? project.binding.canonicalRoot
            : undefined;
      }
      if (root === undefined) return { status: "unavailable", reason: "refused" };
      return await readCanvasDesignAssetFile({
        filesystem: liveWorkFilesystem,
        root,
        path,
        maximumBytes,
      });
    },
  };
  const resolveDesignAssets = (
    block: CanvasDesignBlock,
    provenance: CanvasProvenance,
  ): Promise<ReadonlyArray<CanvasDesignAssetResolution>> =>
    resolveCanvasDesignAssets(block, provenance, canvasDesignAssetPorts);

  const artifactMirrorEvents = new ArtifactMirrorEventStore({
    journal: persistence.journal,
    uuid: randomUUID,
    clock: () => new Date().toISOString() as never,
    actor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
  });
  // The mirror listens for committed versions rather than being called by
  // each surface that can revise, so every revision materializes the same way
  // wherever it came from. It is constructed before the service it listens to
  // so the hook below can name it.
  // Artifact sync is built with the replica services further down; the
  // version hook below reaches it through this slot, which is filled before
  // the host serves its first request.
  const replicaArtifactSync: { service?: ReplicaArtifactSyncService } = {};
  const artifactMirrorService = new ArtifactMirrorService({
    files: createArtifactMirrorFilePort(),
    currentVersion: (canvasId) => persistence.canvasProjection.getById(canvasId)?.currentVersion,
    projects: {
      read: (projectId: string) => {
        const project = persistence
          .readProjects()
          .find((candidate) => String(candidate.id) === projectId);
        if (project === undefined) return undefined;
        return {
          name: project.name,
          ...(project.type === "chat" ? {} : { checkoutRoot: project.binding.canonicalRoot }),
        };
      },
    },
    // A folder the person picked is theirs to pick, but only inside their own
    // home: anywhere else needs the access-outside-project grant, which has no
    // surface yet, so it fails closed rather than being assumed.
    outsideRootApproved: (destination) =>
      destination.kind !== "global-folder" ||
      isInsideHomeDirectory(destination.canonicalRoot, homedir()),
    defaultFallback: () => ({
      kind: "global-folder",
      canonicalRoot: join(
        effectiveDefaultFolder(persistence.readShellSettings()?.settings ?? defaultShellSettings()),
        DEFAULT_FOLDER_ARTIFACTS_SUBFOLDER,
      ),
    }),
    // Read-only is a promise about the disk as well as the journal, so a
    // Code thread under Plan mode writes no files. Only Code carries an
    // execution policy; Chat and Work threads have no read-only posture to
    // read here.
    planMode: (version) => {
      const provenance = version.definition.provenance;
      if (provenance.mode !== "code") return false;
      return persistence.readCodeThread(provenance.threadId)?.executionPolicy === "plan";
    },
    // Taking an edited file back in goes through `revise` — the same path a
    // person or an agent takes — so it is authorized, journaled, and counted
    // as a version like any other. Nothing here can replace a version.
    appendVersionFromBundle: ({ canvasId, definition }) => {
      const entry = persistence.canvasProjection.getById(canvasId);
      if (entry === undefined) {
        return { kind: "denied", message: "That artifact is no longer available." };
      }
      let blocks;
      try {
        blocks = decodeCanvasDefinition(definition).blocks;
      } catch {
        return { kind: "denied", message: "The file is not a readable artifact bundle." };
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
      const project =
        provenance.projectId === null ? undefined : persistence.readProject(provenance.projectId);
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
          prompt: "Re-imported from the mirrored file.",
          actor: { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID },
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
          projectId: provenance.projectId === null ? null : String(provenance.projectId),
          hostId: String(LOCAL_HOST_ID),
          workspace,
          originThreadId: String(provenance.threadId),
        },
        project === undefined
          ? undefined
          : { id: String(project.id), type: project.type, lifecycle: project.lifecycle },
        blocks,
      );
      return result.kind === "accepted"
        ? { kind: "accepted", versionId: String(result.receipt.versionId) }
        : { kind: "denied", message: result.message };
    },
    // Auto-commit is off unless the person turned it on, and even then it
    // commits only what the mirror wrote. Its Git service is this host's own
    // rather than the Code runtime's: the commit is authorized against the
    // index as it stands at that moment, so anything staged underneath
    // refuses the commit rather than joining it.
    commitMirroredFiles: createArtifactMirrorCommitPort(
      new GitService(new GitObservationPort(), new GitMutationPort()),
    ),
    journal: artifactMirrorEvents,
    receiptNotJournaled: (failure) => console.error("[artifact-mirror]", failure),
    clock: () => new Date().toISOString() as never,
  });

  const canvasService = new CanvasService(
    {
      projection: persistence.canvasProjection,
      eventStore: canvasEventStore,
      uuid: randomUUID,
      clock: () => new Date().toISOString() as never,
      onVersionCommitted: (version) => {
        // materialize reports what it can, so a rejection here is a broken
        // invariant: surfaced by name rather than left unhandled.
        artifactMirrorService.materialize(version).catch((error: unknown) => {
          console.error("[artifact-mirror] materialize failed", {
            canvasId: String(version.canvasId),
            error: error instanceof Error ? error.name : "unknown",
          });
        });
        // The replica publish listens on the same seam as the mirror, so
        // every surface's revisions publish the same way.
        void replicaArtifactSync.service?.versionCommitted(version);
      },
    },
    {
      // Reauthorize every source against authoritative server state; the
      // resolver fails closed (missing/revoked/offline/unauthorized/failed)
      // when a source is gone, deleted, offline, or not refreshable.
      // A person starting a Canvas chooses from the same recipes describe
      // offers an agent: in-tree, plus those admitted skills contribute.
      documentRecipes: () =>
        offeredCanvasDocumentRecipes(extensionApiService.snapshot().skills ?? []),
      refreshSource: createCanvasRefreshSourceResolver({
        clock: () => new Date().toISOString() as never,
        artifactState: (projectId, opaqueRef) => {
          for (const entry of workArtifactProjection.snapshot().values()) {
            if (String(entry.projectId) === projectId && entry.artifactRef === opaqueRef) {
              return {
                displayName: entry.displayName,
                relativePath: entry.relativePath,
                contentSha256: entry.currentSourceVersion.contentSha256,
                deleted: entry.deleted,
              };
            }
          }
          return undefined;
        },
        threadState: (projectId, threadId, mode) => {
          if (mode === "chat") {
            const thread = persistence.readChatThread(threadId as never);
            if (thread === undefined || String(thread.projectId) !== projectId) return undefined;
            return {
              title: thread.title,
              updatedAt: thread.updatedAt,
              lifecycle: thread.lifecycle,
            };
          }
          if (mode === "code") {
            const thread = persistence.readCodeThread(threadId as never);
            if (thread === undefined || String(thread.projectId) !== projectId) return undefined;
            return {
              title: thread.title,
              updatedAt: thread.updatedAt,
              lifecycle: thread.lifecycle,
            };
          }
          const thread = workThreadProjection.read(threadId as never);
          if (thread === undefined || String(thread.projectId) !== projectId) return undefined;
          return {
            title: thread.title,
            updatedAt: thread.updatedAt,
            lifecycle: thread.lifecycle,
          };
        },
        fileState: {
          resolve: async (projectId, opaqueRef, request) => {
            const project = persistence.readProject(projectId as never);
            if (project === undefined || project.lifecycle !== "active") {
              return undefined;
            }
            if (project.type === "chat") {
              const thread = persistence.readChatThread(request.originThreadId as never);
              if (
                thread === undefined ||
                thread.lifecycle !== "active" ||
                thread.projectId === undefined ||
                String(thread.projectId) !== projectId
              ) {
                return undefined;
              }
              const view = persistence.readChatThreadView(thread.id);
              const source = request.recipe.sourceManifest.find(
                (entry) => String(entry.opaqueRef) === opaqueRef,
              );
              if (
                request.mode !== "chat" ||
                (source?.kind !== "attachment" && source?.kind !== "image")
              ) {
                return undefined;
              }
              const attachment = view?.attachments.find(
                (candidate) =>
                  String(candidate.id) === opaqueRef &&
                  String(candidate.threadId) === String(thread.id) &&
                  candidate.status === "finalized",
              );
              if (attachment === undefined) return undefined;
              const attachmentPath = join(
                chatDataDirectory,
                "threads",
                String(request.originThreadId),
                String(attachment.id),
                "finalized.bin",
              );
              return await resolveCanvasRefreshFile(liveWorkFilesystem, {
                absolutePath: attachmentPath,
                displayName: attachment.displayName,
                relativePath: String(attachment.id),
                expectedDigest: attachment.digest,
                expectedByteLength: attachment.byteLength,
              });
            }
            if (project.type === "code") {
              const thread = persistence.readCodeThread(request.originThreadId as never);
              if (
                thread === undefined ||
                String(thread.projectId) !== projectId ||
                thread.lifecycle !== "active"
              ) {
                return undefined;
              }
              const reference = persistence
                .readCodeFileReferences(thread.id)
                .find((candidate) => String(candidate.id) === opaqueRef);
              if (
                reference === undefined ||
                reference.relativePath === undefined ||
                (reference.state !== "available" &&
                  reference.state !== "read-only" &&
                  reference.state !== "completed")
              )
                return undefined;
              const checkoutRoot = await codeThreadCheckoutRoot(thread.id, projectId);
              if (checkoutRoot === undefined) return undefined;
              const resolved = resolveConfinedPath(checkoutRoot, reference.relativePath);
              if (!resolved.ok) return undefined;
              return await resolveCanvasRefreshFile(liveWorkFilesystem, {
                absolutePath: resolved.absolutePath,
                displayName: reference.relativePath,
                relativePath: reference.relativePath,
              });
            }
            for (const entry of workArtifactProjection.snapshot().values()) {
              if (
                String(entry.projectId) === projectId &&
                entry.artifactRef === opaqueRef &&
                !entry.deleted
              ) {
                const resolved = resolveConfinedPath(
                  project.binding.canonicalRoot,
                  entry.relativePath,
                );
                if (!resolved.ok) return undefined;
                return await resolveCanvasRefreshFile(liveWorkFilesystem, {
                  absolutePath: resolved.absolutePath,
                  displayName: entry.displayName,
                  relativePath: entry.relativePath,
                });
              }
            }
            return undefined;
          },
          read: async (file) =>
            await readCanvasRefreshFile({
              filesystem: liveWorkFilesystem,
              file,
              maxBytes: Math.max(MAX_CHAT_ATTACHMENT_BYTES, MAX_CODE_FILE_BODY_SIZE),
            }),
        },
        providerObserved: (providerInstanceId, modelId) => {
          const observed = providerRuntimeRegistry.observedState(providerInstanceId as never);
          return (
            observed?.readiness === "ready" &&
            observed.models.some((model) => String(model.id) === modelId)
          );
        },
      }),
      // The Canvas's only source of authorized skill identity. A renderer
      // cannot mint a digest-pinned qualifiedId, so the host publishes the
      // skills already trusted, enabled, effective, and in scope for this
      // Canvas. Every option here is one `skillAuthorized` below would
      // admit — it is offered, not granted, and the refresh re-checks it.
      listRefreshSkills: (provenance, workspace) => {
        const scopeContext = {
          mode: provenance.mode,
          workspace,
          originThreadId: provenance.threadId,
        };
        return (extensionApiService.snapshot().skills ?? [])
          .filter(
            (record) =>
              record.desiredEnabled &&
              record.effectiveState.kind === "effective" &&
              // The record's own scope is what a client would echo back, so
              // the eligibility test is the admission test run against it.
              sameCanvasSkillScope(record, record.scope, scopeContext),
          )
          .map((record) => ({
            skill: {
              qualifiedId: record.skill.qualifiedId,
              ...(record.version === undefined ? {} : { version: record.version }),
              ...(record.scope === undefined ? {} : { scope: record.scope }),
            },
            displayName: record.displayName,
          }))
          .slice(0, CANVAS_REFRESH_MAX_SKILL_OPTIONS);
      },
      skillAuthorized: (skill, request) => {
        const record = extensionApiService
          .snapshot()
          .skills?.find(
            (candidate) => String(candidate.skill.qualifiedId) === String(skill.qualifiedId),
          );
        return (
          record !== undefined &&
          record.desiredEnabled &&
          record.effectiveState.kind === "effective" &&
          (record.version === undefined ||
            skill.version === undefined ||
            String(record.version) === String(skill.version)) &&
          sameCanvasSkillScope(record, skill.scope, request)
        );
      },
      // Resolve trusted skill layout/presentation contributions during
      // refresh on the real production path. The authoritative skill record
      // supplies the trust/enablement facts, and the published contribution
      // document (carried on the reconciled record) is re-validated at this
      // trust boundary before the pure admission policy admits or denies it.
      // A denied contribution fails the refresh closed and a contribution
      // never grants authority beyond the reauthorized sources. Skills that
      // do not yet publish parsed Canvas contribution content simply carry no
      // document, so the trusted skill contributes no layouts and the C2
      // skill gate above still applies.
      resolveSkillContribution: createCanvasSkillContributionResolver({
        lookup: createCanvasSkillContributionLookup({
          findSkillRecord: (skill, request) => {
            const record = extensionApiService
              .snapshot()
              .skills?.find(
                (candidate) => String(candidate.skill.qualifiedId) === String(skill.qualifiedId),
              );
            if (record === undefined || !sameCanvasSkillScope(record, skill.scope, request)) {
              return undefined;
            }
            return record;
          },
          readContributionDocument: (record) => record.canvasContribution,
        }),
      }),
      parameterAuthorized: (parameter, request, currentDefinition) => {
        if (!parameter.value.startsWith("ref:")) return false;
        const reference = parameter.value.slice("ref:".length);
        const allowed = new Set([
          String(request.canvasId),
          String(request.originThreadId),
          ...currentDefinition.sourceManifest.map((source) => String(source.sourceId)),
        ]);
        return allowed.has(reference);
      },
      resolveWorkspace: resolveCanvasWorkspace,
      authorize: authorizeCanvas,
      // Only an active Chat thread outside every Chat Project owns its own
      // Canvas; a thread in a Project has that Project to hold it.
      threadMayOwnCanvas: (threadId) => {
        let thread;
        try {
          thread = persistence.readChatThread(decodeChatThreadId(threadId));
        } catch {
          return false;
        }
        return (
          thread !== undefined && thread.lifecycle === "active" && thread.projectId === undefined
        );
      },
    },
  );
  // What a Chat thread's agent may do with a Canvas: write blocks into one,
  // through the same service and the same Project the person clicking New
  // Canvas reaches. The Project and workspace are resolved from the window
  // here, never taken from the agent.
  const canvasAgentToolPort: CanvasAgentToolPort = {
    activeContext: (windowId) => resolveCanvasActiveContext(shellService.bootstrap(windowId)),
    project: async (windowId, projectId) => {
      const bootstrap = await projectService.bootstrap(windowId);
      const project = bootstrap.active.find((candidate) => String(candidate.id) === projectId);
      return project === undefined
        ? undefined
        : { id: String(project.id), type: project.type, lifecycle: project.lifecycle };
    },
    canvas: canvasService,
    markReader: ({ readerId, canvasId }) => {
      const entry = persistence.canvasProjection.getById(canvasId);
      if (entry === undefined) return { status: "refused" };
      return markCanvasReader({
        journal: persistence.journal,
        marks: threadOutsideContentMarks,
        readerId,
        canvasId: String(canvasId),
        canvasThreadId: String(entry.currentVersion.definition.provenance.threadId),
        correlationId: randomUUID,
      });
    },
    preview: createCanvasPreviewService({
      canvas: canvasService,
      resolveDesignAssets,
      renderer: createPlaywrightCanvasPreviewRenderer({
        // The preview page ships beside the web build, so it follows the
        // same folder a host injects for the app; otherwise every preview
        // would report no renderer on that host.
        webAssetsPath: options.webAssetsPath ?? resolveWebAssetsPath(),
      }),
    }),
    imagesInToolResults: ({ providerInstanceId, modelId }) => {
      const model = providerRuntimeRegistry
        .observedState(providerInstanceId)
        ?.models.find((candidate) => String(candidate.id) === String(modelId));
      return model?.inputModalities.includes("image") === true;
    },
    uuid: randomUUID,
    hostId: LOCAL_HOST_ID,
    resolveWorkspace: resolveCanvasWorkspace,
    documentRecipes: () =>
      offeredCanvasDocumentRecipes(extensionApiService.snapshot().skills ?? []),
  };
  // A managed child writes into a Canvas through the same port, inside the
  // workspace its own run recorded rather than one a window shows.
  contributeChildTools((input) => {
    const target = effectiveAgentRunExecutionTarget(input.run.routingReceipt);
    return createChildCanvasAgentTools({
      port: {
        ...canvasAgentToolPort,
        resolveChildWorkspace: (query) =>
          loadChildCanvasWorkspace(
            {
              readRun: (runId) => {
                try {
                  return agentRunPersistence.getById(decodeAgentRunId(runId));
                } catch {
                  return undefined;
                }
              },
              readProject: (projectId) => {
                try {
                  const project = persistence.readProject(decodeProjectId(projectId));
                  if (project === undefined) return undefined;
                  if (project.type === "chat") {
                    return {
                      id: String(project.id),
                      type: project.type,
                      lifecycle: project.lifecycle,
                    };
                  }
                  return {
                    id: String(project.id),
                    type: project.type,
                    lifecycle: project.lifecycle,
                    binding: project.binding,
                    bindingHistory: project.bindingHistory,
                  };
                } catch {
                  return undefined;
                }
              },
              readCodeThread: (threadId) => {
                try {
                  return persistence.readCodeThread(decodeCodeThreadId(threadId));
                } catch {
                  return undefined;
                }
              },
              findManagedWorktreeReceipt: (lookup) => managedWorktreeReceipts.findActive(lookup),
            },
            query.runId,
          ),
      },
      run: {
        id: String(input.run.id),
        parentThreadId: String(input.run.parentThreadId),
        mode: input.run.routingReceipt.mode,
        ...("projectId" in input.run.workspaceReceipt
          ? { projectId: String(input.run.workspaceReceipt.projectId) }
          : {}),
        providerInstanceId: target.providerInstanceId,
        modelId: target.modelId,
      },
    });
  });
  // Canvas sharing is local-only: a snapshot is served over the loopback
  // Canvas API to a principal this host authenticates, never uploaded or
  // linked. Lifecycle is journaled, so revocation survives restart and the
  // access log is rebuilt by replay.
  const canvasShareService = new CanvasShareService(
    {
      projection: persistence.canvasProjection,
      eventStore: new CanvasShareEventStore({
        journal: persistence.journal,
        uuid: randomUUID,
        actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      }),
      uuid: randomUUID,
      clock: () => new Date().toISOString() as never,
      hostId: String(LOCAL_HOST_ID),
      owner: { kind: "local-user", actorId: String(OCTANT_LOCAL_ACTOR_ID) },
    },
    { authorize: authorizeCanvas },
  );
  // Where a Project's exports are written, and whether that folder is still
  // usable. Choosing one is a person's act on this machine: the host resolves
  // the browser's candidate to a path itself, and the choice is judged against
  // the same authority the artifact mirror's global folder uses — inside home
  // unless the standing access-outside-project grant exists, which has no
  // surface yet, so an outside folder fails closed.
  const canvasExportFilePort = createCanvasExportFilePort();
  const canvasExportFolderService = new CanvasExportFolderService({
    journal: persistence.journal,
    uuid: randomUUID,
    actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    clock: () => new Date().toISOString() as never,
    files: canvasExportFilePort,
    home: homedir(),
    standingOutsideApproval: false,
  });
  const canvasExportRegistration: CanvasExportTargetRegistration = {
    folderFor: (canvasId) => {
      const entry = persistence.canvasProjection.getById(canvasId);
      if (entry === undefined) return undefined;
      // A Canvas owned by its thread exports to the host folder, the one
      // chosen for everything without a Project of its own.
      const projectId = entry.currentVersion.definition.provenance.projectId;
      return canvasExportFolderService.folderFor(
        projectId === null ? undefined : String(projectId),
      );
    },
    files: canvasExportFilePort,
    home: homedir(),
    standingOutsideApproval: false,
    newTempId: randomUUID,
    // The gist destination reuses the GitHub connection Octant already has:
    // the same host-managed credential `gh` resolves, and the snapshot the
    // host keeps current. It reads that credential nowhere here.
    gist: {
      availability: () => gistConnection.availability(),
      gists: createGhGistCreationPort(options.ghExecutable),
    },
  };
  // Destinations arrive through the export contribution and are offered
  // through the same activation policy a plugin's contribution passes. The
  // folder destination ships in-tree on that seam; a third-party destination
  // reaches this list the same way, so it is granted nothing a plugin could
  // not have.
  const canvasExportService = new CanvasExportService({
    load: (canvasId, versionId) => {
      const entry = persistence.canvasProjection.getById(canvasId);
      if (entry === undefined) return undefined;
      const version =
        versionId === undefined
          ? entry.currentVersion
          : entry.versions.find((candidate) => String(candidate.versionId) === String(versionId));
      if (version === undefined) return undefined;
      return {
        canvasId: version.canvasId,
        versionId: version.versionId,
        sequence: version.sequence,
        title: version.definition.title,
        blocks: version.definition.blocks,
      };
    },
    targets: (canvasId) => canvasExportTargetBindings(canvasExportRegistration, canvasId),
    eventStore: new CanvasExportEventStore({
      journal: persistence.journal,
      uuid: randomUUID,
    }),
    uuid: randomUUID,
    clock: () => new Date().toISOString() as never,
  });
  // The library is a host-wide read of the same journal-derived projection
  // the per-Project inventory reads. It is deliberately wider than a window's
  // Project scope (0026); the service, not the route, decides what a given
  // principal may see.
  const artifactLibraryService = new ArtifactLibraryService({
    projection: persistence.canvasProjection,
    projects: () =>
      persistence.readProjects().map((project) => ({
        id: project.id,
        name: project.name,
        type: project.type,
        lifecycle: project.lifecycle,
      })),
    liveShares: () => canvasShareService.liveShareCanvasIds(),
    synced: () =>
      replicaSyncedLibraryEntries(
        persistence.replicaArtifactProjection.state(),
        persistence.replicaMembershipProjection.state().local,
      ),
    syncFacts: (entry) =>
      localArtifactSyncFacts(
        persistence.replicaArtifactProjection.state(),
        persistence.replicaMembershipProjection.state(),
        entry,
      ),
    clock: () => new Date().toISOString() as never,
  });
  const artifactLibraryRoutes = createArtifactLibraryRouteHandler({
    library: artifactLibraryService,
    windowAuthorityStore,
  });
  const artifactMirrorRoutes = createArtifactMirrorRouteHandler({
    mirror: artifactMirrorService,
    windowAuthorityStore,
  });
  // Comments are journaled facts of the Canvas, authored as the local user
  // with the originating device recorded beside the author; the service
  // rebuilds them from the journal and refuses reads a workspace may not make.
  const canvasCommentService = new CanvasCommentService(
    {
      journal: persistence.journal,
      projection: persistence.canvasProjection,
      uuid: randomUUID,
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      // A person's comment change on a Canvas the replica carries goes to
      // their other computers; one taken in from another computer does not.
      committed: (canvasId, event) => {
        void replicaArtifactSync.service?.commentCommitted({ canvasId, event });
      },
    },
    { authorize: authorizeCanvas },
  );
  const snapshotCanvas: NonNullable<AgentRunRouteDependencies["snapshotCanvas"]> = (input) =>
    createAgentRunForestCanvasSnapshot({
      mode: input.mode,
      parentThreadId: String(input.parentThreadId),
      title: input.title,
      blocks: input.blocks,
      uuid: randomUUID,
      resolveWorkspace: resolveCanvasWorkspace,
      readProject: (projectId) => {
        try {
          const project = persistence.readProject(decodeProjectId(projectId));
          if (project === undefined) return undefined;
          return { id: String(project.id), type: project.type, lifecycle: project.lifecycle };
        } catch {
          return undefined;
        }
      },
      readChatProjectId: (threadId) => {
        try {
          const thread = persistence.readChatThread(decodeChatThreadId(threadId));
          return thread?.projectId === undefined ? undefined : String(thread.projectId);
        } catch {
          return undefined;
        }
      },
      createCanvas: (request, context, project, blocks) =>
        canvasService.create(request, context, project, blocks),
    });
  const canvasRoutes = createCanvasRouteHandler({
    canvasProjection: persistence.canvasProjection,
    canvasService,
    resolveDesignAssets,
    designRunTickets: new CanvasDesignRunTickets(),
    canvasShareService,
    canvasExportService,
    // A host with no usable `gh` has no GitHub state to read; the gist
    // destination then stays not-connected without spawning anything.
    ...(options.ghExecutable === undefined
      ? {}
      : { refreshCanvasExportTargets: () => gistConnection.refresh() }),
    canvasExportFolderService,
    resolveFolderCandidate: (windowId, input) =>
      folderBrowseService.resolveCandidate(windowId, input),
    canvasCommentService,
    windowAuthorityStore,
    projects: projectService,
    activeContextResolver: (windowId) =>
      resolveCanvasActiveContext(shellService.bootstrap(windowId)),
  });
  return {
    artifactLibraryRoutes,
    artifactLibraryService,
    artifactMirrorRoutes,
    canvasAgentToolPort,
    canvasCommentService,
    canvasRoutes,
    canvasService,
    replicaArtifactSync,
    resolveCanvasWorkspace,
    snapshotCanvas,
  };
}

export type CanvasWiring = ReturnType<typeof wireCanvas>;
