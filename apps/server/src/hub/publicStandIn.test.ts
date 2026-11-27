import type { HubMembershipChangedPayload } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  HubLinkState,
  type HubSideState,
  type HubState,
  type HubStatePort,
} from "./hubStateStore";
import {
  handBackPublicQueue,
  holdsPublicCopies,
  servesOwnPublicEndpoints,
  servesPublicEntrance,
  servingRosterMemberIds,
  setServeWhileStandingIn,
  standbyPublicUrls,
} from "./publicStandIn";

const WINDOW = { kind: "local-window" } as const;

const HUB = "11111111-1111-4111-8111-111111111111";

/** A complete link, decoded like a stored one, from this standby to its hub. */
function linkOf(fields: Record<string, unknown> = {}): HubLinkState {
  return Schema.decodeUnknownSync(HubLinkState)({
    selfMemberId: "22222222-2222-4222-8222-222222222222",
    hubMemberId: HUB,
    hubName: "Hub",
    hubOrigin: "https://100.101.102.103:8443",
    hubListenerPin: "a".repeat(64),
    hubIdentityPublicKey: "hub-key",
    rosterSigningPublicKey: "roster-key",
    grant: { items: [], actProjects: [] },
    roster: {
      roster: { sequence: 1, members: [], standbyOrder: [], failoverAfterSeconds: 60 },
      signedBy: { kind: "hub", memberId: HUB },
      signature: "signature",
    },
    peerGrants: [],
    ...fields,
  });
}

/** This host's own hub role, switched on with no members yet. */
const OWN_HUB: HubSideState = { enabled: true, members: [], joinTickets: [] };
const PUBLIC_GRANT = { grant: { items: ["public"], actProjects: [] } };

function standby(
  standIn: { readonly handingBack?: true } | undefined,
  serve: boolean,
  fields: Record<string, unknown> = {},
): HubState {
  return {
    link: linkOf({
      ...(standIn === undefined
        ? {}
        : {
            standIn: {
              startedAt: 1,
              baseSequence: 1,
              added: [],
              removed: [],
              joinTickets: [],
              ...standIn,
            },
          }),
      ...fields,
    }),
    publicEntrance: { enabled: true, ...(serve ? { serveWhileStandingIn: true } : {}) },
  };
}

describe("who serves the public entrance", () => {
  it("the hub serves it whenever its role is on", () => {
    expect(servesPublicEntrance({ hubEnabled: true, state: {} })).toBe(true);
  });

  it("a standby without its own Serve choice never serves it, even while it stands in", () => {
    expect(servesPublicEntrance({ hubEnabled: false, state: standby({}, false) })).toBe(false);
  });

  it("a standby serves it only while it stands in, and stops while it hands back", () => {
    expect(servesPublicEntrance({ hubEnabled: false, state: standby(undefined, true) })).toBe(
      false,
    );
    expect(servesPublicEntrance({ hubEnabled: false, state: standby({}, true) })).toBe(true);
    expect(
      servesPublicEntrance({ hubEnabled: false, state: standby({ handingBack: true }, true) }),
    ).toBe(false);
  });

  it("a standby that turned its own hub role on still takes deliveries for its own endpoints while its Public grant stands", () => {
    expect(servesOwnPublicEndpoints({ ...standby({}, true), hub: OWN_HUB })).toBe(false);
    expect(servesOwnPublicEndpoints({ ...standby({}, true, PUBLIC_GRANT), hub: OWN_HUB })).toBe(
      true,
    );
  });

  it("a host promoted to hub, which no longer has a hub of its own, refuses deliveries for the endpoints it owned as a spoke", () => {
    expect(servesOwnPublicEndpoints({ hub: OWN_HUB })).toBe(false);
    const removed = standby({}, true, { ...PUBLIC_GRANT, removed: true });
    expect(servesOwnPublicEndpoints(removed)).toBe(false);
  });

  it("refuses the choice on a host the hub has not named a standby, and journals a change", () => {
    let state: HubState = {};
    const port: HubStatePort = { load: () => state, save: (next) => void (state = next) };
    const records: HubMembershipChangedPayload[] = [];
    const record = (change: HubMembershipChangedPayload) => records.push(change);
    expect(
      setServeWhileStandingIn({ state: port, enabled: true, principal: WINDOW, record }),
    ).toEqual({ status: "refused", kind: "not-a-named-standby" });
    expect(
      setServeWhileStandingIn({ state: port, enabled: false, principal: WINDOW, record }),
    ).toEqual({ status: "changed", enabled: false });
    expect(records.map((change) => change.change)).toEqual(["public-standby-serve-changed"]);
  });
});

describe("handing the webhook queue back to the hub", () => {
  const delivery = (id: string, endpointId = "AAAAAAAAAAAAAAAAAAAAAA") =>
    ({
      spokeMemberId: "33333333-3333-4333-8333-333333333333",
      keys: [`id:${id}`],
      bytes: 2,
      envelope: {
        endpointId,
        deliveryId: id,
        receivedAt: 1,
        headers: {},
        body: "e30=",
      },
    }) as never;

  function attempt(
    answers: ReadonlyArray<() => Response>,
    initial: ReadonlyArray<{ readonly envelope: { readonly deliveryId: string } }> = [
      delivery("one"),
      delivery("two"),
    ],
  ) {
    let queue = initial;
    const dropped: string[] = [];
    const webhooks = {
      handbackQueue: () => queue as never,
      handedBack: (
        taken: ReadonlyArray<{ readonly envelope: { readonly deliveryId: string } }>,
      ) => {
        const ids = new Set(taken.map((entry) => entry.envelope.deliveryId));
        queue = queue.filter((entry) => !ids.has(entry.envelope.deliveryId));
      },
      dropHandback: (
        gone: ReadonlyArray<{ readonly envelope: { readonly deliveryId: string } }>,
      ) => {
        const ids = new Set(gone.map((entry) => entry.envelope.deliveryId));
        dropped.push(...ids);
        queue = queue.filter((entry) => !ids.has(entry.envelope.deliveryId));
      },
    };
    let index = 0;
    const run = () =>
      handBackPublicQueue({
        webhooks: webhooks as never,
        link: {
          hubOrigin: "https://100.101.102.103:8443",
          hubListenerPin: "a".repeat(64),
          selfMemberId: "22222222-2222-4222-8222-222222222222",
          hubMemberId: "11111111-1111-4111-8111-111111111111",
        } as never,
        identity: { signing: { signHostPayload: () => "sig", hostPublicKey: "key" } } as never,
        transport: () => async () => {
          const answer = answers[Math.min(index, answers.length - 1)];
          index += 1;
          if (answer === undefined) throw new Error("no answer scripted");
          return answer();
        },
        now: () => 1,
      });
    return { run, queue: () => queue, dropped };
  }

  it("keeps a delivery the hub refuses as queue-full, and does not step down yet", async () => {
    const handback = attempt([
      () => Response.json({ status: "queued" }),
      () => Response.json({ status: "queue-full" }),
    ]);
    expect(await handback.run()).toBe(false);
    expect(handback.queue().map((entry) => entry.envelope.deliveryId)).toEqual(["two"]);
    expect(handback.dropped).toEqual([]);
  });

  it("a standby the hub no longer names steps down, dropping what is left on the record", async () => {
    const handback = attempt([
      () => Response.json({ status: "refused", kind: "not-a-named-standby" }, { status: 403 }),
    ]);
    expect(await handback.run()).toBe(true);
    expect(handback.queue()).toEqual([]);
    expect(handback.dropped).toEqual(["one", "two"]);
  });

  it("drops a delivery whose endpoint the hub no longer holds, and hands back the rest", async () => {
    const handback = attempt([
      () => Response.json({ status: "unknown-endpoint" }),
      () => Response.json({ status: "duplicate" }),
    ]);
    expect(await handback.run()).toBe(true);
    expect(handback.queue()).toEqual([]);
    expect(handback.dropped).toEqual(["one"]);
  });

  it("a full endpoint waits for the next attempt while another endpoint's deliveries go back now", async () => {
    const handback = attempt(
      [() => Response.json({ status: "queue-full" }), () => Response.json({ status: "queued" })],
      [delivery("full-1"), delivery("full-2"), delivery("other", "BBBBBBBBBBBBBBBBBBBBBB")],
    );
    expect(await handback.run()).toBe(false);
    expect(handback.queue().map((entry) => entry.envelope.deliveryId)).toEqual([
      "full-1",
      "full-2",
    ]);
  });

  it("a hub from before hand-back answers 404, and the stand-in ends with the rest on the record", async () => {
    const handback = attempt([() => new Response("", { status: 404 })]);
    expect(await handback.run()).toBe(true);
    expect(handback.dropped).toEqual(["one", "two"]);
  });

  it("drops a delivery the hub's own copy of the secret does not verify", async () => {
    const handback = attempt([
      () => Response.json({ status: "refused" }),
      () => Response.json({ status: "queued" }),
    ]);
    expect(await handback.run()).toBe(true);
    expect(handback.dropped).toEqual(["one"]);
  });
});

describe("where a standby can be reached and what it keeps", () => {
  const STANDBY = "22222222-2222-4222-8222-222222222222";
  const anchored = (self: string) =>
    ({
      selfMemberId: self,
      removed: false,
      roster: {
        signedBy: { kind: "hub" },
        roster: {
          standbyOrder: [STANDBY],
          members: [
            {
              memberId: STANDBY,
              role: "standby-hub",
              name: "Studio",
              privateNames: ["studio.tail1234.ts.net"],
            },
          ],
        },
      },
    }) as never;

  it("gives this standby's own fallback URL its Funnel port, and says another's port is a guess", () => {
    expect(standbyPublicUrls(anchored(STANDBY), 10000)).toMatchObject([
      { url: "https://studio.tail1234.ts.net:10000", portKnown: true },
    ]);
    expect(
      standbyPublicUrls(anchored("33333333-3333-4333-8333-333333333333"), 10000),
    ).toMatchObject([{ url: "https://studio.tail1234.ts.net", portKnown: false }]);
  });

  it("a member that is neither the hub nor a named standby keeps no public copies", () => {
    expect(holdsPublicCopies({ hubEnabled: true, state: {} })).toBe(true);
    expect(holdsPublicCopies({ hubEnabled: false, state: {} })).toBe(true);
    expect(
      holdsPublicCopies({
        hubEnabled: false,
        state: { link: anchored("33333333-3333-4333-8333-333333333333") },
      }),
    ).toBe(false);
  });

  it("a standing-in host that was once a hub prunes by the roster it now serves from", () => {
    const state = {
      hub: { enabled: false, roster: { roster: { members: [{ memberId: "old-spoke" }] } } },
      link: { roster: { roster: { members: [{ memberId: STANDBY }, { memberId: "new-spoke" }] } } },
    } as never;
    expect(servingRosterMemberIds(state)).toEqual([STANDBY, "new-spoke"]);
  });
});
