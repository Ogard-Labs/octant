import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  decodeBrowserAutomationFailure,
  decodeBrowserContextPolicy,
  decodeBrowserProfile,
} from "./browserAutomation";
import {
  decodeBrowserProfileCleared,
  decodeBrowserProfilesCommand,
  decodeBrowserProfilesResult,
  decodeStoredBrowserProfile,
} from "./browserProfiles";
import { RememberedBrowserProfileSite } from "./shell";

const projectId = "40000000-0000-4000-8000-000000000001";
const policy = {
  profileMode: "isolated",
  allowedOrigins: ["https://example.com"],
  credentialFieldProtection: true,
  maxConcurrentTabs: 1,
  sessionTimeoutMs: 300_000,
};

describe("Browser profiles contract", () => {
  it("knows three profiles and nothing else", () => {
    expect(decodeBrowserProfile({ kind: "private" })).toEqual({ kind: "private" });
    expect(decodeBrowserProfile({ kind: "personal" })).toEqual({ kind: "personal" });
    expect(decodeBrowserProfile({ kind: "project", projectId })).toEqual({
      kind: "project",
      projectId,
    });
    expect(() => decodeBrowserProfile({ kind: "existing" })).toThrow();
    expect(() => decodeBrowserProfile({ kind: "project" })).toThrow();
    // A profile cannot carry a store path or partition of its own choosing.
    expect(() => decodeBrowserProfile({ kind: "personal", partition: "persist:x" })).toThrow();
  });

  it("lets a policy name a profile and decodes an older policy as Private", () => {
    expect(
      decodeBrowserContextPolicy({ ...policy, profile: { kind: "personal" } }).profile,
    ).toEqual({ kind: "personal" });
    expect(decodeBrowserContextPolicy(policy).profile).toBeUndefined();
    expect(() =>
      decodeBrowserContextPolicy({ ...policy, profileMode: "existing-profile" }),
    ).toThrow();
  });

  it("carries a profile refusal as a reason beside its message", () => {
    expect(
      decodeBrowserAutomationFailure({
        category: "policy-denied",
        reason: "profile-needs-a-person",
        message: "Needs a person.",
      }),
    ).toMatchObject({ reason: "profile-needs-a-person" });
    expect(() =>
      decodeBrowserAutomationFailure({
        category: "policy-denied",
        reason: "because",
        message: "No.",
      }),
    ).toThrow();
  });

  it("lists and clears only stored profiles, never Private", () => {
    expect(decodeBrowserProfilesCommand({ kind: "list" })).toEqual({ kind: "list" });
    expect(
      decodeBrowserProfilesCommand({
        kind: "clear",
        profile: { kind: "project", projectId },
        scope: "cookies",
      }),
    ).toMatchObject({ scope: "cookies" });
    expect(() =>
      decodeBrowserProfilesCommand({ kind: "clear", profile: { kind: "private" }, scope: "all" }),
    ).toThrow();
    expect(() => decodeStoredBrowserProfile({ kind: "private" })).toThrow();
  });

  it("decodes each result a profile command can end in", () => {
    expect(
      decodeBrowserProfilesResult({
        kind: "browser-profiles",
        profiles: [{ profile: { kind: "personal" }, label: "Personal", sizeBytes: 0 }],
      }).kind,
    ).toBe("browser-profiles");
    expect(
      decodeBrowserProfilesResult({
        kind: "browser-profiles-refused",
        reason: "profile-not-local",
        message: "Only on this Mac.",
      }).kind,
    ).toBe("browser-profiles-refused");
  });

  it("journals a clear as a profile and a scope, with room for nothing else", () => {
    expect(
      decodeBrowserProfileCleared({
        kind: "browser-profile-cleared",
        profile: { kind: "personal" },
        scope: "all",
      }),
    ).toBeDefined();
    expect(() =>
      decodeBrowserProfileCleared({
        kind: "browser-profile-cleared",
        profile: { kind: "personal" },
        scope: "all",
        cookies: [{ name: "sid", value: "secret" }],
      }),
    ).toThrow();
  });

  it("remembers a site for a stored profile only, never for Private", () => {
    const decode = Schema.decodeUnknownSync(RememberedBrowserProfileSite);
    expect(decode({ origin: "https://github.com", profile: { kind: "personal" } })).toBeDefined();
    expect(() => decode({ origin: "https://github.com", profile: { kind: "private" } })).toThrow();
  });
});
