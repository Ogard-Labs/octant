// The destination's routes for a thread move another member sends. Each is
// signed like every member request, but the move carries no authority of its
// own: the offer is accepted only against a one-time ticket an owner made on
// this host with a fresh unlock, naming this sender, and every later request
// names a move that sender owns.

import { HUB_LINK_HEADER, HUB_PEER_KEY_HEADER } from "./hubLink";
import { readBody, refused } from "./hubLinkRoutes";
import {
  THREAD_MOVE_CHUNK_MAX_BODY_BYTES,
  THREAD_MOVE_ROUTES,
  type DestinationAnswer,
  type SignedRequest,
  type ThreadMoveService,
} from "./threadMoveService";

const NO_STORE = { "cache-control": "no-store" } as const;

/** The body cap each route holds a request to; only a chunk carries part bytes. */
export const THREAD_MOVE_ROUTE_BODY_BYTES: Readonly<Record<string, number>> = {
  [THREAD_MOVE_ROUTES.offer]: 256 * 1024,
  [THREAD_MOVE_ROUTES.chunk]: THREAD_MOVE_CHUNK_MAX_BODY_BYTES,
  [THREAD_MOVE_ROUTES.finish]: 4_096,
  [THREAD_MOVE_ROUTES.commit]: 4_096,
  [THREAD_MOVE_ROUTES.status]: 4_096,
  [THREAD_MOVE_ROUTES.discard]: 4_096,
  // Sixteen repository remotes of at most 2 KiB each.
  [THREAD_MOVE_ROUTES.projects]: 64 * 1024,
};

export function createThreadMoveRouteHandler(options: {
  readonly moves: ThreadMoveService;
}): (request: Request) => Promise<Response | undefined> {
  const answer = (outcome: DestinationAnswer) =>
    Response.json(outcome.body, { status: outcome.httpStatus, headers: NO_STORE });
  const handlers: Readonly<Record<string, (signed: SignedRequest) => Promise<DestinationAnswer>>> =
    {
      [THREAD_MOVE_ROUTES.offer]: (signed) => options.moves.receiveOffer(signed),
      [THREAD_MOVE_ROUTES.chunk]: (signed) => options.moves.receiveChunk(signed),
      [THREAD_MOVE_ROUTES.finish]: (signed) => options.moves.finish(signed),
      [THREAD_MOVE_ROUTES.commit]: (signed) => options.moves.commit(signed),
      [THREAD_MOVE_ROUTES.status]: (signed) => options.moves.status(signed),
      [THREAD_MOVE_ROUTES.discard]: (signed) => options.moves.discard(signed),
      [THREAD_MOVE_ROUTES.projects]: (signed) => options.moves.listProjects(signed),
    };
  return async (request) => {
    const url = new URL(request.url);
    const handler = handlers[url.pathname];
    const limit = THREAD_MOVE_ROUTE_BODY_BYTES[url.pathname];
    if (handler === undefined || limit === undefined) return undefined;
    if (request.method !== "POST" || url.search !== "") return refused(405, "invalid");
    const body = await readBody(request, limit);
    if (body === undefined) return refused(413, "invalid");
    return answer(
      await handler({
        header: request.headers.get(HUB_LINK_HEADER),
        publicKey: request.headers.get(HUB_PEER_KEY_HEADER),
        method: request.method,
        path: url.pathname,
        body,
      }),
    );
  };
}
