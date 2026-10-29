import { describe, expect, it } from "vitest";
import {
  decodeHubJoinRequest,
  decodeHubLeaveRequest,
  decodeHubMembershipChangedPayload,
} from "./hubMembership";

const id = "11111111-1111-4111-8111-111111111111";
const digest = "a".repeat(64);

describe("hub membership wire contracts", () => {
  it("decodes a join request and refuses a role or owner mark the member claims for itself", () => {
    const request = {
      ticketId: id,
      ticketProof: "proof",
      member: {
        memberId: id,
        name: "Laptop",
        identityKeyFingerprint: digest,
        listenerPin: digest,
        privateNames: [],
        addresses: ["100.64.0.2"],
      },
      identityPublicKey: "a2V5",
      listenerOrigin: "https://100.64.0.2:8443",
    };

    expect(decodeHubJoinRequest(request).member.name).toBe("Laptop");
    expect(() =>
      decodeHubJoinRequest({ ...request, member: { ...request.member, owner: true } }),
    ).toThrow();
    expect(() =>
      decodeHubJoinRequest({ ...request, member: { ...request.member, role: "hub" } }),
    ).toThrow();
  });

  it("decodes a leave request and refuses a field it does not take", () => {
    expect(decodeHubLeaveRequest({ memberId: id }).memberId).toBe(id);
    expect(() => decodeHubLeaveRequest({ memberId: id, force: true })).toThrow();
  });

  it("journals a change with the principal that petitioned and refuses an unknown change", () => {
    expect(
      decodeHubMembershipChangedPayload({
        change: "member-removed",
        actingPrincipal: { kind: "local-window" },
        memberId: id,
        sequence: 3,
      }).change,
    ).toBe("member-removed");
    expect(() =>
      decodeHubMembershipChangedPayload({
        change: "granted-root",
        actingPrincipal: { kind: "local-window" },
      }),
    ).toThrow();
    expect(() => decodeHubMembershipChangedPayload({ change: "member-removed" })).toThrow();
  });
});
