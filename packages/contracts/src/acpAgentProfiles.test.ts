import { describe, expect, it } from "vitest";
import { ACP_AGENT_KINDS, acpAgentProfile } from "./acpAgentProfiles";

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
