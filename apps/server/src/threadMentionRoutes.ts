import {
  decodeThreadMentionCommandResult,
  type ThreadMentionCommandResult,
  type WindowId,
} from "@octant/contracts";
import { authenticateRouteWindowId } from "./principalRouteContext";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const JSON_BODY_LIMIT = 262_144;
const METHODS = "POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const COMMANDS_PATH = "/api/thread-mentions/commands";

export interface ThreadMentionRouteDependencies {
  readonly service: {
    execute(
      command: unknown,
      context: { readonly windowId: WindowId },
    ): Promise<ThreadMentionCommandResult>;
  };
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly maxJsonBodySize?: number;
  readonly now?: () => number;
}

/**
 * Authoritative thread-mention and Side Chat route.
 *
 * The service owns openability, the bounded transcript window, and sidecar
 * identity; this route only proves the request came from a loopback renderer
 * holding a valid window capability, then hands the decoded body to the
 * service under that authenticated principal. The renderer never supplies its
 * own identity, so it cannot widen the set of threads a mention resolves.
 */
export function createThreadMentionRouteHandler(dependencies: ThreadMentionRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  const jsonLimit = dependencies.maxJsonBodySize ?? JSON_BODY_LIMIT;

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== COMMANDS_PATH) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failure("Thread mention API requests must use loopback.", 400, null);
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failure("Renderer origin is not allowed.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST" || url.search !== "") {
      return failure("Thread mention request is invalid.", 400, origin);
    }

    let body: unknown;
    try {
      requireJsonContentType(request);
      body = parseJson(await readBoundedBytes(request, jsonLimit));
    } catch (error) {
      if (error instanceof ThreadMentionRouteRejected) {
        return failure(error.message, error.status, origin);
      }
      return failure("Thread mention request is invalid.", 400, origin);
    }

    let windowId: WindowId;
    try {
      windowId = authenticateRouteWindowId({
        request,
        body,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failure("Thread mention request is unauthorized.", 401, origin);
      }
      return failure("Thread mention request is invalid.", 400, origin);
    }

    let result: ThreadMentionCommandResult;
    try {
      result = await dependencies.service.execute(body, { windowId });
    } catch {
      // A malformed command and an unavailable service are both refusals the
      // renderer must treat as "nothing resolved"; neither ever falls back to
      // a partially-resolved mention.
      return failure("Thread mention command is invalid.", 400, origin);
    }
    return json(decodeThreadMentionCommandResult(result), 200, origin);
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return Response.json(body, { status, headers: corsHeaders(origin) });
}

function failure(message: string, status: number, origin: string | null): Response {
  return json({ message }, status, origin);
}

function requireJsonContentType(request: Request): void {
  if (request.headers.get("content-type")?.trim().toLowerCase() !== "application/json") {
    throw new ThreadMentionRouteRejected("Thread mention content type is invalid.", 400);
  }
}

async function readBoundedBytes(request: Request, maximumBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      throw new ThreadMentionRouteRejected("Content length is invalid.", 400);
    }
    if (BigInt(declared) > BigInt(maximumBytes)) {
      throw new ThreadMentionRouteRejected("Request body is too large.", 413);
    }
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maximumBytes) {
    throw new ThreadMentionRouteRejected("Request body is too large.", 413);
  }
  return bytes;
}

function parseJson(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ThreadMentionRouteRejected("Thread mention body must be valid UTF-8 JSON.", 400);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ThreadMentionRouteRejected("Thread mention body must be valid JSON.", 400);
  }
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

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers({
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    vary: "Origin",
  });
  if (origin !== null && isAllowedOrigin(origin)) {
    headers.set("access-control-allow-origin", origin);
  }
  return headers;
}

class ThreadMentionRouteRejected extends Error {
  override readonly name = "ThreadMentionRouteRejected";

  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
