import { decodeHubOfferBody, HUB_OFFER_KINDS } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  allowedUpdateChannels,
  decideAutoApply,
  decideOfferAdmission,
  settleProposals,
} from "./hubProvisionPolicy";

const plugin = decodeHubOfferBody({
  kind: "plugin",
  catalogId: "octant",
  entryId: "review-helper",
  expectedDigest: `sha256:${"a".repeat(64)}`,
});

const admit = (overrides: Partial<Parameters<typeof decideOfferAdmission>[0]> = {}) =>
  decideOfferAdmission({
    offer: plugin,
    offerHeld: false,
    provisionGranted: true,
    supportedKinds: HUB_OFFER_KINDS,
    currentChannel: undefined,
    canVerifyMirror: true,
    heldCount: 0,
    maxProposals: 4,
    ...overrides,
  });

describe("taking a hub's offer as a proposal", () => {
  it("proposes an offer the spoke can apply, within room", () => {
    expect(admit()).toEqual({ status: "propose" });
  });

  it("refuses without the Provision grant, for a kind it cannot apply, a repeat, and a full list", () => {
    expect(admit({ provisionGranted: false })).toEqual({
      status: "refuse",
      kind: "provision-not-granted",
    });
    expect(admit({ supportedKinds: ["routine"] })).toEqual({
      status: "refuse",
      kind: "kind-unsupported",
    });
    expect(admit({ offerHeld: true })).toEqual({ status: "refuse", kind: "duplicate" });
    expect(admit({ heldCount: 4 })).toEqual({ status: "refuse", kind: "proposals-full" });
  });

  it("follows stable and preview, and candidate only from candidate", () => {
    expect(allowedUpdateChannels(undefined)).toEqual(["stable", "preview"]);
    expect(allowedUpdateChannels("candidate")).toContain("candidate");
    const candidate = decodeHubOfferBody({ kind: "update-channel", channel: "candidate" });
    expect(admit({ offer: candidate, currentChannel: "stable" })).toEqual({
      status: "refuse",
      kind: "channel-not-allowed",
    });
    expect(admit({ offer: candidate, currentChannel: "candidate" })).toEqual({
      status: "propose",
    });
  });

  it("refuses a mirrored feed it cannot check", () => {
    const mirrored = decodeHubOfferBody({
      kind: "update-channel",
      channel: "stable",
      mirror: true,
    });
    expect(admit({ offer: mirrored, canVerifyMirror: false })).toEqual({
      status: "refuse",
      kind: "mirror-unverifiable",
    });
  });

  it("refuses a profile that carries Full access or a remembered permission", () => {
    const base = {
      kind: "agent-profile",
      displayName: "Reviewer",
      approvedSkillIds: [],
      toolConstraints: [],
      modelConstraints: [],
      defaultExecutionPolicy: "approval-gated",
      defaultPermissionPersistence: "current-session",
      compatibleModes: ["work"],
    };
    for (const change of [
      { defaultExecutionPolicy: "full-access" },
      { defaultPermissionPersistence: "project-default" },
    ]) {
      expect(admit({ offer: decodeHubOfferBody({ ...base, ...change }) })).toEqual({
        status: "refuse",
        kind: "widens-authority",
      });
    }
  });
});

describe("applying on arrival", () => {
  it("applies only the three kinds the person turned on", () => {
    expect(decideAutoApply({ kind: "plugin", autoApply: ["plugin"] })).toBe(true);
    expect(decideAutoApply({ kind: "plugin", autoApply: [] })).toBe(false);
    expect(decideAutoApply({ kind: "routine", autoApply: ["plugin", "agent-profile"] })).toBe(
      false,
    );
    expect(decideAutoApply({ kind: "model-endpoint", autoApply: ["update-channel"] })).toBe(false);
  });
});

describe("proposals that lapse", () => {
  it("splits open from expired by the clock", () => {
    const held = [{ expiresAtMs: 100 }, { expiresAtMs: 200 }];
    expect(settleProposals(held, 150)).toEqual({
      open: [{ expiresAtMs: 200 }],
      expired: [{ expiresAtMs: 100 }],
    });
  });
});
