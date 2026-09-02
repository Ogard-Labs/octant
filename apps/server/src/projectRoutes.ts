import {
  decodeMemoryCommand,
  decodeCodeThreadId,
  decodeProjectCommand,
  decodeProjectId,
  type ProjectFailure,
} from "@octant/contracts";
import type { CodeEnvironmentServiceApi } from "./codeEnvironmentService";
import { authenticateProjectRequest } from "./projectBindingRoutes";
import { ProjectServiceError, type ProjectServiceApi } from "./projectService";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const DEFAULT_BODY_LIMIT = 1_048_576;
const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";

export interface ProjectRouteDependencies {
  readonly service: ProjectServiceApi;
  readonly environmentService: CodeEnvironmentServiceApi;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly maxRequestBodySize?: number;
  readonly now?: () => number;
}

export function createProjectRouteHandler(dependencies: ProjectRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  const bodyLimit = dependencies.maxRequestBodySize ?? DEFAULT_BODY_LIMIT;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/projects/")) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname))
      return response(
        { category: "unsupported", message: "Project API requests must use loopback." },
        400,
        null,
      );
    if (origin !== null && !isAllowedOrigin(origin))
      return response(
        { category: "unsupported", message: "Renderer origin is not allowed." },
        400,
        null,
      );
    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: corsHeaders(origin) });

    const isBootstrap = url.pathname === "/api/projects/bootstrap";
    const isSearch = url.pathname === "/api/projects/search";
    const isCommands = url.pathname === "/api/projects/commands";
    const isMemoryCommands = url.pathname === "/api/projects/memory/commands";
    const memoryMatch = /^\/api\/projects\/([^/]+)\/memory$/.exec(url.pathname);
    const isMemory = memoryMatch !== null;
    const environmentMatch = /^\/api\/projects\/([^/]+)\/environment$/.exec(url.pathname);
    const isEnvironment = environmentMatch !== null;
    if (
      !isBootstrap &&
      !isSearch &&
      !isCommands &&
      !isMemoryCommands &&
      !isMemory &&
      !isEnvironment
    )
      return undefined;
    if (
      ((isBootstrap || isSearch || isMemory || isEnvironment) && request.method !== "GET") ||
      ((isCommands || isMemoryCommands) && request.method !== "POST")
    ) {
      return response(
        { category: "unsupported", message: "HTTP method is not supported for this route." },
        400,
        origin,
      );
    }

    let body: unknown = {};
    if (isCommands || isMemoryCommands) {
      const read = await readJson(request, bodyLimit);
      if (read.kind === "too-large")
        return response(
          { category: "invalid", message: "Request body is too large." },
          413,
          origin,
        );
      if (read.kind === "invalid")
        return response(
          { category: "invalid", message: "Command body must be valid JSON." },
          400,
          origin,
        );
      body = read.value;
    }
    if (
      (isBootstrap && url.search !== "") ||
      (isSearch && [...url.searchParams.keys()].some((key) => key !== "q")) ||
      ((isCommands || isMemoryCommands || isMemory) && url.search !== "") ||
      (isEnvironment &&
        [...url.searchParams.keys()].some((key) => key !== "threadId" && key !== "fresh"))
    ) {
      return response({ category: "invalid", message: "Project request is invalid." }, 400, origin);
    }

    let windowId;
    try {
      windowId = authenticateProjectRequest({
        request,
        body,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      if (error instanceof WindowAuthorityError)
        return response(
          { category: "unauthorized", message: "Project request is unauthorized." },
          401,
          origin,
        );
      return response({ category: "invalid", message: "Project request is invalid." }, 400, origin);
    }

    try {
      if (isBootstrap) return response(await dependencies.service.bootstrap(windowId), 200, origin);
      if (isSearch)
        return response(
          await dependencies.service.search(url.searchParams.get("q") ?? ""),
          200,
          origin,
        );
      if (isEnvironment) {
        const freshValue = url.searchParams.get("fresh");
        if (freshValue !== null && freshValue !== "1") {
          return response(
            { category: "invalid", message: "Project request is invalid." },
            400,
            origin,
          );
        }
        const fresh = freshValue === "1";
        let projectId;
        try {
          projectId = decodeProjectId(decodeURIComponent(environmentMatch[1] ?? ""));
        } catch {
          return response({ category: "invalid", message: "Project ID is invalid." }, 400, origin);
        }
        const threadValue = url.searchParams.get("threadId");
        if (threadValue !== null) {
          let threadId;
          try {
            threadId = decodeCodeThreadId(threadValue);
          } catch {
            return response(
              { category: "invalid", message: "Code thread ID is invalid." },
              400,
              origin,
            );
          }
          return response(
            fresh
              ? await dependencies.environmentService.observeThread(
                  windowId,
                  projectId,
                  threadId,
                  request.signal,
                  true,
                )
              : await dependencies.environmentService.observeThread(
                  windowId,
                  projectId,
                  threadId,
                  request.signal,
                ),
            200,
            origin,
          );
        }
        return response(
          fresh
            ? await dependencies.environmentService.observe(
                windowId,
                projectId,
                request.signal,
                true,
              )
            : await dependencies.environmentService.observe(windowId, projectId, request.signal),
          200,
          origin,
        );
      }
      if (isMemory) {
        let projectId;
        try {
          projectId = decodeProjectId(decodeURIComponent(memoryMatch[1] ?? ""));
        } catch {
          return response({ category: "invalid", message: "Project ID is invalid." }, 400, origin);
        }
        return response(await dependencies.service.memory(projectId), 200, origin);
      }
      if (isMemoryCommands) {
        let command;
        try {
          command = decodeMemoryCommand(body);
        } catch {
          return response(
            { category: "invalid", message: "Memory command is invalid." },
            400,
            origin,
          );
        }
        return response(await dependencies.service.executeMemory(command), 200, origin);
      }
      let command;
      try {
        command = decodeProjectCommand(body);
      } catch {
        return response(
          { category: "invalid", message: "Project command is invalid." },
          400,
          origin,
        );
      }
      return response(await dependencies.service.executeProject(windowId, command), 200, origin);
    } catch (error) {
      if (error instanceof ProjectServiceError) return failureResponse(error.failure, origin);
      return response(
        { category: "unavailable", message: "Octant Project service is unavailable." },
        503,
        origin,
      );
    }
  };
}

async function readJson(
  request: Request,
  maxBytes: number,
): Promise<{ kind: "ok"; value: unknown } | { kind: "invalid" } | { kind: "too-large" }> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { kind: "too-large" };
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) return { kind: "too-large" };
  try {
    return { kind: "ok", value: JSON.parse(text) };
  } catch {
    return { kind: "invalid" };
  }
}

function failureResponse(failure: ProjectFailure, origin: string | null): Response {
  const status =
    failure.category === "unauthorized"
      ? 401
      : failure.category === "not-found"
        ? 404
        : failure.category === "conflict"
          ? 409
          : failure.category === "unavailable"
            ? 503
            : 400;
  return response(failure, status, origin);
}

function response(body: unknown, status: number, origin: string | null): Response {
  return Response.json(body, { status, headers: corsHeaders(origin) });
}

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers({
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    vary: "Origin",
  });
  if (origin !== null && isAllowedOrigin(origin))
    headers.set("access-control-allow-origin", origin);
  return headers;
}

function isAllowedOrigin(origin: string): boolean {
  if (origin === "file://") return true;
  try {
    const url = new URL(origin);
    return (
      origin === url.origin &&
      url.protocol === "http:" &&
      isLoopbackHostname(url.hostname) &&
      url.username === "" &&
      url.password === "" &&
      url.pathname === "/" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}
