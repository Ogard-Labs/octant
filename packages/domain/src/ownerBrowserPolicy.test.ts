import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { HubMemberId } from "@octant/contracts";
import { decodeOwnerBrowserTarget } from "@octant/contracts/owner-browser";
import { decideOwnerBrowserTakeOver, decideOwnerBrowserUse } from "./ownerBrowserPolicy";

const member = Schema.decodeUnknownSync(HubMemberId)("a7880000-0000-4000-8000-000000000001");
const target = decodeOwnerBrowserTarget({
  hostMemberId: member,
  threadId: "a7880000-0000-4000-8000-000000000002",
  contextId: "a7880000-0000-4000-8000-000000000003",
  targetVersion: "a".repeat(64),
  documentRevision: 1,
  origin: "https://fixture.invalid",
  profile: "private",
});
const admission = {
  principal: { kind: "owner-unlock" as const, memberId: member },
  ownerCurrent: true,
  resourceCurrent: true,
  privateHeld: false,
  controllerBusy: false,
  freshOwnUnlock: true,
};

describe("owner Browser control policy", () => {
  it("requires current own-class presence and refuses guests, stale ownership or private custody", () => {
    expect(decideOwnerBrowserTakeOver(admission)).toEqual({ status: "allowed" });
    for (const change of [
      { freshOwnUnlock: false },
      { ownerCurrent: false },
      { resourceCurrent: false },
      { privateHeld: true },
      { controllerBusy: true },
    ])
      expect(decideOwnerBrowserTakeOver({ ...admission, ...change }).status).toBe("refused");
    expect(
      decideOwnerBrowserTakeOver({ ...admission, principal: { kind: "local-window" } }).status,
    ).toBe("refused");
  });

  it("refuses expired controls even when the expiry callback is delayed, and binds the exact one-use frame sequence", () => {
    const use = {
      principal: admission.principal,
      ownerMemberId: member,
      ownerCurrent: true,
      resourceCurrent: true,
      privateHeld: false,
      now: 100,
      expiresAt: 200,
      target,
      currentTarget: target,
      sequence: 2,
      expectedSequence: 2,
      expectedFrame: 3,
      currentFrame: 3,
    };
    expect(decideOwnerBrowserUse(use)).toEqual({ status: "allowed" });
    for (const change of [
      { now: 200 },
      { sequence: 1 },
      { expectedFrame: 2 },
      { privateHeld: true },
      { ownerCurrent: false },
      { currentTarget: { ...target, documentRevision: 2 } },
    ])
      expect(decideOwnerBrowserUse({ ...use, ...change }).status).toBe("refused");
  });
});
