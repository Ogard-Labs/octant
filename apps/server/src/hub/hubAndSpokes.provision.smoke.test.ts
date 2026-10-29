// Hosts in one process, each the real remote gateway behind a real TLS listener
// serving a certificate it made itself. The hub's window makes an offer; a spoke
// whose person ticked Provision holds it as a proposal and applies it only when
// that person says so, or, for three kinds, when they turned on applying it on
// arrival. Each host's services for applying are fakes a test can read, so the
// tests prove what the spoke asked of them: installed but untrusted, no secret,
// and a routine authored by the spoke's own principal. The mirrored update feed
// is signed with a key the spoke trusts, so the signature check is the real one.

import { generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeHubOfferBody,
  decodeHubOfferRequest,
  decodeHubProposalDecisionRequest,
  AppUpdateFeed,
  type HubGrant,
  type HubOfferBody,
} from "@octant/contracts";
import { canonicalReleaseBytes } from "@octant/domain";
import { Schema } from "effect";
import { HubTestNetwork, startHubTestHost, type HubTestHost } from "./hubHost.test-support";
import { HUB_LINK_HEADER, HUB_PEER_KEY_HEADER, signHubLinkRequest } from "./hubLink";
import { HUB_LINK_ROUTES } from "./hubLinkRoutes";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const window = { kind: "local-window" } as const;
const decodeFeed = Schema.decodeUnknownSync(AppUpdateFeed);
const provisionGrant: HubGrant = {
  items: ["roster", "introduce", "owners", "provision"],
  actProjects: [],
};
const noProvisionGrant: HubGrant = { items: ["roster", "introduce", "owners"], actProjects: [] };
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";

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

async function startPair(
  options: {
    readonly hubExtra?: Partial<Parameters<typeof startHubTestHost>[0]>;
    readonly laptopExtra?: Partial<Parameters<typeof startHubTestHost>[0]>;
    readonly provisionSwitch?: boolean;
    readonly grant?: HubGrant;
  } = {},
) {
  const network = new HubTestNetwork();
  const clock = makeClock();
  const hub = await start(network, clock, "Mac mini", 103, options.hubExtra);
  const laptop = await start(network, clock, "Laptop", 104, options.laptopExtra);
  const enabled = hub.hub.enable(window);
  if (enabled.status !== "enabled") throw new Error(enabled.status);
  await join(hub, laptop);
  if (options.provisionSwitch !== false) {
    expect(hub.provision.setEnabled(true, window)).toEqual({ status: "changed", enabled: true });
  }
  laptop.spoke.setGrant(options.grant ?? provisionGrant, window);
  return { network, clock, hub, laptop };
}

// --- offers, as the hub's window would make them ---

const DIGEST = `sha256:${"a".repeat(64)}`;
const pluginOffer = decodeHubOfferBody({
  kind: "plugin",
  catalogId: "octant",
  entryId: "review-helper",
  expectedDigest: DIGEST,
});
const channelOffer = (channel: "stable" | "preview" | "candidate", mirror = false) =>
  decodeHubOfferBody({ kind: "update-channel", channel, ...(mirror ? { mirror: true } : {}) });
const profileOffer = decodeHubOfferBody({
  kind: "agent-profile",
  displayName: "Reviewer",
  instructions: "Review the change and list the risks.",
  approvedSkillIds: [],
  toolConstraints: [],
  modelConstraints: [],
  defaultExecutionPolicy: "approval-gated",
  defaultPermissionPersistence: "current-session",
  compatibleModes: ["work"],
});
const endpointOffer = decodeHubOfferBody({
  kind: "model-endpoint",
  family: "openai-compatible",
  displayName: "Home gateway",
  baseUrl: "https://gateway.example.test/v1",
  protocol: "auto",
  authentication: "key",
  manualModelIds: ["model-a"],
});
const routineOffer = decodeHubOfferBody({
  kind: "routine",
  displayName: "Morning review",
  taskPrompt: "Summarise yesterday's changes.",
  mode: "work",
  trigger: { kind: "interval", anchorAt: "2026-10-30T07:00:00.000Z", intervalMinutes: 1440 },
});

function make(hub: HubTestHost, offer: HubOfferBody, extra: Record<string, unknown> = {}) {
  return hub.provision.offer(decodeHubOfferRequest({ offer, ...extra }), window);
}

async function offerAndGetId(hub: HubTestHost, offer: HubOfferBody, extra = {}) {
  const made = await make(hub, offer, extra);
  if (made.status !== "offered") throw new Error(JSON.stringify(made));
  return made;
}

const proposals = (host: HubTestHost) => host.spokeProvision.view().proposals;
const changes = (host: HubTestHost, change: string) =>
  host.records.filter((record) => record.change === change);

// --- a signed update feed and the key the spoke trusts for it ---

function feedSigner() {
  const keys = generateKeyPairSync("ed25519");
  const release = {
    version: "1.4.0",
    platform: "darwin",
    arch: "arm64",
    ring: "preview",
    url: "https://updates.example.test/octant-1.4.0.zip",
    sha256: "b".repeat(64),
    releasedAt: "2026-10-29T12:00:00.000Z",
  } as const;
  const signFeed = (body: typeof release, key: KeyObject): AppUpdateFeed => {
    const signed = decodeFeed({ schemaVersion: 1, release: body, signature: "A".repeat(86) + "==" });
    return {
      ...signed,
      signature: sign(null, canonicalReleaseBytes(signed.release), key).toString("base64"),
    };
  };
  const trusts = (publicKey: KeyObject) => (message: Uint8Array, signature: string) => {
    try {
      return verify(null, message, publicKey, Buffer.from(signature, "base64"));
    } catch {
      return false;
    }
  };
  return { keys, release, signFeed, trusts };
}

/** A request to `recipient`'s listener signed with `signer`'s identity key, as the signer's own server would. */
function signedRequest(input: {
  readonly signer: HubTestHost;
  readonly recipient: HubTestHost;
  readonly clock: Clock;
  readonly path: string;
  readonly body: unknown;
  readonly senderId?: string;
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
          senderMemberId: input.senderId ?? input.signer.hostId,
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

describe("an offer from the hub's window", () => {
  it("lands as a proposal on a spoke whose person ticked Provision, and applies nothing yet", async () => {
    const { hub, laptop } = await startPair();

    const made = await offerAndGetId(hub, pluginOffer);

    expect(made.delivered).toBe(1);
    expect(proposals(laptop).map((proposal) => proposal.offer.kind)).toEqual(["plugin"]);
    expect(laptop.provisioned.plugins).toEqual([]);
    expect(hub.provision.status().offers[0]?.deliveries.map((entry) => entry.result)).toEqual([
      "proposed",
    ]);
    expect(
      changes(hub, "provision-offered").map((record) => [
        record.actingPrincipal.kind,
        record.provisionKind,
      ]),
    ).toEqual([["local-window", "plugin"]]);
    expect(
      changes(laptop, "provision-proposed").map((record) => [
        record.actingPrincipal.kind,
        record.provisionKind,
      ]),
    ).toEqual([["hub", "plugin"]]);
  });

  it("is refused while the hub's switch is off, and by a host that is no hub", async () => {
    const { hub, laptop } = await startPair({ provisionSwitch: false });

    expect(await make(hub, pluginOffer)).toEqual({
      status: "refused",
      kind: "provision-service-off",
    });
    expect(await make(laptop, pluginOffer)).toEqual({ status: "refused", kind: "hub-role-off" });
    expect(proposals(laptop)).toEqual([]);
  });

  it("is refused by a spoke whose person did not tick Provision, and the hub learns only that", async () => {
    const { hub, laptop } = await startPair({ grant: noProvisionGrant });

    const made = await offerAndGetId(hub, pluginOffer);

    expect(made.delivered).toBe(0);
    expect(proposals(laptop)).toEqual([]);
    expect(hub.provision.status().offers[0]?.deliveries).toMatchObject([
      { result: "refused", reason: "provision-not-granted" },
    ]);
    expect(changes(laptop, "provision-refused")).toMatchObject([
      { provisionReason: "provision-not-granted" },
    ]);
    expect(changes(hub, "provision-offer-refused")).toHaveLength(1);
  });

  it("is refused when it comes from a peer, a stranger, or a host claiming to be the hub", async () => {
    const { network, clock, hub, laptop } = await startPair();
    const peer = await start(network, clock, "Desktop", 105);
    await join(hub, peer);
    const stranger = await start(network, clock, "Stranger", 106);
    const delivery = { offerId: "55555555-5555-4555-8555-555555555555", offer: pluginOffer };

    const fromPeer = await signedRequest({
      signer: peer,
      recipient: laptop,
      clock,
      path: HUB_LINK_ROUTES.provisionOffer,
      body: delivery,
    });
    const fromStranger = await signedRequest({
      signer: stranger,
      recipient: laptop,
      clock,
      path: HUB_LINK_ROUTES.provisionOffer,
      body: delivery,
    });
    const claimingHub = await signedRequest({
      signer: peer,
      recipient: laptop,
      clock,
      path: HUB_LINK_ROUTES.provisionOffer,
      body: delivery,
      senderId: hub.hostId,
    });

    expect(fromPeer?.status).toBe(401);
    expect(fromStranger?.status).toBe(401);
    expect(claimingHub?.status).toBe(401);
    expect(proposals(laptop)).toEqual([]);
  });

  it("is refused by the hub's mirror route when a stranger or a guest-less host asks for a feed", async () => {
    const { network, clock, hub } = await startPair();
    const stranger = await start(network, clock, "Stranger", 106);

    const asked = await signedRequest({
      signer: stranger,
      recipient: hub,
      clock,
      path: HUB_LINK_ROUTES.provisionMirror,
      body: { offerId: "55555555-5555-4555-8555-555555555555" },
    });

    expect(asked?.status).toBe(401);
  });

  it("is refused on arrival when it carries a field a secret could ride in", async () => {
    const { clock, hub, laptop } = await startPair();
    const bodies = [
      { ...endpointOffer, apiKey: "not-a-real-key" },
      { ...endpointOffer, baseUrl: "https://user:pass@gateway.example.test/v1" },
      { ...endpointOffer, baseUrl: "https://gateway.example.test/v1?key=abc" },
      { ...profileOffer, instructions: "Use sk-abcdefghijklmnopqrstuvwxyz0123 to call it." },
      { ...profileOffer, headers: { authorization: "Bearer abcdefghijklmnopqrstuv" } },
    ];

    for (const offer of bodies) {
      const response = await signedRequest({
        signer: hub,
        recipient: laptop,
        clock,
        path: HUB_LINK_ROUTES.provisionOffer,
        body: { offerId: "55555555-5555-4555-8555-555555555555", offer },
      });
      expect(response?.status).toBe(400);
    }
    expect(proposals(laptop)).toEqual([]);
    expect(() => decodeHubOfferRequest({ offer: bodies[0] })).toThrow();
  });

  it("is refused when the kind is one this spoke cannot apply, and when it asks for more than a person could", async () => {
    const { hub, laptop } = await startPair();
    const full = decodeHubOfferBody({
      ...profileOffer,
      defaultExecutionPolicy: "full-access",
    });
    const remembered = decodeHubOfferBody({
      ...profileOffer,
      defaultPermissionPersistence: "project-default",
    });

    await make(hub, full);
    await make(hub, remembered);
    // The candidate ring is a test stream no offer moves a spoke onto.
    await make(hub, channelOffer("candidate"));

    expect(proposals(laptop)).toEqual([]);
    expect(
      hub.provision
        .status()
        .offers.flatMap((offer) => offer.deliveries.map((delivery) => delivery.reason)),
    ).toEqual(["widens-authority", "widens-authority", "channel-not-allowed"]);
  });

  it("can be withdrawn by the hub's window, which also stops serving its mirror", async () => {
    const signer = feedSigner();
    const { hub, laptop } = await startPair({
      laptopExtra: { updateFeedVerifier: signer.trusts(signer.keys.publicKey) },
    });
    const feed = signer.signFeed(signer.release, signer.keys.privateKey);
    const made = await offerAndGetId(hub, channelOffer("preview", true), { mirrorFeed: feed });

    expect(hub.provision.withdraw(made.offerId, window)).toEqual({ status: "withdrawn" });
    const applied = await laptop.spokeProvision.apply(made.offerId, window);

    expect(applied).toEqual({ status: "refused", kind: "mirror-unreachable" });
    expect(laptop.provisioned.channel).toBeUndefined();
  });
});

describe("applying a proposal in the spoke's own window", () => {
  it("installs a plugin untrusted and disabled, journaled with the window as the principal", async () => {
    const { hub, laptop } = await startPair();
    const { offerId } = await offerAndGetId(hub, pluginOffer);

    expect(await laptop.spokeProvision.apply(offerId, window)).toEqual({ status: "applied" });

    expect(laptop.provisioned.plugins).toEqual([
      { entryId: "review-helper", trusted: false, enabled: false },
    ]);
    expect(proposals(laptop)).toEqual([]);
    expect(
      changes(laptop, "provision-applied").map((record) => [
        record.actingPrincipal.kind,
        record.provisionMode,
        record.provisionKind,
      ]),
    ).toEqual([["local-window", "manual", "plugin"]]);
  });

  it("adds a profile and an endpoint row with no secret, the row switched off", async () => {
    const { hub, laptop } = await startPair();
    const profile = await offerAndGetId(hub, profileOffer);
    const endpoint = await offerAndGetId(hub, endpointOffer);

    await laptop.spokeProvision.apply(profile.offerId, window);
    await laptop.spokeProvision.apply(endpoint.offerId, window);

    expect(laptop.provisioned.profiles).toEqual([{ displayName: "Reviewer" }]);
    expect(laptop.provisioned.endpoints).toEqual([{ displayName: "Home gateway", enabled: false }]);
    expect(JSON.stringify(laptop.state.load())).not.toMatch(/api-?key|secret|authorization/i);
  });

  it("keeps the proposal and journals the refusal when the service it asked fails", async () => {
    const { hub, laptop } = await startPair();
    const { offerId } = await offerAndGetId(hub, pluginOffer);
    laptop.provisioned.fail = true;

    expect(await laptop.spokeProvision.apply(offerId, window)).toEqual({
      status: "refused",
      kind: "apply-failed",
    });

    expect(proposals(laptop)).toHaveLength(1);
    expect(changes(laptop, "provision-refused").at(-1)).toMatchObject({
      provisionReason: "apply-failed",
      provisionMode: "manual",
    });
  });

  it("dismisses a proposal without applying it, and journals who dismissed it", async () => {
    const { hub, laptop } = await startPair();
    const { offerId } = await offerAndGetId(hub, pluginOffer);

    expect(laptop.spokeProvision.dismiss(offerId, window)).toEqual({ status: "dismissed" });

    expect(proposals(laptop)).toEqual([]);
    expect(laptop.provisioned.plugins).toEqual([]);
    expect(changes(laptop, "provision-dismissed")).toMatchObject([
      { actingPrincipal: { kind: "local-window" }, provisionKind: "plugin" },
    ]);
    expect(laptop.spokeProvision.dismiss(offerId, window)).toEqual({
      status: "refused",
      kind: "unknown-offer",
    });
  });

  it("moves to a channel the spoke already allows and refuses one it does not", async () => {
    const { hub, laptop } = await startPair();
    const preview = await offerAndGetId(hub, channelOffer("preview"));

    await laptop.spokeProvision.apply(preview.offerId, window);

    expect(laptop.provisioned.channel).toBe("preview");
    const candidate = await make(hub, channelOffer("candidate"));
    expect(candidate).toMatchObject({ status: "offered", delivered: 0 });
    expect(laptop.provisioned.channel).toBe("preview");
  });
});

describe("a routine offer", () => {
  it("always waits for the person even with applying on arrival on for everything else, and is authored by the spoke's own principal", async () => {
    const { hub, laptop } = await startPair();
    for (const kind of ["update-channel", "plugin", "agent-profile"] as const) {
      expect(laptop.spokeProvision.setAutoApply(kind, true)).toEqual({ status: "changed" });
    }
    // A routine is not a kind that can be switched on to apply unasked.
    expect(() => decodeHubOfferRequest({ offer: routineOffer, memberIds: [] })).not.toThrow();

    const { offerId } = await offerAndGetId(hub, routineOffer);

    expect(laptop.provisioned.routines).toEqual([]);
    expect(proposals(laptop)).toHaveLength(1);
    // The person binds it to a Project of their own; without one it stays a proposal.
    expect(await laptop.spokeProvision.apply(offerId, window)).toEqual({
      status: "refused",
      kind: "needs-person",
    });
    expect(
      await laptop.spokeProvision.apply(
        offerId,
        window,
        decodeHubProposalDecisionRequest({ offerId, projectId: PROJECT_ID }).projectId,
      ),
    ).toEqual({ status: "applied" });

    expect(laptop.provisioned.routines).toEqual([
      { displayName: "Morning review", projectId: PROJECT_ID, authoredBy: "local-window" },
    ]);
    expect(changes(laptop, "provision-applied")).toMatchObject([
      { actingPrincipal: { kind: "local-window" }, provisionMode: "manual" },
    ]);
  });

  it("and an endpoint row wait for the person too", async () => {
    const { hub, laptop } = await startPair();
    for (const kind of ["update-channel", "plugin", "agent-profile"] as const) {
      laptop.spokeProvision.setAutoApply(kind, true);
    }

    await offerAndGetId(hub, endpointOffer);

    expect(laptop.provisioned.endpoints).toEqual([]);
    expect(proposals(laptop)).toHaveLength(1);
  });
});

describe("applying a kind on arrival", () => {
  const cases: ReadonlyArray<readonly [string, "update-channel" | "plugin" | "agent-profile", HubOfferBody]> =
    [
      ["an update channel", "update-channel", channelOffer("preview")],
      ["an untrusted plugin install", "plugin", pluginOffer],
      ["a profile without secrets", "agent-profile", profileOffer],
    ];

  it.each(cases)(
    "does exactly what Apply does for %s, and nothing more",
    async (_label, kind, offer) => {
      const { network, clock, hub, laptop: automatic } = await startPair();
      const second = await start(network, clock, "Desktop", 105);
      await join(hub, second);
      second.spoke.setGrant(provisionGrant, window);
      automatic.spokeProvision.setAutoApply(kind, true);

      // One offer to both spokes: one applies it on arrival, the other when its person does.
      await offerAndGetId(hub, offer);
      const held = second.spokeProvision.view().proposals[0];
      if (held === undefined) throw new Error("The second spoke holds no proposal.");
      await second.spokeProvision.apply(held.offerId, window);

      expect(automatic.provisioned).toEqual(second.provisioned);
      expect(proposals(automatic)).toEqual([]);
      expect(
        changes(automatic, "provision-applied").map((record) => [
          record.actingPrincipal.kind,
          record.provisionMode,
        ]),
      ).toEqual([["local-window", "auto"]]);
      expect(
        changes(second, "provision-applied").map((record) => [
          record.actingPrincipal.kind,
          record.provisionMode,
        ]),
      ).toEqual([["local-window", "manual"]]);
    },
  );

  it("stays a proposal when the service it asked fails", async () => {
    const { hub, laptop } = await startPair();
    laptop.spokeProvision.setAutoApply("plugin", true);
    laptop.provisioned.fail = true;

    await offerAndGetId(hub, pluginOffer);

    expect(proposals(laptop)).toHaveLength(1);
    expect(changes(laptop, "provision-refused").at(-1)).toMatchObject({
      provisionReason: "apply-failed",
      provisionMode: "auto",
    });
  });

  it("is off for every kind until the person turns it on", async () => {
    const { hub, laptop } = await startPair();

    expect(laptop.spokeProvision.view().autoApply).toEqual([]);
    await offerAndGetId(hub, pluginOffer);

    expect(laptop.provisioned.plugins).toEqual([]);
    expect(proposals(laptop)).toHaveLength(1);
  });
});

describe("the mirrored update feed", () => {
  it("is served as plain bytes whose own signature the spoke still verifies", async () => {
    const signer = feedSigner();
    const { hub, laptop } = await startPair({
      laptopExtra: { updateFeedVerifier: signer.trusts(signer.keys.publicKey) },
    });
    const feed = signer.signFeed(signer.release, signer.keys.privateKey);
    const { offerId } = await offerAndGetId(hub, channelOffer("preview", true), {
      mirrorFeed: feed,
    });

    expect(await laptop.spokeProvision.apply(offerId, window)).toEqual({ status: "applied" });

    expect(laptop.provisioned.channel).toBe("preview");
    expect(laptop.state.load().link?.provision?.verifiedFeed).toEqual(feed);
    expect(laptop.requests.length).toBeGreaterThan(0);
    expect(hub.requests).toContain(`POST ${HUB_LINK_ROUTES.provisionMirror}`);
  });

  it("is refused when the hub altered the bytes it serves", async () => {
    const signer = feedSigner();
    const { hub, laptop } = await startPair({
      laptopExtra: { updateFeedVerifier: signer.trusts(signer.keys.publicKey) },
    });
    const feed = signer.signFeed(signer.release, signer.keys.privateKey);
    const { offerId } = await offerAndGetId(hub, channelOffer("preview", true), {
      mirrorFeed: feed,
    });
    // The hub holds a feed whose release no longer matches its signature.
    const state = hub.state.load();
    const record = state.hub?.provision?.offers[0];
    if (state.hub?.provision === undefined || record?.mirrorFeed === undefined) {
      throw new Error("The hub holds no mirror.");
    }
    hub.state.save({
      ...state,
      hub: {
        ...state.hub,
        provision: {
          ...state.hub.provision,
          offers: [
            {
              ...record,
              mirrorFeed: {
                ...record.mirrorFeed,
                release: { ...record.mirrorFeed.release, sha256: "c".repeat(64) },
              },
            },
          ],
        },
      },
    });

    expect(await laptop.spokeProvision.apply(offerId, window)).toEqual({
      status: "refused",
      kind: "mirror-untrusted",
    });

    expect(laptop.provisioned.channel).toBeUndefined();
    expect(proposals(laptop)).toHaveLength(1);
  });

  it("is refused when the hub signed it itself with a key the spoke does not trust", async () => {
    const trusted = feedSigner();
    const hubsOwn = feedSigner();
    const { hub, laptop } = await startPair({
      laptopExtra: { updateFeedVerifier: trusted.trusts(trusted.keys.publicKey) },
    });
    const feed = hubsOwn.signFeed(hubsOwn.release, hubsOwn.keys.privateKey);
    const { offerId } = await offerAndGetId(hub, channelOffer("preview", true), {
      mirrorFeed: feed,
    });

    expect(await laptop.spokeProvision.apply(offerId, window)).toEqual({
      status: "refused",
      kind: "mirror-untrusted",
    });
    expect(laptop.provisioned.channel).toBeUndefined();
  });

  it("is refused on arrival by a spoke that holds no release key to check it with", async () => {
    const signer = feedSigner();
    const { hub, laptop } = await startPair();
    const feed = signer.signFeed(signer.release, signer.keys.privateKey);

    const made = await offerAndGetId(hub, channelOffer("preview", true), { mirrorFeed: feed });

    expect(made.delivered).toBe(0);
    expect(hub.provision.status().offers[0]?.deliveries).toMatchObject([
      { result: "refused", reason: "mirror-unverifiable" },
    ]);
    expect(proposals(laptop)).toEqual([]);
  });

  it("is not accepted for an offer that does not say it has a mirror, or for another channel", async () => {
    const signer = feedSigner();
    const { hub } = await startPair();
    const feed = signer.signFeed(signer.release, signer.keys.privateKey);

    expect(await make(hub, channelOffer("preview"), { mirrorFeed: feed })).toEqual({
      status: "refused",
      kind: "malformed",
    });
    expect(await make(hub, channelOffer("stable", true), { mirrorFeed: feed })).toEqual({
      status: "refused",
      kind: "malformed",
    });
  });
});

describe("how long and how many proposals a spoke holds", () => {
  it("lets a proposal lapse after its lifetime and journals that it did", async () => {
    const { clock, hub, laptop } = await startPair({ laptopExtra: { proposalLifetimeMs: 60_000 } });
    const { offerId } = await offerAndGetId(hub, pluginOffer);
    expect(proposals(laptop)).toHaveLength(1);

    clock.state.offset += 120_000;

    expect(proposals(laptop)).toEqual([]);
    expect(await laptop.spokeProvision.apply(offerId, window)).toEqual({
      status: "refused",
      kind: "unknown-offer",
    });
    expect(changes(laptop, "provision-dismissed")).toMatchObject([
      { provisionReason: "expired", provisionKind: "plugin" },
    ]);
  });

  it("refuses an offer past the most it holds", async () => {
    const { hub, laptop } = await startPair({ laptopExtra: { maxProposals: 2 } });

    await make(hub, pluginOffer);
    await make(hub, profileOffer);
    await make(hub, endpointOffer);

    expect(proposals(laptop)).toHaveLength(2);
    expect(hub.provision.status().offers.at(-1)?.deliveries).toMatchObject([
      { result: "refused", reason: "proposals-full" },
    ]);
  });

  it("drops what it holds once the person unticks Provision", async () => {
    const { hub, laptop } = await startPair();
    await make(hub, pluginOffer);
    expect(proposals(laptop)).toHaveLength(1);

    laptop.spoke.setGrant(noProvisionGrant, window);

    expect(proposals(laptop)).toEqual([]);
    const gone = await make(hub, profileOffer);
    expect(gone).toMatchObject({ status: "offered", delivered: 0 });
  });
});
