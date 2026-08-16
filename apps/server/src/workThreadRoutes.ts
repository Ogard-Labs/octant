import {
  WorkThreadFailure as WorkThreadFailureSchema,
  decodeWorkThreadBootstrap,
  decodeWorkThreadCommand,
  decodeWorkThreadCommandResult,
  type WorkThreadBootstrap,
  type WorkThreadCommandResult,
  type WorkThreadFailure,
  type WindowId,
} from "@octant/contracts";
import { Schema } from "effect";
import { authenticateRouteWindowId } from "./principalRouteContext";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const JSON_BODY_LIMIT = 1_048_576;
const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const decodeWorkThreadFailure = Schema.decodeUnknownSync(WorkThreadFailureSchema);

export interface WorkThreadRouteService {
  readonly bootstrap: (
    authenticatedWindowId: WindowId,
  ) => Promise<WorkThreadBootstrap> | WorkThreadBootstrap;
  readonly execute: (
    authenticatedWindowId: WindowId,
    command: unknown,
  ) => Promise<WorkThreadCommandResult> | WorkThreadCommandResult;
}

export interface WorkThreadRouteDependencies {
  readonly service: WorkThreadRouteService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly maxJsonBodySize?: number;
  readonly now?: () => number;
}

export function createWorkThreadRouteHandler(dependencies: WorkThreadRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  const jsonLimit = dependencies.maxJsonBodySize ?? JSON_BODY_LIMIT;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/work/threads")) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failureResponse(
        { category: "unsupported", message: "Work thread API requests must use loopback." },
        400,
        null,
      );
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failureResponse(
        { category: "unsupported", message: "Renderer origin is not allowed." },
        400,
        null,
      );
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const isBootstrap = url.pathname === "/api/work/threads/bootstrap";
    const isCommands = url.pathname === "/api/work/threads/commands";
    if (!isBootstrap && !isCommands) return undefined;

    let authenticatedWindowId: WindowId;
    try {
      if (url.searchParams.has("windowId")) {
        throw new WorkThreadRouteRejected(
          "Work thread requests cannot supply window identity.",
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
          { category: "unauthorized", message: "Work thread request is unauthorized." },
          401,
          origin,
        );
      }
      return failureResponse(
        { category: "invalid", message: "Work thread request is invalid." },
        400,
        origin,
      );
    }

    try {
      if (isBootstrap) {
        if (request.method !== "GET" || url.search !== "") {
          throw new WorkThreadRouteRejected("Work thread request is invalid.", 400);
        }
        return jsonResponse(
          decodeWorkThreadBootstrap(await dependencies.service.bootstrap(authenticatedWindowId)),
          200,
          origin,
        );
      }
      if (request.method !== "POST" || url.search !== "") {
        throw new WorkThreadRouteRejected("Work thread request is invalid.", 400);
      }
      requireJsonContentType(request);
      const body = await readBoundedBytes(request, jsonLimit);
      const value = parseJson(body);
      if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, "windowId")) {
        throw new WorkThreadRouteRejected(
          "Work thread requests cannot supply window identity.",
          400,
        );
      }
      const command = decodeWorkThreadCommand(value);
      return jsonResponse(
        decodeWorkThreadCommandResult(
          await dependencies.service.execute(authenticatedWindowId, command),
        ),
        200,
        origin,
      );
    } catch (error) {
      if (error instanceof WorkThreadRouteRejected) {
        return failureResponse(
          {
            category:
              error.status === 409 ? "stale" : error.status === 503 ? "unavailable" : "invalid",
            message: error.message,
          },
          error.status,
          origin,
        );
      }
      const serviceFailure = serviceFailureFrom(error);
      if (serviceFailure !== undefined) return failureResponse(serviceFailure, origin);
      return failureResponse(
        { category: "unavailable", message: "Octant Work thread service is unavailable." },
        503,
        origin,
      );
    }
  };
}

function serviceFailureFrom(error: unknown): WorkThreadFailure | undefined {
  if (!isRecord(error) || !("failure" in error)) return undefined;
  try {
    return decodeWorkThreadFailure(error.failure);
  } catch {
    return undefined;
  }
}

function failureResponse(failure: WorkThreadFailure, origin: string | null): Response;
function failureResponse(
  failure: WorkThreadFailure,
  status: number,
  origin: string | null,
): Response;
function failureResponse(
  failure: WorkThreadFailure,
  statusOrOrigin: number | string | null,
  maybeOrigin?: string | null,
): Response {
  const status =
    typeof statusOrOrigin === "number"
      ? statusOrOrigin
      : failure.category === "unauthorized"
        ? 401
        : failure.category === "stale"
          ? 409
          : failure.category === "unavailable" ||
              failure.category === "waiting" ||
              failure.category === "interrupted" ||
              failure.category === "failed" ||
              failure.category === "disconnected"
            ? 503
            : 400;
  const origin = typeof statusOrOrigin === "number" ? (maybeOrigin ?? null) : statusOrOrigin;
  return jsonResponse(decodeWorkThreadFailure(failure), status, origin);
}

function jsonResponse(body: unknown, status: number, origin: string | null): Response {
  return Response.json(body, { status, headers: corsHeaders(origin) });
}

function requireJsonContentType(request: Request): void {
  if (request.headers.get("content-type")?.trim().toLowerCase() !== "application/json") {
    throw new WorkThreadRouteRejected("Work thread command content type is invalid.", 400);
  }
}

async function readBoundedBytes(request: Request, maximumBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      throw new WorkThreadRouteRejected("Content length is invalid.", 400);
    }
    if (BigInt(declared) > BigInt(maximumBytes)) {
      throw new WorkThreadRouteRejected("Request body is too large.", 413);
    }
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maximumBytes) {
    throw new WorkThreadRouteRejected("Request body is too large.", 413);
  }
  return bytes;
}

function parseJson(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new WorkThreadRouteRejected("Command body must be valid UTF-8 JSON.", 400);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new WorkThreadRouteRejected("Command body must be valid JSON.", 400);
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

class WorkThreadRouteRejected extends Error {
  override readonly name = "WorkThreadRouteRejected";

  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
