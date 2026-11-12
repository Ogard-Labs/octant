import { readPrincipalRouteContext } from "../principalRouteContext";

export type PairedDeviceRoutes = (request: Request) => Promise<Response | undefined>;

/**
 * The place in the product route chain for the routes the remote wiring
 * builds. The loopback listener asks those routes itself, ahead of the product
 * chain; a paired device's request reaches only the product chain, so without
 * this slot each of them answered a device with Not Found whatever the private
 * listener forwarded. The remote wiring is built after the chain and binds its
 * routes here; the slot answers nothing until then.
 *
 * Only a device's request is handed on. Each bound route still judges the
 * device itself: the slot decides where a request can arrive, never who may
 * act.
 */
export function createPairedDeviceRouteSlot(): {
  readonly routes: PairedDeviceRoutes;
  readonly bind: (routes: ReadonlyArray<PairedDeviceRoutes>) => void;
} {
  let bound: ReadonlyArray<PairedDeviceRoutes> = [];
  return {
    routes: async (request) => {
      if (readPrincipalRouteContext(request)?.principal.kind !== "remote-device") return undefined;
      for (const routes of bound) {
        const response = await routes(request);
        if (response !== undefined) return response;
      }
      return undefined;
    },
    bind: (routes) => {
      bound = routes;
    },
  };
}
