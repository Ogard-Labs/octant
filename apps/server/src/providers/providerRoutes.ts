import {
  decodeProviderInstanceId,
  decodeProviderSessionId,
  decodeProviderProbeResult,
  decodeProviderRegistryCommand,
  decodeProviderRegistryCommandResult,
  decodeProviderRegistrySnapshot,
  type OctantMode,
  type ProviderExecutionPolicy,
  type ProviderFailure,
  type ProviderModelId,
} from "@octant/contracts";
import { authenticateProjectRequest } from "../projectBindingRoutes";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import { ProviderServiceError, type ProviderServiceApi } from "./providerService";

const DEFAULT_BODY_LIMIT = 1_048_576;
const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";

export interface ProviderRouteDependencies {
  readonly service: ProviderServiceApi;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly maxRequestBodySize?: number;
  readonly now?: () => number;
  readonly packagedProviderSmokeControl?: boolean;
}

export function createProviderRouteHandler(dependencies: ProviderRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  const bodyLimit = dependencies.maxRequestBodySize ?? DEFAULT_BODY_LIMIT;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/providers/")) return undefined;
    const isBootstrap = url.pathname === "/api/providers/bootstrap";
    const isCommands = url.pathname === "/api/providers/commands";
    const probeMatch = /^\/api\/providers\/([^/]+)\/probe$/.exec(url.pathname);
    const isProbe = probeMatch !== null;
    const smokeMatch = /^\/api\/providers\/([^/]+)\/packaged-smoke-turn$/.exec(url.pathname);
    const isSmokeTurn = smokeMatch !== null && dependencies.packagedProviderSmokeControl === true;
    if (!isBootstrap && !isCommands && !isProbe && !isSmokeTurn) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return response(
        { category: "unsupported", message: "Provider API requests must use loopback." },
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

    if ((isBootstrap && request.method !== "GET") || (!isBootstrap && request.method !== "POST")) {
      return response(
        { category: "unsupported", message: "HTTP method is not supported for this route." },
        400,
        origin,
      );
    }
    if (url.search !== "") {
      return response(
        { category: "invalid-configuration", message: "Provider request is invalid." },
        400,
        origin,
      );
    }

    let body: unknown = {};
    if (isCommands || isProbe || isSmokeTurn) {
      const read = await readJson(request, bodyLimit, isProbe);
      if (read.kind === "too-large") {
        return response(
          { category: "invalid-configuration", message: "Request body is too large." },
          413,
          origin,
        );
      }
      if (read.kind === "invalid") {
        return response(
          { category: "invalid-configuration", message: "Provider request body is invalid." },
          400,
          origin,
        );
      }
      body = read.value;
      if (isProbe && (!isRecord(body) || Object.keys(body).length !== 0)) {
        return response(
          { category: "invalid-configuration", message: "Provider probe request is invalid." },
          400,
          origin,
        );
      }
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
          { category: "unauthorized", message: "Provider request is unauthorized." },
          401,
          origin,
        );
      }
      return response(
        { category: "invalid-configuration", message: "Provider request is invalid." },
        400,
        origin,
      );
    }

    try {
      if (isBootstrap) {
        return response(
          decodeProviderRegistrySnapshot(await dependencies.service.bootstrap(windowId)),
          200,
          origin,
        );
      }
      if (isCommands) {
        let command;
        try {
          command = decodeProviderRegistryCommand(body);
        } catch {
          return response(
            { category: "invalid-configuration", message: "Provider command is invalid." },
            400,
            origin,
          );
        }
        return response(
          decodeProviderRegistryCommandResult(
            await dependencies.service.execute(windowId, command),
          ),
          200,
          origin,
        );
      }
      if (isSmokeTurn) {
        let instanceId;
        let input;
        try {
          instanceId = decodeProviderInstanceId(decodeURIComponent(smokeMatch?.[1] ?? ""));
          input = decodePackagedSmokeTurn(body);
        } catch {
          return response(
            { category: "invalid-configuration", message: "Provider smoke request is invalid." },
            400,
            origin,
          );
        }
        return response(
          await dependencies.service.smokeTurn(windowId, instanceId, input),
          200,
          origin,
        );
      }
      let instanceId;
      try {
        instanceId = decodeProviderInstanceId(decodeURIComponent(probeMatch?.[1] ?? ""));
      } catch {
        return response(
          { category: "invalid-configuration", message: "Provider instance ID is invalid." },
          400,
          origin,
        );
      }
      return response(
        decodeProviderProbeResult(await dependencies.service.probe(windowId, instanceId)),
        200,
        origin,
      );
    } catch (error) {
      if (error instanceof ProviderServiceError) return failureResponse(error.failure, origin);
      return response(
        { category: "unavailable", message: "Octant Provider service is unavailable." },
        503,
        origin,
      );
    }
  };
}

function decodePackagedSmokeTurn(value: unknown) {
  const action = isRecord(value) ? value.action : undefined;
  const allowedKeys = new Set([
    "sessionId",
    "modelId",
    "prompt",
    "action",
    "mode",
    "executionPolicy",
    ...(action === "answer-approval"
      ? ["approved"]
      : action === "answer-question"
        ? ["answer"]
        : []),
  ]);
  const requiredKeys = [
    "sessionId",
    "modelId",
    "prompt",
    "action",
    ...(action === "answer-approval"
      ? ["approved"]
      : action === "answer-question"
        ? ["answer"]
        : []),
  ];
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !allowedKeys.has(key)) ||
    requiredKeys.some((key) => !Object.hasOwn(value, key)) ||
    typeof value.modelId !== "string" ||
    value.modelId.length === 0 ||
    value.modelId.length > 512 ||
    typeof value.prompt !== "string" ||
    value.prompt.length === 0 ||
    Buffer.byteLength(value.prompt, "utf8") > 32_768 ||
    (value.action !== "complete" &&
      value.action !== "cancel-after-output" &&
      value.action !== "answer-approval" &&
      value.action !== "answer-question") ||
    (value.action === "answer-approval" && typeof value.approved !== "boolean") ||
    (value.action === "answer-question" &&
      (typeof value.answer !== "string" ||
        value.answer.length === 0 ||
        Buffer.byteLength(value.answer, "utf8") > 4_096)) ||
    (value.mode !== undefined &&
      value.mode !== "chat" &&
      value.mode !== "work" &&
      value.mode !== "code") ||
    (value.executionPolicy !== undefined &&
      value.executionPolicy !== "plan" &&
      value.executionPolicy !== "approval-gated" &&
      value.executionPolicy !== "full-access")
  ) {
    throw new Error("invalid");
  }
  const common = {
    sessionId: decodeProviderSessionId(value.sessionId),
    modelId: value.modelId as ProviderModelId,
    prompt: value.prompt,
    ...(value.mode === undefined ? {} : { mode: value.mode as OctantMode }),
    ...(value.executionPolicy === undefined
      ? {}
      : { executionPolicy: value.executionPolicy as ProviderExecutionPolicy }),
  };
  if (value.action === "answer-approval") {
    return { ...common, action: value.action, approved: value.approved as boolean } as const;
  }
  if (value.action === "answer-question") {
    return { ...common, action: value.action, answer: value.answer as string } as const;
  }
  return { ...common, action: value.action } as const;
}

async function readJson(
  request: Request,
  maxBytes: number,
  emptyAllowed: boolean,
): Promise<{ kind: "ok"; value: unknown } | { kind: "invalid" } | { kind: "too-large" }> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return { kind: "too-large" };
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) return { kind: "too-large" };
  if (emptyAllowed && text.length === 0) return { kind: "ok", value: {} };
  try {
    return { kind: "ok", value: JSON.parse(text) };
  } catch {
    return { kind: "invalid" };
  }
}

function failureResponse(failure: ProviderFailure, origin: string | null): Response {
  const status =
    failure.category === "unauthorized" ? 401 : failure.category === "unavailable" ? 503 : 400;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
