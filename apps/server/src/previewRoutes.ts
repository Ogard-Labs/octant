import {
  decodePreviewCancelReply,
  decodePreviewChunksReply,
  decodePreviewChunksRequest,
  decodePreviewCancelRequest,
  decodePreviewHandoffReply,
  decodePreviewHandoffRequest,
  decodePreviewOpenRequest,
  decodePreviewOutcome,
  decodePreviewRefreshRequest,
  type PreviewCancelReply,
  type PreviewChunksReply,
  type PreviewHandoffReply,
  type PreviewOutcome,
  type PreviewTarget,
} from "@octant/contracts/previews";
import type { ProjectId } from "@octant/contracts/projects";
import type {
  CodeThreadId,
  OctantMode,
  ShellBootstrap,
  WindowId,
  WorkspaceLayoutNode,
} from "@octant/contracts";
import type { PreviewPosture } from "@octant/domain";
import { authenticateRouteWindowId, readPrincipalRouteContext } from "./principalRouteContext";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";
import type { ProjectService } from "./projectService";
import type { PreviewAuthorityContext, PreviewService } from "./preview/previewService";

const JSON_BODY_LIMIT = 1_048_576;
const METHODS = "POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";

export interface PreviewRouteDependencies {
  readonly service: PreviewService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly projects: Pick<ProjectService, "bootstrap">;
  readonly activeContextResolver: (
    windowId: WindowId,
  ) => PreviewActiveContext | undefined | Promise<PreviewActiveContext | undefined>;
  readonly hostId: PreviewAuthorityContext["activeHostId"];
  readonly postureResolver?: (
    windowId: WindowId,
    projectId: ProjectId,
  ) => PreviewPosture | Promise<PreviewPosture>;
  readonly maxJsonBodySize?: number;
  readonly now?: () => number;
}

export interface PreviewActiveContext {
  readonly mode: OctantMode;
  readonly projectId: ProjectId | null;
  readonly activeThreadId?: CodeThreadId;
}

/** Resolve the authoritative active Project and Code thread from the shell workspace. */
export function resolvePreviewActiveContext(bootstrap: ShellBootstrap): PreviewActiveContext {
  const { workspace } = bootstrap;
  const mode = workspace.activeMode;
  const context = workspace.contextByMode[mode];
  const activeThreadId =
    mode === "code"
      ? findActiveCodeThreadId(workspace.layouts.code, workspace.activePaneIds.code)
      : undefined;
  return {
    mode,
    projectId: context.projectId,
    ...(activeThreadId === undefined ? {} : { activeThreadId }),
  };
}

function findActiveCodeThreadId(
  layout: WorkspaceLayoutNode,
  activePaneId: ShellBootstrap["workspace"]["activePaneIds"]["code"],
): CodeThreadId | undefined {
  if (layout.kind === "split") {
    return (
      findActiveCodeThreadId(layout.first, activePaneId) ??
      findActiveCodeThreadId(layout.second, activePaneId)
    );
  }
  if (layout.paneId !== activePaneId) return undefined;
  const surface = layout.surface;
  if (surface.kind !== "browser" && "threadId" in surface && surface.mode === "code") {
    return surface.threadId;
  }
  return undefined;
}

export function createPreviewRouteHandler(dependencies: PreviewRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  const jsonLimit = dependencies.maxJsonBodySize ?? JSON_BODY_LIMIT;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/preview/")) return undefined;
    const route = url.pathname.slice("/api/preview/".length);
    if (
      route !== "open" &&
      route !== "refresh" &&
      route !== "chunks" &&
      route !== "cancel" &&
      route !== "handoff"
    ) {
      return undefined;
    }
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failureResponse("Preview API requests must use loopback.", 400, null);
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failureResponse("Renderer origin is not allowed.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST" || url.search !== "") {
      return failureResponse("Preview request is invalid.", 400, origin);
    }

    let authenticatedWindowId: WindowId;
    try {
      authenticatedWindowId = authenticateRouteWindowId({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failureResponse("Preview request is unauthorized.", 401, origin);
      }
      return failureResponse("Preview request is invalid.", 400, origin);
    }

    const decoded = await readJson(request, jsonLimit);
    if (decoded.kind === "too-large") {
      return failureResponse("Preview request body is too large.", 413, origin);
    }
    if (decoded.kind === "invalid") {
      return failureResponse("Preview request body is invalid.", 400, origin);
    }

    try {
      if (route === "open") {
        const body = decodePreviewOpenRequest(decoded.value);
        const authority = await resolvePreviewAuthority(
          dependencies,
          authenticatedWindowId,
          body.target,
        );
        if (authority.kind !== "ok") {
          return jsonResponse(
            decodePreviewOutcome({ kind: "unauthorized", targetId: body.target.targetId }),
            200,
            origin,
          );
        }
        const outcome: PreviewOutcome = await dependencies.service.open({
          authority: authority.context,
          target: body.target,
          ...(body.knownVersion === undefined ? {} : { knownVersion: body.knownVersion }),
        });
        return jsonResponse(decodePreviewOutcome(outcome), 200, origin);
      }
      if (route === "refresh") {
        const body = decodePreviewRefreshRequest(decoded.value);
        const authority = await resolvePreviewAuthority(
          dependencies,
          authenticatedWindowId,
          body.target,
        );
        if (authority.kind !== "ok") {
          return jsonResponse(
            decodePreviewOutcome({ kind: "unauthorized", targetId: body.target.targetId }),
            200,
            origin,
          );
        }
        const outcome = await dependencies.service.refresh({
          authority: authority.context,
          target: body.target,
          knownVersion: body.knownVersion,
        });
        return jsonResponse(decodePreviewOutcome(outcome), 200, origin);
      }
      if (route === "chunks") {
        const body = decodePreviewChunksRequest(decoded.value);
        const authority = await resolvePreviewAuthority(
          dependencies,
          authenticatedWindowId,
          body.target,
        );
        if (authority.kind !== "ok") {
          return jsonResponse(
            decodePreviewChunksReply({ kind: "unauthorized", targetId: body.target.targetId }),
            200,
            origin,
          );
        }
        const reply: PreviewChunksReply = await dependencies.service.readChunks({
          authority: authority.context,
          target: body.target,
          sourceVersion: body.sourceVersion,
          afterSequence: body.afterSequence,
          ...(body.maxChunks === undefined ? {} : { maxChunks: body.maxChunks }),
          signal: request.signal,
        });
        return jsonResponse(decodePreviewChunksReply(reply), 200, origin);
      }
      if (route === "cancel") {
        const cancelBody = decodePreviewCancelRequest(decoded.value);
        const authority = await resolvePreviewAuthority(
          dependencies,
          authenticatedWindowId,
          cancelBody.target,
        );
        if (authority.kind !== "ok") {
          return jsonResponse(
            decodePreviewCancelReply({
              kind: "unauthorized",
              targetId: cancelBody.target.targetId,
            }),
            200,
            origin,
          );
        }
        const reply: PreviewCancelReply = await dependencies.service.cancel({
          authority: authority.context,
          target: cancelBody.target,
        });
        return jsonResponse(decodePreviewCancelReply(reply), 200, origin);
      }
      const body = decodePreviewHandoffRequest(decoded.value);
      const authority = await resolvePreviewAuthority(
        dependencies,
        authenticatedWindowId,
        body.target,
      );
      if (authority.kind !== "ok") {
        return jsonResponse(
          decodePreviewHandoffReply({
            kind: "unauthorized",
            targetId: body.target.targetId,
          }),
          200,
          origin,
        );
      }
      // The transport principal is authoritative: local-window requests are
      // resolved by the window authority store; the authenticated remote
      // gateway binds a remote-device principal. The domain policy fails
      // closed for remote principals before any host side effect.
      const principalKind = readPrincipalRouteContext(request)?.principal.kind ?? "local-window";
      const resolution = await dependencies.service.handoff({
        authority: authority.context,
        principalKind,
        target: body.target,
        kind: body.kind,
        signal: request.signal,
      });
      const handoffReply: PreviewHandoffReply =
        resolution.kind === "resolved"
          ? decodePreviewHandoffReply({
              kind: "done",
              handoffKind: resolution.handoffKind,
            })
          : resolution.kind === "unauthorized"
            ? decodePreviewHandoffReply({
                kind: "unauthorized",
                targetId: resolution.targetId,
              })
            : resolution.kind === "unavailable"
              ? decodePreviewHandoffReply({
                  kind: "unavailable",
                  target: resolution.target,
                })
              : decodePreviewHandoffReply({
                  kind: "failed",
                  reason: resolution.reason,
                  ...(resolution.message === undefined ? {} : { message: resolution.message }),
                });
      return jsonResponse(handoffReply, 200, origin);
    } catch {
      return failureResponse("Preview request is invalid.", 400, origin);
    }
  };
}

type AuthorityResolution =
  | { readonly kind: "ok"; readonly context: PreviewAuthorityContext }
  | { readonly kind: "unavailable" };

/**
 * Resolve the authoritative active Project/thread/posture context for an
 * authenticated window and a preview target. Shared by the renderer-facing
 * preview routes and the desktop preview-handoff bridge so both enforce the
 * same mode/Project/thread/posture authority before any host resolution.
 */
export async function resolvePreviewAuthority(
  dependencies: PreviewRouteDependencies,
  windowId: WindowId,
  target: PreviewTarget,
): Promise<AuthorityResolution> {
  let activeContext: PreviewActiveContext | undefined;
  try {
    activeContext = await dependencies.activeContextResolver(windowId);
  } catch {
    return { kind: "unavailable" };
  }
  if (activeContext?.projectId === null || activeContext?.projectId !== target.projectId) {
    return { kind: "unavailable" };
  }
  const bootstrap = await dependencies.projects.bootstrap(windowId);
  const project = bootstrap.active.find((candidate) => candidate.id === activeContext.projectId);
  if (project === undefined || project.type !== activeContext.mode) return { kind: "unavailable" };
  const posture =
    dependencies.postureResolver === undefined
      ? "approval-gated"
      : await dependencies.postureResolver(windowId, target.projectId);
  return {
    kind: "ok",
    context: {
      mode: project.type,
      projectType: project.type,
      activeProjectId: activeContext.projectId,
      activeHostId: dependencies.hostId,
      ...(activeContext.activeThreadId === undefined
        ? {}
        : { activeThreadId: activeContext.activeThreadId }),
      posture,
    },
  };
}

async function readJson(
  request: Request,
  maxBytes: number,
): Promise<{ kind: "ok"; value: unknown } | { kind: "invalid" } | { kind: "too-large" }> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) return { kind: "invalid" };
    if (BigInt(declared) > BigInt(maxBytes)) return { kind: "too-large" };
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) return { kind: "too-large" };
  try {
    return { kind: "ok", value: JSON.parse(text) };
  } catch {
    return { kind: "invalid" };
  }
}

function failureResponse(message: string, status: number, origin: string | null): Response {
  return jsonResponse({ message }, status, origin);
}

function jsonResponse(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(origin), "content-type": "application/json" },
  });
}

function corsHeaders(origin: string | null): HeadersInit {
  return {
    "access-control-allow-origin": origin ?? "null",
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    vary: "Origin",
  };
}

function isAllowedOrigin(origin: string): boolean {
  if (origin === "file://") return true;
  try {
    const parsed = new URL(origin);
    return (
      origin === parsed.origin &&
      parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost") &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}
