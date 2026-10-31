import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  decodeBrowserAutomationFailure,
  decodeBrowserContextPolicy,
  decodeBrowserProfile,
} from "./browserAutomation";
import {
  decodeBrowserCookiesImported,
  decodeImportedCookie,
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

  it("imports by naming a browser and one of its profiles, never by carrying a cookie or a path", () => {
    const command = {
      kind: "import-cookies",
      profile: { kind: "personal" },
      browser: "chrome",
      sourceProfile: "Default",
    };
    expect(decodeBrowserProfilesCommand(command)).toEqual(command);
    expect(decodeBrowserProfilesCommand({ kind: "import-sources" })).toEqual({
      kind: "import-sources",
    });
    expect(() => decodeBrowserProfilesCommand({ ...command, browser: "safari" })).toThrow();
    expect(() =>
      decodeBrowserProfilesCommand({ ...command, profile: { kind: "private" } }),
    ).toThrow();
    expect(() => decodeBrowserProfilesCommand({ ...command, cookies: [] })).toThrow();
    expect(() => decodeBrowserProfilesCommand({ ...command, path: "/etc" })).toThrow();
  });

  it("decodes the import answers and refusals", () => {
    expect(
      decodeBrowserProfilesResult({
        kind: "browser-cookies-imported",
        profile: { kind: "personal" },
        browser: "firefox",
        sourceProfile: "Profiles/a.default",
        imported: 3,
        skipped: 1,
      }).kind,
    ).toBe("browser-cookies-imported");
    expect(
      decodeBrowserProfilesResult({
        kind: "browser-profiles-refused",
        reason: "keychain-refused",
        message: "No.",
      }).kind,
    ).toBe("browser-profiles-refused");
  });

  it("journals an import as a source, a profile and counts, with room for no cookie", () => {
    const payload = {
      kind: "browser-cookies-imported",
      profile: { kind: "personal" },
      browser: "chrome",
      sourceProfile: "Default",
      imported: 3,
      skipped: 0,
    };
    expect(decodeBrowserCookiesImported(payload)).toEqual(payload);
    expect(() =>
      decodeBrowserCookiesImported({ ...payload, cookies: [{ name: "sid", value: "secret" }] }),
    ).toThrow();
  });

  it("bounds a cookie in transit and refuses unknown fields", () => {
    const cookie = {
      domain: ".example.com",
      hostOnly: false,
      name: "sid",
      value: "v",
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
    };
    expect(decodeImportedCookie(cookie)).toEqual(cookie);
    expect(() => decodeImportedCookie({ ...cookie, value: "v".repeat(4_097) })).toThrow();
    expect(() => decodeImportedCookie({ ...cookie, sameSite: "other" })).toThrow();
    expect(() => decodeImportedCookie({ ...cookie, extra: 1 })).toThrow();
  });
});
