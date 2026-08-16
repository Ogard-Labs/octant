import {
  decodeAgentProfileCommandResult,
  decodeAgentProfileId,
  decodeResolveEffectiveProfileRequest,
  type AgentProfileCommandResult,
} from "@octant/contracts";
import { authenticateProjectRequest } from "./projectBindingRoutes";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";
import { AgentProfileServiceError, type AgentProfileServiceApi } from "./agentProfileService";

const DEFAULT_BODY_LIMIT = 1_048_576;
const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";

export interface AgentProfileRouteDependencies {
  readonly service: AgentProfileServiceApi;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly maxRequestBodySize?: number;
  readonly now?: () => number;
}

export function createAgentProfileRouteHandler(dependencies: AgentProfileRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  const bodyLimit = dependencies.maxRequestBodySize ?? DEFAULT_BODY_LIMIT;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== "/api/agent-profiles" && !url.pathname.startsWith("/api/agent-profiles/"))
      return undefined;

    const isList = url.pathname === "/api/agent-profiles";
    const isCommands = url.pathname === "/api/agent-profiles/commands";
    const isResolve = url.pathname === "/api/agent-profiles/resolve-effective-profile";
    const isScopeProfiles = url.pathname === "/api/agent-profiles/scope";
    const profileMatch =
      /^\/api\/agent-profiles\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/.exec(
        url.pathname,
      );
    const isProfileRead = profileMatch !== null && !isCommands && !isResolve && !isScopeProfiles;

    if (!isList && !isCommands && !isResolve && !isProfileRead && !isScopeProfiles)
      return undefined;

    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return response(
        { category: "unsupported", message: "Agent profile API requests must use loopback." },
        400,
        null,
      );
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return response(
        { category: "unsupported", message: "Renderer origin is not allowed." },
        400,
        null,
      );
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    const isGet = request.method === "GET";
    const isPost = request.method === "POST";

    if (
      ((isList || isProfileRead || isScopeProfiles) && !isGet) ||
      ((isCommands || isResolve) && !isPost)
    ) {
      return response(
        { category: "unsupported", message: "HTTP method is not supported for this route." },
        400,
        origin,
      );
    }

    if (url.search !== "") {
      return response(
        { category: "invalid", message: "Agent profile request is invalid." },
        400,
        origin,
      );
    }

    let body: unknown = {};
    if (isCommands || isResolve) {
      const read = await readJson(request, bodyLimit);
      if (read.kind === "too-large") {
        return response(
          { category: "invalid", message: "Request body is too large." },
          413,
          origin,
        );
      }
      if (read.kind === "invalid") {
        return response(
          { category: "invalid", message: "Agent profile request body is invalid." },
          400,
          origin,
        );
      }
      body = read.value;
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
      if (error instanceof WindowAuthorityError) {
        return response(
          { category: "unauthorized", message: "Agent profile request is unauthorized." },
          401,
          origin,
        );
      }
      return response(
        { category: "invalid", message: "Agent profile request is invalid." },
        400,
        origin,
      );
    }

    try {
      if (isList) {
        return response(await dependencies.service.list(), 200, origin);
      }

      if (isProfileRead) {
        let profileId;
        try {
          profileId = decodeAgentProfileId(decodeURIComponent(profileMatch[1] ?? ""));
        } catch {
          return response(
            { category: "invalid", message: "Agent profile ID is invalid." },
            400,
            origin,
          );
        }
        const profile = await dependencies.service.read(profileId);
        if (profile === undefined) {
          return response(
            { category: "not-found", message: "Agent profile was not found." },
            404,
            origin,
          );
        }
        return response(profile, 200, origin);
      }

      if (isScopeProfiles) {
        return response(await dependencies.service.list(), 200, origin);
      }

      if (isResolve) {
        let request;
        try {
          request = decodeResolveEffectiveProfileRequest(body);
        } catch {
          return response(
            { category: "invalid", message: "Resolution request is invalid." },
            400,
            origin,
          );
        }
        const receipt = await dependencies.service.resolveEffectiveProfile(request);
        return response(receipt, 200, origin);
      }

      // isCommands
      const result: AgentProfileCommandResult = await dependencies.service.execute(body);
      return response(decodeAgentProfileCommandResult(result), 200, origin);
    } catch (error) {
      if (error instanceof AgentProfileServiceError) {
        return failureResponse(error.failure, origin);
      }
      return response(
        { category: "unavailable", message: "Octant agent profile service is unavailable." },
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

function failureResponse(
  failure: { readonly reason: string; readonly message: string },
  origin: string | null,
): Response {
  const status =
    failure.reason === "stale-version"
      ? 409
      : failure.reason === "unauthorized"
        ? 401
        : failure.reason === "in-use"
          ? 409
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
