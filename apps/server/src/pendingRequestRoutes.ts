import {
  decodePendingRequestFailure,
  decodePendingRequestList,
  type PendingRequestList,
  type WindowId,
} from "@octant/contracts";
import { createLocalWindowReadRoute } from "./localWindowReadRoute";
import type { WindowAuthorityStore } from "./windowAuthorityStore";

export const PENDING_REQUESTS_PATH = "/api/pending-requests";

export interface PendingRequestRouteDependencies {
  readonly service: {
    readonly list: (windowId: WindowId) => Promise<PendingRequestList>;
  };
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

/**
 * `GET /api/pending-requests`: every approval and question the calling window
 * can answer. Local windows only.
 */
export function createPendingRequestRouteHandler(dependencies: PendingRequestRouteDependencies) {
  return createLocalWindowReadRoute({
    path: PENDING_REQUESTS_PATH,
    noun: "Pending request",
    plural: "Pending requests",
    read: async (windowId) => decodePendingRequestList(await dependencies.service.list(windowId)),
    decodeFailure: decodePendingRequestFailure,
    windowAuthorityStore: dependencies.windowAuthorityStore,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
}
