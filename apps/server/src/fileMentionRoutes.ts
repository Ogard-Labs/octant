import {
  decodeFileMentionCommandResult,
  type FileMentionCommandResult,
  type WindowId,
} from "@octant/contracts";
import { authenticateRouteWindowId } from "./principalRouteContext";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const JSON_BODY_LIMIT = 262_144;
const METHODS = "POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const COMMANDS_PATH = "/api/file-mentions/commands";

export interface FileMentionRouteDependencies {
  readonly service: {
    execute(
      command: unknown,
      context: { readonly windowId: WindowId },
    ): Promise<FileMentionCommandResult>;
  };
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly maxJsonBodySize?: number;
  readonly now?: () => number;
}

/**
 * Authoritative `@file` mention route for Work and Code.
 *
 * The service owns confinement and the read. This route only proves the
 * request came from a loopback renderer holding a valid window capability,
 * then hands the decoded body to the service under that principal.
 */
export function createFileMentionRouteHandler(dependencies: FileMentionRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  const jsonLimit = dependencies.maxJsonBodySize ?? JSON_BODY_LIMIT;

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== COMMANDS_PATH) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failure("File mention API requests must use loopback.", 400, null);
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failure("Renderer origin is not allowed.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "POST" || url.search !== "") {
      return failure("File mention request is invalid.", 400, origin);
    }

    let body: unknown;
    try {
      requireJsonContentType(request);
      body = parseJson(await readBoundedBytes(request, jsonLimit));
    } catch (error) {
      if (error instanceof FileMentionRouteRejected) {
        return failure(error.message, error.status, origin);
      }
      return failure("File mention request is invalid.", 400, origin);
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
        return failure("File mention request is unauthorized.", 401, origin);
      }
      return failure("File mention request is invalid.", 400, origin);
    }

    let result: FileMentionCommandResult;
    try {
      result = await dependencies.service.execute(body, { windowId });
    } catch {
      return failure("File mention command is invalid.", 400, origin);
    }
    return json(decodeFileMentionCommandResult(result), 200, origin);
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return Response.json(body, { status, headers: corsHeaders(origin) });
}

function failure(message: string, status: number, origin: string | null): Response {
  return Response.json({ message }, { status, headers: corsHeaders(origin) });
}

function corsHeaders(origin: string | null): HeadersInit {
  return {
    ...(origin === null ? {} : { "access-control-allow-origin": origin }),
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
  };
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

function requireJsonContentType(request: Request): void {
  const type = request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("application/json")) {
    throw new FileMentionRouteRejected("File mention request must be JSON.", 415);
  }
}

async function readBoundedBytes(request: Request, limit: number): Promise<Uint8Array> {
  const buffer = await request.arrayBuffer();
  if (buffer.byteLength > limit) {
    throw new FileMentionRouteRejected("File mention request is too large.", 413);
  }
  return new Uint8Array(buffer);
}

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new FileMentionRouteRejected("File mention request is invalid.", 400);
  }
}

class FileMentionRouteRejected extends Error {
  override readonly name = "FileMentionRouteRejected";
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
