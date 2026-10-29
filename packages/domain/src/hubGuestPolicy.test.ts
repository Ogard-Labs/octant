import { describe, expect, it } from "vitest";
import {
  NO_LISTENER_PIN,
  type HubMemberId,
  type HubRoster,
  type PeerGrant,
  type RosterMember,
} from "@octant/contracts";
import {
  TAILSCALE_CERTIFICATE_RENEW_BEFORE_MS,
  introduceGuests,
  tailscaleCertificateRenewal,
} from "./index";

const id = (suffix: string) => `00000000-0000-4000-8000-${suffix.padStart(12, "0")}` as HubMemberId;
const digest = "a".repeat(64);

const member = (suffix: string, role: RosterMember["role"]): RosterMember => ({
  memberId: id(suffix),
  name: `member ${suffix}`,
  role,
  identityKeyFingerprint: digest,
  listenerPin: role === "guest" ? NO_LISTENER_PIN : digest,
  privateNames: [],
  addresses: [],
  owner: false,
});

const rosterOf = (...members: ReadonlyArray<RosterMember>): HubRoster => ({
  sequence: 2,
  members,
  standbyOrder: [],
  failoverAfterSeconds: 300,
});

const spokeId = id("2");

describe("a spoke accepting the guests a verified roster lists", () => {
  it("accepts a listed guest as a full member when Introduce is ticked", () => {
    const result = introduceGuests({
      spokeId,
      roster: rosterOf(member("1", "hub"), member("2", "spoke"), member("3", "guest")),
      grants: [],
      introduce: true,
      confirmNewMembers: false,
    });

    expect(result.admitted.map((guest) => String(guest.memberId))).toEqual([String(id("3"))]);
    expect(result.grants).toEqual([{ memberId: id("3"), readStatus: true, answerApprovals: true }]);
  });

  it("accepts no guest when Introduce is not ticked", () => {
    const result = introduceGuests({
      spokeId,
      roster: rosterOf(member("1", "hub"), member("2", "spoke"), member("3", "guest")),
      grants: [],
      introduce: false,
      confirmNewMembers: false,
    });

    expect(result).toEqual({ grants: [], admitted: [], dropped: [] });
  });

  it("holds a new guest at status only while Confirm new members is on", () => {
    const result = introduceGuests({
      spokeId,
      roster: rosterOf(member("1", "hub"), member("3", "guest")),
      grants: [],
      introduce: true,
      confirmNewMembers: true,
    });

    expect(result.grants).toEqual([{ memberId: id("3"), readStatus: true }]);
  });

  it("does not admit a guest again and drops the grant of one the roster no longer lists", () => {
    const held: ReadonlyArray<PeerGrant> = [
      { memberId: id("3"), readStatus: true, answerApprovals: true },
      { memberId: id("4"), readStatus: true, answerApprovals: true },
    ];

    const result = introduceGuests({
      spokeId,
      roster: rosterOf(member("1", "hub"), member("3", "guest")),
      grants: held,
      introduce: true,
      confirmNewMembers: false,
    });

    expect(result.admitted).toEqual([]);
    expect(result.dropped).toEqual([id("4")]);
    expect(result.grants.map((grant) => String(grant.memberId))).toEqual([String(id("3"))]);
  });

  it("drops a guest's grant even when Introduce is not ticked", () => {
    const result = introduceGuests({
      spokeId,
      roster: rosterOf(member("1", "hub")),
      grants: [{ memberId: id("3"), readStatus: true, answerApprovals: true }],
      introduce: false,
      confirmNewMembers: false,
    });

    expect(result.grants).toEqual([]);
    expect(result.dropped).toEqual([id("3")]);
  });

  it("accepts another spoke as a full member that may delegate, and never the hub or itself", () => {
    const result = introduceGuests({
      spokeId,
      roster: rosterOf(member("1", "hub"), member("2", "spoke"), member("5", "spoke")),
      grants: [],
      introduce: true,
      confirmNewMembers: false,
    });

    expect(result.admitted.map((admitted) => String(admitted.memberId))).toEqual([String(id("5"))]);
    expect(result.grants).toEqual([
      {
        memberId: id("5"),
        readStatus: true,
        delegation: {
          projects: "all",
          modes: ["work", "code"],
          posture: "approval-gated",
          providerProfiles: { allowDefault: true, profileIds: [] },
        },
      },
    ]);
  });

  it("holds a new spoke at status only while Confirm new members is on", () => {
    const result = introduceGuests({
      spokeId,
      roster: rosterOf(member("1", "hub"), member("5", "spoke")),
      grants: [],
      introduce: true,
      confirmNewMembers: true,
    });

    expect(result.grants).toEqual([{ memberId: id("5"), readStatus: true }]);
  });
});

describe("when a Tailscale certificate is renewed", () => {
  const notAfter = Date.UTC(2027, 0, 1);

  it("leaves a certificate alone until less than two weeks of its life remain", () => {
    const now = notAfter - TAILSCALE_CERTIFICATE_RENEW_BEFORE_MS - 1;

    expect(tailscaleCertificateRenewal({ notAfter, now })).toEqual({
      status: "current",
      renewAt: notAfter - TAILSCALE_CERTIFICATE_RENEW_BEFORE_MS,
    });
  });

  it("renews from two weeks before the end up to the end", () => {
    expect(
      tailscaleCertificateRenewal({
        notAfter,
        now: notAfter - TAILSCALE_CERTIFICATE_RENEW_BEFORE_MS,
      }).status,
    ).toBe("due");
    expect(tailscaleCertificateRenewal({ notAfter, now: notAfter - 1 }).status).toBe("due");
  });

  it("reports a certificate past its end as expired", () => {
    expect(tailscaleCertificateRenewal({ notAfter, now: notAfter })).toEqual({ status: "expired" });
  });
});
