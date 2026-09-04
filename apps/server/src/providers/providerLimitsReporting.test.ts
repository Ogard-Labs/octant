import { describe, expect, it } from "vitest";
import { unavailableLimitsReason } from "./providerLimitsReporting";

describe("provider limits reporting", () => {
  it("keeps runtimes that narrate usage windows waiting for their first report", () => {
    expect(unavailableLimitsReason("claude", undefined)).toBe("unsupported");
    expect(unavailableLimitsReason("codex", "silent")).toBe("unsupported");
  });

  it("names an HTTP endpoint silent only after a completed turn carried no headers", () => {
    expect(unavailableLimitsReason("openai-compatible", undefined)).toBe("unsupported");
    expect(unavailableLimitsReason("anthropic-compatible", "reported")).toBe("unsupported");
    expect(unavailableLimitsReason("azure-foundry", "silent")).toBe("endpoint-silent");
  });

  it("closes the question for runtimes that never report and for local models", () => {
    for (const kind of ["opencode", "pi", "oh-my-pi", "kilo", "devin", "mistral-vibe"] as const) {
      expect(unavailableLimitsReason(kind, undefined)).toBe("runtime-does-not-report");
    }
    expect(unavailableLimitsReason("ollama", "silent")).toBe("local-runtime");
  });
});
