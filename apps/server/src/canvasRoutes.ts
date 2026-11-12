import { decodeCanvasDocumentRecipeCatalog } from "@octant/contracts/canvas-skill";
import type { DesignSystemList } from "@octant/contracts/design-systems";
import type { CanvasDesignSystem } from "@octant/contracts/canvas";
import { canvasMockupsTsx, canvasExportStem, importCanvasHtmlPage } from "@octant/domain";
import {
  type CanvasId,
  decodeCanvasActionResult,
  decodeCanvasBlockId,
  decodeCanvasDesignAssetsOutcome,
  decodeCanvasDesignRunOutcome,
  decodeCanvasDesignRunRequest,
  decodePublishedSnapshotRunOutcome,
  decodePublishedSnapshotRunRequest,
  type PublishedSnapshotRunOutcome,
  type PublishedSnapshotRunRequest,
  type ThreadPublishedSnapshot,
  decodeCanvasGetOutcome,
  decodeCanvasHistoryOutcome,
  decodeCanvasId,
  decodeCanvasInventoryList,
  decodeCanvasOriginThreadId,
  decodeCanvasThreadReferenceCardsOutcome,
  decodeCanvasCreateResult,
  decodeCanvasHtmlImportResult,
  CANVAS_HTML_IMPORT_MAX_BYTES,
  decodeCanvasCommentCommandResult,
  decodeCanvasCommentsOutcome,
  decodeCanvasDiagramLayoutReviseResult,
  decodeCanvasReviseResult,
  decodeCanvasRefreshResult,
  decodeCanvasExportDecideRequest,
  decodeCanvasExportDecideResult,
  decodeCanvasExportOfferList,
  decodeCanvasExportPrepareRequest,
  decodeCanvasExportPrepareResult,
  decodeCanvasShareAccessRequest,
  decodeCanvasShareAccessResult,
  type CanvasShareAccessRequest,
  decodeCanvasShareOverview,
  decodeCanvasShareResult,
  decodeCanvasVersionId,
  decodeProjectId,
  type CanvasDesignAssetResolution,
  type CanvasDesignAssetsOutcome,
  type CanvasDesignBlock,
  type CanvasDesignRunOutcome,
  type CanvasDesignRunRequest,
  type CanvasGetOutcome,
  type CanvasProvenance,
  type CanvasInventoryEntry,
  type ProjectId,
  type ShellBootstrap,
  type WindowId,
} from "@octant/contracts";
import {
  CANVAS_HTML_FILE_MAX_BYTES,
  canvasExportBodyByteLength,
  decodeCanvasHtmlFileRequest,
  decodeCanvasHtmlFileResult,
  type CanvasHtmlFileRequest,
  type CanvasHtmlFileResult,
} from "@octant/contracts/canvas-export";
import {
  decodeCanvasExportFolderCommand,
  decodeCanvasExportFolderResult,
  decodeCanvasExportFolderView,
  type CanvasExportFolderRefusalReason,
  type CanvasExportFolderScope,
} from "@octant/contracts/canvas-export-folder";
import {
  authorizeCanvasInventoryAccess,
  canvasExportPlannedName,
  filterCanvasInventoryEntries,
  projectInventoryEntryFromProjection,
} from "@octant/domain";
import { readableMockup, renderCanvasHtmlFile } from "./canvas/artifactDocumentRender";
import type { CanvasService } from "./canvas/canvasService";
import type { CanvasCommentService } from "./canvas/canvasCommentService";
import type { CanvasShareService } from "./canvas/canvasShareService";
import type { CanvasExportService } from "./canvas/canvasExportService";
import type { CanvasExportFolderService } from "./canvas/canvasExportFolderService";
import type { CanvasPublicShareService } from "./canvas/canvasPublicShareService";
import {
  decodeCanvasPublicLinkSettingsCommand,
  decodeCanvasPublicLinkSettingsResult,
  decodeCanvasPublicShareRevokeRequest,
  decodeCanvasPublicShareRevokeResult,
} from "@octant/contracts/canvas-public-share";
import { canvasExportEventActor } from "./canvas/canvasExportActor";
import {
  canvasDesignPageHeaders,
  canvasDesignPageNetworkBase,
  canvasDesignPagePath,
  canvasDesignPageRefusal,
  issueSharedDesignRun,
  renderCanvasDesignPage,
  type CanvasDesignRunTickets,
} from "./canvas/canvasDesignPage";
import type { CanvasNetworkAccessService } from "./canvas/canvasNetworkAccessService";
import { canvasNetworkProxyResponse, type CanvasNetworkProxy } from "./canvas/canvasNetworkProxy";
import {
  CANVAS_NETWORK_PROXY_PATH_PREFIX,
  decodeCanvasNetworkAccessCommand,
  decodeCanvasNetworkAccessResult,
  decodeCanvasNetworkAccessView,
  type CanvasNetworkAccessRefusalReason,
} from "@octant/contracts/canvas-network";
import { OCTANT_LOCAL_ACTOR_ID } from "./shellService";
import type { CanvasProjection, CanvasProjectionEntry } from "./canvas/canvasProjection";
import type { ClientPrincipal } from "./clientPrincipal";
import { authenticateRouteWindowId, readPrincipalRouteContext } from "./principalRouteContext";
import { isLoopbackHostname } from "./shellRoutes";
import type { ProjectService } from "./projectService";
import type { ThreadReadAuthority } from "./threadReadAuthority";
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
  /** Destination export. Absent when the host cannot journal an export. */
  readonly canvasExportService?: CanvasExportService;
  /**
   * Public links: the Settings switch, each Canvas's links, and revoke.
   * Publishing goes through the export routes, never here.
   */
  readonly canvasPublicShareService?: CanvasPublicShareService;
  /**
   * Brings the export destinations' connection state current before they are
   * listed or prepared. The offer list itself is synchronous, so a destination
   * whose state needs an external read (the gist's GitHub connection) is read
   * here, on demand, rather than when the host starts.
   */
  readonly refreshCanvasExportTargets?: () => Promise<void>;
  /**
   * Which folder a Project's exports are written to. Absent when the host
   * cannot journal the choice, which also leaves the folder destination
   * `not-connected`.
   */
  readonly canvasExportFolderService?: CanvasExportFolderService;
  /**
   * The canonical path behind a folder-browser candidate. The renderer sends a
   * candidate id and this resolves it host-side, so a renderer never names a
   * path itself. Rejects when the candidate is expired, foreign, or off-mode,
   * or when its path no longer resolves inside the authorized root.
   */
  readonly resolveFolderCandidate?: (windowId: WindowId, input: unknown) => Promise<string>;
  /**
   * Reads one of a Project's design systems as a Canvas carries it: its name,
   * where it came from, and its tokens. Absent on a host without design
   * systems, which refuses every switch to one; undefined when the file is
   * not there or not in a folder the Project lends.
   */
  readonly resolveDesignSystem?: (
    projectId: string,
    location: unknown,
  ) => Promise<CanvasDesignSystem | undefined>;
  /** The design systems of a Project, for a Canvas in it to switch between. */
  readonly listDesignSystems?: (projectId: string) => Promise<DesignSystemList | undefined>;
  /** Comment journal; a host without it serves boards without a conversation. */
  readonly canvasCommentService?: CanvasCommentService;
  /**
   * Resolves a design's declared images under the authority of the Canvas
   * version holding it. Absent on a host that cannot, and every design is then
   * drawn with placeholders: the route answers that the images are
   * unavailable rather than guessing.
   */
  readonly resolveDesignAssets?: (
    block: CanvasDesignBlock,
    provenance: CanvasProvenance,
  ) => Promise<ReadonlyArray<CanvasDesignAssetResolution>>;
  /**
   * Single-use tickets for running designs' pages. Absent on a host that does
   * not serve them, and a running design then answers that it cannot run here.
   */
  readonly designRunTickets?: CanvasDesignRunTickets;
  /**
   * The per-Canvas **Allow network** switch and the proxy a running page's
   * requests go through. Absent, no Canvas has a switch and no page a proxy.
   */
  readonly canvasNetwork?: {
    readonly access: CanvasNetworkAccessService;
    readonly proxy: Pick<CanvasNetworkProxy, "fetch">;
  };
  /**
   * The host's snapshot of a page a Work or Code thread published, when the
   * window may read that thread. Absent leaves published pages unrunnable.
   */
  readonly findPublishedSnapshot?: (
    windowId: WindowId,
    request: PublishedSnapshotRunRequest,
  ) => Promise<ThreadPublishedSnapshot | undefined>;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly projects: Pick<ProjectService, "bootstrap">;
  readonly activeContextResolver: (
    windowId: WindowId,
  ) => CanvasActiveContext | undefined | Promise<CanvasActiveContext | undefined>;
  /**
   * Whether a caller may open a thread. A paired device reads a Canvas under
   * this rule, through the thread the Canvas belongs to: it has no active
   * Project and no way to set one. Absent, a paired device reads no Canvas.
   */
  readonly threadReadAuthority?: ThreadReadAuthority;
  readonly now?: () => number;
}

export interface CanvasActiveContext {
  readonly mode: ShellBootstrap["workspace"]["activeMode"];
  readonly projectId: ProjectId | null;
}

/** What it takes to decide whether one window may read one Canvas. */
export interface CanvasWindowReadDependencies {
  readonly canvasProjection: Pick<CanvasProjection, "getById">;
  readonly projects: Pick<ProjectService, "bootstrap">;
  readonly activeContextResolver: CanvasRouteDependencies["activeContextResolver"];
}

/**
 * May this window read this Canvas, and what is it called?
 *
 * The same authorization the read route performs, offered to surfaces that
 * need to know a Canvas is reachable before they address it — Zen pins a card
 * by naming a canvas, and whether the caller may reach it stays this decision
 * rather than becoming a second one kept somewhere else. Returns nothing when
 * the answer is no, for either reason: a surface that pins a canvas has no use
 * for the difference, and repeating it would say more about the host's
 * contents than the caller was authorized to learn.
 */
export async function readCanvasForWindow(
  dependencies: CanvasWindowReadDependencies,
  windowId: WindowId,
  canvasId: CanvasId,
): Promise<{ readonly title: string } | undefined> {
  const context = await resolveAuthorizedContext(dependencies, windowId, canvasId);
  if (context.kind !== "ok") return undefined;
  const entry = dependencies.canvasProjection.getById(canvasId);
  return entry === undefined ? undefined : { title: entry.currentVersion.definition.title };
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
      route !== "design-assets" &&
      route !== "design-run" &&
      route !== "published-snapshot-run" &&
      route !== "design-page" &&
      route !== "history" &&
      route !== "revise" &&
      route !== "layout-revise" &&
      route !== "plan-revise" &&
      route !== "deck-propose" &&
      route !== "design-system-apply" &&
      route !== "design-systems" &&
      route !== "comments" &&
      route !== "comment" &&
      route !== "refresh" &&
      route !== "refresh-cancel" &&
      route !== "action" &&
      route !== "action-cancel" &&
      route !== "create" &&
      route !== "import-html" &&
      route !== "recipes" &&
      route !== "share" &&
      route !== "share-revoke" &&
      route !== "share-access" &&
      route !== "export-targets" &&
      route !== "export-prepare" &&
      route !== "export-decide" &&
      route !== "export-folder" &&
      route !== "html-file" &&
      route !== "public-shares" &&
      route !== "public-share-revoke" &&
      route !== "public-link-settings" &&
      route !== "thread-reference-cards" &&
      route !== "network-access" &&
      !route.startsWith(NETWORK_PROXY_ROUTE_PREFIX)
    ) {
      return undefined;
    }

    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failureResponse("Canvas API requests must use loopback.", 400, null);
    }
    // A frame loads a running design's page by address alone, so it carries
    // no window credential; the single-use ticket is the whole authority, and
    // it was issued only after the same read check as the Canvas itself.
    if (route === "design-page") return serveDesignPage(dependencies, request, url);
    // A running page asks for a fetch the same way: its origin is opaque and
    // it holds no window credential, so the token in the path is the whole
    // authority, and nothing else the request carries is read.
    if (route.startsWith(NETWORK_PROXY_ROUTE_PREFIX)) {
      return serveNetworkRequest(dependencies, request, url, route);
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
          canvasReaderFor(principal, authenticatedWindowId),
          canvasId,
          versionId,
        );
        return jsonResponse(decodeCanvasGetOutcome(outcome), 200, origin);
      }

      if (route === "design-assets" && request.method === "GET") {
        const keys = [...url.searchParams.keys()];
        if (
          keys.length !== 3 ||
          !keys.every((key) => key === "canvasId" || key === "versionId" || key === "blockId")
        ) {
          return failureResponse("Canvas design assets request is invalid.", 400, origin);
        }
        let parsed;
        try {
          parsed = {
            canvasId: decodeCanvasId(url.searchParams.get("canvasId") ?? ""),
            versionId: decodeCanvasVersionId(url.searchParams.get("versionId") ?? ""),
            blockId: decodeCanvasBlockId(url.searchParams.get("blockId") ?? ""),
          };
        } catch {
          return failureResponse("Canvas design assets request is invalid.", 400, origin);
        }
        const outcome = await resolveDesignAssetsForReader(
          dependencies,
          canvasReaderFor(principal, authenticatedWindowId),
          parsed,
        );
        return jsonResponse(decodeCanvasDesignAssetsOutcome(outcome), 200, origin);
      }

      if (route === "design-run" && request.method === "POST") {
        const body = await readJson(request);
        let parsed: CanvasDesignRunRequest;
        try {
          if (body.kind !== "ok") throw new Error("invalid");
          parsed = decodeCanvasDesignRunRequest(body.value);
        } catch {
          return failureResponse("Canvas design run request is invalid.", 400, origin);
        }
        const outcome = await issueDesignRun(
          dependencies,
          canvasReaderFor(principal, authenticatedWindowId),
          parsed,
        );
        return jsonResponse(decodeCanvasDesignRunOutcome(outcome), 200, origin);
      }

      if (route === "published-snapshot-run" && request.method === "POST") {
        const body = await readJson(request);
        let parsed: PublishedSnapshotRunRequest;
        try {
          if (body.kind !== "ok") throw new Error("invalid");
          parsed = decodePublishedSnapshotRunRequest(body.value);
        } catch {
          return failureResponse("Published page run request is invalid.", 400, origin);
        }
        const outcome = await issuePublishedSnapshotRun(
          dependencies,
          authenticatedWindowId,
          parsed,
        );
        return jsonResponse(decodePublishedSnapshotRunOutcome(outcome), 200, origin);
      }

      // The design systems a Canvas may switch to: its own Project's. Like
      // the switch itself, only the host window reaches this (the remote
      // classifier names neither), and the Project is the Canvas's, never one
      // the window names.
      if (route === "design-systems" && request.method === "GET") {
        if (url.searchParams.size !== 1 || !url.searchParams.has("canvasId")) {
          return failureResponse("Canvas design systems request is invalid.", 400, origin);
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
        const projectId = context.kind === "ok" ? context.activeContext.projectId : null;
        const listed =
          projectId === null || dependencies.listDesignSystems === undefined
            ? undefined
            : await dependencies.listDesignSystems(String(projectId)).catch(() => undefined);
        return jsonResponse(listed ?? { systems: [], truncated: false }, 200, origin);
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
        const context = await resolveReadContext(
          dependencies,
          canvasReaderFor(principal, authenticatedWindowId),
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

      // A drag on a diagram, a person's change to a plan task, and a person's
      // one-click deck proposal are all board revisions: the same
      // authorization, the same answer shape. None is admitted for a paired
      // device (the remote classifier names none of them), so each is the
      // host window's own act.
      if (
        (route === "layout-revise" ||
          route === "plan-revise" ||
          route === "deck-propose" ||
          route === "design-system-apply") &&
        request.method === "POST"
      ) {
        const what =
          route === "plan-revise"
            ? "plan revision"
            : route === "deck-propose"
              ? "deck proposal"
              : route === "design-system-apply"
                ? "design system switch"
                : "layout revision";
        const body = await readJson(request);
        const malformed = () =>
          jsonResponse(
            decodeCanvasDiagramLayoutReviseResult({
              kind: "denied",
              denialCode: "malformed-request",
              message: `Canvas ${what} is malformed.`,
            }),
            200,
            origin,
          );
        if (body.kind === "too-large" || body.kind === "invalid") return malformed();
        let canvasId;
        try {
          canvasId = decodeCanvasId((body.value as { canvasId?: unknown }).canvasId ?? "");
        } catch {
          return malformed();
        }
        const context = await resolveAuthorizedContext(
          dependencies,
          authenticatedWindowId,
          canvasId,
        );
        if (context.kind === "unauthorized") {
          return jsonResponse(
            decodeCanvasDiagramLayoutReviseResult({
              kind: "denied",
              denialCode: "unauthorized",
              message: `Canvas ${what} is not authorized in this workspace.`,
            }),
            200,
            origin,
          );
        }
        if (context.kind === "unavailable") {
          return jsonResponse(
            decodeCanvasDiagramLayoutReviseResult({
              kind: "denied",
              denialCode: "unavailable",
              message: context.reason,
            }),
            200,
            origin,
          );
        }
        const authorization = {
          mode: context.activeContext.mode,
          projectId:
            context.activeContext.projectId === null
              ? null
              : String(context.activeContext.projectId),
        };
        if (route === "design-system-apply") {
          // The host reads the chosen file itself, under the Canvas's own
          // Project, so a window names a location and never hands over tokens.
          const location = (body.value as { designSystem?: unknown }).designSystem;
          let designSystem: CanvasDesignSystem | undefined;
          if (location !== null) {
            const projectId = context.activeContext.projectId;
            designSystem =
              projectId === null || dependencies.resolveDesignSystem === undefined
                ? undefined
                : await dependencies
                    .resolveDesignSystem(String(projectId), location)
                    .catch(() => undefined);
            if (designSystem === undefined) {
              return jsonResponse(
                decodeCanvasDiagramLayoutReviseResult({
                  kind: "denied",
                  denialCode: "unavailable",
                  message: "That design system cannot be read from this Project.",
                }),
                200,
                origin,
              );
            }
          }
          return jsonResponse(
            decodeCanvasDiagramLayoutReviseResult(
              dependencies.canvasService.applyDesignSystem(
                body.value,
                authorization,
                context.project,
                designSystem,
              ),
            ),
            200,
            origin,
          );
        }
        const result =
          route === "plan-revise"
            ? dependencies.canvasService.revisePlanTask(body.value, authorization, context.project)
            : route === "deck-propose"
              ? dependencies.canvasService.proposeDeck(body.value, authorization, context.project)
              : dependencies.canvasService.reviseDiagramLayout(
                  body.value,
                  authorization,
                  context.project,
                );
        return jsonResponse(decodeCanvasDiagramLayoutReviseResult(result), 200, origin);
      }

      if (route === "comments" && request.method === "GET") {
        if (url.searchParams.size !== 1 || !url.searchParams.has("canvasId")) {
          return failureResponse("Canvas comments request is invalid.", 400, origin);
        }
        let canvasId;
        try {
          canvasId = decodeCanvasId(url.searchParams.get("canvasId") ?? "");
        } catch {
          return failureResponse("Canvas ID is invalid.", 400, origin);
        }
        const comments = dependencies.canvasCommentService;
        if (comments === undefined) {
          return jsonResponse(
            decodeCanvasCommentsOutcome({
              kind: "unavailable",
              canvasId,
              reason: "Canvas comments are unavailable on this host.",
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
            decodeCanvasCommentsOutcome({ kind: "unauthorized", canvasId }),
            200,
            origin,
          );
        }
        if (context.kind === "unavailable") {
          return jsonResponse(
            decodeCanvasCommentsOutcome({ kind: "unavailable", canvasId, reason: context.reason }),
            200,
            origin,
          );
        }
        return jsonResponse(
          comments.comments(
            canvasId,
            {
              mode: context.activeContext.mode,
              projectId:
                context.activeContext.projectId === null
                  ? null
                  : String(context.activeContext.projectId),
            },
            context.project,
          ),
          200,
          origin,
        );
      }

      if (route === "comment" && request.method === "POST") {
        const body = await readJson(request);
        const denied = (
          denialCode: "malformed-request" | "unauthorized" | "unavailable",
          message: string,
        ) =>
          jsonResponse(
            decodeCanvasCommentCommandResult({ kind: "denied", denialCode, message }),
            200,
            origin,
          );
        if (body.kind === "too-large" || body.kind === "invalid") {
          return denied("malformed-request", "Canvas comment command is malformed.");
        }
        let canvasId;
        try {
          canvasId = decodeCanvasId((body.value as { canvasId?: unknown }).canvasId ?? "");
        } catch {
          return denied("malformed-request", "Canvas comment command is malformed.");
        }
        const comments = dependencies.canvasCommentService;
        if (comments === undefined) {
          return denied("unavailable", "Canvas comments are unavailable on this host.");
        }
        const context = await resolveAuthorizedContext(
          dependencies,
          authenticatedWindowId,
          canvasId,
        );
        if (context.kind === "unauthorized") {
          return denied("unauthorized", "Canvas comments are not authorized in this workspace.");
        }
        if (context.kind === "unavailable") return denied("unavailable", context.reason);
        // The device is what this host authenticated the request from, never a
        // field the client wrote; a comment from a paired phone says so.
        const commentOrigin =
          principal.kind === "remote-device"
            ? { kind: "remote-device" as const, deviceId: String(principal.deviceId) }
            : { kind: "host" as const };
        const result = comments.comment(
          body.value,
          {
            mode: context.activeContext.mode,
            projectId:
              context.activeContext.projectId === null
                ? null
                : String(context.activeContext.projectId),
          },
          context.project,
          commentOrigin,
        );
        return jsonResponse(decodeCanvasCommentCommandResult(result), 200, origin);
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

      // The recipes a person may start a Canvas from. A recipe is a starting
      // shape and carries no Project data, so any authenticated window may
      // read the list; create re-resolves the chosen id against it.
      if (route === "recipes" && request.method === "GET") {
        if (url.searchParams.size !== 0) {
          return failureResponse("Canvas recipes request is invalid.", 400, origin);
        }
        return jsonResponse(
          decodeCanvasDocumentRecipeCatalog({
            recipes: dependencies.canvasService.documentRecipes(),
          }),
          200,
          origin,
        );
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

      // A person's page, imported into a new Canvas. It is a create in every
      // respect the window's authority sees: the same context, the same Project
      // check, and no route a create does not have. The page is read and
      // bounded on the host before anything is journaled.
      if (route === "import-html" && request.method === "POST") {
        const body = await readJson(request);
        if (body.kind === "too-large") {
          return jsonResponse(
            decodeCanvasHtmlImportResult({
              kind: "refused",
              reason: "too-large",
              message: `This page is larger than ${String(CANVAS_HTML_IMPORT_MAX_BYTES / 1024)} KB, the most Octant imports.`,
            }),
            200,
            origin,
          );
        }
        if (body.kind === "invalid") {
          return jsonResponse(
            decodeCanvasHtmlImportResult({
              kind: "denied",
              denialCode: "malformed-request",
              message: "Canvas import request is malformed.",
            }),
            200,
            origin,
          );
        }
        const context = await resolveCreateContext(dependencies, authenticatedWindowId);
        if (context.kind !== "ok") {
          return jsonResponse(
            decodeCanvasHtmlImportResult({
              kind: "denied",
              denialCode: context.kind,
              message:
                context.kind === "unavailable"
                  ? context.reason
                  : "Canvas create is not authorized in this workspace.",
            }),
            200,
            origin,
          );
        }
        const result = dependencies.canvasService.importHtml(
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
        return jsonResponse(decodeCanvasHtmlImportResult(result), 200, origin);
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
        // A reader allowed to open the snapshot may run a prototype it holds:
        // the page is ticketed from the snapshot's own design, after the same
        // decision and the same access-log entry as the read itself.
        const run = result.kind === "allowed" ? sharedDesignRunAsked(body.value) : undefined;
        const designPage =
          result.kind === "allowed" && run !== undefined
            ? issueSharedDesignRun(dependencies.designRunTickets, result.document, run)
            : undefined;
        return jsonResponse(
          decodeCanvasShareAccessResult(
            designPage === undefined ? result : { ...result, designPage },
          ),
          200,
          origin,
        );
      }

      if (route === "html-file" && request.method === "POST") {
        const body = await readJson(request);
        let parsed: CanvasHtmlFileRequest;
        try {
          if (body.kind !== "ok") throw new Error("invalid");
          parsed = decodeCanvasHtmlFileRequest(body.value);
        } catch {
          return jsonResponse(
            decodeCanvasHtmlFileResult({
              kind: "refused",
              code: "malformed",
              message: "Canvas HTML file request is malformed.",
            }),
            200,
            origin,
          );
        }
        return jsonResponse(
          decodeCanvasHtmlFileResult(
            await renderCanvasHtmlFileForReader(
              dependencies,
              canvasReaderFor(principal, authenticatedWindowId),
              parsed,
            ),
          ),
          200,
          origin,
        );
      }

      if (route === "export-targets" && request.method === "GET") {
        const exportService = dependencies.canvasExportService;
        if (exportService === undefined) {
          return failureResponse("Canvas export is unavailable on this host.", 404, origin);
        }
        if (url.searchParams.size !== 1 || !url.searchParams.has("canvasId")) {
          return failureResponse("Canvas export request is invalid.", 400, origin);
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
            "Canvas export is not available for this canvas.",
            context.kind === "unauthorized" ? 403 : 404,
            origin,
          );
        }
        await dependencies.refreshCanvasExportTargets?.();
        const offers = exportService.offers(canvasId);
        if (offers === undefined) {
          return failureResponse("Canvas export is not available for this canvas.", 404, origin);
        }
        return jsonResponse(decodeCanvasExportOfferList(offers), 200, origin);
      }

      if ((route === "export-prepare" || route === "export-decide") && request.method === "POST") {
        const exportService = dependencies.canvasExportService;
        const malformed =
          route === "export-prepare"
            ? decodeCanvasExportPrepareResult({
                kind: "refused",
                code: "malformed",
                message: "Canvas export request is malformed.",
              })
            : decodeCanvasExportDecideResult({
                kind: "refused",
                code: "malformed",
                message: "Canvas export request is malformed.",
              });
        if (exportService === undefined) {
          return jsonResponse(
            route === "export-prepare"
              ? decodeCanvasExportPrepareResult({
                  kind: "refused",
                  code: "unavailable",
                  message: "Canvas export is unavailable on this host.",
                })
              : decodeCanvasExportDecideResult({
                  kind: "refused",
                  code: "unavailable",
                  message: "Canvas export is unavailable on this host.",
                }),
            200,
            origin,
          );
        }
        const body = await readJson(request);
        if (body.kind === "too-large" || body.kind === "invalid") {
          return jsonResponse(malformed, 200, origin);
        }
        if (route === "export-prepare") {
          let requestBody;
          try {
            requestBody = decodeCanvasExportPrepareRequest(body.value);
          } catch {
            return jsonResponse(malformed, 200, origin);
          }
          const context = await resolveAuthorizedContext(
            dependencies,
            authenticatedWindowId,
            requestBody.canvasId,
          );
          if (context.kind === "ok") await dependencies.refreshCanvasExportTargets?.();
          return jsonResponse(
            decodeCanvasExportPrepareResult(
              await exportService.prepare(requestBody, context.kind === "ok", principal.kind),
            ),
            200,
            origin,
          );
        }
        let requestBody;
        try {
          requestBody = decodeCanvasExportDecideRequest(body.value);
        } catch {
          return jsonResponse(malformed, 200, origin);
        }
        const context = await resolveAuthorizedContext(
          dependencies,
          authenticatedWindowId,
          requestBody.canvasId,
        );
        return jsonResponse(
          decodeCanvasExportDecideResult(
            await exportService.decide({
              canvasId: requestBody.canvasId,
              approvalId: requestBody.approvalId,
              decision: requestBody.decision,
              permitted: context.kind === "ok",
              ...(requestBody.visibility === undefined
                ? {}
                : { visibility: requestBody.visibility }),
              ...(requestBody.link === undefined ? {} : { link: requestBody.link }),
              // The envelope names the transport principal this host
              // authenticated for the approval, never a fixed local user.
              actor: canvasExportEventActor(principal, OCTANT_LOCAL_ACTOR_ID),
            }),
          ),
          200,
          origin,
        );
      }

      if (
        route === "public-shares" ||
        route === "public-share-revoke" ||
        route === "public-link-settings"
      ) {
        const links = dependencies.canvasPublicShareService;
        if (links === undefined) {
          return failureResponse("Public links are unavailable on this host.", 404, origin);
        }
        if (route === "public-link-settings" && request.method === "GET") {
          if (url.searchParams.size !== 0) {
            return failureResponse("Public link settings request is invalid.", 400, origin);
          }
          return jsonResponse(links.settings(), 200, origin);
        }
        if (route === "public-link-settings" && request.method === "POST") {
          // Turning public links on or pointing them at another service is
          // the person's choice at this Mac, never a paired device's.
          if (principal.kind !== "local-window") {
            return jsonResponse(
              decodeCanvasPublicLinkSettingsResult({
                kind: "canvas-public-link-settings-refused",
                reason: "unauthorized",
                message: "Public link settings can be changed only from a window on this computer.",
              }),
              200,
              origin,
            );
          }
          const body = await readJson(request);
          let command;
          try {
            if (body.kind !== "ok") throw new Error("malformed");
            command = decodeCanvasPublicLinkSettingsCommand(body.value);
          } catch {
            return jsonResponse(
              decodeCanvasPublicLinkSettingsResult({
                kind: "canvas-public-link-settings-refused",
                reason: "malformed",
                message: "Public link settings request is malformed.",
              }),
              200,
              origin,
            );
          }
          return jsonResponse(links.changeSettings(command), 200, origin);
        }
        if (route === "public-shares" && request.method === "GET") {
          if (url.searchParams.size !== 1 || !url.searchParams.has("canvasId")) {
            return failureResponse("Public links request is invalid.", 400, origin);
          }
          let canvasId;
          try {
            canvasId = decodeCanvasId(url.searchParams.get("canvasId") ?? "");
          } catch {
            return failureResponse("Canvas ID is invalid.", 400, origin);
          }
          const context = await resolveReadContext(
            dependencies,
            canvasReaderFor(principal, authenticatedWindowId),
            canvasId,
          );
          if (context.kind !== "ok") {
            return failureResponse(
              "Public links are not available for this canvas.",
              context.kind === "unauthorized" ? 403 : 404,
              origin,
            );
          }
          return jsonResponse(links.list(canvasId), 200, origin);
        }
        if (route === "public-share-revoke" && request.method === "POST") {
          const refusedRevoke = (code: "unauthorized" | "malformed", message: string) =>
            jsonResponse(
              decodeCanvasPublicShareRevokeResult({ kind: "refused", code, message }),
              200,
              origin,
            );
          // Revoking is recorded as the owner's act, like an authenticated share's.
          if (principal.kind !== "local-window") {
            return refusedRevoke(
              "unauthorized",
              "A public link can be revoked only from a window on this computer.",
            );
          }
          const body = await readJson(request);
          let revokeRequest;
          try {
            if (body.kind !== "ok") throw new Error("malformed");
            revokeRequest = decodeCanvasPublicShareRevokeRequest(body.value);
          } catch {
            return refusedRevoke("malformed", "Public link revoke request is malformed.");
          }
          const context = await resolveAuthorizedContext(
            dependencies,
            authenticatedWindowId,
            revokeRequest.canvasId,
          );
          if (context.kind !== "ok") {
            return refusedRevoke("unauthorized", "Public links are not available for this canvas.");
          }
          return jsonResponse(
            await links.revoke(revokeRequest.canvasId, revokeRequest.publicShareId),
            200,
            origin,
          );
        }
        return failureResponse("Public links request is invalid.", 405, origin);
      }

      if (route === "network-access" && (request.method === "GET" || request.method === "POST")) {
        const access = dependencies.canvasNetwork?.access;
        if (request.method === "GET") {
          if (url.searchParams.size !== 1 || !url.searchParams.has("canvasId")) {
            return failureResponse("Canvas network request is invalid.", 400, origin);
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
          if (context.kind !== "ok" || access === undefined) {
            return failureResponse(
              "Canvas network is not available for this canvas.",
              context.kind === "unauthorized" ? 403 : 404,
              origin,
            );
          }
          return jsonResponse(
            decodeCanvasNetworkAccessView({
              kind: "canvas-network-access",
              canvasId,
              allowed: access.isAllowed(canvasId),
            }),
            200,
            origin,
          );
        }

        const refusedNetwork = (reason: CanvasNetworkAccessRefusalReason, message: string) =>
          jsonResponse(
            decodeCanvasNetworkAccessResult({
              kind: "canvas-network-access-refused",
              reason,
              message,
            }),
            200,
            origin,
          );
        // Letting a Canvas's pages send its content to the internet is a
        // person's choice at this machine. A paired device and an agent grant
        // are other principals, and no agent tool reaches this route.
        if (principal.kind !== "local-window") {
          return refusedNetwork(
            "local-window-required",
            "Only a person at this machine can change a Canvas's network.",
          );
        }
        const body = await readJson(request);
        if (body.kind !== "ok") {
          return refusedNetwork("malformed", "Canvas network request is malformed.");
        }
        let command;
        try {
          command = decodeCanvasNetworkAccessCommand(body.value);
        } catch {
          return refusedNetwork("malformed", "Canvas network request is malformed.");
        }
        if (access === undefined) {
          return refusedNetwork("unavailable", "This host does not offer a Canvas network.");
        }
        const context = await resolveAuthorizedContext(
          dependencies,
          authenticatedWindowId,
          command.canvasId,
        );
        if (
          context.kind !== "ok" ||
          dependencies.canvasProjection.getById(command.canvasId) === undefined
        ) {
          return refusedNetwork(
            "canvas-unavailable",
            "That Canvas is not available in this workspace.",
          );
        }
        access.set(command.canvasId, command.allowed);
        return jsonResponse(
          decodeCanvasNetworkAccessResult({
            kind: "canvas-network-access",
            canvasId: command.canvasId,
            allowed: access.isAllowed(command.canvasId),
          }),
          200,
          origin,
        );
      }

      if (route === "export-folder" && (request.method === "GET" || request.method === "POST")) {
        const folders = dependencies.canvasExportFolderService;
        // Reading where a Canvas exports to and choosing it are the same
        // surface: a host without it has no folder destination at all, so it
        // says so rather than offering a chooser that cannot store anything.
        if (folders === undefined) {
          return request.method === "GET"
            ? failureResponse("Canvas export folders are unavailable on this host.", 404, origin)
            : jsonResponse(
                decodeCanvasExportFolderResult({
                  kind: "canvas-export-folder-refused",
                  reason: "canvas-unavailable",
                  message: "Canvas export folders are unavailable on this host.",
                }),
                200,
                origin,
              );
        }

        if (request.method === "GET") {
          if (url.searchParams.size !== 1 || !url.searchParams.has("canvasId")) {
            return failureResponse("Canvas export folder request is invalid.", 400, origin);
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
              "Canvas export is not available for this canvas.",
              context.kind === "unauthorized" ? 403 : 404,
              origin,
            );
          }
          const entry = dependencies.canvasProjection.getById(canvasId);
          if (entry === undefined) {
            return failureResponse("Canvas export is not available for this canvas.", 404, origin);
          }
          // A Canvas carries its Project, so a choice made here is remembered
          // for that Project. The host folder is the same choice made for a
          // thread filed nowhere, and travels through the same command; a
          // Canvas owned by a Chat thread outside every Project uses it.
          const provenance = entry.currentVersion.definition.provenance;
          const scope: CanvasExportFolderScope = provenance.projectId === null ? "host" : "project";
          const folder = folders.folderFor(
            provenance.projectId === null ? undefined : String(provenance.projectId),
          );
          const view = {
            kind: "canvas-export-folder-view",
            settings: folders.settings(),
            ...(folder === undefined ? {} : { folder }),
            scope,
            hostId: String(provenance.hostId),
            // Chat and Work browse the same folders; only Code is offered a
            // mode of its own, and the browser records the mode a candidate
            // was listed under.
            mode: provenance.mode === "code" ? "code" : "work",
          };
          return jsonResponse(decodeCanvasExportFolderView(view), 200, origin);
        }

        const refusedFolder = (reason: CanvasExportFolderRefusalReason, message: string) =>
          jsonResponse(
            decodeCanvasExportFolderResult({
              kind: "canvas-export-folder-refused",
              reason,
              message,
            }),
            200,
            origin,
          );
        const body = await readJson(request);
        if (body.kind !== "ok") {
          return refusedFolder("malformed", "Canvas export folder request is malformed.");
        }
        let command;
        try {
          command = decodeCanvasExportFolderCommand(body.value);
        } catch {
          return refusedFolder("malformed", "Canvas export folder request is malformed.");
        }
        const context = await resolveAuthorizedContext(
          dependencies,
          authenticatedWindowId,
          command.canvasId,
        );
        if (context.kind !== "ok") {
          return refusedFolder(
            "canvas-unavailable",
            "That Canvas is not available in this workspace.",
          );
        }
        const entry = dependencies.canvasProjection.getById(command.canvasId);
        if (entry === undefined) {
          return refusedFolder(
            "canvas-unavailable",
            "That Canvas is not available in this workspace.",
          );
        }
        if (dependencies.resolveFolderCandidate === undefined) {
          return refusedFolder(
            "candidate-unavailable",
            "This host cannot resolve a chosen folder.",
          );
        }
        let folder: string;
        try {
          // The renderer sent a candidate id; the path is resolved here, from
          // the record the host made when it listed the folder.
          folder = await dependencies.resolveFolderCandidate(authenticatedWindowId, {
            hostId: String(entry.currentVersion.definition.provenance.hostId),
            mode: command.mode,
            candidateId: command.candidateId,
          });
        } catch {
          return refusedFolder(
            "candidate-unavailable",
            "That folder is no longer available to choose.",
          );
        }
        const exportProjectId = entry.currentVersion.definition.provenance.projectId;
        if (command.scope === "project" && exportProjectId === null) {
          return refusedFolder(
            "malformed",
            "This Canvas belongs to no Project; choose the folder for the host instead.",
          );
        }
        return jsonResponse(
          folders.choose({
            scope: command.scope,
            ...(command.scope === "host" || exportProjectId === null
              ? {}
              : { projectId: String(exportProjectId) }),
            folder,
            expectedVersion: command.expectedVersion,
          }),
          200,
          origin,
        );
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
          canvasReaderFor(principal, authenticatedWindowId),
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
      /** Absent for a Canvas owned by a Chat thread outside every Project. */
      readonly project:
        | {
            readonly id: string;
            readonly type: "chat" | "work" | "code";
            readonly lifecycle: "active" | "archived";
          }
        | undefined;
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
  if (activeContext === undefined) return { kind: "unauthorized" };
  // A Chat window with no Project open creates a Canvas owned by the thread
  // the request names; the service checks that thread before anything is
  // journaled. Every other mode needs its active Project.
  if (activeContext.projectId === null) {
    return activeContext.mode === "chat"
      ? { kind: "ok", activeContext, project: undefined }
      : { kind: "unauthorized" };
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
  reader: CanvasReader,
  mode: CanvasActiveContext["mode"],
  threadId: string,
  projectId: ProjectId | null,
) {
  if (reader.kind === "paired-device") {
    return resolvePairedThreadReferenceCards(
      dependencies,
      reader.scopeId,
      mode,
      threadId,
      projectId,
    );
  }
  const { windowId } = reader;
  // A Chat thread in no Project lists the Canvases it owns itself; they are
  // read wherever the thread is, so a window in Chat is all it takes.
  if (projectId === null) {
    if (mode !== "chat") return [];
    let activeContext: CanvasActiveContext | undefined;
    try {
      activeContext = await dependencies.activeContextResolver(windowId);
    } catch {
      return [];
    }
    if (activeContext?.mode !== "chat") return [];
    return dependencies.canvasService.threadReferenceCards({ mode, threadId, projectId: null });
  }
  const authority = await resolveInventoryAuthority(dependencies, windowId, projectId);
  if (authority.kind !== "ok" || authority.mode !== mode) return [];
  return dependencies.canvasService.threadReferenceCards({
    mode,
    threadId,
    projectId: String(projectId),
  });
}

async function resolveAuthorizedContext(
  dependencies: CanvasWindowReadDependencies,
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
  if (activeContext === undefined) return { kind: "unauthorized" };
  const provenance = entry.currentVersion.definition.provenance;
  // A Canvas owned by a Chat thread outside every Project has no Project to
  // match the window against: any window in Chat reaches it, and the Canvas
  // authority itself checks that its thread still exists.
  if (provenance.projectId === null) {
    return activeContext.mode === "chat"
      ? { kind: "ok", activeContext, project: undefined }
      : { kind: "unauthorized" };
  }
  if (activeContext.projectId === null) return { kind: "unauthorized" };
  const bootstrap = await dependencies.projects.bootstrap(windowId);
  const project = bootstrap.active.find((candidate) => candidate.id === provenance.projectId);
  if (project === undefined || project.lifecycle !== "active") {
    return {
      kind: "unavailable",
      reason: "Canvas is unavailable. Reopen it from the Project.",
    };
  }
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

/**
 * Who reads a Canvas, and under which rule. A window on this host reads under
 * its active Project and mode. A paired device has neither (the shell route
 * that sets them is local-only), so it reads under thread read authority: a
 * Canvas whose thread it may open. That reach is read-only; every route that
 * changes, publishes, exports, or shares a Canvas keeps the window rule.
 */
type CanvasReader =
  | { readonly kind: "window"; readonly windowId: WindowId }
  | { readonly kind: "paired-device"; readonly scopeId: WindowId };

function canvasReaderFor(principal: ClientPrincipal, windowId: WindowId): CanvasReader {
  return principal.kind === "remote-device"
    ? { kind: "paired-device", scopeId: windowId }
    : { kind: "window", windowId };
}

function resolveReadContext(
  dependencies: CanvasRouteDependencies,
  reader: CanvasReader,
  canvasId: CanvasId,
): Promise<AuthorizedCanvasContext> {
  return reader.kind === "window"
    ? resolveAuthorizedContext(dependencies, reader.windowId, canvasId)
    : resolvePairedReadContext(dependencies, reader.scopeId, canvasId);
}

/**
 * A paired device reads a Canvas when it may open the thread the Canvas
 * belongs to, and that thread is still filed in the Canvas's Project. A
 * missing Canvas answers exactly as one the device may not read, so a refusal
 * never tells the device which Canvases exist.
 */
async function resolvePairedReadContext(
  dependencies: CanvasRouteDependencies,
  scopeId: WindowId,
  canvasId: CanvasId,
): Promise<AuthorizedCanvasContext> {
  const threadReadAuthority = dependencies.threadReadAuthority;
  const entry = dependencies.canvasProjection.getById(canvasId);
  if (threadReadAuthority === undefined || entry === undefined) return { kind: "unauthorized" };
  const provenance = entry.currentVersion.definition.provenance;
  const thread = await threadReadAuthority(scopeId, {
    mode: provenance.mode,
    threadId: String(provenance.threadId),
  });
  if (thread.kind !== "readable") return { kind: "unauthorized" };
  // The Canvas service still applies its own check to the context it is
  // handed; this one is the Canvas's own scope, admitted by its thread.
  const activeContext: CanvasActiveContext = {
    mode: provenance.mode,
    projectId: provenance.projectId,
  };
  // A Chat thread's own Canvas, from before the thread was filed anywhere,
  // stays the thread's wherever it is filed now.
  if (provenance.projectId === null) return { kind: "ok", activeContext, project: undefined };
  if (thread.projectId === null || String(thread.projectId) !== String(provenance.projectId)) {
    return { kind: "unauthorized" };
  }
  const project = await activeProjectOfMode(
    dependencies,
    scopeId,
    provenance.projectId,
    provenance.mode,
  );
  if (project === undefined) return { kind: "unauthorized" };
  return { kind: "ok", activeContext, project };
}

async function resolvePairedThreadReferenceCards(
  dependencies: CanvasRouteDependencies,
  scopeId: WindowId,
  mode: CanvasActiveContext["mode"],
  threadId: string,
  projectId: ProjectId | null,
) {
  const threadReadAuthority = dependencies.threadReadAuthority;
  if (threadReadAuthority === undefined) return [];
  const thread = await threadReadAuthority(scopeId, { mode, threadId });
  if (thread.kind !== "readable") return [];
  if (thread.projectId === null) {
    if (projectId !== null) return [];
    return dependencies.canvasService.threadReferenceCards({ mode, threadId, projectId: null });
  }
  if (projectId === null || String(thread.projectId) !== String(projectId)) return [];
  const project = await activeProjectOfMode(dependencies, scopeId, projectId, mode);
  if (project === undefined) return [];
  return dependencies.canvasService.threadReferenceCards({
    mode,
    threadId,
    projectId: String(projectId),
  });
}

async function activeProjectOfMode(
  dependencies: CanvasRouteDependencies,
  scopeId: WindowId,
  projectId: ProjectId,
  mode: CanvasActiveContext["mode"],
) {
  const bootstrap = await dependencies.projects.bootstrap(scopeId);
  const project = bootstrap.active.find((candidate) => String(candidate.id) === String(projectId));
  if (project === undefined || project.lifecycle !== "active" || project.type !== mode) {
    return undefined;
  }
  return { id: String(project.id), type: project.type, lifecycle: project.lifecycle };
}

function inventoryEntriesForProject(
  projection: CanvasProjection,
  projectId: ProjectId,
  mode: CanvasActiveContext["mode"],
): ReadonlyArray<CanvasInventoryEntry> {
  return projection
    .byProject(projectId)
    .filter((entry) => entry.currentVersion.definition.provenance.mode === mode)
    .flatMap((entry) => {
      const inventoryProjectId = entry.currentVersion.definition.provenance.projectId;
      return inventoryProjectId === null ? [] : [toInventoryEntry(entry, inventoryProjectId)];
    });
}

async function resolveCanvasGet(
  dependencies: CanvasRouteDependencies,
  reader: CanvasReader,
  canvasId: ReturnType<typeof decodeCanvasId>,
  versionId?: ReturnType<typeof decodeCanvasVersionId>,
): Promise<CanvasGetOutcome> {
  const context = await resolveReadContext(dependencies, reader, canvasId);
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

/**
 * One design's images for this reader, now. The read runs the same
 * authorization `get` does, for the version the reader is drawing, and the
 * images resolve under that version's own provenance: its mode, Project, and
 * thread. Nothing is cached, so a paired device or a window asks through the
 * same checks every time it draws the design.
 */
async function resolveDesignAssetsForReader(
  dependencies: CanvasRouteDependencies,
  reader: CanvasReader,
  input: {
    readonly canvasId: CanvasId;
    readonly versionId: ReturnType<typeof decodeCanvasVersionId>;
    readonly blockId: ReturnType<typeof decodeCanvasBlockId>;
  },
): Promise<CanvasDesignAssetsOutcome> {
  const read = await resolveCanvasGet(dependencies, reader, input.canvasId, input.versionId);
  if (read.kind === "unauthorized") return { kind: "unauthorized", canvasId: input.canvasId };
  if (read.kind !== "ready") {
    return {
      kind: "unavailable",
      canvasId: input.canvasId,
      reason: "Canvas is unavailable. Reopen it from the Project.",
    };
  }
  const definition = read.version.definition;
  const block = definition.blocks.find(
    (candidate): candidate is CanvasDesignBlock =>
      candidate.kind === "design" && String(candidate.blockId) === String(input.blockId),
  );
  if (block === undefined) {
    return {
      kind: "unavailable",
      canvasId: input.canvasId,
      reason: "That design is not in this Canvas version.",
    };
  }
  const resolve = dependencies.resolveDesignAssets;
  const assets =
    resolve === undefined
      ? (block.assets ?? []).map((asset) => ({
          assetId: asset.assetId,
          status: "unavailable" as const,
          reason: "refused" as const,
        }))
      : await resolve(block, definition.provenance);
  return {
    kind: "ready",
    canvasId: input.canvasId,
    versionId: read.version.versionId,
    blockId: block.blockId,
    assets,
  };
}

/**
 * The Canvas as one HTML file for this reader. It is a read: the same window
 * authorization `get` runs, for the version the reader is drawing, and each
 * design's declared images resolve under that version's own provenance, as
 * they do when the reader draws the design. Nothing is sent anywhere and
 * nothing is journaled; the file goes back to the window that asked.
 */
async function renderCanvasHtmlFileForReader(
  dependencies: CanvasRouteDependencies,
  reader: CanvasReader,
  input: CanvasHtmlFileRequest,
): Promise<CanvasHtmlFileResult> {
  const read = await resolveCanvasGet(dependencies, reader, input.canvasId, input.versionId);
  if (read.kind === "unauthorized") {
    return {
      kind: "refused",
      code: "unauthorized",
      message: "This Canvas is not available to this window.",
    };
  }
  if (read.kind !== "ready") {
    return {
      kind: "refused",
      code: "unavailable",
      message: "Canvas is unavailable. Reopen it from the Project.",
    };
  }
  const definition = read.version.definition;
  // The TSX handoff names no destination and journals nothing, exactly as the
  // document form: the file goes back to the window that asked, generated
  // from the share-filtered mockups as the HTML form is.
  if (input.form === "mockups-tsx") {
    const tsx = canvasMockupsTsx(
      definition.blocks.map((block) => (block.kind === "mockup" ? readableMockup(block) : block)),
    );
    if (tsx === undefined) {
      return {
        kind: "refused",
        code: "unavailable",
        message: "This Canvas holds no mockup to hand off.",
      };
    }
    if (canvasExportBodyByteLength(tsx) > CANVAS_HTML_FILE_MAX_BYTES) {
      return {
        kind: "refused",
        code: "too-large",
        message: `The mockup components are too large for one file (over ${String(CANVAS_HTML_FILE_MAX_BYTES / (1024 * 1024))} MB).`,
      };
    }
    return {
      kind: "ready-tsx",
      canvasId: input.canvasId,
      versionId: read.version.versionId,
      fileName: `${canvasExportStem(definition.title)}.tsx`,
      tsx,
    };
  }
  const designAssets = new Map<string, ReadonlyArray<CanvasDesignAssetResolution>>();
  const resolve = dependencies.resolveDesignAssets;
  if (resolve !== undefined) {
    for (const block of definition.blocks) {
      if (block.kind !== "design" || (block.assets ?? []).length === 0) continue;
      designAssets.set(String(block.blockId), await resolve(block, definition.provenance));
    }
  }
  const rendered = renderCanvasHtmlFile(definition, {
    frames: "as-written",
    ...(input.frameTheme === undefined ? {} : { frameTheme: input.frameTheme }),
    designAssets,
  });
  if (rendered.kind === "too-large") {
    return {
      kind: "refused",
      code: "too-large",
      message: `This Canvas is too large for one HTML file (over ${String(CANVAS_HTML_FILE_MAX_BYTES / (1024 * 1024))} MB).`,
    };
  }
  return {
    kind: "ready",
    canvasId: input.canvasId,
    versionId: read.version.versionId,
    fileName: canvasExportPlannedName(rendered.title, "html"),
    html: rendered.body,
    writesDesignMarkup: rendered.writesDesignMarkup,
    imagesLeftOut: rendered.imagesLeftOut,
  };
}

/**
 * A ticket for one running design's page. Issuing one runs the same read
 * check `get` does, for the version the reader is drawing, so a window or a
 * paired device can run only a design it could already read. The design must
 * declare that it runs script; a static design is never served this way.
 */
async function issueDesignRun(
  dependencies: CanvasRouteDependencies,
  reader: CanvasReader,
  input: CanvasDesignRunRequest,
): Promise<CanvasDesignRunOutcome> {
  const unavailable = (reason: string): CanvasDesignRunOutcome => ({
    kind: "unavailable",
    canvasId: input.canvasId,
    reason,
  });
  const tickets = dependencies.designRunTickets;
  if (tickets === undefined) return unavailable("This host does not run prototypes.");
  const read = await resolveCanvasGet(dependencies, reader, input.canvasId, input.versionId);
  if (read.kind === "unauthorized") return { kind: "unauthorized", canvasId: input.canvasId };
  if (read.kind !== "ready")
    return unavailable("Canvas is unavailable. Reopen it from the Project.");
  const definition = read.version.definition;
  const block = definition.blocks.find(
    (candidate): candidate is CanvasDesignBlock =>
      candidate.kind === "design" && String(candidate.blockId) === String(input.blockId),
  );
  if (block === undefined || block.runsScript !== true) {
    return unavailable("That prototype is not in this Canvas version.");
  }
  const startFrameId = input.frameId ?? block.frames[0]?.frameId;
  if (
    startFrameId === undefined ||
    !block.frames.some((frame) => String(frame.frameId) === String(startFrameId))
  ) {
    return unavailable("That screen is not in this prototype.");
  }
  const ticket = tickets.issue({
    canvasId: input.canvasId,
    versionId: read.version.versionId,
    blockId: block.blockId,
    startFrameId: String(startFrameId),
    block,
    provenance: definition.provenance,
    // A paired device's page never carries the mark, whatever the switch says:
    // the proxy answers on this machine's loopback host, for a frame here.
    ...(reader.kind === "window" && dependencies.canvasNetwork?.access.isAllowed(input.canvasId)
      ? { network: true as const }
      : {}),
  });
  return {
    kind: "ready",
    canvasId: input.canvasId,
    versionId: read.version.versionId,
    blockId: block.blockId,
    page: canvasDesignPagePath(ticket),
  };
}

/**
 * A running page for the snapshot of a page a thread published. The snapshot
 * is read from the thread's own journal under the window's read authority,
 * and drawn through the same importer and design policy an HTML page brought
 * into a Canvas goes through, so it runs under the running tier's page,
 * sandbox, and policy. Nothing the request carries becomes the page.
 */
async function issuePublishedSnapshotRun(
  dependencies: CanvasRouteDependencies,
  windowId: WindowId,
  input: PublishedSnapshotRunRequest,
): Promise<PublishedSnapshotRunOutcome> {
  const unavailable = (reason: string): PublishedSnapshotRunOutcome => ({
    kind: "unavailable",
    reason,
  });
  const tickets = dependencies.designRunTickets;
  const find = dependencies.findPublishedSnapshot;
  if (tickets === undefined || find === undefined) {
    return unavailable("This host does not run published pages.");
  }
  let snapshot: ThreadPublishedSnapshot | undefined;
  try {
    snapshot = await find(windowId, input);
  } catch {
    snapshot = undefined;
  }
  if (snapshot?.format !== "html") return unavailable("That published page is not in this thread.");
  const imported = importCanvasHtmlPage(snapshot.content);
  if (imported.status !== "imported" || imported.block.runsScript !== true) {
    return unavailable("That published page has no script to run.");
  }
  const startFrameId = imported.block.frames[0]?.frameId;
  if (startFrameId === undefined) return unavailable("That published page has nothing to run.");
  const ticket = tickets.issue({
    blockId: imported.block.blockId,
    startFrameId: String(startFrameId),
    block: imported.block,
  });
  return { kind: "ready", page: canvasDesignPagePath(ticket) };
}

/** The prototype a share access asked to run, when it asked for one. */
function sharedDesignRunAsked(body: unknown): CanvasShareAccessRequest["runDesign"] {
  try {
    return decodeCanvasShareAccessRequest(body).runDesign;
  } catch {
    return undefined;
  }
}

/**
 * A running design's page, for the one load its ticket allows. Anything but a
 * plain load of a fresh ticket by a frame is refused with a page that runs
 * nothing, under the same policy.
 */
async function serveDesignPage(
  dependencies: CanvasRouteDependencies,
  request: Request,
  url: URL,
): Promise<Response> {
  const refuse = (status: number) =>
    new Response(request.method === "HEAD" ? null : canvasDesignPageRefusal(), {
      status,
      headers: canvasDesignPageHeaders("text/html; charset=utf-8"),
    });
  if (request.method !== "GET") return refuse(405);
  const keys = [...url.searchParams.keys()];
  const ticket = url.searchParams.get("ticket");
  if (keys.length !== 1 || ticket === null || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) {
    return refuse(400);
  }
  // A browser names what it is loading; the page is only ever a frame.
  const destination = request.headers.get("sec-fetch-dest");
  if (destination !== null && destination !== "iframe") return refuse(403);
  const grant = dependencies.designRunTickets?.redeem(ticket);
  if (grant === undefined) return refuse(403);
  const assets =
    (grant.block.assets ?? []).length === 0 ||
    grant.provenance === undefined ||
    dependencies.resolveDesignAssets === undefined
      ? []
      : await dependencies.resolveDesignAssets(grant.block, grant.provenance);
  // A token is minted only for a frame a browser on this machine is loading:
  // the desktop's prototype host has no route to this host, so its page keeps
  // the policy that names nothing. The switch is read again here, since it
  // may have gone off after the ticket was issued.
  const token =
    grant.network === true && grant.canvasId !== undefined && destination === "iframe"
      ? dependencies.canvasNetwork?.access.issueToken(grant.canvasId)
      : undefined;
  const networkBase =
    token === undefined ? undefined : canvasDesignPageNetworkBase(url.origin, token);
  return new Response(
    renderCanvasDesignPage(grant.block, grant.startFrameId, assets, networkBase),
    { status: 200, headers: canvasDesignPageHeaders("text/html; charset=utf-8", networkBase) },
  );
}

const NETWORK_PROXY_ROUTE_PREFIX = CANVAS_NETWORK_PROXY_PATH_PREFIX.slice("/api/canvas/".length);
const NETWORK_PROXY_ROUTE = /^network\/([A-Za-z0-9_-]{43})\/fetch$/;

/**
 * One fetch on behalf of a running page. The token names the Canvas and is
 * live only while that Canvas's switch is on. The request's cookies, origin,
 * and headers are not read and nothing of them is passed on; the address to
 * fetch is the one thing the page chooses, and the proxy holds it to the
 * destination rule.
 */
async function serveNetworkRequest(
  dependencies: CanvasRouteDependencies,
  request: Request,
  url: URL,
  route: string,
): Promise<Response> {
  const match = NETWORK_PROXY_ROUTE.exec(route);
  const token = match?.[1];
  if (token === undefined) {
    return canvasNetworkProxyResponse({ status: "refused", reason: "invalid-request" });
  }
  const network = dependencies.canvasNetwork;
  // A page's request arrives by address alone. One a session carried here (a
  // paired device's, forwarded by the remote gateway) is not a frame on this
  // machine, whatever token it names.
  const canvasId =
    readPrincipalRouteContext(request) === undefined
      ? network?.access.canvasForToken(token)
      : undefined;
  if (network === undefined || canvasId === undefined) {
    return canvasNetworkProxyResponse({ status: "refused", reason: "token-not-live" });
  }
  if (request.method !== "GET") {
    return canvasNetworkProxyResponse({ status: "refused", reason: "method-not-allowed" });
  }
  // A browser names what it is loading. A script's request is the only kind
  // answered, so a fetched page is never drawn as a document on this origin.
  const destination = request.headers.get("sec-fetch-dest");
  if (destination !== null && destination !== "empty") {
    return canvasNetworkProxyResponse({ status: "refused", reason: "not-a-script-request" });
  }
  const target = url.searchParams.get("url");
  if (url.searchParams.size !== 1 || target === null) {
    return canvasNetworkProxyResponse({ status: "refused", reason: "invalid-request" });
  }
  return canvasNetworkProxyResponse(await network.proxy.fetch(canvasId, target));
}

function toInventoryEntry(
  entry: CanvasProjectionEntry,
  projectId: ProjectId,
): CanvasInventoryEntry {
  const version = entry.currentVersion;
  const provenance = version.definition.provenance;
  return projectInventoryEntryFromProjection({
    canvasId: entry.canvasId,
    projectId,
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
