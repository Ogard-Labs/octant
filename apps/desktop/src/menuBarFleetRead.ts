import { decodeFleetActivity, type FleetActivity } from "@octant/contracts/fleet-activity";

export const FLEET_ACTIVITY_PATH = "/api/fleet-activity";

export interface MenuBarFleetHost {
  readonly url: string;
  readonly instanceId: string;
}

export interface MenuBarFleetAuthority {
  readonly capability: string;
  readonly revoke: () => Promise<void>;
}

export interface MenuBarFleetReaderOptions {
  /**
   * Registers a window authority for the menu bar with the desktop bridge
   * secret, the same way a Project window gets its own.
   */
  readonly register: (host: MenuBarFleetHost) => Promise<MenuBarFleetAuthority>;
  readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
}

/**
 * Reads the host's fleet roster for the menu bar while every window may be
 * closed. The menu bar holds its own local-window authority, registered with
 * the bridge secret the shell already holds, so it reads exactly what any
 * local window could and nothing a window could not. The authority is
 * replaced when the host instance changes and revoked when the menu bar goes.
 *
 * A read that fails returns `undefined`, never an empty roster: an empty list
 * would read as every running thread having finished.
 */
export function createMenuBarFleetReader(options: MenuBarFleetReaderOptions) {
  let authority: (MenuBarFleetAuthority & { readonly instanceId: string }) | undefined;
  let inFlight: Promise<FleetActivity | undefined> | undefined;

  const drop = async (): Promise<void> => {
    const current = authority;
    authority = undefined;
    await current?.revoke().catch(() => undefined);
  };

  const readOnce = async (host: MenuBarFleetHost): Promise<FleetActivity | undefined> => {
    if (authority !== undefined && authority.instanceId !== host.instanceId) await drop();
    if (authority === undefined) {
      try {
        authority = { ...(await options.register(host)), instanceId: host.instanceId };
      } catch {
        return undefined;
      }
    }
    let response: Response;
    try {
      response = await options.fetch(new URL(FLEET_ACTIVITY_PATH, host.url).toString(), {
        method: "GET",
        headers: { "x-octant-window-capability": authority.capability },
      });
    } catch {
      return undefined;
    }
    if (response.status === 401) {
      // The host forgot this authority (it restarted under the same instance or
      // revoked it); the next read registers a fresh one.
      await drop();
      return undefined;
    }
    if (response.status !== 200) return undefined;
    try {
      return decodeFleetActivity(await response.json());
    } catch {
      return undefined;
    }
  };

  return {
    read(host: MenuBarFleetHost): Promise<FleetActivity | undefined> {
      inFlight ??= readOnce(host).finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    revoke: drop,
  };
}
