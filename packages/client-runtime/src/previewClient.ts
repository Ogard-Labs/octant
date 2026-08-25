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
  type PreviewHandoffKind,
  type PreviewHandoffReply,
  type PreviewOutcome,
  type PreviewSourceVersion,
  type PreviewTarget,
} from "@octant/contracts/previews";
import { bindFetchPort } from "./bindFetchPort";

export interface PreviewClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly windowCapability: string;
  /**
   * Maximum number of chunk pages requested per `readChunks` call. The server
   * caps the reply at this many chunks; the caller drains pages until a final
   * chunk is observed. Defaults to 16.
   */
  readonly maxChunksPerPage?: number;
}

export interface PreviewClient {
  open(target: PreviewTarget, knownVersion?: PreviewSourceVersion): Promise<PreviewOutcome>;
  refresh(target: PreviewTarget, knownVersion: PreviewSourceVersion): Promise<PreviewOutcome>;
  readChunks(
    target: PreviewTarget,
    sourceVersion: PreviewSourceVersion,
    afterSequence: number,
    signal?: AbortSignal,
  ): Promise<PreviewChunksReply>;
  cancel(target: PreviewTarget): Promise<PreviewCancelReply>;
  /**
   * Request an authenticated external-application handoff (Finder reveal,
   * Quick Look, or open-external) for the opaque target. The reply never
   * carries a host path; the native desktop executes the affordance through
   * the desktop-authenticated bridge after this authorization check.
   * An optional AbortSignal cancels the in-flight authorization request.
   */
  handoff(
    target: PreviewTarget,
    kind: PreviewHandoffKind,
    signal?: AbortSignal,
  ): Promise<PreviewHandoffReply>;
}

export class PreviewClientFailure extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "PreviewClientFailure";
    this.status = status;
  }
}

export function createPreviewClient(options: PreviewClientOptions): PreviewClient {
  const resolved = { ...options, fetch: bindFetchPort(options.fetch) };
  validateLoopbackBaseUrl(options.baseUrl);
  const maxChunksPerPage = options.maxChunksPerPage ?? 16;
  return {
    async open(target, knownVersion) {
      const body = decodePreviewOpenRequest(
        knownVersion === undefined ? { target } : { target, knownVersion },
      );
      return postJson(resolved, "/api/preview/open", body, decodePreviewOutcome);
    },
    async refresh(target, knownVersion) {
      const body = decodePreviewRefreshRequest({ target, knownVersion });
      return postJson(resolved, "/api/preview/refresh", body, decodePreviewOutcome);
    },
    async readChunks(target, sourceVersion, afterSequence, signal) {
      const body = decodePreviewChunksRequest({
        target,
        sourceVersion,
        afterSequence,
        maxChunks: maxChunksPerPage,
      });
      return postJson(resolved, "/api/preview/chunks", body, decodePreviewChunksReply, signal);
    },
    async cancel(target) {
      const body = decodePreviewCancelRequest({ target });
      return postJson(resolved, "/api/preview/cancel", body, decodePreviewCancelReply);
    },
    async handoff(target, kind, signal) {
      const body = decodePreviewHandoffRequest({ target, kind });
      return postJson(resolved, "/api/preview/handoff", body, decodePreviewHandoffReply, signal);
    },
  };
}

async function postJson<T>(
  options: PreviewClientOptions,
  path: string,
  body: unknown,
  decode: (value: unknown) => T,
  signal?: AbortSignal,
): Promise<T> {
  const url = new URL(path, options.baseUrl).toString();
  let response: Response;
  try {
    response = await options.fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-octant-window-capability": options.windowCapability,
      },
      body: JSON.stringify(body),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch {
    throw new PreviewClientFailure("Preview request is unavailable.", 0);
  }
  const text = await response.text().catch(() => "");
  if (!response.ok) {
    const message = extractMessage(text) ?? "Preview request failed.";
    throw new PreviewClientFailure(message, response.status);
  }
  try {
    return decode(JSON.parse(text));
  } catch {
    throw new PreviewClientFailure("Preview reply is invalid.", response.status);
  }
}

function extractMessage(text: string): string | undefined {
  if (text === "") return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "message" in parsed &&
      typeof (parsed as { message: unknown }).message === "string"
    ) {
      return (parsed as { message: string }).message;
    }
  } catch {
    // fall through
  }
  return undefined;
}

function validateLoopbackBaseUrl(baseUrl: string): void {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new PreviewClientFailure("Preview base URL is invalid.", 0);
  }
  const host = url.hostname;
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new PreviewClientFailure("Preview base URL must be loopback.", 0);
  }
}
