import { describe, expect, it, vi } from "vitest";
import type { ResearchBackendInput } from "@octant/domain/research-policy";
import { ResearchRouter, type ResearchExecuteInput } from "./researchRouter";

function input(overrides: Partial<ResearchBackendInput> = {}): ResearchBackendInput {
  return {
    researchEnabled: true,
    routing: "automatic",
    searxngConfigured: true,
    appManagedTools: "supported",
    nativeResearch: "supported",
    ...overrides,
  };
}

describe("ResearchRouter.resolve", () => {
  it("returns disabled and unavailable domain decisions unchanged", () => {
    const router = new ResearchRouter({
      searxngClient: { search: vi.fn() },
      providerNativeExecute: vi.fn(),
    });

    expect(router.resolve(input({ researchEnabled: false }))).toEqual({ kind: "disabled" });

    expect(
      router.resolve(
        input({
          routing: "searxng",
          searxngConfigured: false,
        }),
      ),
    ).toEqual({ kind: "unavailable", reason: "searxng-not-configured" });
  });

  it("returns a SearXNG executor and attribution for selected SearXNG routing", () => {
    const searxngSearch = vi.fn(async () => ({
      query: "Octant",
      backend: "searxng" as const,
      results: [],
    }));
    const router = new ResearchRouter({
      searxngClient: { search: searxngSearch },
      providerNativeExecute: vi.fn(),
    });

    const resolved = router.resolve(input({ routing: "searxng" }));
    expect(resolved).toMatchObject({
      kind: "ready",
      backend: "searxng",
      attribution: "SearXNG",
    });
    if (resolved.kind !== "ready" || resolved.backend !== "searxng") {
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
      searxngClient: { search: vi.fn() },
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
      searxngClient: { search: vi.fn() },
    });

    expect(router.resolve(input({ routing: "provider-native" }))).toEqual({
      kind: "ready",
      backend: "provider-native",
      attribution: "Provider-native search",
    });
  });

  it("never silently falls back when an explicit backend is unavailable", () => {
    const router = new ResearchRouter({
      searxngClient: { search: vi.fn() },
      providerNativeExecute: vi.fn(),
    });

    expect(
      router.resolve(
        input({
          routing: "searxng",
          appManagedTools: "unsupported",
          nativeResearch: "supported",
        }),
      ),
    ).toEqual({ kind: "unavailable", reason: "app-managed-tools-unsupported" });

    expect(
      router.resolve(
        input({
          routing: "provider-native",
          searxngConfigured: true,
          appManagedTools: "supported",
          nativeResearch: "unavailable",
        }),
      ),
    ).toEqual({ kind: "unavailable", reason: "native-research-unsupported" });
  });

  it("automatic routing prefers SearXNG without exposing a forced native fallback path", () => {
    const searxngSearch = vi.fn();
    const router = new ResearchRouter({
      searxngClient: { search: searxngSearch },
    });

    const resolved = router.resolve(input({ routing: "automatic" }));
    expect(resolved).toMatchObject({ kind: "ready", backend: "searxng" });
  });
});
