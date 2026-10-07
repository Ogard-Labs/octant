/**
 * Host-only routes for Settings › Sync: read the store choice, change it, and
 * run Test connection.
 *
 * Store setup is host authority (decision 0163): a paired phone is refused
 * even if transport policy regressed. Three layers keep it off the remote
 * listener - the route answers only a loopback host name, it is registered on
 * the loopback chain outside the shared product dispatch the remote gateway
 * uses, and `/api/replica-store` is a remote local-only prefix - and the
 * principal check refuses anything that is not a local window.
 *
 * A bucket's key pair arrives in exactly one command and goes straight to the
 * host credential store. No response, refusal, or error message echoes a
 * request body.
 */

import { LOCAL_HOST_ID, type WindowId } from "@octant/contracts";
import {
  decodeReplicaStoreSettingsCommand,
  type ReplicaStoreSettingsCommand,
  type ReplicaStoreSettingsResult,
} from "@octant/contracts/replica-store-settings";
import { authenticateRoutePrincipal } from "../principalRouteContext";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import {
  replicaStoreRefusal,
  type ReplicaStoreSettingsService,
} from "./replicaStoreSettingsService";

const ROUTES = {
  settings: "/api/replica-store/settings",
  commands: "/api/replica-store/commands",
} as const;
const METHODS = "GET, POST, OPTIONS";
const HEADERS = "content-type, x-octant-window-capability";
const JSON_BODY_LIMIT = 16_384;

export interface ReplicaStoreSettingsRouteDependencies {
  readonly service: Pick<
    ReplicaStoreSettingsService,
    "view" | "chooseFolder" | "configureS3" | "clear" | "setSync" | "testConnection"
  >;
  readonly windowAuthorityStore: WindowAuthorityStore;
  /**
   * The canonical path behind a candidate the host's folder browser listed for
   * this window. A renderer never names a path; it names a candidate.
   */
  readonly resolveFolderCandidate: (windowId: WindowId, input: unknown) => Promise<string>;
  readonly maxJsonBodySize?: number;
  readonly now?: () => number;
}

export function createReplicaStoreSettingsRouteHandler(
  dependencies: ReplicaStoreSettingsRouteDependencies,
) {
  const now = dependencies.now ?? Date.now;
  const bodyLimit = dependencies.maxJsonBodySize ?? JSON_BODY_LIMIT;

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== ROUTES.settings && url.pathname !== ROUTES.commands) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return failure("Sync settings requests must use loopback.", 400, null);
    }
    if (origin !== null && !isAllowedOrigin(origin)) {
      return failure("Renderer origin is not allowed.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (url.search !== "") return failure("Sync settings request is invalid.", 400, origin);
    const expectedMethod = url.pathname === ROUTES.settings ? "GET" : "POST";
    if (request.method !== expectedMethod) {
      return failure("HTTP method is not supported for this route.", 405, origin);
    }

    let body: unknown;
    if (expectedMethod === "POST") {
      const read = await readJson(request, bodyLimit);
      if (read.kind === "too-large") return failure("Request body is too large.", 413, origin);
      if (read.kind === "invalid") return failure("Request body must be valid JSON.", 400, origin);
      body = read.value;
    }

    let windowId: WindowId;
    try {
      const context = authenticateRoutePrincipal({
        request,
        ...(body === undefined ? {} : { body }),
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
      // Host-only: a paired phone is refused even if transport policy regressed.
      if (context.principal.kind !== "local-window") {
        return failure("Sync settings are host-only.", 403, origin);
      }
      windowId = context.scopeId;
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failure("Sync settings are unauthorized.", 401, origin);
      }
      return failure("Sync settings request is invalid.", 400, origin);
    }

    try {
      if (expectedMethod === "GET") return json(await dependencies.service.view(), origin);
      let command: ReplicaStoreSettingsCommand;
      try {
        command = decodeReplicaStoreSettingsCommand(body);
      } catch {
        return json(replicaStoreRefusal("malformed"), origin);
      }
      return json(await run(dependencies, windowId, command), origin);
    } catch {
      return failure("Sync settings are unavailable.", 500, origin);
    }
  };
}

async function run(
  dependencies: ReplicaStoreSettingsRouteDependencies,
  windowId: WindowId,
  command: ReplicaStoreSettingsCommand,
): Promise<ReplicaStoreSettingsResult> {
  const service = dependencies.service;
  switch (command.kind) {
    case "choose-synced-folder": {
      let folder: string;
      try {
        // The renderer sent a candidate id; the path is resolved here, from
        // the record the host made when it listed the folder for this window.
        folder = await dependencies.resolveFolderCandidate(windowId, {
          hostId: LOCAL_HOST_ID,
          mode: command.mode,
          candidateId: command.candidateId,
        });
      } catch {
        return replicaStoreRefusal("candidate-unavailable");
      }
      return service.chooseFolder({ folder, expectedVersion: command.expectedVersion });
    }
    case "configure-s3":
      return service.configureS3({
        settings: command.settings,
        ...(command.credentials === undefined ? {} : { credentials: command.credentials }),
        expectedVersion: command.expectedVersion,
      });
    case "clear-store":
      return service.clear({ expectedVersion: command.expectedVersion });
    case "set-sync":
      return service.setSync({
        syncOn: command.syncOn,
        expectedVersion: command.expectedVersion,
      });
    case "test-connection":
      return service.testConnection();
  }
}

type ReadJsonResult =
  | { readonly kind: "ok"; readonly value: unknown }
  | { readonly kind: "invalid" }
  | { readonly kind: "too-large" };

async function readJson(request: Request, limit: number): Promise<ReadJsonResult> {
  const contentType = request.headers.get("content-type")?.trim().toLowerCase();
  if (contentType !== "application/json") return { kind: "invalid" };
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return { kind: "too-large" };
  try {
    const text = await request.text();
    if (Buffer.byteLength(text, "utf8") > limit) return { kind: "too-large" };
    return { kind: "ok", value: JSON.parse(text) };
  } catch {
    return { kind: "invalid" };
  }
}

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
    vary: "Origin",
  };
}

function json(body: unknown, origin: string | null): Response {
  return Response.json(body, { status: 200, headers: corsHeaders(origin) });
}

function failure(message: string, status: number, origin: string | null): Response {
  return Response.json({ message }, { status, headers: corsHeaders(origin) });
}

function isAllowedOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return (
      (parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname)) ||
      parsed.protocol === "app:"
    );
  } catch {
    return false;
  }
}
