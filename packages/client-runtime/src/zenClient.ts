import {
  decodeZenCommand,
  decodeZenBootstrapResponse,
  decodeZenResult,
  decodeZenTerminalAttachRequest,
  decodeZenTerminalAttachResult,
  decodeZenThreadAttachRequest,
  decodeZenThreadAttachResult,
  decodeZenThreadCatalogRef,
  decodeZenThreadCatalogResponse,
  decodeZenThreadContinuationTarget,
  decodeZenAssistantSnapshot,
  decodeZenSpace,
  decodeZenFocusZoneCommand,
  decodeZenFocusZoneResult,
  type ZenCommand,
  type ZenBootstrapResponse,
  type ZenResult,
  type ZenTerminalAttachRequest,
  type ZenTerminalAttachResult,
  type ZenThreadAttachRequest,
  type ZenThreadAttachResult,
  type ZenThreadCatalogRef,
  type ZenThreadCatalogResponse,
  type ZenThreadContinuationTarget,
  type ZenAssistantSnapshot,
  type ZenBackgroundAssetId,
  type ZenSpace,
  type ZenSpaceId,
  type ZenFocusZoneCommand,
  type ZenFocusZoneResult,
} from "@octant/contracts/zen";
import { bindFetchPort } from "./bindFetchPort";

export interface ZenClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
}

export interface ZenClient {
  bootstrap(): Promise<ZenBootstrapResponse>;
  command(command: ZenCommand): Promise<ZenResult>;
  /**
   * Adds, renames, reorders, removes, or switches the spaces this window holds.
   * Separate from `command`, which acts on whichever space is in front.
   */
  space(command: ZenFocusZoneCommand): Promise<ZenFocusZoneResult>;
  searchThreads(query?: string): Promise<ZenThreadCatalogResponse>;
  attachThread(request: ZenThreadAttachRequest): Promise<ZenThreadAttachResult>;
  /**
   * Pins a terminal one of this window's Code threads owns. The request names
   * the terminal; the card itself is written by the server.
   */
  attachTerminal(request: ZenTerminalAttachRequest): Promise<ZenTerminalAttachResult>;
  continueThread(catalogRef: ZenThreadCatalogRef): Promise<ZenThreadContinuationTarget>;
  assistant(): Promise<ZenAssistantSnapshot>;
  /**
   * Opens this window's Zen assistant surface on the conversation it is a
   * front on. Turns themselves go to the host's Navigator command surface;
   * Zen has no turn endpoint of its own.
   */
  ensureAssistant(): Promise<ZenAssistantSnapshot>;
  uploadBackground(input: {
    readonly spaceId: ZenSpaceId;
    readonly expectedVersion: number;
    readonly bytes: Uint8Array;
    readonly mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif";
    readonly displayName: string;
  }): Promise<ZenSpace>;
  readBackground(assetId: ZenBackgroundAssetId): Promise<Blob>;
}

export class ZenClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ZenClientFailure";
    this.status = status;
  }
}

export function createZenClient(options: ZenClientOptions): ZenClient {
  validateLoopbackBaseUrl(options.baseUrl);
  const fetch = bindFetchPort(options.fetch);

  return {
    async bootstrap(): Promise<ZenBootstrapResponse> {
      const url = new URL("/api/zen", options.baseUrl);
      let response: Response;
      try {
        response = await fetch(url.toString(), {
          method: "GET",
          headers: { "x-octant-window-capability": options.windowCapability },
        });
      } catch {
        throw new ZenClientFailure("Zen is unavailable.", 0);
      }

      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new ZenClientFailure(zenErrorMessage(body), response.status);
      }

      return decodeZenBootstrapResponse(body);
    },

    async command(cmd: ZenCommand): Promise<ZenResult> {
      const command = decodeZenCommand(cmd);
      const url = new URL("/api/zen/command", options.baseUrl);
      let response: Response;
      try {
        response = await fetch(url.toString(), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-octant-window-capability": options.windowCapability,
          },
          body: JSON.stringify(command),
        });
      } catch {
        throw new ZenClientFailure("Zen command is unavailable.", 0);
      }

      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new ZenClientFailure(zenErrorMessage(body), response.status);
      }

      return decodeZenResult(body);
    },

    async space(cmd: ZenFocusZoneCommand): Promise<ZenFocusZoneResult> {
      const command = decodeZenFocusZoneCommand(cmd);
      const url = new URL("/api/zen/spaces", options.baseUrl);
      const body = await zenRequest(fetch, url, options.windowCapability, {
        method: "POST",
        body: JSON.stringify(command),
        contentType: true,
      });
      return decodeZenFocusZoneResult(body);
    },

    async searchThreads(query = ""): Promise<ZenThreadCatalogResponse> {
      const url = new URL("/api/zen/threads", options.baseUrl);
      if (query.trim().length > 0) url.searchParams.set("q", query.trim());
      const body = await zenRequest(fetch, url, options.windowCapability, { method: "GET" });
      return decodeZenThreadCatalogResponse(body);
    },

    async attachThread(request: ZenThreadAttachRequest): Promise<ZenThreadAttachResult> {
      const input = decodeZenThreadAttachRequest(request);
      const url = new URL("/api/zen/threads/attach", options.baseUrl);
      const body = await zenRequest(fetch, url, options.windowCapability, {
        method: "POST",
        body: JSON.stringify(input),
        contentType: true,
      });
      return decodeZenThreadAttachResult(body);
    },

    async attachTerminal(request: ZenTerminalAttachRequest): Promise<ZenTerminalAttachResult> {
      const input = decodeZenTerminalAttachRequest(request);
      const url = new URL("/api/zen/terminals/attach", options.baseUrl);
      const body = await zenRequest(fetch, url, options.windowCapability, {
        method: "POST",
        body: JSON.stringify(input),
        contentType: true,
      });
      return decodeZenTerminalAttachResult(body);
    },

    async continueThread(catalogRef: ZenThreadCatalogRef): Promise<ZenThreadContinuationTarget> {
      const exact = decodeZenThreadCatalogRef(catalogRef);
      const url = new URL("/api/zen/threads/continue", options.baseUrl);
      url.searchParams.set("ref", exact);
      const body = await zenRequest(fetch, url, options.windowCapability, { method: "GET" });
      return decodeZenThreadContinuationTarget(body);
    },

    async assistant(): Promise<ZenAssistantSnapshot> {
      const url = new URL("/api/zen/assistant", options.baseUrl);
      const body = await zenRequest(fetch, url, options.windowCapability, { method: "GET" });
      return decodeZenAssistantSnapshot(body);
    },

    async ensureAssistant(): Promise<ZenAssistantSnapshot> {
      const url = new URL("/api/zen/assistant", options.baseUrl);
      const body = await zenRequest(fetch, url, options.windowCapability, { method: "POST" });
      return decodeZenAssistantSnapshot(body);
    },

    async uploadBackground(input): Promise<ZenSpace> {
      const url = new URL("/api/zen/backgrounds", options.baseUrl);
      let response: Response;
      try {
        response = await fetch(url.toString(), {
          method: "POST",
          headers: {
            "content-type": input.mediaType,
            "x-octant-window-capability": options.windowCapability,
            "x-octant-zen-space-id": input.spaceId,
            "x-octant-zen-expected-version": String(input.expectedVersion),
            "x-octant-zen-background-display-name": input.displayName,
          },
          body: input.bytes as unknown as BodyInit,
        });
      } catch {
        throw new ZenClientFailure("Zen background upload is unavailable.", 0);
      }
      const body: unknown = await response.json().catch(() => ({}));
      if (!response.ok) throw new ZenClientFailure(zenErrorMessage(body), response.status);
      if (typeof body !== "object" || body === null || !("space" in body)) {
        throw new ZenClientFailure("Zen background response is invalid.", response.status);
      }
      return decodeZenSpace(body.space);
    },

    async readBackground(assetId: ZenBackgroundAssetId): Promise<Blob> {
      const url = new URL(`/api/zen/backgrounds/${assetId}`, options.baseUrl);
      let response: Response;
      try {
        response = await fetch(url.toString(), {
          method: "GET",
          headers: { "x-octant-window-capability": options.windowCapability },
        });
      } catch {
        throw new ZenClientFailure("Zen background is unavailable.", 0);
      }
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => ({}));
        throw new ZenClientFailure(zenErrorMessage(body), response.status);
      }
      return await response.blob();
    },
  };
}

async function zenRequest(
  fetch: typeof globalThis.fetch,
  url: URL,
  windowCapability: string,
  input: { readonly method: "GET" | "POST"; readonly body?: string; readonly contentType?: true },
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url.toString(), {
      method: input.method,
      headers: {
        ...(input.contentType === true ? { "content-type": "application/json" } : {}),
        "x-octant-window-capability": windowCapability,
      },
      ...(input.body === undefined ? {} : { body: input.body }),
    });
  } catch {
    throw new ZenClientFailure("Zen is unavailable.", 0);
  }
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw new ZenClientFailure(zenErrorMessage(body), response.status);
  return body;
}

function zenErrorMessage(body: unknown): string {
  if (
    typeof body === "object" &&
    body !== null &&
    "error" in body &&
    typeof body.error === "string"
  ) {
    return body.error;
  }
  return "Zen request failed.";
}

function validateLoopbackBaseUrl(baseUrl: string): void {
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new ZenClientFailure("Zen base URL must use http or https.", 0);
    }
  } catch (err) {
    if (err instanceof ZenClientFailure) throw err;
    throw new ZenClientFailure("Zen base URL is invalid.", 0);
  }
}
