/**
 * The host's HTTPS call port for cloud desktop drivers.
 *
 * A cloud driver reaches its provider only through this port. The host checks
 * the URL against the hosts the driver declares in code before anything
 * else, attaches the recipe's API key itself and only when a lease of this
 * provider recorded that credential reference, refuses redirects, and bounds
 * every call in time and bytes. The key never reaches the driver, and nothing
 * here logs a URL, a header, or a body.
 */
import type { DesktopCredentialRef } from "@octant/contracts";
import {
  desktopProviderHostDeclared,
  type DesktopHttpsPort,
  type DesktopHttpsResult,
} from "@octant/plugin-api/desktop-provider";

export type DesktopHttpsFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface DesktopHttpsPortOptions {
  /** The hosts the driver declares in its code. */
  readonly hosts: () => ReadonlyArray<string>;
  /**
   * Whether a lease of this provider recorded `ref`. A driver may name only
   * a credential the person gave this provider, never another provider's.
   */
  readonly credentialPermitted: (ref: DesktopCredentialRef) => boolean;
  /** Reads the key from the host credential store; undefined when it holds none. */
  readonly credential: (ref: DesktopCredentialRef) => Promise<string | undefined>;
  readonly fetch?: DesktopHttpsFetch;
  readonly timeoutMs?: number;
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
}

/** One call, start to last byte. A teardown call is bounded at 60 seconds above this. */
const DEFAULT_TIMEOUT_MS = 45_000;
/** A transfer's largest file with room for a multipart envelope. */
const DEFAULT_MAX_REQUEST_BYTES = 128 * 1024 * 1024 + 1_048_576;
/** A frame of the largest screen a recipe allows, uncompressed, with room to spare. */
const DEFAULT_MAX_RESPONSE_BYTES = 7_680 * 4_320 * 4 + 4_320 + 1_048_576;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;
/** Headers the host owns: the transport's own framing and anything that could carry another identity. */
const HOST_OWNED_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "cookie",
  "proxy-authorization",
]);

const refused = (
  reason: Extract<DesktopHttpsResult, { readonly status: "refused" }>["reason"],
): DesktopHttpsResult => ({ status: "refused", reason });
const failed = (
  reason: Extract<DesktopHttpsResult, { readonly status: "failed" }>["reason"],
): DesktopHttpsResult => ({ status: "failed", reason });

export function createDesktopHttpsPort(options: DesktopHttpsPortOptions): DesktopHttpsPort {
  const fetch: DesktopHttpsFetch =
    options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRequestBytes = options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;

  return {
    request: async (request) => {
      if (request.signal?.aborted === true) return { status: "cancelled" };
      // Checked before any credential is read: the driver chooses the URL, so
      // the host decides where anything may go.
      if (!desktopProviderHostDeclared(request.url, options.hosts())) {
        return refused("host-not-declared");
      }
      const bodyBytes =
        request.body === undefined
          ? 0
          : typeof request.body === "string"
            ? Buffer.byteLength(request.body, "utf8")
            : request.body.byteLength;
      if (bodyBytes > maxRequestBytes) return refused("request-too-large");
      if (request.body !== undefined && request.method === "GET") return refused("request-invalid");
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers ?? {})) {
        if (!HEADER_NAME.test(name) || HOST_OWNED_HEADERS.has(name.toLowerCase())) {
          return refused("request-invalid");
        }
        try {
          headers.set(name, value);
        } catch {
          return refused("request-invalid");
        }
      }
      if (request.credential !== undefined) {
        const { ref, header, scheme } = request.credential;
        if (!HEADER_NAME.test(header) || HOST_OWNED_HEADERS.has(header.toLowerCase())) {
          return refused("request-invalid");
        }
        if (!options.credentialPermitted(ref)) return refused("credential-not-permitted");
        const key = await options.credential(ref).catch(() => undefined);
        if (key === undefined || key.length === 0) return refused("credential-missing");
        try {
          headers.set(header, scheme === undefined ? key : `${scheme} ${key}`);
        } catch {
          return refused("credential-missing");
        }
      }

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const cancel = () => controller.abort();
      request.signal?.addEventListener("abort", cancel, { once: true });
      const interrupted = (): DesktopHttpsResult =>
        timedOut ? failed("timed-out") : { status: "cancelled" };
      try {
        let response: Response;
        try {
          response = await fetch(request.url, {
            method: request.method,
            headers,
            redirect: "manual",
            signal: controller.signal,
            ...(request.body === undefined
              ? {}
              : {
                  body:
                    typeof request.body === "string" ? request.body : new Uint8Array(request.body),
                }),
          });
        } catch {
          return controller.signal.aborted ? interrupted() : failed("unreachable");
        }
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel().catch(() => undefined);
          return failed("redirected");
        }
        const limit = Math.min(Math.max(0, request.maxResponseBytes), maxResponseBytes);
        const body = await readBounded(response, limit);
        if (body === "too-large") return failed("response-too-large");
        if (body === "interrupted") {
          return controller.signal.aborted ? interrupted() : failed("unreachable");
        }
        const answeredHeaders: Record<string, string> = {};
        response.headers.forEach((value, name) => {
          answeredHeaders[name.toLowerCase()] = value;
        });
        return {
          status: "answered",
          httpStatus: response.status,
          headers: answeredHeaders,
          body,
        };
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", cancel);
      }
    },
  };
}

/** Reads a response body whole, stopping at `limit` bytes. */
async function readBounded(
  response: Response,
  limit: number,
): Promise<Uint8Array | "too-large" | "interrupted"> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && Number(declared) > limit) {
    await response.body?.cancel().catch(() => undefined);
    return "too-large";
  }
  if (response.body === null) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return "too-large";
      }
      chunks.push(value);
    }
  } catch {
    return "interrupted";
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
