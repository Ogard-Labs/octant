import { describe, expect, it } from "vitest";
import { ACP_AGENT_KINDS, acpAgentProfile, personalSignInRefusals } from "./acpAgentProfiles";

describe("ACP agent profiles", () => {
  it("names the key wherever a profile lets an instance sign in with one", () => {
    for (const kind of ACP_AGENT_KINDS) {
      const profile = acpAgentProfile(kind);
      const offered = profile.offeredAuthentication ?? profile.authentication;
      expect(
        offered.every((posture) => profile.authentication.includes(posture)),
        kind,
      ).toBe(true);
      expect(
        profile.authentication.includes("api-key") === (profile.apiKeyLabel !== undefined),
        kind,
      ).toBe(true);
    }
  });
});

describe("personal sign-in limits", () => {
  const antigravity = (authentication?: string) => ({
    driverKind: "antigravity",
    configuration: authentication === undefined ? {} : { authentication },
  });

  it("an Antigravity instance on personal sign-in keeps every limit", () => {
    for (const instance of [antigravity(), antigravity("provider-owned")]) {
      expect(personalSignInRefusals(instance)).toEqual(
        acpAgentProfile("antigravity").personalSignIn,
      );
    }
  });

  it("an Antigravity instance signed in with a Gemini API key or Agent Platform carries no personal sign-in limit", () => {
    expect(personalSignInRefusals(antigravity("api-key"))).toBeUndefined();
    expect(personalSignInRefusals(antigravity("agent-platform"))).toBeUndefined();
  });

  it("names no limit for a provider that declares none, or for no provider", () => {
    expect(personalSignInRefusals({ driverKind: "gemini", configuration: {} })).toBeUndefined();
    expect(personalSignInRefusals({ driverKind: "codex", configuration: {} })).toBeUndefined();
    expect(personalSignInRefusals(undefined)).toBeUndefined();
  });
});
