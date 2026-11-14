import { describe, expect, it } from "vitest";
import { type ResearchBackendInput, resolveResearchBackend } from "./researchPolicy";

function input(overrides: Partial<ResearchBackendInput> = {}): ResearchBackendInput {
  return {
    researchEnabled: true,
    routing: "automatic" as const,
    webSearchReady: true,
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

  it("automatic prefers the provider's own search even when a web search backend is eligible", () => {
    expect(resolveResearchBackend(input())).toEqual({
      kind: "selected",
      backend: "provider-native",
    });
  });

  it("automatic falls back to an eligible web search backend when the provider has no search of its own", () => {
    expect(resolveResearchBackend(input({ nativeResearch: "unsupported" }))).toEqual({
      kind: "selected",
      backend: "octant",
    });
  });

  it("automatic falls back to provider-native when no web search backend is eligible", () => {
    expect(
      resolveResearchBackend(input({ webSearchReady: false, nativeResearch: "supported" })),
    ).toEqual({ kind: "selected", backend: "provider-native" });
  });

  it("automatic falls back to provider-native when app-managed tools are unsupported even with an eligible web search backend", () => {
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
          webSearchReady: false,
          appManagedTools: "unsupported",
          nativeResearch: "unavailable",
        }),
      ),
    ).toEqual({
      kind: "unavailable",
      reason: "no-eligible-web-search-backend",
    });
  });

  it("explicit Octant search fails when no web search backend is eligible", () => {
    expect(
      resolveResearchBackend(
        input({
          routing: "octant",
          webSearchReady: false,
          appManagedTools: "supported",
        }),
      ),
    ).toEqual({
      kind: "unavailable",
      reason: "no-eligible-web-search-backend",
    });
  });

  it("explicit Octant search fails when app-managed tools are unsupported", () => {
    expect(
      resolveResearchBackend(
        input({
          routing: "octant",
          webSearchReady: true,
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
    const octant = resolveResearchBackend(
      input({
        routing: "octant",
        webSearchReady: true,
        appManagedTools: "unsupported",
        nativeResearch: "supported",
      }),
    );
    expect(octant).toEqual({
      kind: "unavailable",
      reason: "app-managed-tools-unsupported",
    });

    const native = resolveResearchBackend(
      input({
        routing: "provider-native",
        webSearchReady: true,
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
