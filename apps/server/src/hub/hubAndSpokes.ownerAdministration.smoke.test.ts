// Four hosts in one process, each a real remote gateway behind a real TLS
// listener: a hub, two spokes, and a phone that is the person's owner device
// holding a software unlock key. What is proved here is the five-minute
// administration session (it covers administration screens, ends on time and on
// an owner change, and never reaches Full access, a credential copy, or an
// owner change), the posture routes, the API-key copy between two hosts, and an
// owner device applying a provisioning proposal. Every request that carries no
// unlock, an expired one, the wrong device, the hub, or no member key at all is
// refused and changes nothing.

import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodeThreadId,
  HubMemberId,
  OWNER_SESSION_HEADER,
  decodeHubOfferBody,
  decodeHubOfferRequest,
  type HubGrant,
} from "@octant/contracts";
import { HubTestNetwork, startHubTestHost, type HubTestHost } from "./hubHost.test-support";
import { publicKeyFingerprint } from "./hubCrypto";
import { HUB_LINK_HEADER, HUB_PEER_KEY_HEADER, signHubLinkRequest } from "./hubLink";
import { HUB_OWNER_ROUTES } from "./hubOwnerRoutes";
import {
  ownerCall,
  softwareAuthenticator,
  type SoftwareAuthenticator,
} from "./hubOwner.test-support";
import { PEER_CREDENTIAL_ROUTE } from "./ownerCredentialCopy";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const window = { kind: "local-window" } as const;
const decodeMemberId = Schema.decodeUnknownSync(HubMemberId);
const decodeThreadId = Schema.decodeUnknownSync(CodeThreadId);

const THREAD = "77777777-7777-4777-8777-777777777777";
const TICKET = "66666666-6666-4666-8666-666666666666";
const SECRET = "sk-test-0123456789abcdef";
// The same provider on two hosts: each host gave its row its own id.
const SOURCE_ROW = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const TARGET_ROW = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const SUBSCRIPTION_ROW = "cccccccc-3333-4333-8333-cccccccccccc";
const MINUTE = 60_000;

const GRANT_WITH_STATUS: HubGrant = {
  items: ["roster", "status", "introduce", "owners"],
  actProjects: [],
};
const PROVISION_GRANT: HubGrant = {
  items: ["roster", "introduce", "owners", "provision"],
  actProjects: [],
};

async function joinHub(
  hub: HubTestHost,
  device: HubTestHost,
  input: { readonly owner: boolean; readonly unlockPublicKey?: string },
) {
  const minted = hub.hub.mintJoinCode({ owner: input.owner });
  if (minted.status !== "minted") throw new Error(minted.status);
  const started = await device.spoke.startJoin({ code: minted.code });
  if (started.status !== "awaiting-approval") throw new Error(JSON.stringify(started));
  const pending = hub.administration.listPendingPairings().at(-1);
  if (pending === undefined) throw new Error("The hub shows no pairing to approve.");
  hub.administration.approvePairing({ ticketId: pending.ticketId });
  const finished = await device.spoke.finishJoin(
    window,
    input.unlockPublicKey === undefined ? {} : { unlockPublicKey: input.unlockPublicKey },
  );
  if (finished.status !== "joined") throw new Error(JSON.stringify(finished));
}

function listAsOwner(spoke: HubTestHost, phone: HubTestHost, authenticator: SoftwareAuthenticator) {
  const listed = spoke.spoke.addOwners(
    [
      {
        memberId: decodeMemberId(phone.hostId),
        identityKeyFingerprint: publicKeyFingerprint(phone.hostPublicKey),
        unlockKeyFingerprint: authenticator.fingerprint,
      },
    ],
    window,
  );
  if (listed.status !== "changed") throw new Error(JSON.stringify(listed));
}

const grantItems = (spoke: HubTestHost) => {
  const status = spoke.spoke.status();
  if (status.membership !== "member") throw new Error("Not a member.");
  return status.grant.items;
};

const changes = (host: HubTestHost, change: string) =>
  host.records.filter((record) => record.change === change);

/** A hub, two spokes, and a phone the hub and both spokes list as an owner. */
async function startWorld() {
  const network = new HubTestNetwork();
  const [hub, a, b, phone] = [
    await startHubTestHost({ name: "Mac mini", address: "100.101.102.103", network, cleanups }),
    await startHubTestHost({ name: "Laptop A", address: "100.101.102.104", network, cleanups }),
    await startHubTestHost({ name: "Desktop B", address: "100.101.102.105", network, cleanups }),
    await startHubTestHost({ name: "Phone", address: "100.101.102.106", network, cleanups }),
  ];
  const authenticator = softwareAuthenticator();
  hub.hub.enable(window);
  await joinHub(hub, phone, { owner: true, unlockPublicKey: authenticator.publicKey });
  await joinHub(hub, a, { owner: false });
  await joinHub(hub, b, { owner: false });
  await vi.waitFor(() => {
    for (const [spoke, other] of [
      [a, b],
      [b, a],
    ] as const) {
      const held = spoke.spoke.status();
      if (held.membership !== "member") throw new Error("Not a member.");
      expect(held.acceptedMemberIds).toContain(other.hostId);
      expect(held.roster.roster.members.map((member) => member.name)).toContain("Phone");
    }
  });
  listAsOwner(a, phone, authenticator);
  listAsOwner(b, phone, authenticator);
  const unlock = { authenticator, shape: "raw" } as const;
  const asPhone = (
    target: HubTestHost,
    route: string,
    body?: unknown,
    extra: Partial<Parameters<typeof ownerCall>[0]> = {},
  ) => ownerCall({ device: phone, network, target, route, body, ...extra });
  const openSession = async (target: HubTestHost): Promise<string> => {
    const opened = await asPhone(target, HUB_OWNER_ROUTES.session, undefined, { unlock });
    expect(opened.status).toBe(200);
    return (opened.json as { session: { sessionId: string } }).session.sessionId;
  };
  return { network, hub, a, b, phone, authenticator, unlock, asPhone, openSession };
}

describe("one unlock covering five minutes of administration", () => {
  it("covers several administration changes with a single unlock", async () => {
    const { a, phone, asPhone, openSession } = await startWorld();
    const session = await openSession(a);

    const grant = await asPhone(a, HUB_OWNER_ROUTES.grant, GRANT_WITH_STATUS, { session });
    const confirm = await asPhone(
      a,
      HUB_OWNER_ROUTES.confirmNewMembers,
      { enabled: true },
      { session },
    );

    expect(grant.status).toBe(200);
    expect(confirm.status).toBe(200);
    expect(grantItems(a)).toEqual(["roster", "status", "introduce", "owners"]);
    expect(a.requests.filter((line) => line === "POST /api/hub/owner/challenge")).toHaveLength(1);
    expect(changes(a, "owner-session-opened")).toHaveLength(1);
    expect(changes(a, "hub-grant-changed").at(-1)?.actingPrincipal).toEqual({
      kind: "owner-unlock",
      memberId: phone.hostId,
    });
  });

  it("keeps working until five minutes have passed and then asks for a new unlock", async () => {
    const { a, asPhone, openSession } = await startWorld();
    const session = await openSession(a);

    a.clock.offset += 5 * MINUTE - 1_000;
    const inside = await asPhone(a, HUB_OWNER_ROUTES.grant, GRANT_WITH_STATUS, { session });
    a.clock.offset += 2_000;
    const outside = await asPhone(
      a,
      HUB_OWNER_ROUTES.grant,
      { items: ["roster", "owners"], actProjects: [] },
      { session },
    );

    expect(inside.status).toBe(200);
    expect(outside.status).toBe(403);
    expect(outside.json).toEqual({ status: "refused", kind: "session-expired" });
    expect(grantItems(a)).toEqual(["roster", "status", "introduce", "owners"]);
  });

  it("never lets a session reach Full access, a sign-in copy, an owner change, leaving, or a renewal", async () => {
    const { a, b, phone, authenticator, asPhone, openSession } = await startWorld();
    const session = await openSession(a);
    const own: ReadonlyArray<readonly [string, unknown]> = [
      [HUB_OWNER_ROUTES.session, undefined],
      [
        HUB_OWNER_ROUTES.ownersAdd,
        {
          owners: [
            {
              memberId: b.hostId,
              identityKeyFingerprint: publicKeyFingerprint(b.hostPublicKey),
              unlockKeyFingerprint: authenticator.fingerprint,
            },
          ],
        },
      ],
      [HUB_OWNER_ROUTES.ownersRemove, { memberId: phone.hostId }],
      [HUB_OWNER_ROUTES.confirmMember, {}],
      [HUB_OWNER_ROUTES.leave, undefined],
      [
        HUB_OWNER_ROUTES.credentialReceive,
        { sourceMemberId: b.hostId, targetCredentialName: TARGET_ROW },
      ],
      [
        HUB_OWNER_ROUTES.credentialCopy,
        { targetMemberId: b.hostId, sourceCredentialName: SOURCE_ROW, ticketId: TICKET },
      ],
      [
        HUB_OWNER_ROUTES.postureChange,
        {
          subject: { kind: "code-thread", threadId: THREAD },
          posture: "full-access",
          persistence: "current-session",
        },
      ],
    ];

    for (const [route, body] of own) {
      const answered = await asPhone(a, route, body, { session });
      expect(answered.json, route).toEqual({ status: "refused", kind: "own-unlock-required" });
      expect(answered.status, route).toBe(403);
    }

    expect(a.spoke.status().membership).toBe("member");
    expect(a.spoke.ownerContext()?.owners.map((owner) => String(owner.memberId))).toEqual([
      phone.hostId,
    ]);
    expect(b.credentials.stores).toEqual([]);
  });

  it("keeps an owner join code and the hub's own administration under the same rule", async () => {
    const { hub, asPhone, openSession } = await startWorld();
    const session = await openSession(hub);

    const plain = await asPhone(hub, HUB_OWNER_ROUTES.joinCode, { owner: false }, { session });
    const ownerCode = await asPhone(hub, HUB_OWNER_ROUTES.joinCode, { owner: true }, { session });

    expect(plain.status).toBe(200);
    expect(ownerCode.json).toEqual({ status: "refused", kind: "own-unlock-required" });
  });

  it("is useless to another device, and ends when the owner list changes or the device is removed", async () => {
    const { network, hub, a, phone, authenticator, asPhone, openSession } = await startWorld();
    const tablet = await startHubTestHost({
      name: "Tablet",
      address: "100.101.102.107",
      network,
      cleanups,
    });
    const tabletKey = softwareAuthenticator();
    await joinHub(hub, tablet, { owner: true, unlockPublicKey: tabletKey.publicKey });
    await vi.waitFor(() => {
      const held = a.spoke.status();
      if (held.membership !== "member") throw new Error("Not a member.");
      expect(held.roster.roster.members.map((member) => member.name)).toContain("Tablet");
    });
    listAsOwner(a, tablet, tabletKey);
    const session = await openSession(a);

    const borrowed = await ownerCall({
      device: tablet,
      network,
      target: a,
      route: HUB_OWNER_ROUTES.grant,
      body: GRANT_WITH_STATUS,
      session,
    });
    expect(borrowed.json).toEqual({ status: "refused", kind: "session-wrong-owner" });

    // The window takes an owner off the list and puts the same device back.
    a.spoke.removeOwner(tablet.hostId, window);
    listAsOwner(a, tablet, tabletKey);
    const afterChange = await asPhone(a, HUB_OWNER_ROUTES.grant, GRANT_WITH_STATUS, { session });
    expect(afterChange.json).toEqual({ status: "refused", kind: "session-owner-changed" });

    const second = await openSession(a);
    a.spoke.removeOwner(phone.hostId, window);
    const removed = await asPhone(a, HUB_OWNER_ROUTES.grant, GRANT_WITH_STATUS, {
      session: second,
    });
    expect(removed.json).toEqual({ status: "refused", kind: "not-an-owner" });
    listAsOwner(a, phone, authenticator);
    const relisted = await asPhone(a, HUB_OWNER_ROUTES.grant, GRANT_WITH_STATUS, {
      session: second,
    });
    expect(relisted.json).toEqual({ status: "refused", kind: "no-such-session" });
    expect(grantItems(a)).toEqual(["roster", "introduce", "owners"]);
  });

  it("refuses a request that carries no unlock, a made-up session, the hub, and a member that is no owner", async () => {
    const { network, hub, a, b, asPhone, openSession } = await startWorld();
    const session = await openSession(a);

    const none = await asPhone(a, HUB_OWNER_ROUTES.grant, GRANT_WITH_STATUS);
    const invented = await asPhone(a, HUB_OWNER_ROUTES.grant, GRANT_WITH_STATUS, {
      session: "not-a-session-the-host-issued",
    });
    const fromHub = await ownerCall({
      device: hub,
      network,
      target: a,
      route: HUB_OWNER_ROUTES.grant,
      body: GRANT_WITH_STATUS,
      session,
    });
    const fromStranger = await ownerCall({
      device: b,
      network,
      target: a,
      route: HUB_OWNER_ROUTES.grant,
      body: GRANT_WITH_STATUS,
      session,
    });
    const unsigned = await a.hubLink(
      new Request(`${a.origin}${HUB_OWNER_ROUTES.grant}`, {
        method: "POST",
        headers: { [OWNER_SESSION_HEADER]: session, "content-type": "application/json" },
        body: JSON.stringify(GRANT_WITH_STATUS),
      }),
    );

    expect(none.json).toEqual({ status: "refused", kind: "unlock-required" });
    expect(invented.json).toEqual({ status: "refused", kind: "no-such-session" });
    expect(fromHub.json).toEqual({ status: "refused", kind: "hub-principal" });
    expect(fromStranger.json).toEqual({ status: "refused", kind: "not-an-owner" });
    expect(unsigned?.status).toBe(401);
    expect(grantItems(a)).toEqual(["roster", "introduce", "owners"]);
  });

  it("refuses a session on a spoke whose person unticked Owners", async () => {
    const { a, asPhone, openSession } = await startWorld();
    const session = await openSession(a);
    a.spoke.setGrant({ items: ["roster", "introduce"], actProjects: [] }, window);

    const answered = await asPhone(
      a,
      HUB_OWNER_ROUTES.confirmNewMembers,
      { enabled: true },
      {
        session,
      },
    );

    expect(answered.json).toEqual({ status: "refused", kind: "owners-not-honored" });
  });
});

describe("owner routes for a Project's or thread's posture", () => {
  const subject = { kind: "code-thread", threadId: THREAD } as const;
  const seed = (host: HubTestHost) =>
    host.postures.seed({
      subject: { kind: "code-thread", threadId: decodeThreadId(THREAD) },
      posture: "approval-gated",
      persistence: "current-session",
    });

  it("reads a posture only for an owner who unlocked", async () => {
    const { a, asPhone, unlock } = await startWorld();
    seed(a);

    const unlocked = await asPhone(a, HUB_OWNER_ROUTES.postureRead, { subject }, { unlock });
    const locked = await asPhone(a, HUB_OWNER_ROUTES.postureRead, { subject });

    expect(unlocked.json).toMatchObject({
      status: "read",
      posture: { posture: "approval-gated", persistence: "current-session" },
    });
    expect(locked.json).toEqual({ status: "refused", kind: "unlock-required" });
  });

  it("lowers a posture under a session and asks for its own unlock before Full access", async () => {
    const { a, asPhone, openSession, unlock } = await startWorld();
    seed(a);
    const session = await openSession(a);
    const change = (posture: string) => ({ subject, posture, persistence: "current-session" });

    const toPlan = await asPhone(a, HUB_OWNER_ROUTES.postureChange, change("plan"), { session });
    const fullViaSession = await asPhone(a, HUB_OWNER_ROUTES.postureChange, change("full-access"), {
      session,
    });
    const fullFresh = await asPhone(a, HUB_OWNER_ROUTES.postureChange, change("full-access"), {
      unlock,
    });

    expect(toPlan.status).toBe(200);
    expect(fullViaSession.json).toEqual({ status: "refused", kind: "own-unlock-required" });
    expect(fullFresh.status).toBe(200);
    expect(a.postures.changes.map((entry) => entry.posture)).toEqual(["plan", "full-access"]);
    expect(changes(a, "owner-posture-changed").map((entry) => entry.posture)).toEqual([
      "plan",
      "full-access",
    ]);
    expect(changes(a, "owner-posture-changed")[0]?.actingPrincipal.kind).toBe("owner-unlock");
  });

  it("leaves the posture alone when the host's own rule refuses the change", async () => {
    const { a, asPhone, unlock } = await startWorld();
    seed(a);

    const answered = await asPhone(
      a,
      HUB_OWNER_ROUTES.postureChange,
      { subject, posture: "full-access", persistence: "project-default" },
      { unlock },
    );

    expect(answered.status).toBe(409);
    expect(answered.json).toEqual({ status: "refused", kind: "project-default-not-enabled" });
    expect(a.postures.changes).toEqual([]);
    expect(changes(a, "owner-posture-changed")).toEqual([]);
  });

  it("refuses the hub, a member that is no owner, and a request with no unlock", async () => {
    const { network, hub, a, b, asPhone, unlock } = await startWorld();
    seed(a);
    const request = {
      subject,
      posture: "plan",
      persistence: "current-session",
    };

    const noUnlock = await asPhone(a, HUB_OWNER_ROUTES.postureChange, request);
    const fromHub = await ownerCall({
      device: hub,
      network,
      target: a,
      route: HUB_OWNER_ROUTES.postureChange,
      body: request,
      unlock,
    });
    const fromStranger = await ownerCall({
      device: b,
      network,
      target: a,
      route: HUB_OWNER_ROUTES.postureChange,
      body: request,
      unlock,
    });

    expect(noUnlock.json).toEqual({ status: "refused", kind: "unlock-required" });
    expect(fromHub.json).toEqual({ status: "refused", kind: "hub-principal" });
    expect(fromStranger.json).toEqual({ status: "refused", kind: "not-an-owner" });
    expect(a.postures.changes).toEqual([]);
  });
});

describe("copying an API-key sign-in from one host to another", () => {
  async function startCopyWorld() {
    const world = await startWorld();
    world.a.credentials.providers.add(SOURCE_ROW);
    world.a.credentials.keys.set(SOURCE_ROW, SECRET);
    world.b.credentials.providers.add(TARGET_ROW);
    const receive = (
      body: unknown = { sourceMemberId: world.a.hostId, targetCredentialName: TARGET_ROW },
    ) => world.asPhone(world.b, HUB_OWNER_ROUTES.credentialReceive, body, { unlock: world.unlock });
    const send = (ticketId: string, name = SOURCE_ROW) =>
      world.asPhone(
        world.a,
        HUB_OWNER_ROUTES.credentialCopy,
        { targetMemberId: world.b.hostId, sourceCredentialName: name, ticketId },
        { unlock: world.unlock },
      );
    return { ...world, receive, send };
  }
  const ticketOf = (answered: { readonly json: unknown }) =>
    (answered.json as { ticketId: string }).ticketId;

  it("moves the key between the two hosts' brokers under each host's own row id, journals the names, and never the value", async () => {
    const { a, b, receive, send } = await startCopyWorld();

    const ticket = await receive();
    const copied = await send(ticketOf(ticket));

    expect(copied.status).toBe(200);
    expect(copied.json).toEqual({ status: "copied" });
    expect(b.credentials.keys.get(TARGET_ROW)).toBe(SECRET);
    expect(b.credentials.keys.has(SOURCE_ROW)).toBe(false);
    expect(a.credentials.keys.get(SOURCE_ROW)).toBe(SECRET);
    expect(changes(a, "credential-copy-sent")).toMatchObject([
      { credentialName: SOURCE_ROW, actingPrincipal: { kind: "owner-unlock" } },
    ]);
    expect(changes(b, "credential-copy-received")).toMatchObject([
      { credentialName: TARGET_ROW, actingPrincipal: { kind: "owner-unlock" } },
    ]);
    const everything = JSON.stringify([a.records, b.records, ticket.json, copied.json]);
    expect(everything).not.toContain(SECRET);
  });

  it("stores once when two tickets are redeemed together, and tells the second the key is already there", async () => {
    const { b, receive, send } = await startCopyWorld();
    const first = ticketOf(await receive());
    const second = ticketOf(await receive());

    const [one, two] = await Promise.all([send(first), send(second)]);

    expect([one.json, two.json]).toContainEqual({ status: "copied" });
    expect([one.json, two.json]).toContainEqual({ status: "refused", kind: "already-stored" });
    expect(b.credentials.stores).toEqual([TARGET_ROW]);
    expect(b.credentials.keys.get(TARGET_ROW)).toBe(SECRET);
  });

  it("refuses a subscription sign-in with its reason and stores nothing", async () => {
    const { a, b, receive, send } = await startCopyWorld();
    a.credentials.subscriptions.add(SUBSCRIPTION_ROW);
    const ticket = await receive();

    const answered = await send(ticketOf(ticket), SUBSCRIPTION_ROW);

    expect(answered.status).toBe(409);
    expect(answered.json).toEqual({ status: "refused", kind: "subscription-sign-in" });
    expect(b.credentials.keys.size).toBe(0);
    expect(changes(a, "credential-copy-refused")).toMatchObject([
      { credentialName: SUBSCRIPTION_ROW, credentialReason: "subscription-sign-in" },
    ]);
  });

  it("asks for an unlock on each host and refuses the request without one", async () => {
    const { a, b, asPhone } = await startCopyWorld();

    const receiveNone = await asPhone(b, HUB_OWNER_ROUTES.credentialReceive, {
      sourceMemberId: a.hostId,
      targetCredentialName: TARGET_ROW,
    });
    const copyNone = await asPhone(a, HUB_OWNER_ROUTES.credentialCopy, {
      targetMemberId: b.hostId,
      sourceCredentialName: SOURCE_ROW,
      ticketId: TICKET,
    });

    expect(receiveNone.json).toEqual({ status: "refused", kind: "unlock-required" });
    expect(copyNone.json).toEqual({ status: "refused", kind: "unlock-required" });
    expect(b.credentials.keys.size).toBe(0);
  });

  it("refuses a key that arrives without a ticket or with a used ticket", async () => {
    const { b, receive, send } = await startCopyWorld();

    const noTicket = await send(TICKET);
    const ticket = ticketOf(await receive());
    const first = await send(ticket);
    b.credentials.keys.delete(TARGET_ROW);
    const reused = await send(ticket);

    expect(noTicket.json).toEqual({ status: "refused", kind: "no-such-ticket" });
    expect(first.status).toBe(200);
    expect(reused.json).toEqual({ status: "refused", kind: "no-such-ticket" });
    expect(b.credentials.keys.size).toBe(0);
  });

  it("refuses a receiving row that does not exist on the receiving host", async () => {
    const { a, b, receive, send } = await startCopyWorld();
    const ticket = await receive({
      sourceMemberId: a.hostId,
      targetCredentialName: SOURCE_ROW,
    });

    const answered = await send(ticketOf(ticket));

    expect(answered.json).toEqual({ status: "refused", kind: "no-such-provider" });
    expect(b.credentials.keys.size).toBe(0);
  });

  it("refuses to replace a key the person already holds on the receiving host", async () => {
    const { b, receive, send } = await startCopyWorld();
    b.credentials.keys.set(TARGET_ROW, "sk-test-typed-here");

    const answered = await send(ticketOf(await receive()));

    expect(answered.json).toEqual({ status: "refused", kind: "already-stored" });
    expect(b.credentials.keys.get(TARGET_ROW)).toBe("sk-test-typed-here");
  });

  it("refuses the copy when the owner was removed on the receiving host after asking", async () => {
    const { b, phone, receive, send } = await startCopyWorld();
    const ticket = ticketOf(await receive());
    b.spoke.removeOwner(phone.hostId, window);

    const answered = await send(ticket);

    expect(answered.json).toEqual({ status: "refused", kind: "owner-no-longer-listed" });
    expect(b.credentials.keys.size).toBe(0);
  });

  it("refuses the hub as a sender, a member that is no owner, and a request nobody signed", async () => {
    const { network, hub, a, b, asPhone, unlock, receive, send } = await startCopyWorld();
    const ticket = ticketOf(await receive());

    const hubAsTarget = await asPhone(
      a,
      HUB_OWNER_ROUTES.credentialCopy,
      { targetMemberId: hub.hostId, sourceCredentialName: SOURCE_ROW, ticketId: ticket },
      { unlock },
    );
    const fromHub = await ownerCall({
      device: hub,
      network,
      target: b,
      route: HUB_OWNER_ROUTES.credentialReceive,
      body: { sourceMemberId: a.hostId, targetCredentialName: TARGET_ROW },
      unlock,
    });
    const fromStranger = await ownerCall({
      device: b,
      network,
      target: a,
      route: HUB_OWNER_ROUTES.credentialCopy,
      body: { targetMemberId: b.hostId, sourceCredentialName: SOURCE_ROW, ticketId: ticket },
      unlock,
    });
    const unsigned = await b.hubLink(
      new Request(`${b.origin}${PEER_CREDENTIAL_ROUTE}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticketId: ticket, value: SECRET }),
      }),
    );
    const signedByHub = await b.hubLink(
      new Request(`${b.origin}${PEER_CREDENTIAL_ROUTE}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [HUB_PEER_KEY_HEADER]: hub.hostPublicKey,
          [HUB_LINK_HEADER]: signHubLinkRequest({
            signHostPayload: hub.signHostPayload,
            senderMemberId: hub.hostId,
            recipientMemberId: b.hostId,
            method: "POST",
            path: PEER_CREDENTIAL_ROUTE,
            body: JSON.stringify({ ticketId: ticket, value: SECRET }),
            now: Date.now(),
          }),
        },
        body: JSON.stringify({ ticketId: ticket, value: SECRET }),
      }),
    );

    expect(hubAsTarget.json).toEqual({ status: "refused", kind: "not-a-spoke-member" });
    expect(fromHub.json).toEqual({ status: "refused", kind: "hub-principal" });
    expect(fromStranger.json).toEqual({ status: "refused", kind: "not-an-owner" });
    expect(unsigned?.status).toBe(401);
    expect(signedByHub?.status).toBe(401);
    expect(b.credentials.keys.size).toBe(0);
    // The send above never ran, so the ticket is still good for the real source.
    expect((await send(ticket)).status).toBe(200);
  });
});

describe("an owner device applying or dismissing a provisioning proposal", () => {
  const channelOffer = decodeHubOfferBody({ kind: "update-channel", channel: "preview" });

  async function startOfferWorld() {
    const world = await startWorld();
    expect(world.hub.provision.setEnabled(true, window)).toEqual({
      status: "changed",
      enabled: true,
    });
    world.a.spoke.setGrant(PROVISION_GRANT, window);
    const offered = await world.hub.provision.offer(
      decodeHubOfferRequest({ offer: channelOffer }),
      window,
    );
    if (offered.status !== "offered") throw new Error(JSON.stringify(offered));
    return { ...world, offerId: offered.offerId };
  }

  it("applies a proposal through the same path the window uses, journaled as the owner", async () => {
    const { a, asPhone, unlock, offerId } = await startOfferWorld();
    expect(a.spokeProvision.view().proposals).toHaveLength(1);

    const answered = await asPhone(a, HUB_OWNER_ROUTES.provisionApply, { offerId }, { unlock });

    expect(answered.json).toEqual({ status: "applied" });
    expect(a.provisioned.channel).toBe("preview");
    expect(a.spokeProvision.view().proposals).toEqual([]);
    expect(changes(a, "provision-applied").at(-1)?.actingPrincipal.kind).toBe("owner-unlock");
  });

  it("dismisses a proposal under an open session without another unlock", async () => {
    const { a, asPhone, openSession, offerId } = await startOfferWorld();
    const session = await openSession(a);

    const answered = await asPhone(a, HUB_OWNER_ROUTES.provisionDismiss, { offerId }, { session });

    expect(answered.json).toEqual({ status: "dismissed" });
    expect(a.provisioned.channel).toBeUndefined();
    expect(a.spokeProvision.view().proposals).toEqual([]);
    expect(changes(a, "provision-dismissed").at(-1)?.actingPrincipal.kind).toBe("owner-unlock");
  });

  it("refuses the hub, a member that is no owner, and a request with no unlock, and applies nothing", async () => {
    const { network, hub, a, b, asPhone, unlock, offerId } = await startOfferWorld();

    const noUnlock = await asPhone(a, HUB_OWNER_ROUTES.provisionApply, { offerId });
    const fromHub = await ownerCall({
      device: hub,
      network,
      target: a,
      route: HUB_OWNER_ROUTES.provisionApply,
      body: { offerId },
      unlock,
    });
    const fromStranger = await ownerCall({
      device: b,
      network,
      target: a,
      route: HUB_OWNER_ROUTES.provisionApply,
      body: { offerId },
      unlock,
    });

    expect(noUnlock.json).toEqual({ status: "refused", kind: "unlock-required" });
    expect(fromHub.json).toEqual({ status: "refused", kind: "hub-principal" });
    expect(fromStranger.json).toEqual({ status: "refused", kind: "not-an-owner" });
    expect(a.provisioned.channel).toBeUndefined();
    expect(a.spokeProvision.view().proposals).toHaveLength(1);
  });

  it("still refuses an offer the host cannot apply, naming the reason and keeping the proposal", async () => {
    const { a, asPhone, unlock, offerId } = await startOfferWorld();
    a.provisioned.fail = true;

    const answered = await asPhone(a, HUB_OWNER_ROUTES.provisionApply, { offerId }, { unlock });

    expect(answered.status).toBe(409);
    expect(answered.json).toEqual({ status: "refused", kind: "apply-failed" });
    expect(a.spokeProvision.view().proposals).toHaveLength(1);
  });
});
