import {
  decodeCodeThreadId,
  IMAGE_LIBRARY_SCOPE_ID,
  type ImageGenerationSaveResult,
  type ProjectId,
  type WindowId,
} from "@octant/contracts";
import { randomUUID } from "node:crypto";
import { createWorkMutationRouteHandler } from "../workMutationRoutes";
import { createWorkFileListingRouteHandler } from "../workFileListingRoutes";
import { WorkFileListingService } from "../work/workFileListingService";
import { WorkFilePreviewRefs } from "../work/workFilePreviewRefs";
import { liveWorkFilesystem } from "../work/workFilesystemPort";
import { WorkMutationEventStore } from "../work/workMutationEventStore";
import { WorkMutationService } from "../work/workMutationService";
import { WorkResolutionService } from "../work/workResolutionService";
import { createWorkResearchRouteHandler } from "../workResearchRoutes";
import { WorkResearchService } from "../work/workResearchService";
import { WorkResearchEventStore } from "../work/workResearchEventStore";
import { WorkResearchProjection } from "../work/workResearchProjection";
import { createWorkResearchSourcePort } from "../work/workResearchSourcePort";
import { createImageRouteHandler } from "../image/imageRoutes";
import { createSpeechRouteHandler } from "../speech/speechRoutes";
import { writeConfinedWorkFile } from "../work/workConfinedWrite";
import {
  createPreviewRouteHandler,
  resolvePreviewActiveContext,
  resolvePreviewAuthority,
} from "../previewRoutes";
import { createPreviewHandoffBridgeRouteHandler } from "../previewHandoffRoutes";
import { PreviewService } from "../preview/previewService";
import { derivePreviewHostId } from "../preview/previewHostIdentity";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import {
  canonicalizeWorkRelativePath,
  defaultShellSettings,
  type PreviewPosture,
} from "@octant/domain";
import { MAX_JSON_REQUEST_BODY_SIZE, type ServerStart } from "./serverShape";
import type { AuthorityWiring } from "./authority";
import type { WorkspaceWiring } from "./workspace";
import type { ProvidersWiring } from "./providers";
import type { CodeRuntimeWiring } from "./codeRuntime";
import type { ChatWiring } from "./chat";
import type { WorkWiring } from "./work";
import type { ContextWiring } from "./context";

export type WorkFilesDependencies = Pick<ServerStart, "options" | "persistence"> &
  Pick<AuthorityWiring, "windowAuthorityStore"> &
  Pick<WorkspaceWiring, "projectService" | "shellService"> &
  Pick<ProvidersWiring, "credentialResolver" | "providerDataDirectory"> &
  Pick<CodeRuntimeWiring, "routeCodeService"> &
  Pick<ChatWiring, "imageJobService"> &
  Pick<WorkWiring, "workArtifactProjection" | "workThreadService" | "workTurnProjection"> &
  Pick<ContextWiring, "windowCanOpenThread">;

export function wireWorkFiles(deps: WorkFilesDependencies) {
  const {
    credentialResolver,
    imageJobService,
    options,
    persistence,
    projectService,
    providerDataDirectory,
    routeCodeService,
    shellService,
    windowAuthorityStore,
    windowCanOpenThread,
    workArtifactProjection,
    workThreadService,
    workTurnProjection,
  } = deps;

  const previewHostId = derivePreviewHostId(providerDataDirectory);
  const workResolutionService = new WorkResolutionService(liveWorkFilesystem);
  const workMutationEventStore = new WorkMutationEventStore({
    journal: persistence.journal,
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
    actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
  });
  const workMutationService = new WorkMutationService({
    filesystem: liveWorkFilesystem,
    resolution: workResolutionService,
    projection: workArtifactProjection,
    eventStore: workMutationEventStore,
    uuid: randomUUID,
    clock: () => new Date().toISOString(),
    actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    hostId: previewHostId,
  });
  const workMutationRoutes = createWorkMutationRouteHandler({
    service: workMutationService,
    persistence,
    projects: projectService,
    windowAuthorityStore,
    maxJsonBodySize: MAX_JSON_REQUEST_BODY_SIZE,
  });
  // Minted by the folder listing, read by the preview target resolver. It
  // holds no authority of its own: a resolved path is still confined to the
  // Project root, and the preview route still requires that Project to be the
  // window's active one.
  const workFilePreviewRefs = new WorkFilePreviewRefs({
    hostId: previewHostId,
    uuid: randomUUID,
  });
  // Shared by the Files panel route and a Side Chat about a Work thread, so
  // both list a Project folder with the same confinement and ordering.
  const workFileListingService = new WorkFileListingService({
    filesystem: liveWorkFilesystem,
    previewRefs: workFilePreviewRefs,
    // The same projection the mutation service writes to, so a file the
    // panel calls Work's own is one this host recorded writing.
    artifactsForProject: (projectId) =>
      [...workArtifactProjection.snapshot().values()].filter(
        (entry) => String(entry.projectId) === String(projectId),
      ),
    // A provider writes with its own tools and never calls the mutation
    // service, so the artifact projection alone would show most of a
    // Project's real output as files the folder merely happened to hold.
    // The turns' own observations are the other half of that answer.
    pathsWrittenByTurns: (projectId) =>
      workTurnProjection.listForProject(projectId).flatMap((turn) => turn.wroteFiles?.paths ?? []),
  });
  const workFileListingRoutes = createWorkFileListingRouteHandler({
    service: workFileListingService,
    persistence,
    projects: projectService,
    windowAuthorityStore,
  });
  const speechRoutes = createSpeechRouteHandler({
    readVoiceSettings: () =>
      (persistence.readShellSettings()?.settings ?? defaultShellSettings()).voice,
    listInstances: () => persistence.readProviderInstances(),
    windowAuthorityStore,
    ...(credentialResolver === undefined ? {} : { credentialResolver }),
  });
  const imageRoutes = createImageRouteHandler({
    jobs: imageJobService,
    listInstances: () => persistence.readProviderInstances(),
    readImageGenerationSettings: () =>
      (persistence.readShellSettings()?.settings ?? defaultShellSettings()).imageGeneration,
    authorizeScope: async (windowId, threadKind, scopeId) => {
      const threadId = String(scopeId);
      // The library is host-wide: window capability already proved the
      // caller is a registered window, and the scope id is fixed.
      if (threadKind === "image-library") return threadId === String(IMAGE_LIBRARY_SCOPE_ID);
      return windowCanOpenThread(windowId, threadKind, threadId);
    },
    saveToProject: async (input) => {
      if (input.threadKind === "chat-thread") {
        return {
          status: "refused",
          reason: "Chat artifacts grant no filesystem authority.",
        } satisfies ImageGenerationSaveResult;
      }
      try {
        let canonicalRoot: string | undefined;
        if (input.threadKind === "work-thread") {
          const bootstrap = await workThreadService.bootstrap(input.windowId);
          const thread = bootstrap.threads.find(
            (candidate) => String(candidate.id) === String(input.scopeId),
          );
          const project =
            thread === undefined ? undefined : persistence.readProject(thread.projectId);
          if (project === undefined || project.type !== "work" || project.lifecycle !== "active") {
            return {
              status: "refused",
              reason: "The Work Project is unavailable.",
            } satisfies ImageGenerationSaveResult;
          }
          canonicalRoot = project.binding.canonicalRoot;
          const relativePath = canonicalizeWorkRelativePath(input.relativePath);
          const resolution = await workResolutionService.resolveForCreate({
            binding: {
              canonicalRoot,
              knownCanonicalRoot: canonicalRoot,
              availability: "available",
              bindingSuperseded: false,
            },
            relativePath,
          });
          if (resolution.status !== "resolved-for-create") {
            return {
              status: "refused",
              reason: "The save path is outside the Project.",
            } satisfies ImageGenerationSaveResult;
          }
          const written = await writeConfinedWorkFile({
            filesystem: liveWorkFilesystem,
            canonicalPath: resolution.absolutePath,
            allowCreate: true,
            parent: {
              absolutePath: resolution.parentAbsolute,
              identity: resolution.parentIdentity,
              remaining: resolution.remaining,
            },
            bytes: input.bytes,
          });
          if (!written) {
            return {
              status: "failed",
              reason: "The image could not be saved.",
            } satisfies ImageGenerationSaveResult;
          }
          return { status: "saved", relativePath: resolution.relativePath };
        }
        const view = await routeCodeService.read(
          input.windowId,
          decodeCodeThreadId(String(input.scopeId)),
        );
        const project = persistence.readProject(view.thread.projectId);
        if (project === undefined || project.type !== "code" || project.lifecycle !== "active") {
          return {
            status: "refused",
            reason: "The Code Project is unavailable.",
          } satisfies ImageGenerationSaveResult;
        }
        canonicalRoot = project.binding.canonicalRoot;
        const relativePath = canonicalizeWorkRelativePath(input.relativePath);
        const resolution = await workResolutionService.resolveForCreate({
          binding: {
            canonicalRoot,
            knownCanonicalRoot: canonicalRoot,
            availability: "available",
            bindingSuperseded: false,
          },
          relativePath,
        });
        if (resolution.status !== "resolved-for-create") {
          return {
            status: "refused",
            reason: "The save path is outside the Project.",
          } satisfies ImageGenerationSaveResult;
        }
        const written = await writeConfinedWorkFile({
          filesystem: liveWorkFilesystem,
          canonicalPath: resolution.absolutePath,
          allowCreate: true,
          parent: {
            absolutePath: resolution.parentAbsolute,
            identity: resolution.parentIdentity,
            remaining: resolution.remaining,
          },
          bytes: input.bytes,
        });
        if (!written) {
          return {
            status: "failed",
            reason: "The image could not be saved.",
          } satisfies ImageGenerationSaveResult;
        }
        return { status: "saved", relativePath: resolution.relativePath };
      } catch {
        return {
          status: "failed",
          reason: "The image could not be saved.",
        } satisfies ImageGenerationSaveResult;
      }
    },
    windowAuthorityStore,
  });
  // Work research. Sources are observed read-only through the
  // confined filesystem port, so a brief can only cite files inside the
  // approved Project root; kinds this host cannot re-read without egress
  // are reported unsupported rather than recorded as fresh.
  const workResearchProjection = new WorkResearchProjection();
  const workResearchService = new WorkResearchService({
    projection: workResearchProjection,
    eventStore: new WorkResearchEventStore({
      journal: persistence.journal,
      uuid: randomUUID,
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    }),
    sources: createWorkResearchSourcePort({
      filesystem: liveWorkFilesystem,
      resolveProjectRoot: (projectId) => {
        const project = persistence.readProject(projectId);
        if (project === undefined || project.type !== "work") return undefined;
        if (project.lifecycle !== "active") return undefined;
        return project.binding.canonicalRoot;
      },
    }),
    actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    clock: () => new Date().toISOString(),
  });
  // Hydration replays only `work-research` history, so unrelated journal
  // growth cannot abort it. If the research history itself outgrows the scan
  // bound the projection is not a faithful rebuild, so the routes report
  // research unavailable instead of serving a projection that would read as
  // "you have no briefs" and answer mutations on durable briefs as missing.
  const workResearchProjectionRebuilt =
    workResearchService.hydrate().status !== "snapshot-required";
  if (!workResearchProjectionRebuilt) {
    console.warn(
      "Work research projection requires a snapshot; research reports unavailable on this host.",
    );
  }
  const workResearchRoutes = createWorkResearchRouteHandler({
    service: workResearchService,
    projection: workResearchProjection,
    projectionRebuilt: () => workResearchProjectionRebuilt,
    persistence,
    projects: projectService,
    windowAuthorityStore,
    maxJsonBodySize: MAX_JSON_REQUEST_BODY_SIZE,
  });
  const previewService = new PreviewService({
    hostId: previewHostId,
    budget: {
      maxSniffBytes: 4096,
      maxByteSize: 8 * 1024 * 1024,
      maxRenderBytes: 4 * 1024 * 1024,
    },
    textBudget: { maxLinesPerChunk: 200, maxBytesPerChunk: 64 * 1024 },
    targetResolver: {
      async resolve({ projectId, opaqueRef, kind }) {
        // An ordinary file in a Work Project's bound folder, opened from the
        // Files tool. The token was minted by the listing that showed it, so
        // the renderer never names a path; a token this host does not know
        // resolves to nothing rather than to a guess.
        if (kind === "file") {
          const relativePath = workFilePreviewRefs.resolve(projectId, opaqueRef);
          if (relativePath === undefined) return { ok: false, code: "not-found" };
          return { ok: true, relativePath, displayName: relativePath };
        }
        if (kind !== "artifact-version") return { ok: false, code: "not-found" };
        for (const entry of workArtifactProjection.snapshot().values()) {
          if (entry.projectId === projectId && entry.artifactRef === opaqueRef && !entry.deleted) {
            return {
              ok: true,
              relativePath: entry.relativePath,
              displayName: entry.displayName,
            };
          }
        }
        return { ok: false, code: "not-found" };
      },
    },
    projectRootResolver: {
      async resolve(id) {
        const project = persistence.readProject(id);
        if (project === undefined || project.type === "chat" || project.lifecycle !== "active") {
          return { ok: false, code: "unavailable" };
        }
        return { ok: true, canonicalRoot: project.binding.canonicalRoot };
      },
    },
  });
  const previewRouteDependencies = {
    service: previewService,
    windowAuthorityStore,
    projects: projectService,
    activeContextResolver: (windowId: WindowId) =>
      resolvePreviewActiveContext(shellService.bootstrap(windowId)),
    // Plan mode is a Code-thread execution policy: hide and server-enforce
    // every host handoff flag for plan-mode threads so Finder reveal,
    // Quick Look, and open-external can never be commanded from a read-only
    // thread even when a renderer capability flag slipped through.
    postureResolver: (windowId: WindowId, _projectId: ProjectId): PreviewPosture => {
      const activeContext = resolvePreviewActiveContext(shellService.bootstrap(windowId));
      if (activeContext.mode !== "code" || activeContext.activeThreadId === undefined) {
        return "approval-gated";
      }
      const thread = persistence.readCodeThread(activeContext.activeThreadId);
      if (thread === undefined) return "approval-gated";
      if (thread.executionPolicy === "plan") return "plan";
      if (thread.executionPolicy === "full-access") return "full";
      return "approval-gated";
    },
    hostId: previewHostId,
    maxJsonBodySize: MAX_JSON_REQUEST_BODY_SIZE,
  };
  const previewRoutes = createPreviewRouteHandler(previewRouteDependencies);
  const previewHandoffBridgeRoutes = createPreviewHandoffBridgeRouteHandler({
    desktopBridgeSecret: options.desktopBridgeSecret,
    resolve: async ({ windowId, target, kind, signal }) => {
      const authority = await resolvePreviewAuthority(previewRouteDependencies, windowId, target);
      if (authority.kind !== "ok") {
        return { kind: "unauthorized", targetId: target.targetId };
      }
      // The desktop bridge is always the local host, but the handoff still
      // re-runs the full preview authority (mode/Project/thread/posture) and
      // resolves the opaque ref to the confined path before the native
      // executor touches the filesystem.
      return previewService.handoff({
        authority: authority.context,
        principalKind: "local-window",
        target,
        kind,
        ...(signal === undefined ? {} : { signal }),
      });
    },
  });
  return {
    imageRoutes,
    previewHandoffBridgeRoutes,
    previewRoutes,
    speechRoutes,
    workFileListingRoutes,
    workFileListingService,
    workMutationRoutes,
    workResearchProjection,
    workResearchRoutes,
  };
}

export type WorkFilesWiring = ReturnType<typeof wireWorkFiles>;
