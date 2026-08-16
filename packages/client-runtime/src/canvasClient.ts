import {
  decodeCanvasActionResult,
  decodeCanvasGetOutcome,
  decodeCanvasHistoryOutcome,
  decodeCanvasCreateResult,
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
