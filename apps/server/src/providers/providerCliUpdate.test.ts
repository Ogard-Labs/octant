import { describe, expect, it } from "vitest";
import { providerCliUpdateArgs } from "./providerCliUpdate";

describe("provider-owned CLI updates", () => {
  it("only advertises commands verified for the provider binary", () => {
    expect(providerCliUpdateArgs("kimi-code")).toEqual(["upgrade"]);
    expect(providerCliUpdateArgs("devin")).toEqual(["update"]);
    expect(providerCliUpdateArgs("mistral-vibe")).toEqual(["update"]);
    expect(providerCliUpdateArgs("grok")).toEqual(["update"]);
    expect(providerCliUpdateArgs("gemini")).toEqual(["update"]);
    expect(providerCliUpdateArgs("cline")).toEqual(["update"]);
    expect(providerCliUpdateArgs("copilot")).toEqual(["update"]);
    expect(providerCliUpdateArgs("opencode")).toBeUndefined();
    expect(providerCliUpdateArgs("goose")).toBeUndefined();
  });
});
