import { describe, expect, it } from "vitest";
import type { HubMemberId, PeerGrant, RosterMember } from "@octant/contracts";
import { createThreadMoveSenders } from "./threadMoveSenders";

const id = (n: number) =>
  `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
const laptopId = id(3) as HubMemberId;
const selfId = id(2) as HubMemberId;
const key = (n: number) => String(n).repeat(64).slice(0, 64);

const laptop: RosterMember = {
  memberId: laptopId,
  name: "Laptop",
  role: "spoke",
  identityKeyFingerprint: key(3),
  listenerPin: key(3),
  privateNames: [],
  addresses: ["100.64.0.3"],
  owner: true,
};
const grant: PeerGrant = { memberId: laptopId, readStatus: true, moveIn: true };
const owners = { owners: [{ memberId: laptopId }], inactiveDeviceMemberIds: [] };

// A spoke that turned its hub role on keeps its link, so the spoke side still
// recognizes the laptop and the Move in item it was granted.
const spoke: Parameters<typeof createThreadMoveSenders>[0]["spoke"] = {
  authenticatePeer: () => ({
    status: "peer",
    principal: { kind: "peer", memberId: laptopId },
    peer: { member: laptop, grant },
    selfMemberId: selfId,
  }),
  memberTarget: () => ({ status: "member", self: selfId, member: laptop }),
  ownerContext: () => owners,
};

const hubWith = (enabled: boolean): Parameters<typeof createThreadMoveSenders>[0]["hub"] => ({
  // A hub role with no signed roster yet knows no member to verify a request against.
  status: () => ({ enabled }),
  memberKey: () => undefined,
  hubMemberId: () => String(selfId),
  acceptsMovedThreads: () => false,
  ownerContext: () => undefined,
});

const request = { header: "v1.x", publicKey: null, method: "POST", path: "/", body: "" };

describe("thread move senders", () => {
  it("lets a spoke's peer grant decide a move in while its hub role is off", () => {
    const senders = createThreadMoveSenders({ spoke, hub: hubWith(false), now: Date.now });
    expect(senders.authenticate(request)).toEqual({
      status: "member",
      memberId: String(laptopId),
      moveIn: true,
    });
    expect(senders.target(String(laptopId)).status).toBe("member");
    expect(senders.ownerIsCurrent(String(laptopId))).toBe(true);
  });

  it("answers only as the hub once its hub role is on, so an old spoke grant cannot move a thread in", () => {
    const senders = createThreadMoveSenders({ spoke, hub: hubWith(true), now: Date.now });
    expect(senders.authenticate(request)).toEqual({ status: "refused" });
    expect(senders.target(String(laptopId))).toEqual({ status: "refused", kind: "not-in-roster" });
    expect(senders.ownerIsCurrent(String(laptopId))).toBe(false);
  });
});
