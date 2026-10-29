// What the hub may and may not do on a spoke, and what a stranger may not do
// on either. Host A is the hub, host B a spoke that joined it; A's identity key
// signs the requests, as A's own server would.

import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubMemberId, encodeSignedHubRoster, type SignedHubRoster } from "@octant/contracts";
import { hubRosterSigningPayload } from "@octant/domain";
import { HUB_LINK_HEADER, signHubLinkRequest } from "./hubLink";
import { HubTestNetwork, startHubTestHost, type HubTestHost } from "./hubHost.test-support";
import { createPinnedHubTransport } from "./pinnedHubTransport";
import { REMOTE_HUB_LINK_ROUTE_IDS, createRemoteRoutePolicy } from "../remoteRoutePolicy";
import { HUB_LINK_ROUTES } from "./hubLinkRoutes";
import { PEER_DELEGATION_ROUTES } from "./peerDelegationRoutes";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const window = { kind: "local-window" } as const;
const decodeHubMemberId = Schema.decodeUnknownSync(HubMemberId);
const LISTENER_HOST = "100.101.102.103:8443";

async function joinedPair() {
  const network = new HubTestNetwork();
  const a = await startHubTestHost({
    name: "Mac mini",
    address: "100.101.102.103",
    network,
    cleanups,
  });
  const b = await startHubTestHost({
    name: "Laptop",
    address: "100.101.102.104",
    network,
    cleanups,
  });
  a.hub.enable(window);
  const minted = a.hub.mintJoinCode({ owner: false });
  if (minted.status !== "minted") throw new Error(minted.status);
  await b.spoke.startJoin({ code: minted.code });
  const [pending] = a.administration.listPendingPairings();
  if (pending === undefined) throw new Error("No pairing to approve.");
  a.administration.approvePairing({ ticketId: pending.ticketId });
  const joined = await b.spoke.finishJoin(window);
  if (joined.status !== "joined") throw new Error(JSON.stringify(joined));
  return { network, a, b };
}

/** A request to B's route handler, signed with `signer`'s identity key as `senderId`. */
function signedRequest(input: {
  readonly signer: HubTestHost;
  readonly senderId?: string;
  readonly recipient: HubTestHost;
  readonly method: "GET" | "PUT" | "POST";
  readonly path: string;
  readonly body?: string;
  readonly signedBody?: string;
  readonly now?: number;
}): Request {
  const body = input.body ?? "";
  const header = signHubLinkRequest({
    signHostPayload: input.signer.signHostPayload,
    senderMemberId: input.senderId ?? input.signer.hostId,
    recipientMemberId: input.recipient.hostId,
    method: input.method,
    path: input.path,
    body: input.signedBody ?? body,
    now: input.now ?? Date.now(),
  });
  return new Request(`${input.recipient.origin}${input.path}`, {
    method: input.method,
    headers: { [HUB_LINK_HEADER]: header, "content-type": "application/json" },
    ...(input.method === "GET" ? {} : { body }),
  });
}

/** A roster signed by the hub's own roster key, one sequence further on. */
function nextRoster(
  hub: HubTestHost,
  change: (roster: SignedHubRoster["roster"]) => SignedHubRoster["roster"],
) {
  const current = hub.hub.status().roster;
  if (current === undefined) throw new Error("The hub holds no roster.");
  return change({ ...current.roster, sequence: current.roster.sequence + 1 });
}

describe("the hub principal on a spoke", () => {
  it("resolves a request signed with the hub's key to the hub and nothing wider", async () => {
    const { a, b } = await joinedPair();

    const outcome = b.spoke.authenticateHub({
      header: signHubLinkRequest({
        signHostPayload: a.signHostPayload,
        senderMemberId: a.hostId,
        recipientMemberId: b.hostId,
        method: "GET",
        path: "/api/hub/status",
        body: "",
        now: Date.now(),
      }),
      method: "GET",
      path: "/api/hub/status",
      body: "",
    });

    expect(outcome).toEqual({ status: "hub", principal: { kind: "hub", memberId: a.hostId } });
  });

  it("accepts a newer roster only while the hub's Roster item is ticked", async () => {
    const { a, b } = await joinedPair();
    const roster = a.hub.status().roster;
    if (roster === undefined) throw new Error("No roster.");
    const body = JSON.stringify(encodeSignedHubRoster(roster));
    // The same roster the spoke already holds is not newer.
    const stale = await b.hubLink(
      signedRequest({ signer: a, recipient: b, method: "PUT", path: "/api/hub/roster", body }),
    );
    expect(stale?.status).toBe(409);
    expect(await stale?.json()).toEqual({ status: "refused", kind: "stale-sequence" });

    b.spoke.setGrant({ items: ["introduce", "owners"], actProjects: [] }, window);
    const refused = await b.hubLink(
      signedRequest({ signer: a, recipient: b, method: "PUT", path: "/api/hub/roster", body }),
    );
    expect(refused?.status).toBe(403);
    expect(await refused?.json()).toEqual({ status: "refused", kind: "item-not-granted" });

    b.spoke.setGrant({ items: ["roster"], actProjects: [] }, window);
    const removed = await a.hub.removeMember({ memberId: b.hostId }, window);
    expect(removed.status).toBe("removed");
    expect(b.spoke.status().membership).toBe("removed");
  });

  it("reads status only while the hub's Status item is ticked", async () => {
    const { a, b } = await joinedPair();
    const read = () =>
      b.hubLink(signedRequest({ signer: a, recipient: b, method: "GET", path: "/api/hub/status" }));

    const unticked = await read();
    expect(unticked?.status).toBe(403);
    expect(await unticked?.json()).toEqual({ status: "refused", kind: "item-not-granted" });

    b.spoke.setGrant({ items: ["roster", "status"], actProjects: [] }, window);
    const ticked = await read();
    expect(ticked?.status).toBe(200);
    expect(await ticked?.json()).toEqual({
      status: {
        memberId: b.hostId,
        name: "Laptop",
        serverBuildVersion: "0.1.0",
        rosterSequence: 2,
      },
    });
  });

  it("is refused a spoke's own administration and every product route over the listener", async () => {
    const { network, a, b } = await joinedPair();
    b.spoke.setGrant({ items: ["roster", "status", "act", "provision"], actProjects: [] }, window);
    const fetch = createPinnedHubTransport(network.network)({
      origin: b.origin,
      pin: b.listener.tlsPin ?? "",
    });
    const signed = (method: "GET" | "POST", path: string, body: string) => ({
      method,
      headers: {
        [HUB_LINK_HEADER]: signHubLinkRequest({
          signHostPayload: a.signHostPayload,
          senderMemberId: a.hostId,
          recipientMemberId: b.hostId,
          method,
          path,
          body,
          now: Date.now(),
        }),
        "content-type": "application/json",
      },
      ...(method === "GET" ? {} : { body }),
    });

    for (const [method, path] of [
      ["POST", "/api/desktop/hub/grant"],
      ["POST", "/api/desktop/hub/leave"],
      ["POST", "/api/desktop/hub/members/remove"],
      ["POST", "/api/desktop/hub/enable"],
      ["POST", "/api/code/board"],
      ["GET", "/api/host/resources"],
      ["POST", "/api/work/board"],
    ] as const) {
      const response = await fetch(`${b.origin}${path}`, signed(method, path, "{}"));
      expect(response.status, `${method} ${path}`).toBeGreaterThanOrEqual(400);
    }
    // None of it changed what the hub may do or whether it is still a member.
    expect(b.spoke.status().membership).toBe("member");
  });

  it("is refused once the spoke leaves, because it no longer holds the hub's key", async () => {
    const { a, b } = await joinedPair();
    await b.spoke.leave(window);

    const response = await b.hubLink(
      signedRequest({ signer: a, recipient: b, method: "GET", path: "/api/hub/status" }),
    );

    expect(response?.status).toBe(401);
    expect(await response?.json()).toEqual({ status: "refused", kind: "not-a-spoke" });
  });

  it("is not the hub when signed by another key, replayed, stale, or changed in flight", async () => {
    const { a, b } = await joinedPair();
    b.spoke.setGrant({ items: ["roster", "status"], actProjects: [] }, window);
    const stranger = await startHubTestHost({
      name: "Stranger",
      address: "100.101.102.105",
      network: new HubTestNetwork(),
      cleanups,
    });

    const forged = await b.hubLink(
      signedRequest({
        signer: stranger,
        senderId: a.hostId,
        recipient: b,
        method: "GET",
        path: "/api/hub/status",
      }),
    );
    expect(await forged?.json()).toEqual({ status: "refused", kind: "signature-invalid" });

    const unknown = await b.hubLink(
      signedRequest({ signer: stranger, recipient: b, method: "GET", path: "/api/hub/status" }),
    );
    expect(await unknown?.json()).toEqual({ status: "refused", kind: "unknown-sender" });

    const genuine = signedRequest({
      signer: a,
      recipient: b,
      method: "GET",
      path: "/api/hub/status",
    });
    expect((await b.hubLink(genuine.clone()))?.status).toBe(200);
    const replayed = await b.hubLink(genuine);
    expect(await replayed?.json()).toEqual({ status: "refused", kind: "replayed" });

    const stale = await b.hubLink(
      signedRequest({
        signer: a,
        recipient: b,
        method: "GET",
        path: "/api/hub/status",
        now: Date.now() - 10 * 60_000,
      }),
    );
    expect(await stale?.json()).toEqual({ status: "refused", kind: "stale" });

    const roster = a.hub.status().roster;
    if (roster === undefined) throw new Error("No roster.");
    const changed = await b.hubLink(
      signedRequest({
        signer: a,
        recipient: b,
        method: "PUT",
        path: "/api/hub/roster",
        body: JSON.stringify(encodeSignedHubRoster(roster)),
        signedBody: "{}",
      }),
    );
    expect(await changed?.json()).toEqual({ status: "refused", kind: "signature-invalid" });

    const unsigned = await b.hubLink(new Request(`${b.origin}/api/hub/status`, { method: "GET" }));
    expect(await unsigned?.json()).toEqual({ status: "refused", kind: "missing" });
  });

  it("never lets an older or equal roster replace a newer one", async () => {
    const { a, b } = await joinedPair();
    const base = a.hub.status().roster;
    if (base === undefined) throw new Error("No roster.");
    expect(b.spoke.receiveRoster(base)).toEqual({ status: "refused", kind: "stale-sequence" });

    // A newer roster signed with some other key is not the hub's.
    const newer = nextRoster(a, (roster) => roster);
    const forged = {
      roster: newer,
      signedBy: base.signedBy,
      signature: a.signHostPayload(hubRosterSigningPayload(newer)),
    };
    expect(b.spoke.receiveRoster(forged)).toEqual({ status: "refused", kind: "signature-invalid" });
    const held = b.spoke.status();
    if (held.membership !== "member") throw new Error("B left.");
    expect(held.roster.roster.sequence).toBe(base.roster.sequence);
  });

  it("drops the grants a spoke gave to a member a newer roster no longer lists", async () => {
    const { network, a, b } = await joinedPair();
    const c = await startHubTestHost({
      name: "Desktop",
      address: "100.101.102.106",
      network,
      cleanups,
    });
    const minted = a.hub.mintJoinCode({ owner: false });
    if (minted.status !== "minted") throw new Error(minted.status);
    await c.spoke.startJoin({ code: minted.code });
    const [pending] = a.administration.listPendingPairings();
    if (pending === undefined) throw new Error("No pairing to approve.");
    a.administration.approvePairing({ ticketId: pending.ticketId });
    expect((await c.spoke.finishJoin(window)).status).toBe("joined");
    // The hub sent B the roster that lists C, and B gave C a peer grant.
    await vi.waitFor(() => {
      const held = b.spoke.status();
      expect(held.membership === "member" && held.roster.roster.members.length).toBe(3);
    });
    const link = b.state.load().link;
    if (link === undefined) throw new Error("B holds no link.");
    b.state.save({
      link: { ...link, peerGrants: [{ memberId: decodeHubMemberId(c.hostId), readStatus: true }] },
    });
    expect(b.spoke.peerGrantCount()).toBe(1);

    await a.hub.removeMember({ memberId: c.hostId }, window);

    expect(b.spoke.peerGrantCount()).toBe(0);
    expect(b.spoke.status().membership).toBe("member");
  });
});

describe("the hub-link routes the private listener serves", () => {
  it("registers every route on the pre-auth surface with its own method and no query", () => {
    const policy = createRemoteRoutePolicy({ origin: "https://100.101.102.103:8443" });

    for (const [id, method, path] of [
      [REMOTE_HUB_LINK_ROUTE_IDS.join, "POST", HUB_LINK_ROUTES.join],
      [REMOTE_HUB_LINK_ROUTE_IDS.leave, "POST", HUB_LINK_ROUTES.leave],
      [REMOTE_HUB_LINK_ROUTE_IDS.roster, "PUT", HUB_LINK_ROUTES.roster],
      [REMOTE_HUB_LINK_ROUTE_IDS.status, "GET", HUB_LINK_ROUTES.status],
      [REMOTE_HUB_LINK_ROUTE_IDS.guestRoster, "GET", HUB_LINK_ROUTES.guestRoster],
      [REMOTE_HUB_LINK_ROUTE_IDS.guest, "POST", HUB_LINK_ROUTES.guest],
      [REMOTE_HUB_LINK_ROUTE_IDS.standby, "PUT", HUB_LINK_ROUTES.standby],
      [REMOTE_HUB_LINK_ROUTE_IDS.heartbeat, "GET", HUB_LINK_ROUTES.heartbeat],
      [REMOTE_HUB_LINK_ROUTE_IDS.handback, "POST", HUB_LINK_ROUTES.handback],
      [REMOTE_HUB_LINK_ROUTE_IDS.delegate, "POST", PEER_DELEGATION_ROUTES.create],
      [REMOTE_HUB_LINK_ROUTE_IDS.delegationStatus, "POST", PEER_DELEGATION_ROUTES.status],
      [REMOTE_HUB_LINK_ROUTE_IDS.delegationCancel, "POST", PEER_DELEGATION_ROUTES.cancel],
    ] as const) {
      const decision = policy.inspect(
        new Request(`https://100.101.102.103:8443${path}`, {
          method,
          headers: {
            host: LISTENER_HOST,
            [HUB_LINK_HEADER]: "v1.x",
            "content-type": "application/json",
          },
          ...(method === "GET" ? {} : { body: "{}" }),
        }),
      );
      expect(decision, `${method} ${path}`).toMatchObject({
        kind: "allow",
        surface: "pre-auth",
        route: { id },
      });
    }
    const wrongMethod = policy.inspect(
      new Request(`https://100.101.102.103:8443${HUB_LINK_ROUTES.roster}`, {
        method: "POST",
        headers: { host: LISTENER_HOST },
      }),
    );
    expect(wrongMethod.kind).toBe("reject");
    const delegationWithQuery = policy.inspect(
      new Request(`https://100.101.102.103:8443${PEER_DELEGATION_ROUTES.create}?x=1`, {
        method: "POST",
        headers: { host: LISTENER_HOST, "content-type": "application/json" },
        body: "{}",
      }),
    );
    expect(delegationWithQuery.kind).toBe("reject");
  });

  it("refuses the whole administration prefix to anything that arrives over the listener", () => {
    const policy = createRemoteRoutePolicy({ origin: "https://100.101.102.103:8443" });

    for (const path of [
      "/api/desktop/hub/enable",
      "/api/desktop/hub/disable",
      "/api/desktop/hub/join-codes",
      "/api/desktop/hub/members/remove",
      "/api/desktop/hub/join",
      "/api/desktop/hub/join/finish",
      "/api/desktop/hub/grant",
      "/api/desktop/hub/leave",
      "/api/desktop/hub/status",
      "/api/desktop/hub/standby-order",
      "/api/desktop/hub/promote",
      "/api/desktop/hub/accept-new-hub",
      "/api/desktop/hub/stand-in/join-codes",
      "/api/desktop/hub/stand-in/members/remove",
    ]) {
      const decision = policy.inspect(
        new Request(`https://100.101.102.103:8443${path}`, {
          method: "POST",
          headers: { host: LISTENER_HOST, "content-type": "application/json" },
          body: "{}",
        }),
      );
      expect(decision.kind, path).toBe("reject");
    }
  });
});
