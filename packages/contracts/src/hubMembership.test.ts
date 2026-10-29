import { describe, expect, it } from "vitest";
import {
  decodeHubJoinRequest,
  decodeHubLeaveRequest,
  decodeHubMembershipChangedPayload,
  decodeHubPromoteRequest,
  decodeHubStandbyOrderRequest,
  decodeHubStandInHandback,
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

  it("decodes the failover requests and refuses a repeated standby, an unconfirmed promotion, and malformed wake times", () => {
    expect(decodeHubStandbyOrderRequest({ memberIds: [id] }).memberIds).toEqual([id]);
    expect(decodeHubStandbyOrderRequest({ memberIds: [] }).memberIds).toEqual([]);
    expect(() => decodeHubStandbyOrderRequest({ memberIds: [id, id] })).toThrow();
    expect(() => decodeHubStandbyOrderRequest({ memberIds: [id], extra: true })).toThrow();

    expect(decodeHubPromoteRequest({ confirmed: true })).toEqual({ confirmed: true });
    expect(() => decodeHubPromoteRequest({ confirmed: false })).toThrow();
    expect(() => decodeHubPromoteRequest({})).toThrow();

    const handback = { baseSequence: 3, sequence: 5, added: [], removed: [id], wakeTimes: [] };
    expect(decodeHubStandInHandback(handback).removed).toEqual([id]);
    expect(() => decodeHubStandInHandback({ ...handback, wakeTimes: [{}] })).toThrow();
    const carried = {
      memberId: id,
      times: [{ routineId: "r".repeat(22), nextAt: "2026-10-29T08:00:00.000Z" }],
    };
    expect(decodeHubStandInHandback({ ...handback, wakeTimes: [carried] }).wakeTimes).toEqual([
      carried,
    ]);
    expect(() =>
      decodeHubStandInHandback({
        ...handback,
        wakeTimes: [{ ...carried, times: [...carried.times, ...carried.times] }],
      }),
    ).toThrow();
    expect(() => decodeHubStandInHandback({ ...handback, sequence: 0 })).toThrow();

    expect(
      decodeHubMembershipChangedPayload({
        change: "standby-order-changed",
        actingPrincipal: { kind: "local-window" },
        memberIds: [id],
        sequence: 4,
      }).memberIds,
    ).toEqual([id]);
  });
});
