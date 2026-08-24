import { describe, expect, it } from "vitest";
import { providerRowReadinessLabel } from "./providerSettingsPresentation";

describe("provider Settings presentation", () => {
  it("turns technical readiness states into compact next-action labels", () => {
    expect(providerRowReadinessLabel("unauthenticated", 0)).toBe("Sign in required");
    expect(providerRowReadinessLabel("incompatible", 0)).toBe("Update required");
    expect(providerRowReadinessLabel("degraded", 0)).toBe("Needs setup");
    expect(providerRowReadinessLabel("degraded", 4)).toBe("Limited");
    expect(providerRowReadinessLabel("ready", 4)).toBe("Ready");
  });
});
