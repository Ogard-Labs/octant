/**
 * Host-only replica membership routes, and the read-only sync status a paired
 * device may see.
 *
 * Store setup, join approval, and revocation are host authority: a paired
 * phone must be refused even if transport policy regressed. The commands and
 * the full membership view (matching codes, join requests, what this computer
 * may revoke) are registered only on the loopback chain, outside the shared
 * product dispatch the remote gateway uses, and the principal check refuses
 * anything that is not a local window. The status route rides the shared
 * dispatch and carries nothing a caller could act on.
 */

import {
  decodeReplicaJoinReadCommand,
  decodeReplicaMembershipCommand,
  decodeReplicaRestoreCommand,
  type ReplicaMembershipCommand,
  type ReplicaMembershipView,
  type ReplicaRestoreCommand,
  type ReplicaRestoreResult,
} from "@octant/contracts/replica-entry";
import type { ClientPrincipal } from "../clientPrincipal";
import { authenticateRoutePrincipal, readPrincipalRouteContext } from "../principalRouteContext";
import { isAllowedRendererOrigin, isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type {
  ReplicaMembershipOutcome,
  ReplicaMembershipService,
} from "./replicaMembershipService";
import { replicaSyncStatusView } from "./replicaMembershipView";

const JSON_BODY_LIMIT = 262_144;
const COMMANDS_PATH = "/api/replica-membership/commands";
const STATE_PATH = "/api/replica-membership/state";
export const REPLICA_SYNC_STATUS_PATH = "/api/replica-sync/status";

export interface ReplicaMembershipRouteDependencies {
  readonly service: ReplicaMembershipService;
  /** Membership as Settings › Sync shows it on this host. */
  readonly view: () => ReplicaMembershipView;
  /** Stop and resume this computer's restore of the replica's library. */
  readonly restore?: {
    readonly stop: () => ReplicaRestoreResult;
    readonly resume: () => ReplicaRestoreResult;
  };
  readonly windowAuthorityStore: WindowAuthorityStore;
  /** The development renderer origin, or null when the packaged file renderer is in use. */
  readonly allowedRendererHttpOrigin?: string | null;
  readonly maxJsonBodySize?: number;
  readonly now?: () => number;
}

export function createReplicaMembershipRouteHandler(
  dependencies: ReplicaMembershipRouteDependencies,
) {
  const now = dependencies.now ?? Date.now;
  const jsonLimit = dependencies.maxJsonBodySize ?? JSON_BODY_LIMIT;

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== STATE_PATH && url.pathname !== COMMANDS_PATH) return undefined;
    const origin = request.headers.get("origin");
    // The Settings renderer calls these from its own origin: the development
    // server, or the packaged app's opaque one. Any other origin, and any
    // host name that is not loopback, is refused before authentication.
    if (!isLoopbackHostname(url.hostname)) {
      return failure("Replica membership requests must use loopback.", 400, null);
    }
    if (
      origin !== null &&
      !isAllowedRendererOrigin(origin, dependencies.allowedRendererHttpOrigin)
    ) {
      return failure("Renderer origin is not allowed.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (url.pathname === STATE_PATH) return readState(request, url);
    if (request.method !== "POST" || url.search !== "") {
      return failure("Replica membership request is invalid.", 400, origin);
    }
    let body: unknown;
    try {
      const contentType = request.headers.get("content-type")?.trim().toLowerCase();
      if (contentType !== "application/json") throw new Error("content-type");
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength > jsonLimit) throw new Error("too-large");
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return failure("Replica membership request is invalid.", 400, origin);
    }

    let principal;
    try {
      principal = authenticateRoutePrincipal({
        request,
        body,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return failure("Replica membership request is unauthorized.", 401, origin);
      }
      return failure("Replica membership request is invalid.", 400, origin);
    }
    // Host-only: a paired phone is refused even if transport policy regressed.
    if (principal.principal.kind !== "local-window") {
      return failure("Replica membership is host-only.", 403, origin);
    }

    // Stopping and resuming a restore are host decisions too, on this route.
    let restoreCommand: ReplicaRestoreCommand | undefined;
    try {
      restoreCommand = decodeReplicaRestoreCommand(body);
    } catch {
      restoreCommand = undefined;
    }
    if (restoreCommand !== undefined) {
      const restore = dependencies.restore;
      if (restore === undefined) {
        return failure("Replica restore is not available on this host.", 404, origin);
      }
      const result = restoreCommand.kind === "stop-restore" ? restore.stop() : restore.resume();
      return Response.json(result, { status: 200, headers: corsHeaders(origin) });
    }

    // Stopping a join confirmation's read answers at once: the confirmation
    // holds the command line while it reads, so this does not queue behind it.
    let stopsJoinRead = false;
    try {
      stopsJoinRead = decodeReplicaJoinReadCommand(body).kind === "stop-join-read";
    } catch {
      stopsJoinRead = false;
    }
    if (stopsJoinRead) {
      return Response.json(dependencies.service.stopJoinRead(), {
        status: 200,
        headers: corsHeaders(origin),
      });
    }

    // The contract decoder is the only way in: a join request a caller hands
    // over is a store-read entry, and an untrusted payload never reaches the
    // service without passing the same schema the store's entries do.
    let command: ReplicaMembershipCommand;
    try {
      command = decodeReplicaMembershipCommand(body);
    } catch {
      return failure("Replica membership command is invalid.", 400, origin);
    }

    let outcome: ReplicaMembershipOutcome;
    try {
      outcome = await dependencies.service.execute(command);
    } catch {
      return failure("Replica membership command failed.", 500, origin);
    }
    return Response.json(outcome, { status: 200, headers: corsHeaders(origin) });
  };

  function readState(request: Request, url: URL): Response {
    const origin = request.headers.get("origin");
    if (request.method !== "GET" || url.search !== "") {
      return failure("Replica membership request is invalid.", 400, origin);
    }
    let principal;
    try {
      principal = authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      });
    } catch {
      return failure("Replica membership request is unauthorized.", 401, origin);
    }
    if (principal.principal.kind !== "local-window") {
      return failure("Replica membership is host-only.", 403, origin);
    }
    try {
      return Response.json(dependencies.view(), {
        status: 200,
        headers: corsHeaders(origin, true),
      });
    } catch {
      return failure("Replica membership could not be read.", 500, origin);
    }
  }
}

export interface ReplicaSyncStatusRouteDependencies {
  readonly windowAuthorityStore: WindowAuthorityStore;
  /** This host's stable identity. Absent until one has been projected. */
  readonly hostId: () => string | undefined;
  readonly view: () => ReplicaMembershipView;
  /** The development renderer origin, or null when the packaged file renderer is in use. */
  readonly allowedRendererHttpOrigin?: string | null;
  readonly now?: () => number;
}

/**
 * Read-only sync status for the shared product dispatch: a local window, and
 * a paired device of this host under `project.overview.read`. It answers with
 * the status view only - no codes, join requests, ids, or revocability.
 */
export function createReplicaSyncStatusRouteHandler(
  dependencies: ReplicaSyncStatusRouteDependencies,
) {
  const now = dependencies.now ?? Date.now;
  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (url.pathname !== REPLICA_SYNC_STATUS_PATH) return undefined;
    const origin = request.headers.get("origin");
    if (
      origin !== null &&
      !isAllowedRendererOrigin(origin, dependencies.allowedRendererHttpOrigin)
    ) {
      return failure("Renderer origin is not allowed.", 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    if (request.method !== "GET" || url.search !== "") {
      return failure("Sync status request is invalid.", 400, origin);
    }
    let principal: ClientPrincipal;
    try {
      principal =
        readPrincipalRouteContext(request)?.principal ??
        authenticateRoutePrincipal({
          request,
          store: dependencies.windowAuthorityStore,
          now: now(),
        }).principal;
    } catch {
      return failure("Sync status request is unauthorized.", 401, origin);
    }
    if (!statusReader(principal, dependencies.hostId())) {
      return failure("Sync status is not available to this client.", 403, origin);
    }
    try {
      return Response.json(replicaSyncStatusView(dependencies.view()), {
        status: 200,
        headers: corsHeaders(origin, true),
      });
    } catch {
      return failure("Sync status could not be read.", 500, origin);
    }
  };
}

// The same reach as reading this host's load or its Projects: the local owner,
// or a paired device bound to this host's own identity.
function statusReader(principal: ClientPrincipal, hostId: string | undefined): boolean {
  if (principal.kind === "local-window") return true;
  if (principal.kind !== "remote-device") return false;
  if (hostId === undefined || hostId.length === 0) return false;
  return String(principal.hostId) === hostId;
}

function failure(message: string, status: number, origin: string | null): Response {
  return Response.json({ message }, { status, headers: corsHeaders(origin) });
}

function corsHeaders(origin: string | null, noStore = false): Headers {
  const headers = new Headers({
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-octant-window-capability",
    vary: "Origin",
  });
  if (noStore) headers.set("cache-control", "no-store");
  // Only an origin the caller already admitted reaches here.
  if (origin !== null) headers.set("access-control-allow-origin", origin);
  return headers;
}
