import { RemoteConnectionError } from "./remoteConnection";
import type { RemoteSessionBridge } from "./remoteSessionBridge";

/**
 * The loopback launch capability. Every product client attaches it because a
 * desktop window authenticates that way; a paired device authenticates with
 * its session and per-request device proof instead, and must never present a
 * window identity — the server would either ignore it or, on a route that
 * reads the header directly, refuse the request for a capability it cannot
 * verify.
 */
const WINDOW_CAPABILITY_HEADER = "x-octant-window-capability";

export interface RemoteProductFetchOptions {
  readonly bridge: RemoteSessionBridge;
}

/**
 * A `fetch` that carries product requests over the authenticated remote
 * session, so the ordinary Chat, Work, and Code clients can drive a paired
 * host without knowing they are remote.
 *
 * The connection owns the destination: every request goes to the origin the
 * device paired with, and only the path and query of the caller's URL are
 * used. Several clients insist on a loopback base URL because a capability
 * header must never leave the machine; that base URL is a URL-building
 * convenience here, since no capability travels with these requests. Only
 * `/api/` paths are admitted. When the session is stale or gone the request
 * is refused rather than queued; the caller sees the failure and the
 * composer keeps its draft.
 */
export function createRemoteProductFetch(
  options: RemoteProductFetchOptions,
): typeof globalThis.fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined;
    const url = new URL(request?.url ?? (input instanceof URL ? input.href : String(input)));
    if (!url.pathname.startsWith("/api/")) {
      throw new RemoteConnectionError(
        "invalid",
        "Remote product requests must target the paired host's API.",
      );
    }
    const connection = options.bridge.connection();
    if (connection === undefined || connection.session() === undefined) {
      throw new RemoteConnectionError(
        "unauthorized",
        "Octant is disconnected. Reconnect before sending changes.",
      );
    }
    const headers = new Headers(init?.headers ?? request?.headers);
    headers.delete(WINDOW_CAPABILITY_HEADER);
    const contentType = headers.get("content-type") ?? undefined;
    headers.delete("content-type");
    const forwarded: Record<string, string> = {};
    headers.forEach((value, name) => {
      forwarded[name] = value;
    });
    const method = init?.method ?? request?.method ?? "GET";
    const body = await readBody(init?.body ?? request?.body ?? null);
    const signal = init?.signal ?? request?.signal ?? undefined;
    return connection.authenticatedFetch({
      method,
      path: url.pathname,
      ...(url.search === "" ? {} : { query: url.search }),
      ...(body === undefined ? {} : { body }),
      ...(Object.keys(forwarded).length === 0 ? {} : { headers: forwarded }),
      ...(contentType === undefined ? {} : { contentType }),
      ...(signal === undefined || signal === null ? {} : { signal }),
    });
  };
}

async function readBody(body: BodyInit | null): Promise<string | Uint8Array | undefined> {
  if (body === null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  // URLSearchParams, FormData, and streams have no product caller; refusing
  // is safer than signing a digest over a body we did not read exactly.
  throw new RemoteConnectionError("invalid", "Remote product request body is unsupported.");
}
