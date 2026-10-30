// Hosts in one process, each the real remote gateway behind a real TLS listener
// serving a certificate it made itself. A spoke whose person ticked Push hands
// its sealed notifications to the hub, which forwards them to a local stand-in
// for the push gateway. The stand-in checks a delivery the way the real gateway
// does: the signature must verify against the host key the capability was
// issued for, so a forward the hub had re-signed would fail it. Everything else
// is the real path.

import { createHash, createPublicKey, randomBytes, verify } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join as joinPath } from "node:path";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REMOTE_PUSH_DELIVERY_HEADERS,
  REMOTE_PUSH_DELIVERY_SKEW_MS,
  decodeRemotePushDeliveryRequestV1,
  decodeRemotePushEnvelopeV1,
  type RemotePushEnvelopeV1,
  type RemotePushGatewayRefusalCode,
} from "@octant/contracts/remote-push-notifications";
import { HubMemberId, type HubGrant } from "@octant/contracts";
import { remotePushDeliverySigningText } from "@octant/domain/push-notification-policy";
import { signGatewayDelivery } from "../remote/gatewayPushDeliveryTransport";
import { HubTestNetwork, startHubTestHost, type HubTestHost } from "./hubHost.test-support";
import { HUB_LINK_HEADER, HUB_PEER_KEY_HEADER, signHubLinkRequest } from "./hubLink";
import { HUB_LINK_ROUTES } from "./hubLinkRoutes";
import type { HubTransport } from "./pinnedHubTransport";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const window = { kind: "local-window" } as const;
const decodeMemberId = Schema.decodeUnknownSync(HubMemberId);
const FAILOVER_AFTER_MS = 60;
const pushGrant: HubGrant = { items: ["roster", "introduce", "owners", "push"], actProjects: [] };
const pushAndStandbyGrant: HubGrant = {
  items: ["roster", "introduce", "owners", "push", "standby"],
  actProjects: [],
};
const standbyGrant: HubGrant = {
  items: ["roster", "introduce", "owners", "standby"],
  actProjects: [],
};
const noPushGrant: HubGrant = { items: ["roster", "introduce", "owners"], actProjects: [] };

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** One clock for every host in a test, so the signatures on a link request agree with the checks. */
function makeClock() {
  const state = { offset: 0 };
  return { state, now: () => Date.now() + state.offset };
}
type Clock = ReturnType<typeof makeClock>;

function start(
  network: HubTestNetwork,
  clock: Clock,
  name: string,
  last: number,
  extra: Partial<Parameters<typeof startHubTestHost>[0]> = {},
) {
  return startHubTestHost({
    name,
    address: `100.101.102.${last}`,
    network,
    cleanups,
    wakeClock: clock.now,
    failoverAfterMs: FAILOVER_AFTER_MS,
    ...extra,
  });
}

/** The way a person joins: a code from the hub, a comparison on both screens, approval on the hub. */
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

// --- a local push gateway that checks a delivery as the real one does ---

interface Received {
  readonly path: string | undefined;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

interface FakeGateway {
  readonly url: string;
  readonly received: Received[];
  /** Capabilities the gateway issued, each bound to the host key fingerprint it was issued for. */
  readonly issue: (hostKeyFingerprint: string) => string;
  /** Deliveries the gateway accepted: signature valid for the key the capability is bound to. */
  readonly accepted: string[];
  answer: { status: number; code?: RemotePushGatewayRefusalCode } | undefined;
}

async function startGateway(): Promise<FakeGateway> {
  const bound = new Map<string, string>();
  const received: Received[] = [];
  const accepted: string[] = [];
  const gateway: FakeGateway = {
    url: "",
    received,
    accepted,
    answer: undefined,
    issue: (fingerprint) => {
      const capability = `v1.k1.${randomBytes(36).toString("base64url")}`;
      bound.set(capability, fingerprint);
      return capability;
    },
  };
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      received.push({ path: request.url, headers: request.headers, body });
      const code = gatewayCheck(request.headers, body, bound);
      const answered =
        gateway.answer ?? (code === undefined ? { status: 202 } : { status: 403, code });
      if (answered.status === 202 && code === undefined) accepted.push(body);
      response.writeHead(answered.status, { "content-type": "application/json" });
      response.end(JSON.stringify(answered.code === undefined ? {} : { code: answered.code }));
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
  const { port } = server.address() as AddressInfo;
  return Object.assign(gateway, { url: `http://127.0.0.1:${port}` });
}

/** What the real gateway checks: the request's shape, its time, the key against the capability, and the signature. */
function gatewayCheck(
  headers: IncomingMessage["headers"],
  body: string,
  bound: ReadonlyMap<string, string>,
): RemotePushGatewayRefusalCode | undefined {
  let capability: string;
  try {
    capability = decodeRemotePushDeliveryRequestV1(JSON.parse(body)).capability;
  } catch {
    return "malformed";
  }
  const fingerprint = bound.get(capability);
  if (fingerprint === undefined) return "capability-not-issued-here";
  const hostKey = String(headers[REMOTE_PUSH_DELIVERY_HEADERS.hostKey]);
  const timestamp = String(headers[REMOTE_PUSH_DELIVERY_HEADERS.timestamp]);
  const signature = String(headers[REMOTE_PUSH_DELIVERY_HEADERS.signature]);
  if (Math.abs(Date.now() - Date.parse(timestamp)) > REMOTE_PUSH_DELIVERY_SKEW_MS) {
    return "signature-invalid";
  }
  const der = Buffer.from(hostKey, "base64url");
  if (createHash("sha256").update(der).digest("hex") !== fingerprint) return "host-key-mismatch";
  const valid = verify(
    "sha256",
    Buffer.from(
      remotePushDeliverySigningText({
        timestamp,
        bodySha256: createHash("sha256").update(body).digest("base64url"),
      }),
    ),
    { key: createPublicKey({ key: der, format: "der", type: "spki" }), dsaEncoding: "ieee-p1363" },
    Buffer.from(signature, "base64url"),
  );
  return valid ? undefined : "signature-invalid";
}

const envelope: RemotePushEnvelopeV1 = decodeRemotePushEnvelopeV1({
  alert: { title: "Octant", body: "A paired computer has an update" },
  collapseId: "B".repeat(22),
  urgency: "high",
  sealed: { encapsulatedKey: "C".repeat(43), ciphertext: "D".repeat(64) },
});

const fingerprintOf = (host: HubTestHost) =>
  createHash("sha256").update(Buffer.from(host.hostPublicKey, "base64url")).digest("hex");

/** One notification for a phone paired with `host`, as the host's own delivery transport is handed it. */
function notificationFor(host: HubTestHost, gateway: FakeGateway) {
  const token = gateway.issue(fingerprintOf(host));
  return {
    token,
    input: { destination: { deviceId: "device-1", platform: "ios" as const, token }, envelope },
  };
}

/** The request `host` would hand the hub: a delivery signed with its own key, exactly as the gateway requires. */
function handoffFrom(host: HubTestHost, gateway: FakeGateway, clock: Clock) {
  const { input } = notificationFor(host, gateway);
  const delivery = signGatewayDelivery({
    signing: {
      hostKeyFingerprint: fingerprintOf(host),
      hostPublicKey: host.hostPublicKey,
      signHostPayload: host.signHostPayload,
    },
    destination: input.destination,
    envelope,
    clock: () => new Date(clock.now()),
  });
  if (delivery === undefined) throw new Error("The host could not sign.");
  return delivery;
}

/** A request to `recipient`'s listener signed with `signer`'s identity key, as the signer's own server would. */
function signedRequest(input: {
  readonly signer: HubTestHost;
  readonly recipient: HubTestHost;
  readonly clock: Clock;
  readonly method: "POST" | "PUT";
  readonly path: string;
  readonly body: unknown;
  readonly senderId?: string;
}) {
  const body = JSON.stringify(input.body);
  return input.recipient.hubLink(
    new Request(`${input.recipient.origin}${input.path}`, {
      method: input.method,
      headers: {
        host: `${input.recipient.address}:8443`,
        "content-type": "application/json",
        [HUB_PEER_KEY_HEADER]: input.signer.hostPublicKey,
        [HUB_LINK_HEADER]: signHubLinkRequest({
          signHostPayload: input.signer.signHostPayload,
          senderMemberId: input.senderId ?? input.signer.hostId,
          recipientMemberId: input.recipient.hostId,
          method: input.method,
          path: input.path,
          body,
          now: input.clock.now(),
        }),
      },
      body,
    }),
  );
}

/** Every file under a host's data folder that holds `needle`, so a test can look for what a host kept. */
function filesHolding(directory: string, needle: string): string[] {
  const found: string[] = [];
  const visit = (path: string) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = joinPath(path, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (readFileSync(full).includes(needle)) found.push(full);
    }
  };
  visit(directory);
  return found;
}

async function startPair(
  gateway: FakeGateway,
  hubExtra: Partial<Parameters<typeof startHubTestHost>[0]> = {},
  laptopExtra: Partial<Parameters<typeof startHubTestHost>[0]> = {},
) {
  const network = new HubTestNetwork();
  const clock = makeClock();
  const hub = await start(network, clock, "Mac mini", 103, hubExtra);
  const laptop = await start(network, clock, "Laptop", 104, laptopExtra);
  const enabled = hub.hub.enable(window);
  if (enabled.status !== "enabled") throw new Error(enabled.status);
  await join(hub, laptop);
  // The hub's own Notifications setting names the gateway it may forward to.
  hub.pushSetting.enabled = true;
  hub.pushSetting.gatewayUrl = gateway.url;
  expect(await hub.push.setEnabled(true, window)).toEqual({ status: "changed", enabled: true });
  laptop.spoke.setGrant(pushGrant, window);
  return { network, clock, hub, laptop };
}

const forwards = (host: HubTestHost) =>
  host.requests.filter((entry) => entry === `POST ${HUB_LINK_ROUTES.push}`).length;

describe("a spoke handing its sealed notifications to the hub", () => {
  it("forwards the exact bytes and signature the spoke made, and the gateway checks them against the spoke's key, not the hub's", async () => {
    const gateway = await startGateway();
    const { hub, laptop } = await startPair(gateway);
    const { token, input } = notificationFor(laptop, gateway);

    expect(laptop.pushDelivery.providerDelivery()).toBe("available");
    await expect(laptop.pushDelivery.send(input)).resolves.toEqual({ kind: "delivered" });

    expect(forwards(hub)).toBe(1);
    expect(gateway.received).toHaveLength(1);
    const [forwarded] = gateway.received;
    const sentByTheSpoke = JSON.stringify({ capability: token, envelope });
    expect(forwarded?.path).toBe("/v1/deliveries");
    expect(forwarded?.body).toBe(sentByTheSpoke);
    expect(forwarded?.headers[REMOTE_PUSH_DELIVERY_HEADERS.hostKey]).toBe(laptop.hostPublicKey);
    expect(forwarded?.headers[REMOTE_PUSH_DELIVERY_HEADERS.hostKey]).not.toBe(hub.hostPublicKey);
    // The gateway accepted it: the signature verified against the key the capability is bound to.
    expect(gateway.accepted).toEqual([sentByTheSpoke]);
    expect(hub.push.status().spokes).toMatchObject([
      { memberId: laptop.hostId, forwarded: 1, refused: 0, lastResult: { result: "forwarded" } },
    ]);
    expect(hub.records.at(-1)).toMatchObject({
      change: "push-forwarded",
      actingPrincipal: { kind: "peer", memberId: laptop.hostId },
      memberId: laptop.hostId,
      pushBytes: Buffer.byteLength(sentByTheSpoke),
    });
  });

  it("would refuse the same forward had the hub signed it, so the check above is not vacuous", async () => {
    const gateway = await startGateway();
    const { clock, hub, laptop } = await startPair(gateway);
    const { input } = notificationFor(laptop, gateway);
    const signedByTheHub = signGatewayDelivery({
      signing: {
        hostKeyFingerprint: fingerprintOf(hub),
        hostPublicKey: hub.hostPublicKey,
        signHostPayload: hub.signHostPayload,
      },
      destination: input.destination,
      envelope,
      clock: () => new Date(clock.now()),
    });
    if (signedByTheHub === undefined) throw new Error("The hub could not sign.");

    const answer = await fetch(`${gateway.url}/v1/deliveries`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [REMOTE_PUSH_DELIVERY_HEADERS.hostKey]: signedByTheHub.hostKey,
        [REMOTE_PUSH_DELIVERY_HEADERS.timestamp]: signedByTheHub.timestamp,
        [REMOTE_PUSH_DELIVERY_HEADERS.signature]: signedByTheHub.signature,
      },
      body: signedByTheHub.body,
    });

    expect(answer.status).toBe(403);
    expect(await answer.json()).toEqual({ code: "host-key-mismatch" });
    expect(gateway.accepted).toEqual([]);
  });

  it("keeps nothing of a notification after forwarding it, and journals only the spoke and a size", async () => {
    const gateway = await startGateway();
    const { hub, laptop } = await startPair(gateway);
    const { token, input } = notificationFor(laptop, gateway);

    await laptop.pushDelivery.send(input);

    // Neither the capability nor a byte of the sealed content is anywhere the hub keeps state.
    for (const secret of [token, envelope.sealed.ciphertext, envelope.sealed.encapsulatedKey]) {
      expect(filesHolding(hub.directory, secret)).toEqual([]);
      expect(JSON.stringify(hub.records)).not.toContain(secret);
    }
    expect(JSON.stringify(hub.state.load())).not.toContain(token);
    // The record of it is a principal, a count, and a size.
    expect(Object.keys(hub.records.at(-1) ?? {}).sort()).toEqual([
      "actingPrincipal",
      "change",
      "memberId",
      "pushBytes",
    ]);
  });

  it("relays the gateway's answer to the spoke as data, as if the spoke had sent it itself", async () => {
    const gateway = await startGateway();
    const { hub, laptop } = await startPair(gateway);
    const { input } = notificationFor(laptop, gateway);

    gateway.answer = { status: 410, code: "destination-gone" };
    await expect(laptop.pushDelivery.send(input)).resolves.toEqual({ kind: "destination-gone" });
    gateway.answer = { status: 429, code: "rate-limited" };
    await expect(laptop.pushDelivery.send(input)).resolves.toEqual({
      kind: "failed",
      retryable: true,
      category: "gateway-rate-limited",
    });
    // A gateway that answered is not a hub that failed: the spoke does not send it again itself.
    expect(gateway.received).toHaveLength(2);
    expect(hub.push.status().spokes[0]).toMatchObject({
      forwarded: 2,
      lastResult: { result: "failed" },
    });
  });

  it("sends a spoke's notification itself when it did not tick Push, and never asks the hub", async () => {
    const gateway = await startGateway();
    const { hub, laptop } = await startPair(gateway);
    laptop.spoke.setGrant(noPushGrant, window);
    laptop.pushSetting.enabled = true;
    laptop.pushSetting.gatewayUrl = gateway.url;
    const { input } = notificationFor(laptop, gateway);

    await expect(laptop.pushDelivery.send(input)).resolves.toEqual({ kind: "delivered" });

    expect(forwards(hub)).toBe(0);
    expect(gateway.received[0]?.headers[REMOTE_PUSH_DELIVERY_HEADERS.hostKey]).toBe(
      laptop.hostPublicKey,
    );
  });
});

describe("a spoke that cannot use the hub's push", () => {
  it("sends to the gateway itself when the hub is unreachable and its own setting allows it", async () => {
    const gateway = await startGateway();
    const { network, hub, laptop } = await startPair(gateway);
    laptop.pushSetting.enabled = true;
    laptop.pushSetting.gatewayUrl = gateway.url;
    const { input } = notificationFor(laptop, gateway);
    network.stop(hub.address);

    await expect(laptop.pushDelivery.send(input)).resolves.toEqual({ kind: "delivered" });

    expect(gateway.received).toHaveLength(1);
    expect(gateway.accepted).toHaveLength(1);
  });

  it("reports the notification as not sent when the hub is unreachable and its own setting is off", async () => {
    const gateway = await startGateway();
    const { network, hub, laptop } = await startPair(gateway);
    const { input } = notificationFor(laptop, gateway);
    network.stop(hub.address);

    await expect(laptop.pushDelivery.send(input)).resolves.toEqual({
      kind: "failed",
      retryable: true,
      category: "hub-unreachable",
    });
    expect(gateway.received).toHaveLength(0);
  });

  it("falls back when the hub's push switch is off, and reports not sent without a setting of its own", async () => {
    const gateway = await startGateway();
    const { hub, laptop } = await startPair(gateway);
    await hub.push.setEnabled(false, window);
    const { input } = notificationFor(laptop, gateway);

    await expect(laptop.pushDelivery.send(input)).resolves.toEqual({
      kind: "failed",
      retryable: false,
      category: "hub-refused",
    });
    expect(gateway.received).toHaveLength(0);

    laptop.pushSetting.enabled = true;
    laptop.pushSetting.gatewayUrl = gateway.url;
    await expect(laptop.pushDelivery.send(input)).resolves.toEqual({ kind: "delivered" });
    expect(gateway.received).toHaveLength(1);
  });

  it("falls back rather than make the hub send a signed request to a gateway its person never chose", async () => {
    const gateway = await startGateway();
    const elsewhere = await startGateway();
    const { hub, laptop } = await startPair(gateway);
    laptop.pushSetting.enabled = true;
    laptop.pushSetting.gatewayUrl = elsewhere.url;
    const { input } = notificationFor(laptop, elsewhere);

    await expect(laptop.pushDelivery.send(input)).resolves.toEqual({ kind: "delivered" });

    // The hub was asked, refused, and journaled it; the spoke's own gateway took the notification.
    expect(forwards(hub)).toBe(1);
    expect(gateway.received).toHaveLength(0);
    expect(elsewhere.received).toHaveLength(1);
    expect(hub.records.at(-1)).toMatchObject({
      change: "push-refused",
      pushReason: "gateway-mismatch",
    });
  });
});

describe("who the hub forwards for", () => {
  it("is off until the hub's window turns it on, and refuses every request while it is off", async () => {
    const gateway = await startGateway();
    const network = new HubTestNetwork();
    const clock = makeClock();
    const hub = await start(network, clock, "Mac mini", 103);
    const laptop = await start(network, clock, "Laptop", 104);
    expect(await hub.push.setEnabled(true, window)).toEqual({
      status: "refused",
      kind: "hub-role-off",
    });
    hub.hub.enable(window);
    await join(hub, laptop);
    hub.pushSetting.enabled = true;
    hub.pushSetting.gatewayUrl = gateway.url;
    laptop.spoke.setGrant(pushGrant, window);
    expect(hub.push.status().enabled).toBe(false);

    const refused = await signedRequest({
      signer: laptop,
      recipient: hub,
      clock,
      method: "POST",
      path: HUB_LINK_ROUTES.push,
      body: handoffFrom(laptop, gateway, clock),
    });

    expect(refused?.status).toBe(403);
    expect(await refused?.json()).toEqual({ status: "refused", kind: "push-service-off" });
    expect(gateway.received).toHaveLength(0);
  });

  it("refuses a spoke whose person did not tick Push, because the hub asks the spoke and does not assume", async () => {
    const gateway = await startGateway();
    const { clock, hub, laptop } = await startPair(gateway);
    laptop.spoke.setGrant(noPushGrant, window);

    const refused = await signedRequest({
      signer: laptop,
      recipient: hub,
      clock,
      method: "POST",
      path: HUB_LINK_ROUTES.push,
      body: handoffFrom(laptop, gateway, clock),
    });

    expect(refused?.status).toBe(403);
    expect(await refused?.json()).toEqual({ status: "refused", kind: "push-not-granted" });
    expect(gateway.received).toHaveLength(0);
    expect(hub.push.status().spokes[0]).toMatchObject({ forwarded: 0, refused: 1 });
    expect(laptop.records.at(-1)).toMatchObject({
      change: "push-refused",
      pushReason: "push-not-granted",
    });
  });

  it("refuses a spoke whose grant it cannot confirm because the spoke cannot be reached", async () => {
    const gateway = await startGateway();
    const { network, clock, hub, laptop } = await startPair(gateway);
    const handoff = handoffFrom(laptop, gateway, clock);
    // The spoke's request arrives, then its listener goes away before the hub can ask it.
    network.stop(laptop.address);

    const refused = await signedRequest({
      signer: laptop,
      recipient: hub,
      clock,
      method: "POST",
      path: HUB_LINK_ROUTES.push,
      body: handoff,
    });

    expect(await refused?.json()).toEqual({ status: "refused", kind: "grant-unconfirmed" });
    expect(gateway.received).toHaveLength(0);
  });

  it("refuses a sender that is not in the roster, one the hub holds no key for, and a sender claiming to be another member", async () => {
    const gateway = await startGateway();
    const { network, clock, hub, laptop } = await startPair(gateway);
    const stranger = await start(network, clock, "Stranger", 105);
    const handoff = handoffFrom(stranger, gateway, clock);

    const unknown = await signedRequest({
      signer: stranger,
      recipient: hub,
      clock,
      method: "POST",
      path: HUB_LINK_ROUTES.push,
      body: handoff,
    });
    const claiming = await signedRequest({
      signer: stranger,
      recipient: hub,
      clock,
      method: "POST",
      path: HUB_LINK_ROUTES.push,
      body: handoff,
      senderId: laptop.hostId,
    });

    expect(unknown?.status).toBe(401);
    expect(claiming?.status).toBe(401);
    expect(gateway.received).toHaveLength(0);
  });

  it("refuses a peer spoke that asks another spoke whether its grant ticks Push, and a host that is no hub", async () => {
    const gateway = await startGateway();
    const { network, clock, hub, laptop } = await startPair(gateway);
    const other = await start(network, clock, "Desktop", 105);
    await join(hub, other);

    const askedByAPeer = await signedRequest({
      signer: other,
      recipient: laptop,
      clock,
      method: "POST",
      path: HUB_LINK_ROUTES.pushGrant,
      body: {},
    });
    const handedToASpoke = await signedRequest({
      signer: other,
      recipient: laptop,
      clock,
      method: "POST",
      path: HUB_LINK_ROUTES.push,
      body: handoffFrom(other, gateway, clock),
    });

    expect(askedByAPeer?.status).toBeGreaterThanOrEqual(401);
    expect(askedByAPeer?.status).toBeLessThanOrEqual(403);
    expect(handedToASpoke?.status).toBe(403);
    expect(await handedToASpoke?.json()).toEqual({ status: "refused", kind: "hub-role-off" });
    expect(gateway.received).toHaveLength(0);
  });
});

describe("how much one spoke may hand the hub", () => {
  it("refuses a body too large to be a sealed delivery, and one that is not a delivery request at all", async () => {
    const gateway = await startGateway();
    const { clock, hub, laptop } = await startPair(gateway);
    const handoff = handoffFrom(laptop, gateway, clock);

    const tooLarge = await signedRequest({
      signer: laptop,
      recipient: hub,
      clock,
      method: "POST",
      path: HUB_LINK_ROUTES.push,
      body: { ...handoff, body: "x".repeat(20_000) },
    });
    const malformed = await signedRequest({
      signer: laptop,
      recipient: hub,
      clock,
      method: "POST",
      path: HUB_LINK_ROUTES.push,
      body: { ...handoff, body: '{"anything":"else"}' },
    });
    const extraField = await signedRequest({
      signer: laptop,
      recipient: hub,
      clock,
      method: "POST",
      path: HUB_LINK_ROUTES.push,
      body: { ...handoff, memberId: "someone-else" },
    });

    expect(tooLarge?.status).toBe(413);
    expect(await tooLarge?.json()).toEqual({ status: "refused", kind: "too-large" });
    expect(malformed?.status).toBe(400);
    expect(await malformed?.json()).toEqual({ status: "refused", kind: "malformed" });
    expect(extraField?.status).toBe(400);
    expect(gateway.received).toHaveLength(0);
  });

  it("refuses a spoke that asks too often, journals the first refusal only, and forwards again once the minute has passed", async () => {
    const gateway = await startGateway();
    const { clock, hub, laptop } = await startPair(gateway, { pushMaxPerMinute: 3 });
    const ask = () =>
      signedRequest({
        signer: laptop,
        recipient: hub,
        clock,
        method: "POST",
        path: HUB_LINK_ROUTES.push,
        body: handoffFrom(laptop, gateway, clock),
      });

    for (let index = 0; index < 3; index += 1) expect((await ask())?.status).toBe(200);
    const refused = await ask();
    await ask();

    expect(refused?.status).toBe(429);
    expect(await refused?.json()).toEqual({ status: "refused", kind: "rate-limited" });
    expect(gateway.received).toHaveLength(3);
    expect(
      hub.records.filter(
        (record) => record.change === "push-refused" && record.pushReason === "rate-limited",
      ),
    ).toHaveLength(1);

    clock.state.offset = 61_000;
    expect((await ask())?.status).toBe(200);
    expect(gateway.received).toHaveLength(4);
  });
});

describe("push through a standby that stands in", () => {
  async function startFamily(
    gateway: FakeGateway,
    extra: {
      readonly standby?: Partial<Parameters<typeof startHubTestHost>[0]>;
      readonly member?: Partial<Parameters<typeof startHubTestHost>[0]>;
    } = {},
  ) {
    const network = new HubTestNetwork();
    const clock = makeClock();
    const hub = await start(network, clock, "Mac mini", 103);
    const standby = await start(network, clock, "Standby", 104, extra.standby);
    const member = await start(network, clock, "Laptop", 105, extra.member);
    hub.hub.enable(window);
    await join(hub, standby);
    await join(hub, member);
    standby.spoke.setGrant(standbyGrant, window);
    member.spoke.setGrant(pushAndStandbyGrant, window);
    hub.pushSetting.enabled = true;
    hub.pushSetting.gatewayUrl = gateway.url;
    // The standby forwards to the gateway its own person set.
    standby.pushSetting.enabled = true;
    standby.pushSetting.gatewayUrl = gateway.url;
    const ordered = await hub.hub.setStandbyOrder([decodeMemberId(standby.hostId)], window);
    if (ordered.status !== "ordered") throw new Error(JSON.stringify(ordered));
    return { network, clock, hub, standby, member };
  }

  async function standIn(family: Awaited<ReturnType<typeof startFamily>>) {
    const { network, hub, standby, member } = family;
    await standby.failover.tick();
    await member.failover.tick();
    network.stop(hub.address);
    await pause(FAILOVER_AFTER_MS + 40);
    await standby.failover.tick();
    expect(standby.failover.standingIn()).toBe(true);
    await vi.waitFor(() =>
      expect(member.spoke.status()).toMatchObject({ rosterSignedBy: "standby" }),
    );
  }

  it("forwards for a spoke that ticked Push and Standby while the hub is out of reach, and the hub forwards again when it returns", async () => {
    const gateway = await startGateway();
    const family = await startFamily(gateway);
    const { network, hub, standby, member } = family;
    await hub.push.setEnabled(true, window);
    expect(standby.state.load().link?.pushCopy).toEqual({ enabled: true });
    const { input } = notificationFor(member, gateway);

    // With the hub reachable the hub forwards, and the standby is not asked.
    await expect(member.pushDelivery.send(input)).resolves.toEqual({ kind: "delivered" });
    expect(forwards(hub)).toBe(1);
    expect(forwards(standby)).toBe(0);

    await standIn(family);
    await expect(member.pushDelivery.send(input)).resolves.toEqual({ kind: "delivered" });
    expect(forwards(standby)).toBe(1);
    expect(gateway.accepted).toHaveLength(2);
    expect(gateway.received[1]?.headers[REMOTE_PUSH_DELIVERY_HEADERS.hostKey]).toBe(
      member.hostPublicKey,
    );
    expect(standby.records.at(-1)).toMatchObject({
      change: "push-forwarded",
      actingPrincipal: { kind: "peer", memberId: member.hostId },
    });
    // A standing-in standby journals and keeps no counts.
    expect(standby.state.load().hub).toBeUndefined();

    network.start(hub.address);
    await standby.failover.tick();
    await member.failover.tick();
    await expect(member.pushDelivery.send(input)).resolves.toEqual({ kind: "delivered" });
    expect(forwards(hub)).toBe(2);
  });

  it("forwards through a standing-in standby when the hub hangs instead of refusing, though the spoke's grant answer waits on a slow probe", async () => {
    const gateway = await startGateway();
    // The hub accepts the connection and never answers, so every probe of it runs to its timeout.
    const hubHangs = { on: false };
    const hanging = (transport: HubTransport): HubTransport => {
      return (target) => {
        const reach = transport(target);
        return (url, init) =>
          hubHangs.on && target.origin.includes("100.101.102.103")
            ? new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => reject(new Error("timed out")));
              })
            : reach(url, init);
      };
    };
    const family = await startFamily(gateway, {
      standby: { hubLinkTimeoutMs: 300 },
      member: { hubLinkTimeoutMs: 300, failoverTransport: hanging },
    });
    const { hub, standby, member } = family;
    await hub.push.setEnabled(true, window);
    await standIn(family);
    hubHangs.on = true;
    const { input } = notificationFor(member, gateway);

    await expect(member.pushDelivery.send(input)).resolves.toEqual({ kind: "delivered" });
    expect(forwards(standby)).toBe(1);
    expect(gateway.accepted).toHaveLength(1);
  }, 40_000);

  it("refuses a standby that is not standing in, and one standing in while the hub's push switch is off", async () => {
    const gateway = await startGateway();
    const family = await startFamily(gateway);
    const { clock, standby, member } = family;
    const ask = () =>
      signedRequest({
        signer: member,
        recipient: standby,
        clock,
        method: "POST",
        path: HUB_LINK_ROUTES.push,
        body: handoffFrom(member, gateway, clock),
      });

    const notStandingIn = await ask();
    expect(notStandingIn?.status).toBe(403);
    expect(await notStandingIn?.json()).toEqual({ status: "refused", kind: "hub-role-off" });

    // The switch was never turned on, so the standby's copy of it is off.
    await standIn(family);
    const switchedOff = await ask();
    expect(await switchedOff?.json()).toEqual({ status: "refused", kind: "push-service-off" });
    expect(gateway.received).toHaveLength(0);
  });

  it("refuses to stand in for a spoke that did not tick Standby, and for one that can still reach the hub", async () => {
    const gateway = await startGateway();
    const family = await startFamily(gateway);
    const { network, clock, hub, standby, member } = family;
    await hub.push.setEnabled(true, window);
    await standIn(family);
    const ask = () =>
      signedRequest({
        signer: member,
        recipient: standby,
        clock,
        method: "POST",
        path: HUB_LINK_ROUTES.push,
        body: handoffFrom(member, gateway, clock),
      });

    // The hub is back for this spoke before the standby has stepped down.
    network.start(hub.address);
    const reachable = await ask();
    expect(await reachable?.json()).toEqual({ status: "refused", kind: "hub-reachable" });

    network.stop(hub.address);
    await pause(FAILOVER_AFTER_MS + 40);
    member.spoke.setGrant(pushGrant, window);
    const withoutStandby = await ask();
    expect(await withoutStandby?.json()).toEqual({
      status: "refused",
      kind: "standby-not-granted",
    });
    expect(gateway.received).toHaveLength(0);
  });
});

describe("a hub that sends notifications directly", () => {
  /** A capability the hub's own gateway issues for a phone paired with `laptop`, and the delivery input that uses it. */
  async function directInput(hub: HubTestHost, laptop: HubTestHost) {
    const issued = await hub.directGateway.issueCapability(
      JSON.stringify({
        platform: "ios",
        token: "ab".repeat(32),
        hostKeyFingerprint: fingerprintOf(laptop),
      }),
      "phone",
    );
    if (!("capability" in issued)) throw new Error(`No capability: ${issued.status}`);
    return {
      destination: { deviceId: "device-1", platform: "ios" as const, token: issued.capability },
      envelope,
    };
  }

  it("delivers a spoke's notification itself and never contacts the gateway the Notifications setting names", async () => {
    const gateway = await startGateway();
    const { hub, laptop } = await startPair(gateway);
    expect(hub.directPush.setEnabled(true, window)).toEqual({ status: "changed" });
    const input = await directInput(hub, laptop);

    await expect(laptop.pushDelivery.send(input)).resolves.toEqual({ kind: "delivered" });

    expect(hub.directSent).toHaveLength(1);
    expect(hub.directSent[0]).toMatchObject({ platform: "ios", token: "ab".repeat(32), envelope });
    expect(gateway.received).toHaveLength(0);
    expect(hub.push.status().spokes).toMatchObject([
      { memberId: laptop.hostId, forwarded: 1, refused: 0 },
    ]);
  });

  it("delivers itself even while its own Notifications setting is off", async () => {
    const gateway = await startGateway();
    const { hub, laptop } = await startPair(gateway);
    hub.pushSetting.enabled = false;
    hub.directPush.setEnabled(true, window);
    const input = await directInput(hub, laptop);

    await expect(laptop.pushDelivery.send(input)).resolves.toEqual({ kind: "delivered" });

    expect(hub.directSent).toHaveLength(1);
  });

  it("forwards to the configured gateway when direct sending is off", async () => {
    const gateway = await startGateway();
    const { hub, laptop } = await startPair(gateway);
    const { input } = notificationFor(laptop, gateway);

    await expect(laptop.pushDelivery.send(input)).resolves.toEqual({ kind: "delivered" });

    expect(gateway.received).toHaveLength(1);
    expect(hub.directSent).toHaveLength(0);
  });

  it("answers unavailable to a capability it issued once direct sending is turned off", async () => {
    const gateway = await startGateway();
    const { hub, laptop } = await startPair(gateway);
    hub.directPush.setEnabled(true, window);
    const input = await directInput(hub, laptop);
    hub.directPush.setEnabled(false, window);

    // The Notifications setting names the stand-in gateway, which does not know this capability.
    await expect(laptop.pushDelivery.send(input)).resolves.toMatchObject({ kind: "failed" });
    expect(hub.directSent).toHaveLength(0);
  });

  it("reports a capability another gateway issued as a mismatch the person can fix, without sending", async () => {
    const gateway = await startGateway();
    const { hub, laptop } = await startPair(gateway);
    hub.directPush.setEnabled(true, window);
    const { input } = notificationFor(laptop, gateway);

    await expect(laptop.pushDelivery.send(input)).resolves.toEqual({
      kind: "failed",
      retryable: false,
      category: "gateway-mismatch",
    });

    expect(hub.directSent).toHaveLength(0);
    expect(gateway.received).toHaveLength(0);
  });
});
