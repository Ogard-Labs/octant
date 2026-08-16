import {
  decodeDiscoveryCommand,
  decodeDiscoveryCommandResult,
  decodeDiscoverySnapshot,
  type DiscoveryCommand,
  type DiscoveryCandidate,
  type DiscoverySnapshot,
  type ProviderInstance,
  type ProviderInstanceId,
} from "@octant/contracts";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import { authenticateProjectRequest } from "../projectBindingRoutes";
import type { DiscoveryService } from "./discoveryService";
import { autoRegisterPreferredCandidates } from "./discoveryAutoRegister";

const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const DEFAULT_BODY_LIMIT = 1_048_576;

export interface DiscoveryRouteDependencies {
  readonly discoveryService: DiscoveryService;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly onConnect?: (
    command: Extract<DiscoveryCommand, { kind: "connect" }>,
    windowId: string,
  ) => Promise<{ instanceId: string }>;
  readonly listInstances?: (windowId: string) => Promise<ReadonlyArray<ProviderInstance>>;
  readonly createDisabled?: (
    candidate: DiscoveryCandidate,
    windowId: string,
  ) => Promise<{ instanceId: ProviderInstanceId }>;
  readonly maxRequestBodySize?: number;
  readonly now?: () => number;
}

export function createDiscoveryRouteHandler(dependencies: DiscoveryRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  const bodyLimit = dependencies.maxRequestBodySize ?? DEFAULT_BODY_LIMIT;

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/api/providers/discovery")) return undefined;

    const isScan = url.pathname === "/api/providers/discovery/scan";
    const isConnect = url.pathname === "/api/providers/discovery/connect";
    if (!isScan && !isConnect) return undefined;

    if (!isLoopbackHostname(url.hostname)) {
      return response(
        { category: "unsupported", message: "Discovery requests must use loopback." },
        400,
        null,
      );
    }

    const origin = request.headers.get("origin");
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

    if (request.method !== "POST") {
      return response(
        { category: "unsupported", message: "HTTP method is not supported for discovery." },
        400,
        origin,
      );
    }

    if (url.search !== "") {
      return response(
        { category: "invalid-configuration", message: "Discovery request is invalid." },
        400,
        origin,
      );
    }

    // Authenticate window
    let body: unknown = {};
    if (isConnect) {
      const read = await readJson(request, bodyLimit);
      if (read.kind === "too-large") {
        return response(
          { category: "invalid-configuration", message: "Request body is too large." },
          413,
          origin,
        );
      }
      if (read.kind === "invalid") {
        return response(
          { category: "invalid-configuration", message: "Discovery request body is invalid." },
          400,
          origin,
        );
      }
      body = read.value;
    }

    let windowId: string;
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
          { category: "unauthorized", message: "Discovery request is unauthorized." },
          401,
          origin,
        );
      }
      return response(
        { category: "invalid-configuration", message: "Discovery request is invalid." },
        400,
        origin,
      );
    }

    try {
      if (isScan) {
        let snapshot = await dependencies.discoveryService.scan();
        if (dependencies.listInstances !== undefined && dependencies.createDisabled !== undefined) {
          const result = await autoRegisterPreferredCandidates({
            snapshot,
            listInstances: () => dependencies.listInstances!(windowId),
            createDisabled: async (candidate) =>
              (await dependencies.createDisabled!(candidate, windowId)).instanceId,
          });
          snapshot = result.snapshot;
        }
        return response(
          { kind: "scan-completed", snapshot: decodeDiscoverySnapshot(snapshot) },
          200,
          origin,
        );
      }

      // isConnect
      let command: DiscoveryCommand;
      try {
        command = decodeDiscoveryCommand(body);
      } catch {
        return response(
          { category: "invalid-configuration", message: "Discovery connect command is invalid." },
          400,
          origin,
        );
      }

      if (command.kind !== "connect") {
        return response(
          { category: "invalid-configuration", message: "Expected a connect command." },
          400,
          origin,
        );
      }

      if (dependencies.onConnect === undefined) {
        return response(
          { category: "unsupported", message: "Discovery connect is not available." },
          503,
          origin,
        );
      }

      const known = dependencies.discoveryService.getLastScanCandidates?.() ?? [];
      const match = known.find(
        (candidate) =>
          candidate.driverKind === command.driverKind &&
          candidate.binaryPath === command.binaryPath,
      );
      if (match === undefined) {
        return response(
          {
            category: "unknown-candidate",
            message: "Connect requires a candidate from the latest discovery scan on this host.",
          },
          400,
          origin,
        );
      }

      const result = await dependencies.onConnect(command, windowId);
      return response({ kind: "candidate-connected", instanceId: result.instanceId }, 200, origin);
    } catch {
      return response(
        { category: "unavailable", message: "Discovery service is unavailable." },
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
  if (text.length === 0) return { kind: "ok", value: {} };
  try {
    return { kind: "ok", value: JSON.parse(text) };
  } catch {
    return { kind: "invalid" };
  }
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
