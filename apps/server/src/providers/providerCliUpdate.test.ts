import { describe, expect, it } from "vitest";
import { providerCliUpdateArgs, runProviderCliUpdate } from "./providerCliUpdate";

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

  it("waits for a timed-out provider updater to terminate before rejecting", async () => {
    const started = Date.now();

    await expect(
      runProviderCliUpdate({
        binaryPath: process.execPath,
        args: ["-e", "process.once('SIGTERM', () => {}); setTimeout(() => {}, 10000)"],
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ category: "unavailable" });

    expect(Date.now() - started).toBeGreaterThanOrEqual(800);
  });
});
