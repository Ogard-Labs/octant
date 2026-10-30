// The receiving host's route for a sign-in copy an owner device started. It is
// signed like every member request, but it carries no authority of its own: the
// key is stored only against a one-time ticket an owner made on this host with
// a fresh unlock, naming this sender and this sign-in.

import { HUB_LINK_HEADER, HUB_PEER_KEY_HEADER } from "./hubLink";
import { readBody, refused } from "./hubLinkRoutes";
import { PEER_CREDENTIAL_ROUTE, type OwnerCredentialCopyService } from "./ownerCredentialCopy";

const NO_STORE = { "cache-control": "no-store" } as const;

/** Refusals that mean the request did not prove who sent it. */
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
  "hub-cannot-delegate",
  "no-peer-grant",
]);

export function createPeerCredentialRouteHandler(options: {
  readonly copy: OwnerCredentialCopyService;
}): (request: Request) => Promise<Response | undefined> {
  return async (request) => {
    const url = new URL(request.url);
    if (url.pathname !== PEER_CREDENTIAL_ROUTE) return undefined;
    if (request.method !== "POST" || url.search !== "") return refused(405, "invalid");
    const body = await readBody(request);
    if (body === undefined) return refused(413, "invalid");
    const outcome = await options.copy.receive({
      header: request.headers.get(HUB_LINK_HEADER),
      publicKey: request.headers.get(HUB_PEER_KEY_HEADER),
      method: request.method,
      path: PEER_CREDENTIAL_ROUTE,
      body,
    });
    if (outcome.status === "ok") {
      return Response.json({ status: "stored" }, { headers: NO_STORE });
    }
    return Response.json(
      { status: "refused", kind: outcome.kind },
      { status: UNAUTHENTICATED.has(outcome.kind) ? 401 : 409, headers: NO_STORE },
    );
  };
}
