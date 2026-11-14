import { describe, expect, it, vi } from "vitest";
import type { ResearchBackendInput } from "@octant/domain/research-policy";
import { ResearchRouter, type ResearchExecuteInput } from "./researchRouter";

function input(overrides: Partial<ResearchBackendInput> = {}): ResearchBackendInput {
  return {
    researchEnabled: true,
    routing: "automatic",
    webSearchReady: true,
    appManagedTools: "supported",
    nativeResearch: "supported",
    ...overrides,
  };
}

describe("ResearchRouter.resolve", () => {
  it("returns disabled and unavailable domain decisions unchanged", () => {
    const router = new ResearchRouter({
      webSearch: { search: vi.fn() },
      providerNativeExecute: vi.fn(),
    });

    expect(router.resolve(input({ researchEnabled: false }))).toEqual({ kind: "disabled" });

    expect(
      router.resolve(
        input({
          routing: "octant",
          webSearchReady: false,
        }),
      ),
    ).toEqual({ kind: "unavailable", reason: "no-eligible-web-search-backend" });
  });

  it("returns a SearXNG executor and attribution for selected SearXNG routing", () => {
    const searxngSearch = vi.fn(async () => ({
      query: "Octant",
      backend: "octant" as const,
      results: [],
    }));
    const router = new ResearchRouter({
      webSearch: { search: searxngSearch },
      providerNativeExecute: vi.fn(),
    });

    const resolved = router.resolve(input({ routing: "octant" }));
    expect(resolved).toMatchObject({
      kind: "ready",
      backend: "octant",
      attribution: "Octant web search",
    });
    if (resolved.kind !== "ready" || resolved.backend !== "octant") {
      throw new Error("expected ready SearXNG decision");
    }

    const executeInput: ResearchExecuteInput = {
      query: "Octant",
      limit: 5,
      signal: AbortSignal.timeout(1_000),
    };
    void resolved.execute(executeInput);
    expect(searxngSearch).toHaveBeenCalledWith(executeInput);
  });

  it("returns provider-native readiness without requiring an app executor", () => {
    const router = new ResearchRouter({
      webSearch: { search: vi.fn() },
    });

    const resolved = router.resolve(input({ routing: "provider-native" }));
    expect(resolved).toMatchObject({
      kind: "ready",
      backend: "provider-native",
      attribution: "Provider-native search",
    });
    if (resolved.kind !== "ready") throw new Error("expected ready decision");

    expect("execute" in resolved).toBe(false);
  });

  it("uses advertised native capability as the provider-native execution gate", () => {
    const router = new ResearchRouter({
      webSearch: { search: vi.fn() },
    });

    expect(router.resolve(input({ routing: "provider-native" }))).toEqual({
      kind: "ready",
      backend: "provider-native",
      attribution: "Provider-native search",
    });
  });

  it("never silently falls back when an explicit backend is unavailable", () => {
    const router = new ResearchRouter({
      webSearch: { search: vi.fn() },
      providerNativeExecute: vi.fn(),
    });

    expect(
      router.resolve(
        input({
          routing: "octant",
          appManagedTools: "unsupported",
          nativeResearch: "supported",
        }),
      ),
    ).toEqual({ kind: "unavailable", reason: "app-managed-tools-unsupported" });

    expect(
      router.resolve(
        input({
          routing: "provider-native",
          webSearchReady: true,
          appManagedTools: "supported",
          nativeResearch: "unavailable",
        }),
      ),
    ).toEqual({ kind: "unavailable", reason: "native-research-unsupported" });
  });

  it("automatic routing prefers the provider's own search and falls back to Octant web search", () => {
    const searxngSearch = vi.fn();
    const router = new ResearchRouter({
      webSearch: { search: searxngSearch },
    });

    expect(router.resolve(input({ routing: "automatic" }))).toMatchObject({
      kind: "ready",
      backend: "provider-native",
    });
    expect(
      router.resolve(input({ routing: "automatic", nativeResearch: "unsupported" })),
    ).toMatchObject({ kind: "ready", backend: "octant" });
  });
});
