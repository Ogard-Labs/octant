import { describe, expect, it } from "vitest";
import { hostCredentialPassThroughRefusal } from "./hostCredentialPolicy";

describe("host credential pass-through names", () => {
  it("refuses another model provider's key on a pass-through list, since the launch never lets one through", () => {
    expect(hostCredentialPassThroughRefusal("OPENAI_API_KEY")).toContain("model provider");
    expect(hostCredentialPassThroughRefusal("anthropic_api_key")).toContain("model provider");
    // A Bedrock API key buys model calls and nothing else, unlike the AWS
    // access keys the person's other tools sign in with.
    expect(hostCredentialPassThroughRefusal("AWS_BEARER_TOKEN_BEDROCK")).toContain(
      "model provider",
    );
    expect(hostCredentialPassThroughRefusal("AWS_ACCESS_KEY_ID")).toBeUndefined();
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
