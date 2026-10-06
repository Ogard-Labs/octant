import {
  decodeCanvasActionResult,
  decodeCanvasGetOutcome,
  decodeCanvasHistoryOutcome,
  decodeCanvasCreateResult,
  decodeCanvasExportDecideResult,
  decodeCanvasExportOfferList,
  decodeCanvasExportPrepareResult,
  decodeCanvasCommentCommandResult,
  decodeCanvasCommentsOutcome,
  decodeCanvasDiagramLayoutReviseResult,
  decodeCanvasInventoryList,
  decodeCanvasThreadReferenceCardsOutcome,
  decodeCanvasReviseResult,
  decodeCanvasRefreshResult,
  decodeCanvasShareAccessResult,
  decodeCanvasShareOverview,
  decodeCanvasShareResult,
  type CanvasActionCancelRequest,
  type CanvasActionRequest,
  type CanvasActionResult,
  type CanvasGetOutcome,
  type CanvasHistoryOutcome,
  type CanvasId,
  type CanvasCreateRequest,
  type CanvasCreateResult,
  type CanvasExportDecideRequest,
  type CanvasExportDecideResult,
  type CanvasExportOfferList,
  type CanvasExportPrepareRequest,
  type CanvasExportPrepareResult,
  type CanvasCommentCommand,
  type CanvasCommentCommandResult,
  type CanvasCommentsOutcome,
  type CanvasDiagramLayoutReviseCommand,
  type CanvasDiagramLayoutReviseResult,
  type CanvasPlanTaskReviseCommand,
  type CanvasInventoryList,
  type CanvasReviseRequest,
  type CanvasReviseResult,
  type CanvasRefreshCancelRequest,
  type CanvasRefreshRequest,
  type CanvasRefreshResult,
  type CanvasShareAccessRequest,
  type CanvasShareAccessResult,
  type CanvasShareOverview,
  type CanvasShareResult,
  type CanvasShareSnapshotRequest,
  type CanvasShareSnapshotRevokeRequest,
  type CanvasThreadReferenceCardsOutcome,
  type OctantMode,
  type ProjectId,
} from "@octant/contracts";
import {
  decodeCanvasExportFolderResult,
  decodeCanvasExportFolderView,
  type CanvasExportFolderCommand,
  type CanvasExportFolderResult,
  type CanvasExportFolderView,
} from "@octant/contracts/canvas-export-folder";
import type { FolderBrowseRequest, FolderBrowseResult } from "@octant/contracts/folder-browse";
import { createFolderBrowseClient } from "./folderBrowseClient";

export interface CanvasClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface CanvasClient {
  inventory(projectId: ProjectId, query?: string): Promise<CanvasInventoryList>;
  get(canvasId: CanvasId, versionId?: string): Promise<CanvasGetOutcome>;
  history(canvasId: CanvasId): Promise<CanvasHistoryOutcome>;
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
   * Destination export. The host renders and holds an approval card; the client
   * only echoes that card back. A host without the route omits these methods.
   */
  exportOffers?(canvasId: CanvasId): Promise<CanvasExportOfferList>;
  prepareExport?(request: CanvasExportPrepareRequest): Promise<CanvasExportPrepareResult>;
  decideExport?(request: CanvasExportDecideRequest): Promise<CanvasExportDecideResult>;
  /**
   * The folder a Canvas exports to, and the host identity and browse mode a
   * person chooses one with. A host without the route offers no folder
   * chooser; the folder destination then stays `not-connected`.
   */
  exportFolder?(canvasId: CanvasId): Promise<CanvasExportFolderView>;
  /** Record the folder a person picked in the host's own browser. */
  chooseExportFolder?(command: CanvasExportFolderCommand): Promise<CanvasExportFolderResult>;
  /**
   * The host's folder browser, reached through this client so a renderer sends
   * the browser's candidate id and never a path of its own.
   */
  browseFolders?(request: FolderBrowseRequest): Promise<FolderBrowseResult>;
  create(request: CanvasCreateRequest): Promise<CanvasCreateResult>;
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
        decodeCanvasInventoryList,
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
        decodeCanvasGetOutcome,
      );
    },
    history(canvasId) {
      const url = new URL("/api/canvas/history", options.baseUrl);
      url.searchParams.set("canvasId", String(canvasId));
      return request(
        options.fetch,
        url.toString(),
        { method: "GET", headers },
        decodeCanvasHistoryOutcome,
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
        decodeCanvasReviseResult,
      );
    },
    comments(canvasId) {
      const url = new URL("/api/canvas/comments", options.baseUrl);
      url.searchParams.set("canvasId", String(canvasId));
      return request(
        options.fetch,
        url.toString(),
        { method: "GET", headers },
        decodeCanvasCommentsOutcome,
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
        decodeCanvasCommentCommandResult,
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
        decodeCanvasDiagramLayoutReviseResult,
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
        decodeCanvasDiagramLayoutReviseResult,
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
        decodeCanvasRefreshResult,
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
        decodeCanvasRefreshResult,
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
        decodeCanvasActionResult,
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
        decodeCanvasActionResult,
      );
    },
    shareOverview(canvasId) {
      const url = new URL("/api/canvas/share", options.baseUrl);
      url.searchParams.set("canvasId", String(canvasId));
      return request(
        options.fetch,
        url.toString(),
        { method: "GET", headers },
        decodeCanvasShareOverview,
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
        decodeCanvasShareResult,
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
        decodeCanvasShareResult,
      );
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
        decodeCanvasShareAccessResult,
      );
    },
    exportOffers(canvasId) {
      const url = new URL("/api/canvas/export-targets", options.baseUrl);
      url.searchParams.set("canvasId", String(canvasId));
      return request(
        options.fetch,
        url.toString(),
        { method: "GET", headers },
        decodeCanvasExportOfferList,
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
        decodeCanvasExportPrepareResult,
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
        decodeCanvasExportDecideResult,
      );
    },
    exportFolder(canvasId) {
      const url = new URL("/api/canvas/export-folder", options.baseUrl);
      url.searchParams.set("canvasId", String(canvasId));
      return request(
        options.fetch,
        url.toString(),
        { method: "GET", headers },
        decodeCanvasExportFolderView,
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
        decodeCanvasExportFolderResult,
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
        decodeCanvasCreateResult,
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
        decodeCanvasThreadReferenceCardsOutcome,
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
