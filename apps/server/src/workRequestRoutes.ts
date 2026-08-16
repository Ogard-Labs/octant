import {
  decodeWorkRequestCommand,
  decodeWorkRequestCommandResult,
  decodeWorkRequestFailure,
  decodeWorkRequestList,
  decodeWorkThreadId,
  decodeProjectId,
  type WorkRequestCommand,
  type WorkRequestCommandResult,
  type WorkRequestFailure,
  type WorkRequestList,
  type WorkThreadId,
  type ProjectId,
  type WindowId,
} from "@octant/contracts";
import { isLoopbackHostname } from "./shellRoutes";
import { authenticateRouteWindowId } from "./principalRouteContext";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";
import type { WorkRequestApplicationService } from "./work/workRequestApplicationService";

const JSON_BODY_LIMIT = 1_048_576;
const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";

export interface WorkRequestRouteService {
  readonly list: (
    authenticatedWindowId: WindowId,
    projectId: ProjectId,
    threadId?: WorkThreadId,
  ) => Promise<WorkRequestList> | WorkRequestList;
  readonly execute: (
    authenticatedWindowId: WindowId,
    command: WorkRequestCommand,
  ) => Promise<WorkRequestCommandResult> | WorkRequestCommandResult;
}

export interface WorkRequestRouteDependencies {
  readonly service: WorkRequestRouteService | WorkRequestApplicationService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly maxJsonBodySize?: number;
  readonly now?: () => number;
}

export function createWorkRequestRouteHandler(dependencies: WorkRequestRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  const jsonLimit = dependencies.maxJsonBodySize ?? JSON_BODY_LIMIT;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/work/requests")) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failureResponse(
        { code: "invalid", message: "Work request API requests must use loopback." },
        400,
        null,
      );
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failureResponse(
        { code: "invalid", message: "Renderer origin is not allowed." },
        400,
        null,
      );
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const isList = url.pathname === "/api/work/requests";
    const isCommands = url.pathname === "/api/work/requests/commands";
    if (!isList && !isCommands) return undefined;

    let authenticatedWindowId: WindowId;
    try {
      if (url.searchParams.has("windowId")) {
        throw new WorkRequestRouteRejected(
          "Work request requests cannot supply window identity.",
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
          { code: "unauthorized", message: "Work request is unauthorized." },
          401,
          origin,
        );
      }
      return failureResponse(
        {
          code: "invalid",
          message:
            error instanceof WorkRequestRouteRejected ? error.message : "Work request is invalid.",
        },
        error instanceof WorkRequestRouteRejected ? error.status : 400,
        origin,
      );
    }

    try {
      if (isList) {
        if (request.method !== "GET") {
          throw new WorkRequestRouteRejected("HTTP method is not supported for this route.", 400);
        }
        const { projectId, threadId } = decodeListParams(url);
        return jsonResponse(
          decodeWorkRequestList(
            await dependencies.service.list(authenticatedWindowId, projectId, threadId),
          ),
          200,
          origin,
        );
      }
      if (request.method !== "POST" || url.search !== "") {
        throw new WorkRequestRouteRejected("Work request command is invalid.", 400);
      }
      requireJsonContentType(request);
      const body = await readBoundedBytes(request, jsonLimit);
      const value = parseJson(body);
      if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, "windowId")) {
        throw new WorkRequestRouteRejected(
          "Work request commands cannot supply window identity.",
          400,
        );
      }
      const command = decodeWorkRequestCommand(value);
      return jsonResponse(
        decodeWorkRequestCommandResult(
          await dependencies.service.execute(authenticatedWindowId, command),
        ),
        200,
        origin,
      );
    } catch (error) {
      if (error instanceof WorkRequestRouteRejected) {
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
        { code: "unavailable", message: "Octant Work request service is unavailable." },
        503,
        origin,
      );
    }
  };
}

function decodeListParams(url: URL): {
  projectId: ProjectId;
  threadId: WorkThreadId | undefined;
} {
  const keys = [...url.searchParams.keys()];
  for (const key of keys) {
    if (key !== "projectId" && key !== "threadId") {
      throw new WorkRequestRouteRejected("Work request list request is invalid.", 400);
    }
  }
  const projectIdRaw = url.searchParams.get("projectId");
  if (projectIdRaw === null || projectIdRaw.trim() === "") {
    throw new WorkRequestRouteRejected("Work request list requires projectId.", 400);
  }
  let projectId: ProjectId;
  try {
    projectId = decodeProjectId(projectIdRaw);
  } catch {
    throw new WorkRequestRouteRejected("Work request list projectId is invalid.", 400);
  }
  const threadIdRaw = url.searchParams.get("threadId");
  if (threadIdRaw === null) return { projectId, threadId: undefined };
  try {
    return { projectId, threadId: decodeWorkThreadId(threadIdRaw) };
  } catch {
    throw new WorkRequestRouteRejected("Work request list threadId is invalid.", 400);
  }
}

function serviceFailureFrom(error: unknown): WorkRequestFailure | undefined {
  if (!isRecord(error) || !("failure" in error)) return undefined;
  try {
    return decodeWorkRequestFailure(error.failure);
  } catch {
    return undefined;
  }
}

function failureResponse(failure: WorkRequestFailure, origin: string | null): Response;
function failureResponse(
  failure: WorkRequestFailure,
  status: number,
  origin: string | null,
): Response;
function failureResponse(
  failure: WorkRequestFailure,
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
          : failure.code === "unavailable"
            ? 503
            : failure.code === "not-found"
              ? 404
              : 400;
  const origin = typeof statusOrOrigin === "number" ? (maybeOrigin ?? null) : statusOrOrigin;
  return jsonResponse(decodeWorkRequestFailure(failure), status, origin);
}

function jsonResponse(body: unknown, status: number, origin: string | null): Response {
  return Response.json(body, { status, headers: corsHeaders(origin) });
}

function requireJsonContentType(request: Request): void {
  if (request.headers.get("content-type")?.trim().toLowerCase() !== "application/json") {
    throw new WorkRequestRouteRejected("Work request command content type is invalid.", 400);
  }
}

async function readBoundedBytes(request: Request, maximumBytes: number): Promise<Uint8Array> {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) {
      throw new WorkRequestRouteRejected("Content length is invalid.", 400);
    }
    if (BigInt(declared) > BigInt(maximumBytes)) {
      throw new WorkRequestRouteRejected("Request body is too large.", 413);
    }
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > maximumBytes) {
    throw new WorkRequestRouteRejected("Request body is too large.", 413);
  }
  return bytes;
}

function parseJson(bytes: Uint8Array): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new WorkRequestRouteRejected("Command body must be valid UTF-8 JSON.", 400);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new WorkRequestRouteRejected("Command body must be valid JSON.", 400);
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

class WorkRequestRouteRejected extends Error {
  override readonly name = "WorkRequestRouteRejected";

  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
