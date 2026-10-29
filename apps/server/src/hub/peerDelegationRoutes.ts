// What a member asks of this spoke to delegate work to it, on the private
// listener outside any paired device's session: start a remote child run, read
// its state, and cancel it. Every request is signed with the sender's identity
// key (see hubLink) and resolves to the `peer` principal, held to the peer grant
// this spoke gave that member. No route here answers an approval, marks a
// thread Done, or carries a credential.

import { HUB_LINK_HEADER, HUB_PEER_KEY_HEADER } from "./hubLink";
import { readBody, refused } from "./hubLinkRoutes";
import type { DelegationRefusal, PeerDelegationService } from "./peerDelegationService";

export const PEER_DELEGATION_ROUTES = {
  create: "/api/hub/peer/delegations",
  status: "/api/hub/peer/delegations/status",
  cancel: "/api/hub/peer/delegations/cancel",
} as const;

type RouteValue = (typeof PEER_DELEGATION_ROUTES)[keyof typeof PEER_DELEGATION_ROUTES];

const NO_STORE = { "cache-control": "no-store" } as const;

/** Refusals that mean the request did not prove who sent it, as opposed to a refusal of what it asked. */
const UNAUTHENTICATED: ReadonlySet<string> = new Set([
  "not-a-spoke",
  "hub-revoked",
  "missing",
  "malformed",
  "stale",
  "unknown-sender",
  "key-mismatch",
  "signature-invalid",
  "replayed",
  "not-in-roster",
]);

const NOT_AVAILABLE: ReadonlySet<string> = new Set([
  "project-unavailable",
  "mode-unavailable",
  "posture-unavailable",
  "provider-unavailable",
  "thread-unavailable",
]);

function refusalStatus(kind: DelegationRefusal["kind"]): number {
  if (UNAUTHENTICATED.has(kind)) return 401;
  if (kind === "invalid" || kind === "project-mismatch") return 400;
  if (kind === "unknown-request") return 404;
  if (kind === "request-id-in-use") return 409;
  if (kind === "too-many-open-delegations") return 429;
  if (NOT_AVAILABLE.has(kind)) return 422;
  if (kind === "start-failed") return 503;
  return 403;
}

function refusedWith(receipt: DelegationRefusal): Response {
  return Response.json(
    {
      status: "refused",
      kind: receipt.kind,
      ...(receipt.allowedPosture === undefined ? {} : { allowedPosture: receipt.allowedPosture }),
    },
    { status: refusalStatus(receipt.kind), headers: NO_STORE },
  );
}

export interface PeerDelegationRouteOptions {
  readonly delegation: PeerDelegationService;
}

export function createPeerDelegationRouteHandler(
  options: PeerDelegationRouteOptions,
): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const url = new URL(request.url);
    const route = (Object.values(PEER_DELEGATION_ROUTES) as ReadonlyArray<string>).includes(
      url.pathname,
    )
      ? (url.pathname as RouteValue)
      : undefined;
    if (route === undefined) return undefined;
    if (request.method !== "POST" || url.search !== "") return refused(405, "invalid");
    const body = await readBody(request);
    if (body === undefined) return refused(413, "invalid");
    const signed = {
      header: request.headers.get(HUB_LINK_HEADER),
      publicKey: request.headers.get(HUB_PEER_KEY_HEADER),
      method: request.method,
      path: route,
      body,
    };
    if (route === PEER_DELEGATION_ROUTES.create) {
      const receipt = await options.delegation.receive(signed);
      return receipt.status === "accepted"
        ? Response.json(receipt, { status: 201, headers: NO_STORE })
        : refusedWith(receipt);
    }
    if (route === PEER_DELEGATION_ROUTES.status) {
      const receipt = await options.delegation.status(signed);
      return receipt.status === "read"
        ? Response.json(receipt.delegation, { headers: NO_STORE })
        : refusedWith(receipt);
    }
    const receipt = await options.delegation.cancel(signed);
    return receipt.status === "refused"
      ? refusedWith(receipt)
      : Response.json(receipt, { headers: NO_STORE });
  };
}
