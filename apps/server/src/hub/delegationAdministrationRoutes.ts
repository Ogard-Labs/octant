// Loopback administration of this host's own delegations: a person at a window
// on this spoke starts a remote child run for one of its threads, reads where
// it stands, and cancels it. Like the rest of hub administration these answer
// only the loopback desktop bridge with an authenticated window capability and
// refuse a request that carries an Origin header; the private listener refuses
// the whole prefix, so a peer, the hub, or a paired device reaches them on no
// path. They are the entry point an agent's helper request reaches through the
// host until the agent tool surface carries a target member.

import { createHash, timingSafeEqual } from "node:crypto";
import { decodeDelegationReference, decodeDelegationStartCommand } from "@octant/contracts";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type { DelegatingSpokeService } from "./delegatingSpokeService";

const BODY_LIMIT = 64 * 1_024;

export const DELEGATION_ADMINISTRATION_ROUTES = {
  start: "/api/desktop/hub/delegations",
  read: "/api/desktop/hub/delegations/read",
  cancel: "/api/desktop/hub/delegations/cancel",
} as const;

type RouteValue =
  (typeof DELEGATION_ADMINISTRATION_ROUTES)[keyof typeof DELEGATION_ADMINISTRATION_ROUTES];

export interface DelegationAdministrationRouteOptions {
  readonly desktopBridgeSecret: string | undefined;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly delegation: DelegatingSpokeService;
  readonly now?: () => number;
}

export function createDelegationAdministrationRouteHandler(
  options: DelegationAdministrationRouteOptions,
): (request: Request) => Promise<Response | undefined> {
  const now = options.now ?? Date.now;
  return async (request) => {
    const url = new URL(request.url);
    if (
      !(Object.values(DELEGATION_ADMINISTRATION_ROUTES) as ReadonlyArray<string>).includes(
        url.pathname,
      )
    ) {
      return undefined;
    }
    const route = url.pathname as RouteValue;
    if (options.desktopBridgeSecret === undefined) return failure("unavailable", 503);
    if (
      !isLoopbackHostname(url.hostname) ||
      request.headers.has("origin") ||
      !secretsEqual(
        options.desktopBridgeSecret,
        request.headers.get("x-octant-desktop-secret") ?? "",
      )
    ) {
      return failure("unauthorized", 401);
    }
    if (url.search !== "" || request.method !== "POST") return failure("invalid", 400);
    let windowId: string;
    try {
      windowId = String(
        options.windowAuthorityStore.authenticate(
          request.headers.get("x-octant-window-capability") ?? "",
          now(),
        ),
      );
    } catch (error) {
      return failure(error instanceof WindowAuthorityError ? "unauthorized" : "invalid", 401);
    }
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
      return failure("invalid", 400);
    }
    const text = await request.text().catch(() => undefined);
    if (text === undefined || Buffer.byteLength(text, "utf8") > BODY_LIMIT) {
      return failure("invalid", 413);
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      return failure("invalid", 400);
    }
    try {
      if (route === DELEGATION_ADMINISTRATION_ROUTES.start) {
        return outcome(
          await options.delegation.delegate(decodeDelegationStartCommand(value), { windowId }),
        );
      }
      const reference = String(decodeDelegationReference(value).requestId);
      return route === DELEGATION_ADMINISTRATION_ROUTES.read
        ? outcome(await options.delegation.refresh(reference))
        : outcome(await options.delegation.cancel(reference));
    } catch {
      return failure("invalid", 400);
    }
  };
}

/** A refusal is a state the person can act on, so it answers 409 with its kind; anything else is the outcome. */
function outcome(value: { readonly status: string }): Response {
  const refused =
    value.status === "refused" ||
    value.status === "refused-by-target" ||
    value.status === "unknown-request" ||
    value.status === "target-unreachable";
  return Response.json(value, {
    status: refused ? 409 : 200,
    headers: { "cache-control": "no-store" },
  });
}

function secretsEqual(expected: string, actual: string): boolean {
  const left = createHash("sha256").update(expected, "utf8").digest();
  const right = createHash("sha256").update(actual, "utf8").digest();
  return timingSafeEqual(left, right);
}

function failure(category: "invalid" | "unauthorized" | "unavailable", status: number): Response {
  return Response.json(
    {
      category,
      message:
        category === "unavailable"
          ? "Delegation administration is unavailable."
          : category === "unauthorized"
            ? "Delegation administration is unauthorized."
            : "Delegation administration request is invalid.",
    },
    { status },
  );
}
