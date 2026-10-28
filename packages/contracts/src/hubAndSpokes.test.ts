import { describe, expect, it } from "vitest";
import { decodeAuditActingPrincipal } from "./auditEvents";
import {
  decodeDelegationRequest,
  decodeDelegationResult,
  decodeHubAndSpokesPrincipal,
  decodeHubGrant,
  decodeNewMemberConfirmation,
  decodePeerGrant,
  decodeSignedHubRoster,
  encodeSignedHubRoster,
} from "./hubAndSpokes";

const ids = {
  hub: "11111111-1111-4111-8111-111111111111",
  laptop: "22222222-2222-4222-8222-222222222222",
  phone: "33333333-3333-4333-8333-333333333333",
  project: "44444444-4444-4444-8444-444444444444",
  thread: "55555555-5555-4555-8555-555555555555",
  request: "66666666-6666-4666-8666-666666666666",
} as const;
const key = "ab".repeat(32);
const at = "2026-10-28T10:00:00.000Z";

const member = (memberId: string, role: string) => ({
  memberId,
  name: "Mac mini",
  role,
  identityKeyFingerprint: key,
  listenerPin: key,
  privateNames: ["mini.tailnet.ts.net"],
  addresses: ["100.64.0.1"],
  owner: false,
});

const signedRoster = {
  roster: {
    sequence: 3,
    members: [member(ids.hub, "hub"), member(ids.laptop, "spoke")],
    standbyOrder: [ids.laptop],
    failoverAfterSeconds: 300,
  },
  signedBy: { kind: "hub", memberId: ids.hub },
  signature: "c2lnbmF0dXJl",
} as const;

const peerGrant = {
  memberId: ids.laptop,
  delegation: {
    projects: "all",
    modes: ["work", "code"],
    posture: "approval-gated",
    providerProfiles: { allowDefault: true, profileIds: [] },
  },
  readStatus: true,
} as const;

describe("hub and spokes contracts", () => {
  it("decodes the hub and peer principals next to the existing ones", () => {
    expect(decodeHubAndSpokesPrincipal({ kind: "hub", memberId: ids.hub }).kind).toBe("hub");
    expect(decodeAuditActingPrincipal({ kind: "peer", memberId: ids.laptop }).kind).toBe("peer");
    expect(decodeAuditActingPrincipal({ kind: "local-window" }).kind).toBe("local-window");
    expect(() =>
      decodeAuditActingPrincipal({ kind: "peer", memberId: ids.laptop, deviceId: ids.phone }),
    ).toThrow();
  });

  it("round-trips a signed roster and refuses an unknown field at every level", () => {
    expect(
      decodeSignedHubRoster(encodeSignedHubRoster(decodeSignedHubRoster(signedRoster))),
    ).toEqual(signedRoster);
    expect(() => decodeSignedHubRoster({ ...signedRoster, online: true })).toThrow();
    expect(() =>
      decodeSignedHubRoster({ ...signedRoster, roster: { ...signedRoster.roster, online: [] } }),
    ).toThrow();
    expect(() =>
      decodeSignedHubRoster({
        ...signedRoster,
        roster: {
          ...signedRoster.roster,
          members: [{ ...member(ids.hub, "hub"), accepts: "delegation" }],
        },
      }),
    ).toThrow();
  });

  it("refuses a roster that repeats a member or a standby", () => {
    expect(() =>
      decodeSignedHubRoster({
        ...signedRoster,
        roster: {
          ...signedRoster.roster,
          members: [member(ids.hub, "hub"), member(ids.hub, "spoke")],
        },
      }),
    ).toThrow();
    expect(() =>
      decodeSignedHubRoster({
        ...signedRoster,
        roster: { ...signedRoster.roster, standbyOrder: [ids.laptop, ids.laptop] },
      }),
    ).toThrow();
  });

  it("refuses a role outside hub, standby hub, spoke, and guest", () => {
    expect(() =>
      decodeSignedHubRoster({
        ...signedRoster,
        roster: { ...signedRoster.roster, members: [member(ids.hub, "relay")] },
      }),
    ).toThrow();
  });

  it("accepts only items from the closed hub grant list and names Projects only for Act", () => {
    expect(
      decodeHubGrant({ items: ["roster", "introduce", "owners"], actProjects: [] }).items,
    ).toHaveLength(3);
    expect(decodeHubGrant({ items: ["act"], actProjects: [ids.project] }).actProjects).toHaveLength(
      1,
    );
    expect(() => decodeHubGrant({ items: ["shell"], actProjects: [] })).toThrow();
    expect(() => decodeHubGrant({ items: ["status"], actProjects: [ids.project] })).toThrow();
    expect(() => decodeHubGrant({ items: ["status", "status"], actProjects: [] })).toThrow();
    expect(() => decodeHubGrant({ items: [], actProjects: [], extra: 1 })).toThrow();
  });

  it("decodes a peer grant and refuses Full access as a standing posture", () => {
    expect(decodePeerGrant(peerGrant).delegation?.posture).toBe("approval-gated");
    expect(
      decodePeerGrant({ memberId: ids.phone, readStatus: true, answerApprovals: true }).delegation,
    ).toBeUndefined();
    expect(() =>
      decodePeerGrant({
        ...peerGrant,
        delegation: { ...peerGrant.delegation, posture: "full-access" },
      }),
    ).toThrow();
    expect(() => decodePeerGrant({ ...peerGrant, canApprove: true })).toThrow();
  });

  it("decodes an owner's Full access choice only with the Projects it names", () => {
    const choice = { chosenBy: ids.phone, chosenAt: at, projects: [ids.project] };
    const withChoice = {
      ...peerGrant,
      delegation: { ...peerGrant.delegation, fullAccess: choice },
    };
    expect(decodePeerGrant(withChoice).delegation?.fullAccess?.projects).toHaveLength(1);
    expect(() =>
      decodePeerGrant({
        ...peerGrant,
        delegation: { ...peerGrant.delegation, fullAccess: { ...choice, projects: [] } },
      }),
    ).toThrow();
  });

  it("decodes a delegation request and refuses fields that would carry a credential or a command", () => {
    const request = {
      requestId: ids.request,
      projectId: ids.project,
      task: "Run the tests",
      authority: { mode: "code", posture: "approval-gated" },
      delegatedFrom: { kind: "code", memberId: ids.hub, threadId: ids.thread },
    };
    expect(decodeDelegationRequest(request).delegatedFrom.kind).toBe("code");
    expect(() => decodeDelegationRequest({ ...request, apiKey: "secret" })).toThrow();
    expect(() =>
      decodeDelegationRequest({ ...request, authority: { ...request.authority, shell: true } }),
    ).toThrow();
    expect(() => decodeDelegationRequest({ ...request, task: "  " })).toThrow();
  });

  it("decodes a delegation result with provenance and refuses extra fields", () => {
    const result = {
      requestId: ids.request,
      summary: "Tests pass",
      finalMessage: "All 12 tests pass.",
      artifacts: [{ label: "report", digest: key }],
      provenance: { memberId: ids.laptop, projectId: ids.project, completedAt: at },
    };
    expect(decodeDelegationResult(result).provenance.memberId).toBe(ids.laptop);
    expect(() => decodeDelegationResult({ ...result, instruction: "run rm" })).toThrow();
    expect(() => decodeDelegationResult({ ...result, provenance: undefined })).toThrow();
  });

  it("decodes a new-member confirmation and refuses one without a signature", () => {
    const confirmation = {
      spokeId: ids.laptop,
      memberId: ids.phone,
      identityKeyFingerprint: key,
      confirmedBy: ids.hub,
      unlockKeyFingerprint: key,
      confirmedAt: at,
      signature: "c2lnbmF0dXJl",
    };
    expect(decodeNewMemberConfirmation(confirmation).memberId).toBe(ids.phone);
    expect(() => decodeNewMemberConfirmation({ ...confirmation, signature: "" })).toThrow();
    expect(() => decodeNewMemberConfirmation({ ...confirmation, note: "ok" })).toThrow();
  });
});
