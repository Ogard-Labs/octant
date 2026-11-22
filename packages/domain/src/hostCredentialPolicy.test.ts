import { describe, expect, it } from "vitest";
import {
  hostCredentialCrosses,
  hostCredentialPassThroughRefusal,
  isUnrelatedHostCredential,
} from "./hostCredentialPolicy";

const none: ReadonlySet<string> = new Set();

describe("host credentials outside Strict", () => {
  it("a provider launched outside Strict does not receive GH_TOKEN unless its pass-through list names it", () => {
    expect(hostCredentialCrosses("GH_TOKEN", { own: none, passThrough: none })).toBe(false);
    expect(
      hostCredentialCrosses("GH_TOKEN", { own: none, passThrough: new Set(["GH_TOKEN"]) }),
    ).toBe(true);
  });

  it("strips GitHub, npm and AWS credentials and any other service's API key", () => {
    for (const name of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "NPM_TOKEN",
      "NODE_AUTH_TOKEN",
      "AWS_ACCESS_KEY_ID",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_SESSION_TOKEN",
      "STRIPE_API_KEY",
      "stripe_api_key",
    ]) {
      expect(isUnrelatedHostCredential(name), name).toBe(true);
      expect(hostCredentialCrosses(name, { own: none, passThrough: none }), name).toBe(false);
    }
  });

  it("a provider's own API key is never stripped", () => {
    expect(
      hostCredentialCrosses("GEMINI_API_KEY", {
        own: new Set(["GEMINI_API_KEY"]),
        passThrough: none,
      }),
    ).toBe(true);
    expect(
      hostCredentialCrosses("AWS_ACCESS_KEY_ID", {
        own: new Set(["AWS_ACCESS_KEY_ID"]),
        passThrough: none,
      }),
    ).toBe(true);
  });

  it("leaves variables that name no credential to the host's own environment", () => {
    for (const name of [
      "PATH",
      "HTTPS_PROXY",
      "AWS_PROFILE",
      "AWS_REGION",
      "NODE_EXTRA_CA_CERTS",
    ]) {
      expect(hostCredentialCrosses(name, { own: none, passThrough: none }), name).toBe(true);
    }
  });

  it("matches a pass-through name whatever case the host spells it in", () => {
    expect(
      hostCredentialCrosses("gh_token", { own: none, passThrough: new Set(["GH_TOKEN"]) }),
    ).toBe(true);
  });

  it("refuses another model provider's key on a pass-through list, since the launch never lets one through", () => {
    expect(hostCredentialPassThroughRefusal("OPENAI_API_KEY")).toContain("model provider");
    expect(hostCredentialPassThroughRefusal("anthropic_api_key")).toContain("model provider");
    expect(hostCredentialPassThroughRefusal("STRIPE_API_KEY")).toBeUndefined();
  });

  it("refuses a name past the most one provider's list may hold", () => {
    const full = Array.from({ length: 64 }, (_, index) => `TOKEN_${index}`);
    expect(hostCredentialPassThroughRefusal("GH_TOKEN", full.slice(1))).toBeUndefined();
    expect(hostCredentialPassThroughRefusal("GH_TOKEN", full)).toContain("64");
  });

  it("refuses a pass-through name that is not an environment variable name or is one of Octant's own", () => {
    expect(hostCredentialPassThroughRefusal("GH_TOKEN")).toBeUndefined();
    expect(hostCredentialPassThroughRefusal("GH TOKEN")).toBeDefined();
    expect(hostCredentialPassThroughRefusal("1TOKEN")).toBeDefined();
    expect(hostCredentialPassThroughRefusal("")).toBeDefined();
    expect(hostCredentialPassThroughRefusal("OCTANT_DESKTOP_BRIDGE_SECRET")).toBeDefined();
  });
});
