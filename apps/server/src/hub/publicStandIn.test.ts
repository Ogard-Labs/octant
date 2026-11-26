import type { HubMembershipChangedPayload } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import type { HubLinkState, HubState, HubStatePort } from "./hubStateStore";
import {
  handBackPublicQueue,
  servesPublicEntrance,
  setServeWhileStandingIn,
} from "./publicStandIn";

const WINDOW = { kind: "local-window" } as const;

/** Only the fields the rule reads; the rest of a link does not matter to it. */
function standby(
  standIn: { readonly handingBack?: boolean } | undefined,
  serve: boolean,
): HubState {
  const link = {
    removed: false,
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
  } as unknown;
  return {
    link: link as HubLinkState,
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
  const delivery = (id: string) =>
    ({
      spokeMemberId: "33333333-3333-4333-8333-333333333333",
      keys: [`id:${id}`],
      bytes: 2,
      envelope: {
        endpointId: "AAAAAAAAAAAAAAAAAAAAAA",
        deliveryId: id,
        receivedAt: 1,
        headers: {},
        body: "e30=",
      },
    }) as never;

  function attempt(answers: ReadonlyArray<() => Response>) {
    let queue: ReadonlyArray<{ readonly envelope: { readonly deliveryId: string } }> = [
      delivery("one"),
      delivery("two"),
    ];
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
});
