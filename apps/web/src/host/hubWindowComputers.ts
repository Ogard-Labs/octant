import { decodeHubWindowComputers } from "@octant/contracts";
import {
  createHubWindowDismissalStore,
  createHubWindowIdentityStore,
  syncHubWindowComputers,
  type HubWindowComputersSync,
  type HubWindowIntroduction,
} from "@octant/client-runtime/hub-window-computers";
import type { HostFederationStack } from "./useHostFederationLifecycle";
import type { HostFederationLifecycle } from "@octant/client-runtime/host-federation-lifecycle";
import type { ClientHostRegistry } from "@octant/client-runtime/host-federation-registry";
import type { ClientHostRegistryStorage } from "@octant/client-runtime/host-federation-registry";
import type { HubComputersBridge, PairedComputersBridge } from "../shell/hostBridge";
import { createPairedComputerFetch } from "./pairedComputerFetch";

/** How the window names itself to each member that admits it. */
const WINDOW_DEVICE_LABEL = "Octant desktop window";

/**
 * Adds the hub's other members to this desktop window's computers, and takes
 * off the ones the hub no longer lists. Each member is asked through the
 * desktop's paired-computer channel, held to the pin this computer's host
 * named for it, and a computer the person paired directly stays theirs.
 */
export async function syncHubComputersInWindow(input: {
  readonly bridge: HubComputersBridge & Pick<PairedComputersBridge, "requestPairedComputer">;
  readonly stack: HostFederationStack;
  readonly storage: ClientHostRegistryStorage;
  /**
   * Takes a member the roster dropped off the window. It must not be the
   * person's own Remove, which also records a dismissal.
   */
  readonly removeHost?: (hostId: string) => Promise<unknown>;
}): Promise<HubWindowComputersSync> {
  const { bridge, stack } = input;
  const channelFetch = createPairedComputerFetch(bridge);
  const outcome = await syncHubWindowComputers({
    introduce: async (request): Promise<HubWindowIntroduction> => {
      const answer = await bridge.introduceWindowToHub({
        memberId: String(request.memberId),
        devicePublicKey: request.devicePublicKey,
        deviceLabel: request.deviceLabel,
      });
      if (answer.membership === "unavailable") return answer;
      try {
        return decodeHubWindowComputers(answer);
      } catch {
        return { membership: "unavailable" };
      }
    },
    // Main decides the pin from its own record; the window names none.
    transport: () => ({ status: "available", fetch: channelFetch }),
    registry: stack.registry,
    deviceKeyStore: stack.deviceKeyStore,
    identity: createHubWindowIdentityStore(input.storage),
    dismissals: createHubWindowDismissalStore(input.storage),
    deviceLabel: WINDOW_DEVICE_LABEL,
    removeHost: input.removeHost ?? ((hostId) => stack.lifecycle.removeLocal(hostId)),
  });
  // A member that issued a new device gets a new session with it.
  if (outcome.status === "synced") {
    for (const hostId of outcome.replaced) await stack.transports.disconnectHost(hostId);
  }
  await stack.lifecycle.sync();
  return outcome;
}

/**
 * The person's own Remove and Revoke of a computer the hub introduced: each
 * also records a dismissal, so the next roster refresh does not list it again.
 * Roster cleanup goes through the undecorated lifecycle and records nothing.
 */
export function withHubComputerDismissals(
  lifecycle: HostFederationLifecycle,
  registry: ClientHostRegistry,
  storage: ClientHostRegistryStorage,
): HostFederationLifecycle {
  const dismissals = createHubWindowDismissalStore(storage);
  const dismissIfIntroduced = async (hostId: string): Promise<void> => {
    if ((await registry.get(hostId))?.through === "hub") await dismissals.dismiss(hostId);
  };
  return {
    ...lifecycle,
    removeLocal: async (hostId) => {
      await dismissIfIntroduced(String(hostId));
      return lifecycle.removeLocal(hostId);
    },
    revoke: async (hostId, options) => {
      await dismissIfIntroduced(String(hostId));
      return options === undefined ? lifecycle.revoke(hostId) : lifecycle.revoke(hostId, options);
    },
  };
}
