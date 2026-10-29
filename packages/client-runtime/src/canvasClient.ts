import {
  type CanvasActionCancelRequest,
  type CanvasActionRequest,
  CanvasActionResult,
  CanvasDesignAssetsOutcome,
  CanvasGetOutcome,
  CanvasHistoryOutcome,
  type CanvasId,
  type CanvasCreateRequest,
  CanvasCreateResult,
  type CanvasHtmlImportRequest,
  CanvasHtmlImportResult,
  type CanvasExportDecideRequest,
  CanvasExportDecideResult,
  CanvasExportOfferList,
  type CanvasExportPrepareRequest,
  CanvasExportPrepareResult,
  type CanvasHtmlFileRequest,
  CanvasHtmlFileResult,
  type CanvasCommentCommand,
  CanvasCommentCommandResult,
  CanvasCommentsOutcome,
  type CanvasDiagramLayoutReviseCommand,
  CanvasDiagramLayoutReviseResult,
  type CanvasPlanTaskReviseCommand,
  CanvasInventoryList,
  type CanvasReviseRequest,
  CanvasReviseResult,
  type CanvasRefreshCancelRequest,
  type CanvasRefreshRequest,
  CanvasRefreshResult,
  type CanvasShareAccessRequest,
  CanvasShareAccessResult,
  CanvasShareOverview,
  CanvasShareResult,
  type CanvasShareSnapshotRequest,
  type CanvasShareSnapshotRevokeRequest,
  CanvasThreadReferenceCardsOutcome,
  type OctantMode,
  type ProjectId,
  CanvasDesignRunOutcome,
  decodeHostAnswer,
  PublishedSnapshotRunOutcome,
  type PublishedSnapshotRunRequest,
} from "@octant/contracts";
import {
  type CanvasExportFolderCommand,
  CanvasExportFolderResult,
  CanvasExportFolderView,
} from "@octant/contracts/canvas-export-folder";
import {
  CanvasPublicLinkSettings,
  type CanvasPublicLinkSettingsCommand,
  CanvasPublicLinkSettingsResult,
  CanvasPublicShareList,
  type CanvasPublicShareRevokeRequest,
  CanvasPublicShareRevokeResult,
} from "@octant/contracts/canvas-public-share";
import { CanvasDocumentRecipeCatalog } from "@octant/contracts/canvas-skill";
import type { FolderBrowseRequest, FolderBrowseResult } from "@octant/contracts/folder-browse";
import { createFolderBrowseClient } from "./folderBrowseClient";

export interface CanvasClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

/** Where a running design's page loads from, or why it cannot run. */
export type CanvasDesignRunStart =
  | { readonly kind: "ready"; readonly url: string }
  | { readonly kind: "refused"; readonly reason: string };

export interface CanvasClient {
  inventory(projectId: ProjectId, query?: string): Promise<CanvasInventoryList>;
  get(canvasId: CanvasId, versionId?: string): Promise<CanvasGetOutcome>;
  history(canvasId: CanvasId): Promise<CanvasHistoryOutcome>;
  /**
   * One design's declared images, resolved by the host for this reader now.
   * Asked again on every draw; a host without the route omits it and designs
   * draw placeholders.
   */
  designAssets?(input: {
    readonly canvasId: CanvasId;
    readonly versionId: string;
    readonly blockId: string;
  }): Promise<CanvasDesignAssetsOutcome>;
  /**
   * A single-use page for one running design, asked for just before it is
   * loaded. A ready outcome's `url` is the page on this host; a host without
   * the route omits it and running designs say they cannot run here.
   */
  runDesign?(input: {
    readonly canvasId: CanvasId;
    readonly versionId: string;
    readonly blockId: string;
    readonly frameId?: string;
  }): Promise<CanvasDesignRunStart>;
  /**
   * A single-use page for the snapshot of a page a Work or Code thread
   * published, built by the host from that thread's own journal. A host
   * without the route omits it and such a page says it cannot run here.
   */
  runPublishedSnapshot?(input: PublishedSnapshotRunRequest): Promise<CanvasDesignRunStart>;
  revise(request: CanvasReviseRequest): Promise<CanvasReviseResult>;
  /**
   * Journal a user's node positions as a new immutable version of a board.
   * Optional like the other board-era methods: a transport whose host serves
   * no layout route leaves the board readable but not draggable.
   */
  reviseDiagramLayout?(
    command: CanvasDiagramLayoutReviseCommand,
  ): Promise<CanvasDiagramLayoutReviseResult>;
  /**
   * Journal a person's change to one plan task's status as a new version.
   * Optional: a host without the route leaves plans readable but fixed.
   */
  revisePlanTask?(command: CanvasPlanTaskReviseCommand): Promise<CanvasDiagramLayoutReviseResult>;
  /** Comments on a Canvas and the commands that change them; host-journaled. */
  comments?(canvasId: CanvasId): Promise<CanvasCommentsOutcome>;
  comment?(command: CanvasCommentCommand): Promise<CanvasCommentCommandResult>;
  refresh?(request: CanvasRefreshRequest, signal?: AbortSignal): Promise<CanvasRefreshResult>;
  cancelRefresh?(request: CanvasRefreshCancelRequest): Promise<CanvasRefreshResult>;
  executeAction?(request: CanvasActionRequest, signal?: AbortSignal): Promise<CanvasActionResult>;
  cancelAction?(request: CanvasActionCancelRequest): Promise<CanvasActionResult>;
  /**
   * Canvas sharing. The host publishes what is shared and who owns it; the
   * client only echoes those values back, and the server re-checks every one of
   * them before a snapshot exists, is revoked, or is served. A transport whose
   * host has no share authority simply omits these methods.
   */
  shareOverview?(canvasId: CanvasId): Promise<CanvasShareOverview>;
  share?(request: CanvasShareSnapshotRequest): Promise<CanvasShareResult>;
  revokeShare?(request: CanvasShareSnapshotRevokeRequest): Promise<CanvasShareResult>;
  accessShare?(request: CanvasShareAccessRequest): Promise<CanvasShareAccessResult>;
  /**
   * The address of a prototype page an allowed share access named
   * (`designPage`), on this client's host. Absent on a transport that cannot
   * load one, where a shared prototype says it cannot run.
   */
  sharedDesignPageUrl?(path: string): string;
  /**
   * Destination export. The host renders and holds an approval card; the client
   * only echoes that card back. A host without the route omits these methods.
   */
  exportOffers?(canvasId: CanvasId): Promise<CanvasExportOfferList>;
  prepareExport?(request: CanvasExportPrepareRequest): Promise<CanvasExportPrepareResult>;
  decideExport?(request: CanvasExportDecideRequest): Promise<CanvasExportDecideResult>;
  /**
   * The Canvas as one self-contained HTML file for this window to save or
   * copy. The host renders it under the read check; it goes to no
   * destination. A host without the route omits it.
   */
  htmlFile?(request: CanvasHtmlFileRequest): Promise<CanvasHtmlFileResult>;
  /** A person's one click: the host derives and journals a deck from the Canvas. */
  proposeDeck?(body: unknown): Promise<CanvasDiagramLayoutReviseResult>;
  /**
   * The folder a Canvas exports to, and the host identity and browse mode a
   * person chooses one with. A host without the route offers no folder
   * chooser; the folder destination then stays `not-connected`.
   */
  exportFolder?(canvasId: CanvasId): Promise<CanvasExportFolderView>;
  /** Record the folder a person picked in the host's own browser. */
  chooseExportFolder?(command: CanvasExportFolderCommand): Promise<CanvasExportFolderResult>;
  /**
   * Public links. The host keeps the record of each link and the owner
   * secret; a window reads the list, revokes one, and reads or changes the
   * Settings switch and service address.
   */
  publicShares?(canvasId: CanvasId): Promise<CanvasPublicShareList>;
  revokePublicShare?(
    request: CanvasPublicShareRevokeRequest,
  ): Promise<CanvasPublicShareRevokeResult>;
  publicLinkSettings?(): Promise<CanvasPublicLinkSettings>;
  setPublicLinkSettings?(
    command: CanvasPublicLinkSettingsCommand,
  ): Promise<CanvasPublicLinkSettingsResult>;
  /**
   * The host's folder browser, reached through this client so a renderer sends
   * the browser's candidate id and never a path of its own.
   */
  browseFolders?(request: FolderBrowseRequest): Promise<FolderBrowseResult>;
  create(request: CanvasCreateRequest): Promise<CanvasCreateResult>;
  /**
   * A new Canvas from an HTML page the person chose or pasted. A host without
   * the route omits it, and no import is offered.
   */
  importHtml?(request: CanvasHtmlImportRequest): Promise<CanvasHtmlImportResult>;
  /**
   * The recipes a person may start a Canvas from. A host without the route
   * omits it, and the chooser then offers only a blank Canvas.
   */
  recipes?(): Promise<CanvasDocumentRecipeCatalog>;
  threadReferenceCards(input: {
    readonly mode: OctantMode;
    readonly threadId: string;
    readonly projectId: ProjectId | null;
  }): Promise<CanvasThreadReferenceCardsOutcome>;
}

export class CanvasClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "CanvasClientFailure";
    this.status = status;
  }
}

export function createCanvasClient(options: CanvasClientOptions): CanvasClient {
  const headers = { "x-octant-window-capability": options.windowCapability };
  return {
    inventory(projectId, query) {
      const url = new URL("/api/canvas/inventory", options.baseUrl);
      url.searchParams.set("projectId", String(projectId));
      if (query !== undefined && query.trim().length > 0) url.searchParams.set("query", query);
      return request(
        options.fetch,
        url.toString(),
        { method: "GET", headers },
        decodeHostAnswer(CanvasInventoryList),
      );
    },
    get(canvasId, versionId) {
      const url = new URL("/api/canvas/get", options.baseUrl);
      url.searchParams.set("canvasId", String(canvasId));
      if (versionId !== undefined) url.searchParams.set("versionId", versionId);
      return request(
        options.fetch,
        url.toString(),
        { method: "GET", headers },
        decodeHostAnswer(CanvasGetOutcome),
      );
    },
    designAssets(input) {
      const url = new URL("/api/canvas/design-assets", options.baseUrl);
      url.searchParams.set("canvasId", String(input.canvasId));
      url.searchParams.set("versionId", input.versionId);
      url.searchParams.set("blockId", input.blockId);
      return request(
        options.fetch,
        url.toString(),
        { method: "GET", headers, cache: "no-store" },
        decodeHostAnswer(CanvasDesignAssetsOutcome),
      );
    },
    async runDesign(input) {
      const outcome = await request(
        options.fetch,
        new URL("/api/canvas/design-run", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          cache: "no-store",
          body: JSON.stringify({
            canvasId: String(input.canvasId),
            versionId: input.versionId,
            blockId: input.blockId,
            ...(input.frameId === undefined ? {} : { frameId: input.frameId }),
          }),
        },
        decodeHostAnswer(CanvasDesignRunOutcome),
      );
      return outcome.kind === "ready"
        ? { kind: "ready", url: new URL(outcome.page, options.baseUrl).toString() }
        : {
            kind: "refused",
            reason:
              outcome.kind === "unavailable"
                ? outcome.reason
                : "This prototype is not available in this workspace.",
          };
    },
    async runPublishedSnapshot(input) {
      const outcome = await request(
        options.fetch,
        new URL("/api/canvas/published-snapshot-run", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          cache: "no-store",
          body: JSON.stringify(input),
        },
        decodeHostAnswer(PublishedSnapshotRunOutcome),
      );
      return outcome.kind === "ready"
        ? { kind: "ready", url: new URL(outcome.page, options.baseUrl).toString() }
        : { kind: "refused", reason: outcome.reason };
    },
    history(canvasId) {
      const url = new URL("/api/canvas/history", options.baseUrl);
      url.searchParams.set("canvasId", String(canvasId));
      return request(
        options.fetch,
        url.toString(),
        { method: "GET", headers },
        decodeHostAnswer(CanvasHistoryOutcome),
      );
    },
    revise(body) {
      return request(
        options.fetch,
        new URL("/api/canvas/revise", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        decodeHostAnswer(CanvasReviseResult),
      );
    },
    comments(canvasId) {
      const url = new URL("/api/canvas/comments", options.baseUrl);
      url.searchParams.set("canvasId", String(canvasId));
      return request(
        options.fetch,
        url.toString(),
        { method: "GET", headers },
        decodeHostAnswer(CanvasCommentsOutcome),
      );
    },
    comment(body) {
      return request(
        options.fetch,
        new URL("/api/canvas/comment", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        decodeHostAnswer(CanvasCommentCommandResult),
      );
    },
    reviseDiagramLayout(body) {
      return request(
        options.fetch,
        new URL("/api/canvas/layout-revise", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        decodeHostAnswer(CanvasDiagramLayoutReviseResult),
      );
    },
    revisePlanTask(body) {
      return request(
        options.fetch,
        new URL("/api/canvas/plan-revise", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        decodeHostAnswer(CanvasDiagramLayoutReviseResult),
      );
    },
    proposeDeck(body) {
      return request(
        options.fetch,
        new URL("/api/canvas/deck-propose", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        decodeHostAnswer(CanvasDiagramLayoutReviseResult),
      );
    },
    refresh(body, signal) {
      return request(
        options.fetch,
        new URL("/api/canvas/refresh", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
          ...(signal === undefined ? {} : { signal }),
        },
        decodeHostAnswer(CanvasRefreshResult),
      );
    },
    cancelRefresh(body) {
      return request(
        options.fetch,
        new URL("/api/canvas/refresh-cancel", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        decodeHostAnswer(CanvasRefreshResult),
      );
    },
    executeAction(body, signal) {
      return request(
        options.fetch,
        new URL("/api/canvas/action", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
          ...(signal === undefined ? {} : { signal }),
        },
        decodeHostAnswer(CanvasActionResult),
      );
    },
    cancelAction(body) {
      return request(
        options.fetch,
        new URL("/api/canvas/action-cancel", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        decodeHostAnswer(CanvasActionResult),
      );
    },
    shareOverview(canvasId) {
      const url = new URL("/api/canvas/share", options.baseUrl);
      url.searchParams.set("canvasId", String(canvasId));
      return request(
        options.fetch,
        url.toString(),
        { method: "GET", headers },
        decodeHostAnswer(CanvasShareOverview),
      );
    },
    share(body) {
      return request(
        options.fetch,
        new URL("/api/canvas/share", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        decodeHostAnswer(CanvasShareResult),
      );
    },
    revokeShare(body) {
      return request(
        options.fetch,
        new URL("/api/canvas/share-revoke", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        decodeHostAnswer(CanvasShareResult),
      );
    },
    sharedDesignPageUrl(path) {
      return new URL(path, options.baseUrl).toString();
    },
    accessShare(body) {
      return request(
        options.fetch,
        new URL("/api/canvas/share-access", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        decodeHostAnswer(CanvasShareAccessResult),
      );
    },
    exportOffers(canvasId) {
      const url = new URL("/api/canvas/export-targets", options.baseUrl);
      url.searchParams.set("canvasId", String(canvasId));
      return request(
        options.fetch,
        url.toString(),
        { method: "GET", headers },
        decodeHostAnswer(CanvasExportOfferList),
      );
    },
    prepareExport(body) {
      return request(
        options.fetch,
        new URL("/api/canvas/export-prepare", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        decodeHostAnswer(CanvasExportPrepareResult),
      );
    },
    decideExport(body) {
      return request(
        options.fetch,
        new URL("/api/canvas/export-decide", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        decodeHostAnswer(CanvasExportDecideResult),
      );
    },
    htmlFile(body) {
      return request(
        options.fetch,
        new URL("/api/canvas/html-file", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        decodeHostAnswer(CanvasHtmlFileResult),
      );
    },
    publicShares(canvasId) {
      const url = new URL("/api/canvas/public-shares", options.baseUrl);
      url.searchParams.set("canvasId", String(canvasId));
      return request(
        options.fetch,
        url.toString(),
        { method: "GET", headers },
        decodeHostAnswer(CanvasPublicShareList),
      );
    },
    revokePublicShare(body) {
      return request(
        options.fetch,
        new URL("/api/canvas/public-share-revoke", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        decodeHostAnswer(CanvasPublicShareRevokeResult),
      );
    },
    publicLinkSettings() {
      return request(
        options.fetch,
        new URL("/api/canvas/public-link-settings", options.baseUrl).toString(),
        { method: "GET", headers },
        decodeHostAnswer(CanvasPublicLinkSettings),
      );
    },
    setPublicLinkSettings(body) {
      return request(
        options.fetch,
        new URL("/api/canvas/public-link-settings", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        decodeHostAnswer(CanvasPublicLinkSettingsResult),
      );
    },
    exportFolder(canvasId) {
      const url = new URL("/api/canvas/export-folder", options.baseUrl);
      url.searchParams.set("canvasId", String(canvasId));
      return request(
        options.fetch,
        url.toString(),
        { method: "GET", headers },
        decodeHostAnswer(CanvasExportFolderView),
      );
    },
    chooseExportFolder(body) {
      return request(
        options.fetch,
        new URL("/api/canvas/export-folder", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        decodeHostAnswer(CanvasExportFolderResult),
      );
    },
    browseFolders(body) {
      return createFolderBrowseClient({
        baseUrl: options.baseUrl,
        fetch: options.fetch,
        windowCapability: options.windowCapability,
      }).browse(body);
    },
    create(body) {
      return request(
        options.fetch,
        new URL("/api/canvas/create", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        decodeHostAnswer(CanvasCreateResult),
      );
    },
    importHtml(body) {
      return request(
        options.fetch,
        new URL("/api/canvas/import-html", options.baseUrl).toString(),
        {
          method: "POST",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        decodeHostAnswer(CanvasHtmlImportResult),
      );
    },
    recipes() {
      return request(
        options.fetch,
        new URL("/api/canvas/recipes", options.baseUrl).toString(),
        { method: "GET", headers },
        decodeHostAnswer(CanvasDocumentRecipeCatalog),
      );
    },
    threadReferenceCards(input) {
      const url = new URL("/api/canvas/thread-reference-cards", options.baseUrl);
      url.searchParams.set("mode", input.mode);
      url.searchParams.set("threadId", input.threadId);
      url.searchParams.set(
        "projectId",
        input.projectId === null ? "null" : String(input.projectId),
      );
      return request(
        options.fetch,
        url.toString(),
        { method: "GET", headers },
        decodeHostAnswer(CanvasThreadReferenceCardsOutcome),
      );
    },
  };
}

async function request<T>(
  fetchImpl: typeof globalThis.fetch,
  url: string,
  init: RequestInit,
  decode: (value: unknown) => T,
): Promise<T> {
  const response = await fetchImpl(url, init);
  const text = await response.text();
  let body: unknown;
  try {
    body = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    throw new CanvasClientFailure("Canvas response was not valid JSON.", response.status);
  }
  if (!response.ok) {
    const message =
      typeof body === "object" &&
      body !== null &&
      "message" in body &&
      typeof (body as { message: unknown }).message === "string"
        ? (body as { message: string }).message
        : "Canvas request failed.";
    throw new CanvasClientFailure(message, response.status);
  }
  try {
    return decode(body);
  } catch {
    throw new CanvasClientFailure("Canvas response did not match the contract.", response.status);
  }
}
