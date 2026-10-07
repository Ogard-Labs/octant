/**
 * Host-only replica membership routes.
 *
 * Store setup, join approval, and revocation are host authority: a paired
 * phone must be refused even if transport policy regressed. These routes are
 * registered only on the loopback chain, outside the shared product dispatch
 * the remote gateway uses, and the principal check refuses anything that is
 * not a local window.
 */

import {
  decodeReplicaMembershipCommand,
  type ReplicaMembershipCommand,
} from "@octant/contracts/replica-entry";
import { authenticateRoutePrincipal } from "../principalRouteContext";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type {
  ReplicaMembershipOutcome,
  ReplicaMembershipService,
} from "./replicaMembershipService";

const JSON_BODY_LIMIT = 262_144;
const COMMANDS_PATH = "/api/replica-membership/commands";

export interface ReplicaMembershipRouteDependencies {
  readonly service: ReplicaMembershipService;
  readonly windowAuthorityStore: WindowAuthorityStore;
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
    if (url.pathname !== COMMANDS_PATH) return undefined;
    const origin = request.headers.get("origin");
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
}

function failure(message: string, status: number, origin: string | null): Response {
  return Response.json({ message }, { status, headers: corsHeaders(origin) });
}

function corsHeaders(origin: string | null): Headers {
  const headers = new Headers({ vary: "Origin" });
  if (origin !== null && isLoopbackHttpOrigin(origin)) {
    headers.set("access-control-allow-origin", origin);
  }
  return headers;
}

function isLoopbackHttpOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return (
      origin === parsed.origin &&
      parsed.protocol === "http:" &&
      (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
    );
  } catch {
    return false;
  }
}
