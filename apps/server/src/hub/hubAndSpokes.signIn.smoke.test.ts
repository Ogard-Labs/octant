// Hosts in one process, each the real remote gateway behind a real TLS listener
// serving a certificate it made itself. The hub's window (or an owner device
// after its unlock) asks a spoke to sign in to a provider account. A spoke whose
// person ticked Sign-in holds the request as a question; nothing starts until a
// person on that spoke accepts, and then the provider's own sign-in runs there,
// outside Octant. The hub is told one word. Each host's view of the provider's
// own app is a fake a test sets, as the person would by signing in in a terminal.

import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  HubMemberId,
  decodeHubSignInAsk,
  type HubGrant,
  type HubSignInKind,
} from "@octant/contracts";
import { HubTestNetwork, startHubTestHost, type HubTestHost } from "./hubHost.test-support";
import { publicKeyFingerprint } from "./hubCrypto";
import { HUB_LINK_HEADER, HUB_PEER_KEY_HEADER, signHubLinkRequest } from "./hubLink";
import { HUB_LINK_ROUTES } from "./hubLinkRoutes";
import { HUB_OWNER_ROUTES } from "./hubOwnerRoutes";
import {
  ownerCall,
  softwareAuthenticator,
  type SoftwareAuthenticator,
} from "./hubOwner.test-support";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const window = { kind: "local-window" } as const;
const decodeMemberId = Schema.decodeUnknownSync(HubMemberId);
const MINUTE = 60_000;
const CLAUDE: HubSignInKind = "claude-subscription";
const CODEX: HubSignInKind = "codex-subscription";

const signInGrant: HubGrant = {
  items: ["roster", "introduce", "owners", "sign-in"],
  actProjects: [],
};
const noSignInGrant: HubGrant = { items: ["roster", "introduce", "owners"], actProjects: [] };

function makeClock() {
  const state = { offset: 0 };
  return { state, now: () => Date.now() + state.offset };
}
type Clock = ReturnType<typeof makeClock>;

function start(network: HubTestNetwork, clock: Clock, name: string, last: number) {
  return startHubTestHost({
    name,
    address: `100.101.102.${last}`,
    network,
    cleanups,
    wakeClock: clock.now,
  });
}

/** The way a person joins: a code from the hub, a comparison on both screens, approval on the hub. */
async function join(
  hub: HubTestHost,
  member: HubTestHost,
  input: { readonly owner: boolean; readonly unlockPublicKey?: string } = { owner: false },
) {
  const minted = hub.hub.mintJoinCode({ owner: input.owner });
  if (minted.status !== "minted") throw new Error(minted.status);
  const started = await member.spoke.startJoin({ code: minted.code });
  if (started.status !== "awaiting-approval") throw new Error(JSON.stringify(started));
  const pending = hub.administration.listPendingPairings().at(-1);
  if (pending === undefined) throw new Error("The hub shows no pairing to approve.");
  hub.administration.approvePairing({ ticketId: pending.ticketId });
  const finished = await member.spoke.finishJoin(
    window,
    input.unlockPublicKey === undefined ? {} : { unlockPublicKey: input.unlockPublicKey },
  );
  if (finished.status !== "joined") throw new Error(JSON.stringify(finished));
}

async function startPair(grant: HubGrant = signInGrant) {
  const network = new HubTestNetwork();
  const clock = makeClock();
  const hub = await start(network, clock, "Mac mini", 103);
  const laptop = await start(network, clock, "Laptop", 104);
  const enabled = hub.hub.enable(window);
  if (enabled.status !== "enabled") throw new Error(enabled.status);
  await join(hub, laptop);
  laptop.spoke.setGrant(grant, window);
  return { network, clock, hub, laptop };
}

/** A hub, a laptop spoke, and a phone the hub and the laptop both list as an owner. */
async function startOwnerWorld() {
  const { network, clock, hub, laptop } = await startPair();
  const phone = await start(network, clock, "Phone", 105);
  const authenticator: SoftwareAuthenticator = softwareAuthenticator();
  await join(hub, phone, { owner: true, unlockPublicKey: authenticator.publicKey });
  await vi.waitFor(() => {
    const status = laptop.spoke.status();
    if (status.membership !== "member") throw new Error("Not a member.");
    expect(status.roster.roster.members.map((member) => member.name)).toContain("Phone");
  });
  const listed = laptop.spoke.addOwners(
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
  const unlock = { authenticator, shape: "raw" } as const;
  const asPhone = (target: HubTestHost, route: string, body?: unknown, withUnlock = true) =>
    ownerCall({
      device: phone,
      network,
      target,
      route,
      body,
      ...(withUnlock ? { unlock } : {}),
    });
  return { network, clock, hub, laptop, phone, asPhone };
}

const ask = (hub: HubTestHost, laptop: HubTestHost, kind: HubSignInKind = CLAUDE) =>
  hub.signIn.ask(decodeHubSignInAsk({ memberId: laptop.hostId, kind }), window);

async function askedId(hub: HubTestHost, laptop: HubTestHost, kind: HubSignInKind = CLAUDE) {
  const asked = await ask(hub, laptop, kind);
  if (asked.status !== "asked") throw new Error(JSON.stringify(asked));
  return asked.requestId;
}

const held = (host: HubTestHost) => host.spokeSignIn.view().requests;
const changes = (host: HubTestHost, change: string) =>
  host.records.filter((record) => record.change === change);
const hubWord = (hub: HubTestHost) => hub.signIn.status().map((entry) => entry.result);

/** A request to `recipient`'s listener signed with `signer`'s identity key, as the signer's own server would. */
function signedRequest(input: {
  readonly signer: HubTestHost;
  readonly recipient: HubTestHost;
  readonly clock: Clock;
  readonly path: string;
  readonly body: unknown;
}) {
  const body = JSON.stringify(input.body);
  return input.recipient.hubLink(
    new Request(`${input.recipient.origin}${input.path}`, {
      method: "POST",
      headers: {
        host: `${input.recipient.address}:8443`,
        "content-type": "application/json",
        [HUB_PEER_KEY_HEADER]: input.signer.hostPublicKey,
        [HUB_LINK_HEADER]: signHubLinkRequest({
          signHostPayload: input.signer.signHostPayload,
          senderMemberId: input.signer.hostId,
          recipientMemberId: input.recipient.hostId,
          method: "POST",
          path: input.path,
          body,
          now: input.clock.now(),
        }),
      },
      body,
    }),
  );
}

describe("a sign-in request from the hub's window", () => {
  it("waits for a person on the spoke, and starts nothing before they accept", async () => {
    const { hub, laptop } = await startPair();
    laptop.accounts[CLAUDE] = "signed-out";

    const requestId = await askedId(hub, laptop);

    expect(held(laptop).map((request) => [request.requestId, request.kind, request.state])).toEqual(
      [[requestId, CLAUDE, "asked"]],
    );
    // No command is shown, no account is checked for, and the hub still hears only that it asked.
    expect(held(laptop)[0]?.guidance).toBeUndefined();
    const early = await laptop.spokeSignIn.check(requestId, window);
    expect(early).toEqual({ status: "refused", kind: "not-accepted-yet" });
    expect(changes(laptop, "sign-in-accepted")).toEqual([]);
    expect(hubWord(hub)).toEqual(["asked"]);
  });

  it("shows the provider's own command only once a person accepts, and tells the hub signed-in after", async () => {
    const { hub, laptop } = await startPair();
    const requestId = await askedId(hub, laptop);

    const accepted = laptop.spokeSignIn.accept(requestId, window);
    expect(accepted.status).toBe("accepted");
    expect(held(laptop)[0]?.state).toBe("accepted");
    expect(held(laptop)[0]?.guidance).toContain("claude auth login");
    // Still waiting on the person's terminal.
    expect(await laptop.spokeSignIn.check(requestId, window)).toEqual({ status: "pending" });
    expect(hubWord(hub)).toEqual(["asked"]);

    laptop.accounts[CLAUDE] = "signed-in";
    expect(await laptop.spokeSignIn.check(requestId, window)).toEqual({
      status: "ended",
      outcome: "signed-in",
    });

    expect(held(laptop)).toEqual([]);
    expect(hubWord(hub)).toEqual(["signed-in"]);
    expect(
      changes(laptop, "sign-in-accepted").map((record) => record.actingPrincipal.kind),
    ).toEqual(["local-window"]);
  });

  it("tells the hub declined when the person declines", async () => {
    const { hub, laptop } = await startPair();
    const requestId = await askedId(hub, laptop, CODEX);

    expect(await laptop.spokeSignIn.decline(requestId, window)).toEqual({ status: "declined" });

    expect(held(laptop)).toEqual([]);
    expect(hubWord(hub)).toEqual(["declined"]);
    expect(changes(laptop, "sign-in-declined")).toHaveLength(1);
  });

  it("tells the hub failed when the provider's own app can no longer be read", async () => {
    const { hub, laptop } = await startPair();
    const requestId = await askedId(hub, laptop);
    laptop.spokeSignIn.accept(requestId, window);
    laptop.accounts[CLAUDE] = "unavailable";

    expect(await laptop.spokeSignIn.check(requestId, window)).toEqual({
      status: "ended",
      outcome: "failed",
    });

    expect(hubWord(hub)).toEqual(["failed"]);
  });

  it("lapses after ten minutes, even once accepted, and tells the hub expired", async () => {
    const { hub, laptop, clock } = await startPair();
    const requestId = await askedId(hub, laptop);
    laptop.spokeSignIn.accept(requestId, window);

    clock.state.offset += 10 * MINUTE + 1;
    await laptop.spokeSignIn.tick();

    expect(held(laptop)).toEqual([]);
    expect(hubWord(hub)).toEqual(["expired"]);
    expect(await laptop.spokeSignIn.accept(requestId, window)).toEqual({
      status: "refused",
      kind: "unknown-request",
    });
  });

  it("keeps an outcome word the hub could not take and sends it when the hub is back", async () => {
    const { network, hub, laptop } = await startPair();
    const requestId = await askedId(hub, laptop);
    network.stop(hub.address);

    expect(await laptop.spokeSignIn.decline(requestId, window)).toEqual({ status: "declined" });
    expect(hubWord(hub)).toEqual(["asked"]);

    network.start(hub.address);
    await laptop.spokeSignIn.tick();
    expect(hubWord(hub)).toEqual(["declined"]);
  });
});

describe("a spoke that refuses a sign-in request", () => {
  it("refuses when its person did not tick Sign-in, and holds nothing", async () => {
    const { hub, laptop } = await startPair(noSignInGrant);

    const asked = await ask(hub, laptop);

    expect(asked).toEqual({ status: "refused", kind: "sign-in-not-granted" });
    expect(held(laptop)).toEqual([]);
    expect(hubWord(hub)).toEqual([{ refused: "sign-in-not-granted" }]);
    expect(changes(laptop, "sign-in-refused")[0]?.signInReason).toBe("sign-in-not-granted");
  });

  it("drops what it holds, and tells the hub declined, when the person unticks Sign-in", async () => {
    const { hub, laptop } = await startPair();
    await askedId(hub, laptop);

    laptop.spoke.setGrant(noSignInGrant, window);
    await laptop.spokeSignIn.tick();

    expect(held(laptop)).toEqual([]);
    expect(hubWord(hub)).toEqual(["declined"]);
  });

  it("refuses a kind it does not know", async () => {
    const { clock, hub, laptop } = await startPair();

    const answered = await signedRequest({
      signer: hub,
      recipient: laptop,
      clock,
      path: HUB_LINK_ROUTES.signInRequest,
      body: { requestId: "22222222-2222-4222-8222-222222222222", kind: "gemini-subscription" },
    });

    expect(answered?.status).toBe(403);
    expect(await answered?.json()).toEqual({ status: "refused", kind: "unknown-kind" });
    expect(held(laptop)).toEqual([]);
  });

  it("refuses a kind it has no provider for", async () => {
    const { hub, laptop } = await startPair();
    laptop.accounts[CODEX] = "unavailable";

    expect(await ask(hub, laptop, CODEX)).toEqual({ status: "refused", kind: "unknown-kind" });
  });

  it("refuses an account that is already signed in", async () => {
    const { hub, laptop } = await startPair();
    laptop.accounts[CLAUDE] = "signed-in";

    expect(await ask(hub, laptop)).toEqual({ status: "refused", kind: "already-signed-in" });
    expect(held(laptop)).toEqual([]);
  });

  it("refuses a second request for the same account while one is open", async () => {
    const { hub, laptop } = await startPair();
    await askedId(hub, laptop);

    expect(await ask(hub, laptop)).toEqual({ status: "refused", kind: "already-asked" });
    expect(held(laptop)).toHaveLength(1);
  });

  it("refuses the fourth request in an hour from the same requester, and allows one after the hour", async () => {
    const { clock, hub, laptop } = await startPair();
    for (let index = 0; index < 3; index += 1) {
      const requestId = await askedId(hub, laptop);
      await laptop.spokeSignIn.decline(requestId, window);
    }

    expect(await ask(hub, laptop)).toEqual({ status: "refused", kind: "rate-limited" });
    expect(held(laptop)).toEqual([]);

    clock.state.offset += 61 * MINUTE;
    expect((await ask(hub, laptop)).status).toBe("asked");
  });

  it("refuses a request body that could carry a code or an address", async () => {
    const { clock, hub, laptop } = await startPair();

    const answered = await signedRequest({
      signer: hub,
      recipient: laptop,
      clock,
      path: HUB_LINK_ROUTES.signInRequest,
      body: {
        requestId: "22222222-2222-4222-8222-222222222222",
        kind: CLAUDE,
        url: "https://example.test/device?code=ABCD-EFGH",
      },
    });

    expect(answered?.status).toBe(400);
    expect(held(laptop)).toEqual([]);
  });
});

describe("who can send or settle a sign-in request", () => {
  it("accepts a request on the spoke only from the hub's own key", async () => {
    const { network, clock, hub, laptop } = await startPair();
    const other = await start(network, clock, "Desktop", 106);
    await join(hub, other);

    const fromPeer = await signedRequest({
      signer: other,
      recipient: laptop,
      clock,
      path: HUB_LINK_ROUTES.signInRequest,
      body: { requestId: "22222222-2222-4222-8222-222222222222", kind: CLAUDE },
    });

    expect(fromPeer?.status).toBe(401);
    expect(held(laptop)).toEqual([]);
  });

  it("lets a member end only a request the hub asked of it", async () => {
    const { network, clock, hub, laptop } = await startPair();
    const other = await start(network, clock, "Desktop", 106);
    await join(hub, other);
    other.spoke.setGrant(signInGrant, window);
    const requestId = await askedId(hub, laptop);

    const forged = await signedRequest({
      signer: other,
      recipient: hub,
      clock,
      path: HUB_LINK_ROUTES.signInOutcome,
      body: { requestId, outcome: "signed-in" },
    });

    expect(forged?.status).toBe(403);
    expect(hubWord(hub)).toEqual(["asked"]);
  });

  it("refuses an outcome word the hub never asked for, and one that is not a word", async () => {
    const { clock, hub, laptop } = await startPair();

    const unknown = await signedRequest({
      signer: laptop,
      recipient: hub,
      clock,
      path: HUB_LINK_ROUTES.signInOutcome,
      body: { requestId: "22222222-2222-4222-8222-222222222222", outcome: "signed-in" },
    });
    const notAWord = await signedRequest({
      signer: laptop,
      recipient: hub,
      clock,
      path: HUB_LINK_ROUTES.signInOutcome,
      body: {
        requestId: "22222222-2222-4222-8222-222222222222",
        outcome: "ok:person@example.test",
      },
    });

    expect(unknown?.status).toBe(403);
    expect(notAWord?.status).toBe(400);
  });

  it("is sent only from a hub whose role is on, to a member it lists", async () => {
    const { hub, laptop } = await startPair();

    expect(await ask(laptop, hub)).toEqual({ status: "refused", kind: "hub-role-off" });
    const stranger = decodeHubSignInAsk({
      memberId: "99999999-9999-4999-8999-999999999999",
      kind: CLAUDE,
    });
    expect(await hub.signIn.ask(stranger, window)).toEqual({
      status: "refused",
      kind: "unknown-member",
    });
  });

  it("lets an unlocked owner device on the hub send it, journaled as that owner", async () => {
    const { hub, laptop, phone, asPhone } = await startOwnerWorld();

    const answered = await asPhone(hub, HUB_OWNER_ROUTES.signInAsk, {
      memberId: laptop.hostId,
      kind: CLAUDE,
    });

    expect(answered.status).toBe(200);
    expect((answered.json as { status: string }).status).toBe("asked");
    expect(held(laptop)).toHaveLength(1);
    expect(changes(hub, "sign-in-asked")[0]?.actingPrincipal).toEqual({
      kind: "owner-unlock",
      memberId: phone.hostId,
    });
  });

  it("refuses an owner request with no unlock, from a member that is no owner, and with no member key", async () => {
    const { network, hub, laptop, asPhone } = await startOwnerWorld();
    const body = { memberId: laptop.hostId, kind: CLAUDE };

    const noUnlock = await asPhone(hub, HUB_OWNER_ROUTES.signInAsk, body, false);
    const fromSpoke = await ownerCall({
      device: laptop,
      network,
      target: hub,
      route: HUB_OWNER_ROUTES.signInAsk,
      body,
      unlock: { authenticator: softwareAuthenticator(), shape: "raw" },
    });
    const noKey = await ownerCall({
      device: laptop,
      network,
      target: hub,
      route: HUB_OWNER_ROUTES.signInAsk,
      body,
      omitIdentityKey: true,
    });

    expect(noUnlock.json).toEqual({ status: "refused", kind: "unlock-required" });
    expect(fromSpoke.json).toEqual({ status: "refused", kind: "not-an-owner" });
    expect(noKey.status).toBe(401);
    expect(held(laptop)).toEqual([]);
    expect(hubWord(hub)).toEqual([]);
  });

  it("lets a spoke's own unlocked owner device accept, and never the hub", async () => {
    const { network, hub, laptop, phone, asPhone } = await startOwnerWorld();
    const requestId = await askedId(hub, laptop);

    const fromHub = await ownerCall({
      device: hub,
      network,
      target: laptop,
      route: HUB_OWNER_ROUTES.signInAccept,
      body: { requestId },
      unlock: { authenticator: softwareAuthenticator(), shape: "raw" },
    });
    expect(fromHub.json).toEqual({ status: "refused", kind: "hub-principal" });
    expect(held(laptop)[0]?.state).toBe("asked");

    const accepted = await asPhone(laptop, HUB_OWNER_ROUTES.signInAccept, { requestId });
    expect((accepted.json as { status: string }).status).toBe("accepted");
    expect(held(laptop)[0]?.state).toBe("accepted");
    expect(changes(laptop, "sign-in-accepted")[0]?.actingPrincipal).toEqual({
      kind: "owner-unlock",
      memberId: phone.hostId,
    });

    laptop.accounts[CLAUDE] = "signed-in";
    const checked = await asPhone(laptop, HUB_OWNER_ROUTES.signInCheck, { requestId });
    expect(checked.json).toEqual({ status: "ended", outcome: "signed-in" });
    expect(hubWord(hub)).toEqual(["signed-in"]);
  });
});

describe("what the hub and the journal learn", () => {
  it("keeps only the request, the kind, and one outcome word, and never the command", async () => {
    const { hub, laptop } = await startPair();
    const requestId = await askedId(hub, laptop);
    const accepted = laptop.spokeSignIn.accept(requestId, window);
    laptop.accounts[CLAUDE] = "signed-in";
    await laptop.spokeSignIn.check(requestId, window);

    const guidance = accepted.status === "accepted" ? accepted.guidance : "";
    expect(guidance).not.toBe("");
    const entry = hub.signIn.status()[0];
    expect(Object.keys(entry ?? {}).sort()).toEqual([
      "askedAt",
      "kind",
      "memberId",
      "requestId",
      "result",
    ]);
    expect(entry?.result).toBe("signed-in");

    // The hub's saved state and every journal entry on both hosts carry no command, code, address, or name.
    const everything = JSON.stringify([
      hub.signIn.status(),
      hub.state.load().hub,
      hub.records,
      laptop.records,
      hub.requests,
    ]);
    expect(everything).not.toContain(guidance);
    expect(everything).not.toContain("auth login");
    expect(everything).not.toMatch(/@|https?:\/\/(?!100\.)|code=|token/i);
  });

  it("journals the request, the decision, and the outcome on the spoke with the outcome word", async () => {
    const { hub, laptop } = await startPair();
    const requestId = await askedId(hub, laptop);
    laptop.spokeSignIn.accept(requestId, window);
    laptop.accounts[CLAUDE] = "signed-in";
    await laptop.spokeSignIn.check(requestId, window);

    expect(
      laptop.records
        .filter((record) => record.change.startsWith("sign-in-"))
        .map((record) => [record.change, record.signInKind, record.signInOutcome]),
    ).toEqual([
      ["sign-in-requested", CLAUDE, undefined],
      ["sign-in-accepted", CLAUDE, undefined],
      ["sign-in-ended", CLAUDE, "signed-in"],
    ]);
    expect(changes(hub, "sign-in-outcome-received")[0]?.signInOutcome).toBe("signed-in");
  });
});
