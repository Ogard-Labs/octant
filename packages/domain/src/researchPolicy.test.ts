import { describe, expect, it } from "vitest";
import { type ResearchBackendInput, resolveResearchBackend } from "./researchPolicy";

function input(overrides: Partial<ResearchBackendInput> = {}): ResearchBackendInput {
  return {
    researchEnabled: true,
    routing: "automatic" as const,
    searxngConfigured: true,
    appManagedTools: "supported" as const,
    nativeResearch: "supported" as const,
    ...overrides,
  };
}

describe("research backend routing", () => {
  it("disables research when the thread has research disabled", () => {
    expect(resolveResearchBackend(input({ researchEnabled: false }))).toEqual({
      kind: "disabled",
    });
  });

  it("automatic prefers configured SearXNG when app-managed tools are supported", () => {
    expect(resolveResearchBackend(input())).toEqual({
      kind: "selected",
      backend: "searxng",
    });
  });

  it("automatic falls back to provider-native when SearXNG is not configured", () => {
    expect(
      resolveResearchBackend(input({ searxngConfigured: false, nativeResearch: "supported" })),
    ).toEqual({ kind: "selected", backend: "provider-native" });
  });

  it("automatic falls back to provider-native when app-managed tools are unsupported even if SearXNG is configured", () => {
    expect(
      resolveResearchBackend(
        input({ appManagedTools: "unsupported", nativeResearch: "supported" }),
      ),
    ).toEqual({ kind: "selected", backend: "provider-native" });
  });

  it("automatic reports unavailable when neither backend is usable", () => {
    expect(
      resolveResearchBackend(
        input({
          searxngConfigured: false,
          appManagedTools: "unsupported",
          nativeResearch: "unavailable",
        }),
      ),
    ).toEqual({
      kind: "unavailable",
      reason: "native-research-unsupported",
    });
  });

  it("explicit SearXNG fails when SearXNG is not configured", () => {
    expect(
      resolveResearchBackend(
        input({
          routing: "searxng",
          searxngConfigured: false,
          appManagedTools: "supported",
        }),
      ),
    ).toEqual({
      kind: "unavailable",
      reason: "searxng-not-configured",
    });
  });

  it("explicit SearXNG fails when app-managed tools are unsupported", () => {
    expect(
      resolveResearchBackend(
        input({
          routing: "searxng",
          searxngConfigured: true,
          appManagedTools: "unsupported",
        }),
      ),
    ).toEqual({
      kind: "unavailable",
      reason: "app-managed-tools-unsupported",
    });
  });

  it("explicit provider-native fails when native research is unsupported", () => {
    expect(
      resolveResearchBackend(
        input({
          routing: "provider-native",
          nativeResearch: "unsupported",
        }),
      ),
    ).toEqual({
      kind: "unavailable",
      reason: "native-research-unsupported",
    });
  });

  it("explicit unavailable backends never silently fall through to the other backend", () => {
    const searxng = resolveResearchBackend(
      input({
        routing: "searxng",
        searxngConfigured: true,
        appManagedTools: "unsupported",
        nativeResearch: "supported",
      }),
    );
    expect(searxng).toEqual({
      kind: "unavailable",
      reason: "app-managed-tools-unsupported",
    });

    const native = resolveResearchBackend(
      input({
        routing: "provider-native",
        searxngConfigured: true,
        appManagedTools: "supported",
        nativeResearch: "unavailable",
      }),
    );
    expect(native).toEqual({
      kind: "unavailable",
      reason: "native-research-unsupported",
    });
  });
});
