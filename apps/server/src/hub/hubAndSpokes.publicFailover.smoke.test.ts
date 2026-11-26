// A hub, a standby and a spoke in one process, each the real remote gateway
// behind a real TLS listener. The spoke's person ticks Public and Standby, so
// the spoke hands its webhook endpoint (the secret sealed to each recipient)
// and its visitor-link grants to the hub and to the standby. The standby's own
// person chose to serve the public entrance while it stands in. The test stops
// the hub; the standby stands in and serves both features; the hub returns and
// the standby hands back what it still queues. Every delivery runs once.

import { createHmac, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { HubMemberId, type HubGrant } from "@octant/contracts";
import { visitorProofPayload } from "@octant/domain";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubTestNetwork, startHubTestHost, type HubTestHost } from "./hubHost.test-support";
import type { PublicAnswer, PublicRequest, PublicRouteName } from "./publicEntrance";
import { setServeWhileStandingIn } from "./publicStandIn";

const cleanups: Array<() => Promise<void> | void> = [];
const closers: Array<() => void> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) close();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const window = { kind: "local-window" } as const;
const decodeMemberId = Schema.decodeUnknownSync(HubMemberId);
const FAILOVER_AFTER_MS = 60;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const standbyGrant: HubGrant = {
  items: ["roster", "introduce", "owners", "standby"],
  actProjects: [],
};
const spokeGrant: HubGrant = {
  items: ["roster", "introduce", "owners", "standby", "public"],
  actProjects: [],
};

function start(network: HubTestNetwork, name: string, last: number) {
  return startHubTestHost({
    name,
    address: `100.101.103.${last}`,
    network,
    cleanups,
    failoverAfterMs: FAILOVER_AFTER_MS,
  });
}

async function join(hub: HubTestHost, member: HubTestHost) {
  const minted = hub.hub.mintJoinCode({ owner: false });
  if (minted.status !== "minted") throw new Error(minted.status);
  const started = await member.spoke.startJoin({ code: minted.code });
  if (started.status !== "awaiting-approval") throw new Error(JSON.stringify(started));
  const pending = hub.administration.listPendingPairings().at(-1);
  if (pending === undefined) throw new Error("The hub shows no pairing to approve.");
  hub.administration.approvePairing({ ticketId: pending.ticketId });
  const finished = await member.spoke.finishJoin(window);
  if (finished.status !== "joined") throw new Error(JSON.stringify(finished));
}

function delivery(endpointId: string, secret: string, id: string): PublicRequest {
  const body = Buffer.from(`{"workflow":"nightly","run":"${id}"}`);
  const seconds = Math.floor(Date.now() / 1000);
  const signature = createHmac("sha256", Buffer.from(secret.slice("whsec_".length), "base64"))
    .update(`${id}.${seconds}.`)
    .update(body)
    .digest("base64");
  return {
    route: "webhook",
    params: { id: endpointId },
    method: "POST",
    path: `/hooks/${endpointId}`,
    headers: new Map([
      ["webhook-id", id],
      ["webhook-timestamp", String(seconds)],
      ["webhook-signature", `v1,${signature}`],
    ]),
    principal: { kind: "webhook", endpointId },
    readBody: async () => ({ status: "read", bytes: body }),
    signal: new AbortController().signal,
  };
}

/** One browser: its own P-256 key, which signs every request it makes. */
function browser() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  return (method: string, path: string): Map<string, string> => {
    const timestamp = String(Date.now());
    const nonce = randomBytes(12).toString("base64url");
    const signature = sign(
      "sha256",
      Buffer.from(visitorProofPayload({ method, path, timestamp, nonce })),
      { key: privateKey, dsaEncoding: "ieee-p1363" },
    ).toString("base64url");
    return new Map([
      ["octant-visitor-key", spki],
      ["octant-visitor-proof", `${timestamp}.${nonce}.${signature}`],
    ]);
  };
}

async function openLink(
  host: HubTestHost,
  linkId: string,
  secret: string,
  visitor: ReturnType<typeof browser>,
): Promise<PublicAnswer> {
  const handler = host.visitors.handlers().visitorOpen;
  if (handler === undefined) return { status: 404, headers: {} };
  const route: PublicRouteName = "visitor-open";
  const path = `/v/${linkId}/open`;
  const controller = new AbortController();
  closers.push(() => controller.abort());
  return handler({
    route,
    params: { id: linkId },
    method: "POST",
    path,
    headers: visitor("POST", path),
    principal: { kind: "visitor", linkId },
    readBody: async () => ({ status: "read", bytes: Buffer.from(JSON.stringify({ secret })) }),
    signal: controller.signal,
  });
}

async function share(spoke: HubTestHost) {
  const link = await spoke.spokeVisitors.share({ mode: "code", threadId: "t-1", scope: "read" });
  if (link.status !== "shared") throw new Error(link.kind);
  return { linkId: link.linkId, secret: link.url.split("#k=")[1] ?? "" };
}

describe("the public entrance during failover", () => {
  it("a standing-in standby serves webhooks and visitor links, and hand-back loses and repeats no delivery", async () => {
    const network = new HubTestNetwork();
    const hub = await start(network, "Mac mini", 10);
    const standby = await start(network, "Standby", 11);
    const spoke = await start(network, "Laptop", 12);
    expect(hub.hub.enable(window).status).toBe("enabled");
    await join(hub, standby);
    await join(hub, spoke);
    standby.spoke.setGrant(standbyGrant, window);
    spoke.spoke.setGrant(spokeGrant, window);
    const ordered = await hub.hub.setStandbyOrder([decodeMemberId(standby.hostId)], window);
    if (ordered.status !== "ordered") throw new Error(JSON.stringify(ordered));
    await vi.waitFor(() =>
      expect(spoke.state.load().link?.roster.roster.standbyOrder ?? []).toHaveLength(1),
    );
    await hub.visitors.setEnabled(true, window);
    expect(
      setServeWhileStandingIn({
        state: standby.state,
        enabled: true,
        principal: window,
        record: (change) => standby.records.push(change),
      }),
    ).toEqual({ status: "changed", enabled: true });
    await standby.failover.tick();
    await spoke.failover.tick();

    // The spoke hands both the hub and the standby a copy, each sealed to its own key.
    const created = await spoke.spokeWebhooks.create({ scheme: "standard-webhooks", label: "CI" });
    if (created.status !== "created") throw new Error(created.status);
    expect(created.published).toBe(true);
    expect(hub.webhooks.status().endpoints).toBe(1);
    expect(standby.webhooks.status().endpoints).toBe(1);
    const kept = await share(spoke);
    const revoked = await share(spoke);
    expect(standby.visitors.heldGrants()).toHaveLength(2);

    // Through the hub, as on any day. The standby holds copies but serves nothing.
    expect(
      (await hub.webhooks.handle(delivery(created.endpointId, created.secret, "m1"))).status,
    ).toBe(202);
    await hub.webhooks.tick();
    const visitor = browser();
    expect((await openLink(hub, kept.linkId, kept.secret, visitor)).status).toBe(200);
    expect(
      (await standby.webhooks.handle(delivery(created.endpointId, created.secret, "m2"))).status,
    ).toBe(404);
    expect((await openLink(standby, kept.linkId, kept.secret, visitor)).status).toBe(404);

    // The hub stops; after the failover time the standby stands in and serves both.
    network.stop(hub.address);
    await pause(FAILOVER_AFTER_MS + 40);
    await standby.failover.tick();
    expect(standby.failover.standingIn()).toBe(true);

    expect(
      (await standby.webhooks.handle(delivery(created.endpointId, created.secret, "m2"))).status,
    ).toBe(202);
    await standby.webhooks.tick();
    expect(standby.webhooks.status()).toMatchObject({ queued: 0, forwarded: 1 });
    expect((await openLink(standby, kept.linkId, kept.secret, visitor)).status).toBe(200);
    // A second browser is still refused: the binding is the spoke's, not the hub's.
    expect((await openLink(standby, kept.linkId, kept.secret, browser())).status).toBe(403);
    // Stopped on the spoke while the hub is down: the standby drops the grant at
    // once, and would the withdrawal be lost, the spoke still refuses the link.
    await spoke.spokeVisitors.stop(revoked.linkId);
    expect(standby.visitors.heldGrants()).toHaveLength(1);
    expect((await openLink(standby, revoked.linkId, revoked.secret, browser())).status).toBe(404);

    // The spoke goes to sleep; deliveries wait on the standby.
    network.stop(spoke.address);
    expect(
      (await standby.webhooks.handle(delivery(created.endpointId, created.secret, "m3"))).status,
    ).toBe(202);
    expect(
      (await standby.webhooks.handle(delivery(created.endpointId, created.secret, "m4"))).status,
    ).toBe(202);
    await standby.webhooks.tick();
    expect(standby.webhooks.status().queued).toBe(2);

    // The hub returns while the spoke still sleeps. In the split, the sender also
    // reached the hub with m3, and redelivered m2, which the standby already handed on.
    network.start(hub.address);
    expect(
      (await hub.webhooks.handle(delivery(created.endpointId, created.secret, "m3"))).status,
    ).toBe(202);
    expect(
      (await hub.webhooks.handle(delivery(created.endpointId, created.secret, "m2"))).status,
    ).toBe(202);
    await standby.failover.tick();
    expect(standby.failover.standingIn()).toBe(false);
    expect(standby.webhooks.status().queued).toBe(0);
    // m3 was already queued on the hub, so only m4 is added: three wait, each once.
    expect(hub.webhooks.status().queued).toBe(3);
    expect(hub.records.map((record) => record.change)).toContain("webhook-deliveries-handed-back");
    // Back to forwarding only: the standby's entrance serves nothing once it steps down.
    expect(
      (await standby.webhooks.handle(delivery(created.endpointId, created.secret, "m5"))).status,
    ).toBe(404);

    network.start(spoke.address);
    await hub.webhooks.tick();
    expect(hub.webhooks.status()).toMatchObject({ queued: 0 });
    const view = spoke.spokeWebhooks.view();
    // m1 to m4 each ran once; m2's second arrival is a duplicate the spoke's own claim stopped.
    expect(view.endpoints[0]?.deliveries).toBe(4);
    expect(view.log.filter((entry) => entry.outcome === "accepted")).toHaveLength(4);
    expect(view.log.filter((entry) => entry.outcome === "duplicate")).toHaveLength(1);
  });

  it("refuses copies on a standby for a spoke whose person did not tick Standby, and a standby without its own choice serves nothing", async () => {
    const network = new HubTestNetwork();
    const hub = await start(network, "Mac mini", 20);
    const standby = await start(network, "Standby", 21);
    const spoke = await start(network, "Laptop", 22);
    expect(hub.hub.enable(window).status).toBe("enabled");
    await join(hub, standby);
    await join(hub, spoke);
    standby.spoke.setGrant(standbyGrant, window);
    spoke.spoke.setGrant(
      { items: ["roster", "introduce", "owners", "public"], actProjects: [] },
      window,
    );
    const ordered = await hub.hub.setStandbyOrder([decodeMemberId(standby.hostId)], window);
    if (ordered.status !== "ordered") throw new Error(JSON.stringify(ordered));
    await standby.failover.tick();

    const created = await spoke.spokeWebhooks.create({ scheme: "github", label: "Pushes" });
    if (created.status !== "created") throw new Error(created.status);
    expect(hub.webhooks.status().endpoints).toBe(1);
    expect(standby.webhooks.status().endpoints).toBe(0);

    network.stop(hub.address);
    await pause(FAILOVER_AFTER_MS + 40);
    await standby.failover.tick();
    expect(standby.failover.standingIn()).toBe(true);
    expect(standby.visitors.handlers()).toEqual({});
    expect(
      (await standby.webhooks.handle(delivery(created.endpointId, created.secret, "x"))).status,
    ).toBe(404);
  });

  it("a standby serves its own webhook endpoint and visitor link while it stands in", async () => {
    const network = new HubTestNetwork();
    const hub = await start(network, "Mac mini", 30);
    const standby = await start(network, "Standby", 31);
    expect(hub.hub.enable(window).status).toBe("enabled");
    await join(hub, standby);
    standby.spoke.setGrant(spokeGrant, window);
    const ordered = await hub.hub.setStandbyOrder([decodeMemberId(standby.hostId)], window);
    if (ordered.status !== "ordered") throw new Error(JSON.stringify(ordered));
    await vi.waitFor(() =>
      expect(standby.state.load().link?.roster.roster.standbyOrder ?? []).toHaveLength(1),
    );
    await hub.visitors.setEnabled(true, window);
    setServeWhileStandingIn({
      state: standby.state,
      enabled: true,
      principal: window,
      record: (change) => standby.records.push(change),
    });
    await standby.failover.tick();

    // The standby is a spoke too: its own copies stay on it, beside the hub's.
    const created = await standby.spokeWebhooks.create({
      scheme: "standard-webhooks",
      label: "CI",
    });
    if (created.status !== "created") throw new Error(created.status);
    expect(created.published).toBe(true);
    expect(hub.webhooks.status().endpoints).toBe(1);
    expect(standby.webhooks.status().endpoints).toBe(1);
    const own = await share(standby);
    expect(standby.visitors.heldGrants()).toHaveLength(1);

    network.stop(hub.address);
    await pause(FAILOVER_AFTER_MS + 40);
    await standby.failover.tick();
    expect(standby.failover.standingIn()).toBe(true);
    expect(
      (await standby.webhooks.handle(delivery(created.endpointId, created.secret, "own-1"))).status,
    ).toBe(202);
    await standby.webhooks.tick();
    expect(standby.webhooks.status()).toMatchObject({ queued: 0, forwarded: 1 });
    expect((await openLink(standby, own.linkId, own.secret, browser())).status).toBe(200);
  });
});
