import {
  decodeActiveWork,
  decodeActiveWorkFailure,
  type ActiveWork,
} from "@octant/contracts/active-work";
import type { WindowId } from "@octant/contracts";
import { isAgentGrantSession, type ClientPrincipal } from "../clientPrincipal";
import { createLocalWindowReadRoute } from "../localWindowReadRoute";
import type { WindowAuthorityStore } from "../windowAuthorityStore";

export const ACTIVE_WORK_PATH = "/api/active-work";

export interface ActiveWorkRouteDependencies {
  readonly service: {
    readonly list: (windowId: WindowId, principal: ClientPrincipal) => Promise<ActiveWork>;
  };
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

/**
 * `GET /api/active-work`: the work on this host that is not Done, for a window
 * or a paired device, narrowed to the threads that reader's own lists hold.
 * An agent grant's session is no person's and is refused: what an agent may
 * read of other threads is decided by its own tools.
 */
export function createActiveWorkRouteHandler(dependencies: ActiveWorkRouteDependencies) {
  return createLocalWindowReadRoute({
    path: ACTIVE_WORK_PATH,
    noun: "Active work",
    plural: "Active work rows",
    admits: (principal) => !isAgentGrantSession(principal),
    read: async (windowId, _reader, _request, principal) =>
      decodeActiveWork(await dependencies.service.list(windowId, principal)),
    decodeFailure: decodeActiveWorkFailure,
    windowAuthorityStore: dependencies.windowAuthorityStore,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
}
