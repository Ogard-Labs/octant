import type { HubMembershipChangedPayload } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import type { HubLinkState, HubState, HubStatePort } from "./hubStateStore";
import { servesPublicEntrance, setServeWhileStandingIn } from "./publicStandIn";

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
