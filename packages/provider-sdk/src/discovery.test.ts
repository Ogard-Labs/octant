import { describe, expect, it } from "vitest";
import { DISCOVERY_DESCRIPTORS, discoverableDescriptors } from "./discovery";

describe("provider discovery descriptors", () => {
  it("covers every currently discoverable and direct-endpoint driver kind", () => {
    const kinds = DISCOVERY_DESCRIPTORS.map((d) => d.driverKind);
    expect(kinds).toContain("codex");
    expect(kinds).toContain("claude");
    expect(kinds).toContain("opencode");
    expect(kinds).toContain("kimi-code");
    expect(kinds).toContain("devin");
    expect(kinds).toContain("kilo");
    expect(kinds).toContain("pi");
    expect(kinds).toContain("oh-my-pi");
    expect(kinds).toContain("mistral-vibe");
    expect(kinds).toContain("ollama");
    expect(kinds).toContain("openai-compatible");
    expect(kinds).toContain("anthropic-compatible");
    expect(kinds).toContain("azure-foundry");
  });

  it("has no duplicate driver kinds", () => {
    const kinds = DISCOVERY_DESCRIPTORS.map((d) => d.driverKind);
    expect(new Set(kinds).size).toBe(kinds.length);
  });

  it("marks direct HTTP endpoints correctly", () => {
    const directKinds = DISCOVERY_DESCRIPTORS.filter((d) => d.isDirectEndpoint).map(
      (d) => d.driverKind,
    );
    expect(directKinds).toEqual(["openai-compatible", "anthropic-compatible", "azure-foundry"]);
  });

  it("excludes direct endpoints from discoverableDescriptors", () => {
    const discoverable = discoverableDescriptors();
    expect(discoverable.every((d) => !d.isDirectEndpoint)).toBe(true);
    expect(discoverable.length).toBe(DISCOVERY_DESCRIPTORS.length - 3);
  });

  it("every discoverable descriptor has executable names and version probe", () => {
    for (const descriptor of discoverableDescriptors()) {
      expect(descriptor.executableNames.length).toBeGreaterThan(0);
      expect(descriptor.versionProbeArgs.length).toBeGreaterThan(0);
      expect(descriptor.approvedLocations.length).toBeGreaterThan(0);
      expect(descriptor.onboardingGuidance.length).toBeGreaterThan(0);
    }
  });

  it("approved locations are all absolute paths", () => {
    for (const descriptor of DISCOVERY_DESCRIPTORS) {
      for (const location of descriptor.approvedLocations) {
        expect(location.startsWith("/")).toBe(true);
      }
    }
  });

  it("does not ship developer-specific home-directory paths", () => {
    for (const descriptor of DISCOVERY_DESCRIPTORS) {
      expect(descriptor.approvedLocations).not.toContain("/Users/example/.bun/bin");
    }
  });

  it("direct endpoint descriptors have no executable names or locations", () => {
    for (const descriptor of DISCOVERY_DESCRIPTORS.filter((d) => d.isDirectEndpoint)) {
      expect(descriptor.executableNames).toHaveLength(0);
      expect(descriptor.approvedLocations).toHaveLength(0);
      expect(descriptor.versionProbeArgs).toHaveLength(0);
    }
  });

  it("defers cursor discovery until the provider create path exists", () => {
    const kinds = DISCOVERY_DESCRIPTORS.map((d) => d.driverKind);
    expect(kinds).not.toContain("cursor");
    expect(discoverableDescriptors().map((d) => d.driverKind)).not.toContain("cursor");
  });
});
