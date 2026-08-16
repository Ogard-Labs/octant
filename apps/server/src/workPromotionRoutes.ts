import {
  decodeWorkPromotionCommand,
  decodeWorkPromotionCommandResult,
  decodeWorkPromotionFailure,
  decodeWorkPromotionList,
  decodeWorkPromotionProposalId,
  decodeProjectId,
  type WorkPromotionCommand,
  type WorkPromotionCommandResult,
  type WorkPromotionFailure,
  type WorkPromotionList,
  type ProjectId,
  type WindowId,
} from "@octant/contracts";
import { isLoopbackHostname } from "./shellRoutes";
import { authenticateRouteWindowId } from "./principalRouteContext";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";
import {
  WorkPromotionApplicationError,
  type WorkPromotionApplicationService,
} from "./work/workPromotionApplicationService";

const JSON_BODY_LIMIT = 1_048_576;
const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";

export interface WorkPromotionRouteService {
  readonly list: (
    authenticatedWindowId: WindowId,
    originProjectId?: ProjectId,
  ) => Promise<WorkPromotionList> | WorkPromotionList;
  readonly execute: (
    authenticatedWindowId: WindowId,
    command: WorkPromotionCommand,
  ) => Promise<WorkPromotionCommandResult> | WorkPromotionCommandResult;
}

export interface WorkPromotionRouteDependencies {
  readonly service: WorkPromotionRouteService | WorkPromotionApplicationService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly maxJsonBodySize?: number;
  readonly now?: () => number;
}

export function createWorkPromotionRouteHandler(dependencies: WorkPromotionRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  const jsonLimit = dependencies.maxJsonBodySize ?? JSON_BODY_LIMIT;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/work/promotions")) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failureResponse(
        { code: "unsupported", message: "Work promotion API requests must use loopback." },
        400,
        null,
      );
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failureResponse(
        { code: "unsupported", message: "Renderer origin is not allowed." },
        400,
        null,
      );
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const isList = url.pathname === "/api/work/promotions";
    const isCommands = url.pathname === "/api/work/promotions/commands";
    if (!isList && !isCommands) return undefined;

    let authenticatedWindowId: WindowId;
    try {
      if (url.searchParams.has("windowId")) {
        throw new WorkPromotionRouteRejected(
          "Work promotion requests cannot supply window identity.",
          400,
        );
      }
      authenticatedWindowId = authenticateRouteWindowId({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failureResponse(
          { code: "unauthorized", message: "Work promotion request is unauthorized." },
          401,
          origin,
        );
      }
      return failureResponse(
        {
          code: "invalid",
          message:
            error instanceof WorkPromotionRouteRejected
              ? error.message
              : "Work promotion request is invalid.",
        },
        error instanceof WorkPromotionRouteRejected ? error.status : 400,
        origin,
      );
    }

    try {
      if (isList) {
        if (request.method !== "GET") {
          throw new WorkPromotionRouteRejected("HTTP method is not supported for this route.", 400);
        }
        const originProjectId = decodeOptionalOriginProjectId(url);
        return jsonResponse(
          decodeWorkPromotionList(
            await dependencies.service.list(authenticatedWindowId, originProjectId),
          ),
          200,
          origin,
        );
      }
      if (request.method !== "POST" || url.search !== "") {
        throw new WorkPromotionRouteRejected("Work promotion request is invalid.", 400);
      }
      requireJsonContentType(request);
      const body = await readBoundedBytes(request, jsonLimit);
      const value = parseJson(body);
      if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, "windowId")) {
        throw new WorkPromotionRouteRejected(
          "Work promotion requests cannot supply window identity.",
          400,
        );
      }
      const command = decodeWorkPromotionCommand(value);
      return jsonResponse(
        decodeWorkPromotionCommandResult(
          await dependencies.service.execute(authenticatedWindowId, command),
        ),
        200,
        origin,
      );
    } catch (error) {
      if (error instanceof WorkPromotionApplicationError) {
        return failureResponse(error.failure, origin);
      }
      if (error instanceof WorkPromotionRouteRejected) {
        return failureResponse(
          {
            code: error.status === 409 ? "stale" : error.status === 503 ? "unavailable" : "invalid",
            message: error.message,
          },
          error.status,
          origin,
        );
      }
      const serviceFailure = serviceFailureFrom(error);
      if (serviceFailure !== undefined) return failureResponse(serviceFailure, origin);
      return failureResponse(
        { code: "unavailable", message: "Octant Work promotion service is unavailable." },
        503,
        origin,
      );
    }
  };
}

function decodeOptionalOriginProjectId(url: URL): ProjectId | undefined {
  const keys = [...url.searchParams.keys()];
  if (keys.length === 0) return undefined;
  if (keys.length !== 1 || keys[0] !== "originProjectId") {
    throw new WorkPromotionRouteRejected("Work promotion list request is invalid.", 400);
  }
  try {
    return decodeProjectId(url.searchParams.get("originProjectId"));
  } catch {
    throw new WorkPromotionRouteRejected("Work promotion origin Project ID is invalid.", 400);
  }
}

function serviceFailureFrom(error: unknown): WorkPromotionFailure | undefined {
  if (!isRecord(error) || !("failure" in error)) return undefined;
  try {
    return decodeWorkPromotionFailure(error.failure);
  } catch {
    return undefined;
  }
}

function failureResponse(failure: WorkPromotionFailure, origin: string | null): Response;
function failureResponse(
  failure: WorkPromotionFailure,
  status: number,
  origin: string | null,
): Response;
function failureResponse(
  failure: WorkPromotionFailure,
  statusOrOrigin: number | string | null,
  maybeOrigin?: string | null,
): Response {
  const status =
    typeof statusOrOrigin === "number"
      ? statusOrOrigin
      : failure.code === "unauthorized"
        ? 401
        : failure.code === "stale" || failure.code === "conflict"
          ? 409
          : failure.code === "unavailable" || failure.code === "interrupted"
            ? 503
            : failure.code === "not-found"
              ? 404
              : 400;
  const origin = typeof statusOrOrigin === "number" ? (maybeOrigin ?? null) : statusOrOrigin;
  return jsonResponse(decodeWorkPromotionFailure(failure), status, origin);
}

function jsonResponse(body: unknown, status: number, origin: string | null): Response {
  return Response.json(body, { status, headers: corsHeaders(origin) });
}

function requireJsonContentType(request: Request): void {
  if (request.headers.get("content-type")?.trim().toLowerCase() !== "application/json") {
    throw new WorkPromotionRouteRejected("Work promotion command content type is invalid.", 400);
  }
}

async function readBoundedBytes(request: Request, maximumBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      throw new WorkPromotionRouteRejected("Content length is invalid.", 400);
    }
    if (BigInt(declared) > BigInt(maximumBytes)) {
      throw new WorkPromotionRouteRejected("Request body is too large.", 413);
    }
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maximumBytes) {
    throw new WorkPromotionRouteRejected("Request body is too large.", 413);
  }
  return bytes;
}

function parseJson(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new WorkPromotionRouteRejected("Command body must be valid UTF-8 JSON.", 400);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new WorkPromotionRouteRejected("Command body must be valid JSON.", 400);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

class WorkPromotionRouteRejected extends Error {
  override readonly name = "WorkPromotionRouteRejected";

  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export { decodeWorkPromotionProposalId };
