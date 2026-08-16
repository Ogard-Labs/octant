import {
  decodeCanvasActionResult,
  decodeCanvasGetOutcome,
  decodeCanvasHistoryOutcome,
  decodeCanvasId,
  decodeCanvasInventoryList,
  decodeCanvasOriginThreadId,
  decodeCanvasThreadReferenceCardsOutcome,
  decodeCanvasCreateResult,
  decodeCanvasReviseResult,
  decodeCanvasRefreshResult,
  decodeCanvasShareAccessResult,
  decodeCanvasShareOverview,
  decodeCanvasShareResult,
  decodeCanvasVersionId,
  decodeProjectId,
  type CanvasGetOutcome,
  type CanvasInventoryEntry,
  type ProjectId,
  type ShellBootstrap,
  type WindowId,
} from "@octant/contracts";
import {
  authorizeCanvasInventoryAccess,
  filterCanvasInventoryEntries,
  projectInventoryEntryFromProjection,
} from "@octant/domain";
import type { CanvasService } from "./canvas/canvasService";
import type { CanvasShareService } from "./canvas/canvasShareService";
import type { CanvasProjection, CanvasProjectionEntry } from "./canvas/canvasProjection";
import type { ClientPrincipal } from "./clientPrincipal";
import { authenticateRouteWindowId, readPrincipalRouteContext } from "./principalRouteContext";
import { isLoopbackHostname } from "./shellRoutes";
import type { ProjectService } from "./projectService";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const BODY_LIMIT = 1_048_576;

export interface CanvasRouteDependencies {
  readonly canvasProjection: CanvasProjection;
  readonly canvasService: CanvasService;
  /**
   * Canvas sharing authority. A host that cannot journal shares serves no share
   * surface at all rather than a surface whose revocation would be decorative.
   */
  readonly canvasShareService?: CanvasShareService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly projects: Pick<ProjectService, "bootstrap">;
  readonly activeContextResolver: (
    windowId: WindowId,
  ) => CanvasActiveContext | undefined | Promise<CanvasActiveContext | undefined>;
  readonly now?: () => number;
}

export interface CanvasActiveContext {
  readonly mode: ShellBootstrap["workspace"]["activeMode"];
  readonly projectId: ProjectId | null;
}

export function resolveCanvasActiveContext(bootstrap: ShellBootstrap): CanvasActiveContext {
  const { workspace } = bootstrap;
  const mode = workspace.activeMode;
  return { mode, projectId: workspace.contextByMode[mode].projectId };
}

export function createCanvasRouteHandler(dependencies: CanvasRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/canvas/")) return undefined;
    const route = url.pathname.slice("/api/canvas/".length);
    if (
      route !== "inventory" &&
      route !== "get" &&
      route !== "history" &&
      route !== "revise" &&
      route !== "refresh" &&
      route !== "refresh-cancel" &&
      route !== "action" &&
      route !== "action-cancel" &&
      route !== "create" &&
      route !== "share" &&
      route !== "share-revoke" &&
      route !== "share-access" &&
      route !== "thread-reference-cards"
    ) {
      return undefined;
    }

    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failureResponse("Canvas API requests must use loopback.", 400, null);
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failureResponse("Renderer origin is not allowed.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
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
        return failureResponse("Canvas request is unauthorized.", 401, origin);
      }
      return failureResponse("Canvas request is invalid.", 400, origin);
    }
    const principal = requestPrincipal(request, authenticatedWindowId);

    try {
      if (route === "inventory" && request.method === "GET") {
        if (![...url.searchParams.keys()].every((key) => key === "projectId" || key === "query")) {
          return failureResponse("Canvas inventory request is invalid.", 400, origin);
        }
        let projectId: ProjectId;
        try {
          projectId = decodeProjectId(url.searchParams.get("projectId") ?? "");
        } catch {
          return failureResponse("Project ID is invalid.", 400, origin);
        }
        const query = url.searchParams.get("query") ?? undefined;
        const authority = await resolveInventoryAuthority(
          dependencies,
          authenticatedWindowId,
          projectId,
        );
        if (authority.kind !== "ok") {
          return jsonResponse(decodeCanvasInventoryList({ projectId, entries: [] }), 200, origin);
        }
        const entries = inventoryEntriesForProject(
          dependencies.canvasProjection,
          projectId,
          authority.mode,
        );
        const filtered = filterCanvasInventoryEntries(entries, query);
        return jsonResponse(
          decodeCanvasInventoryList({ projectId, entries: filtered }),
          200,
          origin,
        );
      }

      if (route === "get" && request.method === "GET") {
        if (!url.searchParams.has("canvasId")) {
          return failureResponse("Canvas get request is invalid.", 400, origin);
        }
        const keys = [...url.searchParams.keys()];
        if (!keys.every((key) => key === "canvasId" || key === "versionId")) {
          return failureResponse("Canvas get request is invalid.", 400, origin);
        }
        let canvasId;
        try {
          canvasId = decodeCanvasId(url.searchParams.get("canvasId") ?? "");
        } catch {
          return failureResponse("Canvas ID is invalid.", 400, origin);
        }
        let versionId: ReturnType<typeof decodeCanvasVersionId> | undefined;
        if (url.searchParams.has("versionId")) {
          try {
            versionId = decodeCanvasVersionId(url.searchParams.get("versionId") ?? "");
          } catch {
            return failureResponse("Canvas version ID is invalid.", 400, origin);
          }
        }
        const outcome = await resolveCanvasGet(
          dependencies,
          authenticatedWindowId,
          canvasId,
          versionId,
        );
        return jsonResponse(decodeCanvasGetOutcome(outcome), 200, origin);
      }

      if (route === "history" && request.method === "GET") {
        if (url.searchParams.size !== 1 || !url.searchParams.has("canvasId")) {
          return failureResponse("Canvas history request is invalid.", 400, origin);
        }
        let canvasId;
        try {
          canvasId = decodeCanvasId(url.searchParams.get("canvasId") ?? "");
        } catch {
          return failureResponse("Canvas ID is invalid.", 400, origin);
        }
        const context = await resolveAuthorizedContext(
          dependencies,
          authenticatedWindowId,
          canvasId,
        );
        if (context.kind === "unauthorized") {
          return jsonResponse(
            decodeCanvasHistoryOutcome({ kind: "unauthorized", canvasId }),
            200,
            origin,
          );
        }
        if (context.kind === "unavailable") {
          return jsonResponse(
            decodeCanvasHistoryOutcome({
              kind: "unavailable",
              canvasId,
              reason: context.reason,
            }),
            200,
            origin,
          );
        }
        const outcome = dependencies.canvasService.history(
          canvasId,
          {
            mode: context.activeContext.mode,
            projectId:
              context.activeContext.projectId === null
                ? null
                : String(context.activeContext.projectId),
          },
          context.project,
        );
        return jsonResponse(decodeCanvasHistoryOutcome(outcome), 200, origin);
      }

      if (route === "revise" && request.method === "POST") {
        const body = await readJson(request);
        if (body.kind === "too-large") {
          return failureResponse("Canvas revise request is too large.", 413, origin);
        }
        if (body.kind === "invalid") {
          return failureResponse("Canvas revise request is invalid.", 400, origin);
        }
        let canvasId;
        try {
          canvasId = decodeCanvasId(
            (body.value as { canvasId?: unknown }).canvasId ??
              (() => {
                throw new Error("missing");
              })(),
          );
        } catch {
          return jsonResponse(
            decodeCanvasReviseResult({
              kind: "denied",
              denialCode: "malformed-request",
              message: "Canvas revise request is malformed.",
            }),
            200,
            origin,
          );
        }
        const context = await resolveAuthorizedContext(
          dependencies,
          authenticatedWindowId,
          canvasId,
        );
        if (context.kind === "unauthorized") {
          return jsonResponse(
            decodeCanvasReviseResult({
              kind: "denied",
              denialCode: "unauthorized",
              message: "Canvas revise is not authorized in this workspace.",
            }),
            200,
            origin,
          );
        }
        if (context.kind === "unavailable") {
          return jsonResponse(
            decodeCanvasReviseResult({
              kind: "denied",
              denialCode: "unavailable",
              message: context.reason,
            }),
            200,
            origin,
          );
        }
        const result = dependencies.canvasService.revise(
          body.value,
          {
            mode: context.activeContext.mode,
            projectId:
              context.activeContext.projectId === null
                ? null
                : String(context.activeContext.projectId),
          },
          context.project,
        );
        return jsonResponse(decodeCanvasReviseResult(result), 200, origin);
      }

      if ((route === "refresh" || route === "refresh-cancel") && request.method === "POST") {
        const body = await readJson(request);
        if (body.kind === "too-large" || body.kind === "invalid") {
          return jsonResponse(
            decodeCanvasRefreshResult({
              kind: "denied",
              denialCode: "malformed-request",
              message: "Canvas refresh request is malformed.",
            }),
            200,
            origin,
          );
        }
        let canvasId;
        try {
          canvasId = decodeCanvasId((body.value as { canvasId?: unknown }).canvasId ?? "");
        } catch {
          return jsonResponse(
            decodeCanvasRefreshResult({
              kind: "denied",
              denialCode: "malformed-request",
              message: "Canvas refresh request is malformed.",
            }),
            200,
            origin,
          );
        }
        const context = await resolveAuthorizedContext(
          dependencies,
          authenticatedWindowId,
          canvasId,
        );
        if (context.kind === "unauthorized") {
          return jsonResponse(
            decodeCanvasRefreshResult({
              kind: "denied",
              denialCode: "unauthorized",
              message: "Canvas refresh is not authorized in this workspace.",
            }),
            200,
            origin,
          );
        }
        if (context.kind === "unavailable") {
          return jsonResponse(
            decodeCanvasRefreshResult({
              kind: "denied",
              denialCode: "unavailable",
              message: context.reason,
            }),
            200,
            origin,
          );
        }
        const result =
          route === "refresh"
            ? await dependencies.canvasService.refresh(
                body.value,
                {
                  mode: context.activeContext.mode,
                  projectId:
                    context.activeContext.projectId === null
                      ? null
                      : String(context.activeContext.projectId),
                },
                context.project,
              )
            : await dependencies.canvasService.cancelRefresh(body.value);
        return jsonResponse(decodeCanvasRefreshResult(result), 200, origin);
      }

      if ((route === "action" || route === "action-cancel") && request.method === "POST") {
        const body = await readJson(request);
        if (body.kind === "too-large" || body.kind === "invalid") {
          return jsonResponse(
            decodeCanvasActionResult({
              kind: "denied",
              denialCode: "malformed-request",
              message: "Canvas action request is malformed.",
            }),
            200,
            origin,
          );
        }
        let canvasId;
        try {
          canvasId = decodeCanvasId((body.value as { canvasId?: unknown }).canvasId ?? "");
        } catch {
          return jsonResponse(
            decodeCanvasActionResult({
              kind: "denied",
              denialCode: "malformed-request",
              message: "Canvas action request is malformed.",
            }),
            200,
            origin,
          );
        }
        const context = await resolveAuthorizedContext(
          dependencies,
          authenticatedWindowId,
          canvasId,
        );
        if (context.kind === "unauthorized") {
          return jsonResponse(
            decodeCanvasActionResult({
              kind: "denied",
              denialCode: "unauthorized",
              message: "Canvas action is not authorized in this workspace.",
            }),
            200,
            origin,
          );
        }
        if (context.kind === "unavailable") {
          return jsonResponse(
            decodeCanvasActionResult({
              kind: "denied",
              denialCode: "unavailable",
              message: context.reason,
            }),
            200,
            origin,
          );
        }
        const result =
          route === "action"
            ? await dependencies.canvasService.executeAction(
                body.value,
                {
                  mode: context.activeContext.mode,
                  projectId:
                    context.activeContext.projectId === null
                      ? null
                      : String(context.activeContext.projectId),
                },
                context.project,
              )
            : await dependencies.canvasService.cancelAction(body.value);
        return jsonResponse(decodeCanvasActionResult(result), 200, origin);
      }

      if (route === "create" && request.method === "POST") {
        const body = await readJson(request);
        if (body.kind === "too-large") {
          return jsonResponse(
            decodeCanvasCreateResult({
              kind: "denied",
              denialCode: "malformed-request",
              message: "Canvas create request is too large.",
            }),
            200,
            origin,
          );
        }
        if (body.kind === "invalid") {
          return jsonResponse(
            decodeCanvasCreateResult({
              kind: "denied",
              denialCode: "malformed-request",
              message: "Canvas create request is malformed.",
            }),
            200,
            origin,
          );
        }
        const context = await resolveCreateContext(dependencies, authenticatedWindowId);
        if (context.kind === "unauthorized") {
          return jsonResponse(
            decodeCanvasCreateResult({
              kind: "denied",
              denialCode: "unauthorized",
              message: "Canvas create is not authorized in this workspace.",
            }),
            200,
            origin,
          );
        }
        if (context.kind === "unavailable") {
          return jsonResponse(
            decodeCanvasCreateResult({
              kind: "denied",
              denialCode: "unavailable",
              message: context.reason,
            }),
            200,
            origin,
          );
        }
        const result = dependencies.canvasService.create(
          body.value,
          {
            mode: context.activeContext.mode,
            projectId:
              context.activeContext.projectId === null
                ? null
                : String(context.activeContext.projectId),
          },
          context.project,
        );
        return jsonResponse(decodeCanvasCreateResult(result), 200, origin);
      }

      if (route === "share" && request.method === "GET") {
        const shareService = dependencies.canvasShareService;
        if (shareService === undefined) {
          return failureResponse("Canvas sharing is unavailable on this host.", 404, origin);
        }
        if (url.searchParams.size !== 1 || !url.searchParams.has("canvasId")) {
          return failureResponse("Canvas share request is invalid.", 400, origin);
        }
        let canvasId;
        try {
          canvasId = decodeCanvasId(url.searchParams.get("canvasId") ?? "");
        } catch {
          return failureResponse("Canvas ID is invalid.", 400, origin);
        }
        const context = await resolveAuthorizedContext(
          dependencies,
          authenticatedWindowId,
          canvasId,
        );
        if (context.kind !== "ok") {
          return failureResponse(
            "Canvas sharing is not available for this canvas.",
            context.kind === "unauthorized" ? 403 : 404,
            origin,
          );
        }
        const overview = shareService.overview(
          canvasId,
          {
            mode: context.activeContext.mode,
            projectId:
              context.activeContext.projectId === null
                ? null
                : String(context.activeContext.projectId),
          },
          context.project,
        );
        if (overview === undefined) {
          return failureResponse("Canvas sharing is not authorized for this canvas.", 403, origin);
        }
        return jsonResponse(decodeCanvasShareOverview(overview), 200, origin);
      }

      if ((route === "share" || route === "share-revoke") && request.method === "POST") {
        const shareService = dependencies.canvasShareService;
        if (shareService === undefined) {
          return jsonResponse(
            decodeCanvasShareResult({
              kind: "denied",
              denialCode: "unavailable",
              message: "Canvas sharing is unavailable on this host.",
            }),
            200,
            origin,
          );
        }
        const body = await readJson(request);
        if (body.kind === "too-large" || body.kind === "invalid") {
          return jsonResponse(
            decodeCanvasShareResult({
              kind: "denied",
              denialCode: "malformed-request",
              message: "Canvas share request is malformed.",
            }),
            200,
            origin,
          );
        }
        let canvasId;
        try {
          canvasId = decodeCanvasId((body.value as { canvasId?: unknown }).canvasId ?? "");
        } catch {
          return jsonResponse(
            decodeCanvasShareResult({
              kind: "denied",
              denialCode: "malformed-request",
              message: "Canvas share request is malformed.",
            }),
            200,
            origin,
          );
        }
        const context = await resolveAuthorizedContext(
          dependencies,
          authenticatedWindowId,
          canvasId,
        );
        if (context.kind !== "ok") {
          return jsonResponse(
            decodeCanvasShareResult({
              kind: "denied",
              denialCode: context.kind === "unauthorized" ? "unauthorized" : "unavailable",
              message:
                context.kind === "unauthorized"
                  ? "Canvas sharing is not authorized in this workspace."
                  : context.reason,
            }),
            200,
            origin,
          );
        }
        const authorizationContext = {
          mode: context.activeContext.mode,
          projectId:
            context.activeContext.projectId === null
              ? null
              : String(context.activeContext.projectId),
        };
        const result =
          route === "share"
            ? shareService.share(body.value, authorizationContext, context.project, principal)
            : shareService.revoke(body.value, authorizationContext, context.project, principal);
        return jsonResponse(decodeCanvasShareResult(result), 200, origin);
      }

      if (route === "share-access" && request.method === "POST") {
        const shareService = dependencies.canvasShareService;
        if (shareService === undefined) {
          return jsonResponse(
            decodeCanvasShareAccessResult({
              kind: "unavailable",
              denialCode: "unavailable",
              message: "Canvas sharing is unavailable on this host.",
            }),
            200,
            origin,
          );
        }
        const body = await readJson(request);
        if (body.kind === "too-large" || body.kind === "invalid") {
          return jsonResponse(
            decodeCanvasShareAccessResult({
              kind: "unavailable",
              denialCode: "malformed-request",
              message: "Canvas share access request is malformed.",
            }),
            200,
            origin,
          );
        }
        // A snapshot is authorized by its own audience and lifecycle, not by the
        // reader's current Canvas authority, and it serves only the sanitized
        // document already admitted when the share was created. The audience is
        // evaluated against the transport principal this host authenticated, so
        // a paired device is decided and journaled as that device. The raw
        // user-agent stops here: policy reduces it to a coarse browser family.
        const userAgent = request.headers.get("user-agent");
        const result = shareService.access({
          request: body.value,
          principal,
          ...(userAgent === null ? {} : { userAgent }),
        });
        return jsonResponse(decodeCanvasShareAccessResult(result), 200, origin);
      }

      if (route === "thread-reference-cards" && request.method === "GET") {
        const keys = [...url.searchParams.keys()];
        if (
          keys.length !== 3 ||
          !keys.includes("mode") ||
          !keys.includes("threadId") ||
          !keys.includes("projectId")
        ) {
          return failureResponse("Canvas thread card request is invalid.", 400, origin);
        }
        const mode = url.searchParams.get("mode");
        const threadId = url.searchParams.get("threadId") ?? "";
        const projectParam = url.searchParams.get("projectId");
        if (mode !== "chat" && mode !== "work" && mode !== "code") {
          return failureResponse("Canvas thread card mode is invalid.", 400, origin);
        }
        try {
          decodeCanvasOriginThreadId(threadId);
        } catch {
          return failureResponse("Canvas thread ID is invalid.", 400, origin);
        }
        let projectId: ProjectId | null;
        if (projectParam === "null") {
          projectId = null;
        } else {
          try {
            projectId = decodeProjectId(projectParam ?? "");
          } catch {
            return failureResponse("Canvas Project ID is invalid.", 400, origin);
          }
        }
        const cards = await resolveThreadReferenceCards(
          dependencies,
          authenticatedWindowId,
          mode,
          threadId,
          projectId,
        );
        return jsonResponse(
          decodeCanvasThreadReferenceCardsOutcome({
            mode,
            threadId,
            projectId,
            cards,
          }),
          200,
          origin,
        );
      }

      return failureResponse("Canvas request is invalid.", 400, origin);
    } catch {
      return failureResponse("Canvas request is invalid.", 400, origin);
    }
  };
}

type InventoryAuthority =
  | { readonly kind: "ok"; readonly mode: CanvasActiveContext["mode"] }
  | { readonly kind: "denied" };

type AuthorizedCanvasContext =
  | {
      readonly kind: "ok";
      readonly activeContext: CanvasActiveContext;
      readonly project: {
        readonly id: string;
        readonly type: "chat" | "work" | "code";
        readonly lifecycle: "active" | "archived";
      };
    }
  | { readonly kind: "unauthorized" }
  | { readonly kind: "unavailable"; readonly reason: string };

async function resolveInventoryAuthority(
  dependencies: CanvasRouteDependencies,
  windowId: WindowId,
  projectId: ProjectId,
): Promise<InventoryAuthority> {
  let activeContext: CanvasActiveContext | undefined;
  try {
    activeContext = await dependencies.activeContextResolver(windowId);
  } catch {
    return { kind: "denied" };
  }
  if (activeContext === undefined || activeContext.projectId === null) return { kind: "denied" };
  const bootstrap = await dependencies.projects.bootstrap(windowId);
  const project = bootstrap.active.find((candidate) => candidate.id === projectId);
  if (project === undefined || project.lifecycle !== "active") return { kind: "denied" };
  if (
    !authorizeCanvasInventoryAccess({
      requestedProjectId: projectId,
      activeProjectId: activeContext.projectId,
      activeMode: activeContext.mode,
      projectMode: project.type,
    })
  ) {
    return { kind: "denied" };
  }
  return { kind: "ok", mode: project.type };
}

async function resolveCreateContext(
  dependencies: CanvasRouteDependencies,
  windowId: WindowId,
): Promise<AuthorizedCanvasContext> {
  let activeContext: CanvasActiveContext | undefined;
  try {
    activeContext = await dependencies.activeContextResolver(windowId);
  } catch {
    return { kind: "unauthorized" };
  }
  if (activeContext === undefined || activeContext.projectId === null) {
    return { kind: "unauthorized" };
  }
  const bootstrap = await dependencies.projects.bootstrap(windowId);
  const project = bootstrap.active.find((candidate) => candidate.id === activeContext.projectId);
  if (project === undefined || project.lifecycle !== "active") {
    return { kind: "unavailable", reason: "The active Canvas Project is unavailable." };
  }
  if (project.type !== activeContext.mode) return { kind: "unauthorized" };
  return {
    kind: "ok",
    activeContext,
    project: {
      id: String(project.id),
      type: project.type,
      lifecycle: project.lifecycle,
    },
  };
}

async function resolveThreadReferenceCards(
  dependencies: CanvasRouteDependencies,
  windowId: WindowId,
  mode: CanvasActiveContext["mode"],
  threadId: string,
  projectId: ProjectId | null,
) {
  if (projectId === null) return [];
  const authority = await resolveInventoryAuthority(dependencies, windowId, projectId);
  if (authority.kind !== "ok" || authority.mode !== mode) return [];
  return dependencies.canvasService.threadReferenceCards({
    mode,
    threadId,
    projectId: String(projectId),
  });
}

async function resolveAuthorizedContext(
  dependencies: CanvasRouteDependencies,
  windowId: WindowId,
  canvasId: ReturnType<typeof decodeCanvasId>,
): Promise<AuthorizedCanvasContext> {
  const entry = dependencies.canvasProjection.getById(canvasId);
  if (entry === undefined) {
    return {
      kind: "unavailable",
      reason: "Canvas is unavailable. Reopen it from the Project.",
    };
  }
  let activeContext: CanvasActiveContext | undefined;
  try {
    activeContext = await dependencies.activeContextResolver(windowId);
  } catch {
    return { kind: "unauthorized" };
  }
  if (activeContext === undefined || activeContext.projectId === null) {
    return { kind: "unauthorized" };
  }
  const bootstrap = await dependencies.projects.bootstrap(windowId);
  const project = bootstrap.active.find(
    (candidate) => candidate.id === entry.currentVersion.definition.provenance.projectId,
  );
  if (project === undefined || project.lifecycle !== "active") {
    return {
      kind: "unavailable",
      reason: "Canvas is unavailable. Reopen it from the Project.",
    };
  }
  const provenance = entry.currentVersion.definition.provenance;
  if (
    !authorizeCanvasInventoryAccess({
      requestedProjectId: provenance.projectId,
      activeProjectId: activeContext.projectId,
      activeMode: activeContext.mode,
      projectMode: project.type,
    }) ||
    provenance.mode !== project.type
  ) {
    return { kind: "unauthorized" };
  }
  return {
    kind: "ok",
    activeContext,
    project: {
      id: String(project.id),
      type: project.type,
      lifecycle: project.lifecycle,
    },
  };
}

function inventoryEntriesForProject(
  projection: CanvasProjection,
  projectId: ProjectId,
  mode: CanvasActiveContext["mode"],
): ReadonlyArray<CanvasInventoryEntry> {
  return projection
    .byProject(projectId)
    .filter((entry) => entry.currentVersion.definition.provenance.mode === mode)
    .map(toInventoryEntry);
}

async function resolveCanvasGet(
  dependencies: CanvasRouteDependencies,
  windowId: WindowId,
  canvasId: ReturnType<typeof decodeCanvasId>,
  versionId?: ReturnType<typeof decodeCanvasVersionId>,
): Promise<CanvasGetOutcome> {
  const context = await resolveAuthorizedContext(dependencies, windowId, canvasId);
  if (context.kind === "unauthorized") {
    return { kind: "unauthorized", canvasId };
  }
  if (context.kind === "unavailable") {
    return { kind: "unavailable", canvasId, reason: context.reason };
  }
  return dependencies.canvasService.get(
    canvasId,
    {
      mode: context.activeContext.mode,
      projectId:
        context.activeContext.projectId === null ? null : String(context.activeContext.projectId),
    },
    context.project,
    versionId,
  );
}

function toInventoryEntry(entry: CanvasProjectionEntry): CanvasInventoryEntry {
  const version = entry.currentVersion;
  const provenance = version.definition.provenance;
  return projectInventoryEntryFromProjection({
    canvasId: entry.canvasId,
    projectId: provenance.projectId,
    mode: provenance.mode,
    title: version.definition.title,
    versionCount: entry.versionCount,
    currentVersionId: version.versionId,
    currentSequence: version.sequence,
    updatedAt: entry.updatedAt,
  });
}

/**
 * The transport principal is authoritative. A request the remote gateway
 * authenticated carries a bound remote-device principal and stays that device,
 * so the share audience is evaluated and journaled against the device rather
 * than this host's user. Anything without a bound context reached this handler
 * on the loopback listener under a proven window capability.
 */
function requestPrincipal(request: Request, authenticatedWindowId: WindowId): ClientPrincipal {
  const bound = readPrincipalRouteContext(request)?.principal;
  if (bound !== undefined) return bound;
  return {
    kind: "local-window",
    windowId: String(authenticatedWindowId),
    capabilityGeneration: 0,
  };
}

async function readJson(
  request: Request,
): Promise<
  | { readonly kind: "ok"; readonly value: unknown }
  | { readonly kind: "invalid" }
  | { readonly kind: "too-large" }
> {
  const raw = await request.arrayBuffer();
  if (raw.byteLength > BODY_LIMIT) return { kind: "too-large" };
  try {
    return { kind: "ok", value: JSON.parse(new TextDecoder().decode(raw)) as unknown };
  } catch {
    return { kind: "invalid" };
  }
}

function jsonResponse(value: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...corsHeaders(origin),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function failureResponse(message: string, status: number, origin: string | null): Response {
  return jsonResponse({ category: "invalid", message }, status, origin);
}

function corsHeaders(origin: string | null): Record<string, string> {
  return origin === null
    ? {}
    : {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": METHODS,
        "access-control-allow-headers": HEADERS,
      };
}

function isAllowedOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}
