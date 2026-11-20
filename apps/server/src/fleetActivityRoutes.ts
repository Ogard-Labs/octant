import {
  decodeFleetActivity,
  decodeFleetActivityFailure,
  type FleetActivity,
  type WindowId,
} from "@octant/contracts";
import { createLocalWindowReadRoute } from "./localWindowReadRoute";
import type { PrincipalKind } from "@octant/domain/remote-access-policy";
import type { WindowAuthorityStore } from "./windowAuthorityStore";

export const FLEET_ACTIVITY_PATH = "/api/fleet-activity";

export interface FleetActivityRouteDependencies {
  readonly service: {
    readonly list: (windowId: WindowId, reader: PrincipalKind) => Promise<FleetActivity>;
  };
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

/**
 * `GET /api/fleet-activity`: which threads need the person and which are
 * running, for the desktop menu bar and person-paired devices.
 */
export function createFleetActivityRouteHandler(dependencies: FleetActivityRouteDependencies) {
  return createLocalWindowReadRoute({
    path: FLEET_ACTIVITY_PATH,
    noun: "Fleet activity",
    plural: "Fleet states",
    read: async (windowId, reader) =>
      decodeFleetActivity(await dependencies.service.list(windowId, reader)),
    decodeFailure: decodeFleetActivityFailure,
    windowAuthorityStore: dependencies.windowAuthorityStore,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
}
