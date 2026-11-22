// The hub's lookups of a member by its listener address, against a real hub
// and spoke: the removal guard reads the roster the hub keeps while its role
// is off, and a signed hello is believed only while the role is on.

import { afterEach, describe, expect, it } from "vitest";
import { HubTestNetwork, startHubTestHost, type HubTestHost } from "./hubHost.test-support";
import { hubMemberAt, rosterListsListener } from "./memberHello";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const window = { kind: "local-window" } as const;

async function joinSpoke(hub: HubTestHost, spoke: HubTestHost) {
  const minted = hub.hub.mintJoinCode({ owner: false });
  if (minted.status !== "minted") throw new Error(minted.status);
  const started = await spoke.spoke.startJoin({ code: minted.code });
  if (started.status !== "awaiting-approval") throw new Error(JSON.stringify(started));
  const [pending] = hub.administration.listPendingPairings();
  if (pending === undefined) throw new Error("The hub shows no pairing to approve.");
  hub.administration.approvePairing({ ticketId: pending.ticketId });
  const finished = await spoke.spoke.finishJoin(window);
  if (finished.status !== "joined") throw new Error(JSON.stringify(finished));
}

describe("a member found by its listener address", () => {
  it("stays listed for removal while the hub role is off, though no hello is believed from it then", async () => {
    const network = new HubTestNetwork();
    const hub = await startHubTestHost({
      name: "Mac mini",
      address: "100.101.102.103",
      network,
      cleanups,
    });
    const spoke = await startHubTestHost({
      name: "Studio",
      address: "100.101.102.105",
      network,
      cleanups,
    });
    if (hub.hub.enable(window).status !== "enabled") throw new Error("The hub did not start.");
    await joinSpoke(hub, spoke);
    const listener = { address: "100.101.102.105", port: 8443 };
    expect(rosterListsListener(hub.state, listener)).toBe(true);
    expect(hubMemberAt(hub.state, listener)).toBeDefined();

    // The owner turns the hub off with the address-only member still listed,
    // then retries its removal: the guard and the leave step must still see it.
    expect(hub.hub.disable(window).status).toBe("disabled");

    expect(rosterListsListener(hub.state, listener)).toBe(true);
    expect(hubMemberAt(hub.state, listener)).toBeUndefined();
    expect(rosterListsListener(hub.state, { address: "100.101.102.199", port: 8443 })).toBe(false);
  }, 60_000);
});
