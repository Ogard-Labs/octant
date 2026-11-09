// The routes a member's handover requests reach: the source's notice that it
// pushed a handover, and the destination's report that it continued one. Each
// is signed like every member request; the notice opens nothing, and the
// report erases only a thread this host itself handed over.

import { HUB_LINK_HEADER, HUB_PEER_KEY_HEADER } from "./hubLink";
import { readBody, refused } from "./hubLinkRoutes";
import { HANDOVER_ROUTES, type HandoverExchange } from "./handoverExchange";
import type { DestinationAnswer, SignedRequest } from "./threadMoveService";

const NO_STORE = { "cache-control": "no-store" } as const;

/** A notice names a title, a remote, and a branch; a report names two ids. */
export const HANDOVER_ROUTE_BODY_BYTES: Readonly<Record<string, number>> = {
  [HANDOVER_ROUTES.notice]: 16 * 1024,
  [HANDOVER_ROUTES.continued]: 4_096,
};

export function createHandoverRouteHandler(options: {
  readonly exchange: HandoverExchange;
}): (request: Request) => Promise<Response | undefined> {
  const handlers: Readonly<Record<string, (signed: SignedRequest) => Promise<DestinationAnswer>>> =
    {
      [HANDOVER_ROUTES.notice]: (signed) => options.exchange.receiveNotice(signed),
      [HANDOVER_ROUTES.continued]: (signed) => options.exchange.receiveContinued(signed),
    };
  return async (request) => {
    const url = new URL(request.url);
    const handler = handlers[url.pathname];
    const limit = HANDOVER_ROUTE_BODY_BYTES[url.pathname];
    if (handler === undefined || limit === undefined) return undefined;
    if (request.method !== "POST" || url.search !== "") return refused(405, "invalid");
    const body = await readBody(request, limit);
    if (body === undefined) return refused(413, "invalid");
    const answer = await handler({
      header: request.headers.get(HUB_LINK_HEADER),
      publicKey: request.headers.get(HUB_PEER_KEY_HEADER),
      method: request.method,
      path: url.pathname,
      body,
    });
    return Response.json(answer.body, { status: answer.httpStatus, headers: NO_STORE });
  };
}
