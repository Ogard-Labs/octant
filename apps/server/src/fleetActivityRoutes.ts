import {
  decodeFleetActivity,
  decodeFleetActivityFailure,
  type FleetActivity,
  type WindowId,
} from "@octant/contracts";
import { createLocalWindowReadRoute } from "./localWindowReadRoute";
import type { WindowAuthorityStore } from "./windowAuthorityStore";

export const FLEET_ACTIVITY_PATH = "/api/fleet-activity";

export interface FleetActivityRouteDependencies {
  readonly service: {
    readonly list: (windowId: WindowId) => Promise<FleetActivity>;
  };
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

/**
 * `GET /api/fleet-activity`: which threads need the person and which are
 * running, for the desktop menu bar. Local windows only, like
 * `/api/pending-requests`, because it reads the same span.
 */
export function createFleetActivityRouteHandler(dependencies: FleetActivityRouteDependencies) {
  return createLocalWindowReadRoute({
    path: FLEET_ACTIVITY_PATH,
    noun: "Fleet activity",
    plural: "Fleet states",
    read: async (windowId) => decodeFleetActivity(await dependencies.service.list(windowId)),
    decodeFailure: decodeFleetActivityFailure,
    windowAuthorityStore: dependencies.windowAuthorityStore,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
}
