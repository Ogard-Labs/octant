import { decodeProviderInstance, type ProviderInstance } from "@octant/contracts/providers";
import { describe, expect, it } from "vitest";
import {
  PROVIDER_OWN_SEARCH_OFFERS,
  decideHarnessProviderSearch,
  decideProviderOwnSearch,
  providerNativeResearchUnderPolicy,
  providerOwnSearchOrigin,
} from "./providerWebSearchPolicy";
import { resolveResearchBackend } from "./researchPolicy";

const createdAt = "2026-11-14T12:00:00.000Z";

function anthropic(baseUrl: string, configuration: Record<string, unknown> = {}): ProviderInstance {
  return decodeProviderInstance({
    id: "00000000-0000-4000-8000-0000000000a9",
    displayName: "Anthropic",
    driverKind: "anthropic-compatible",
    configuration: {
      kind: "anthropic-compatible-http",
      baseUrl,
      authentication: "api-key",
      protocol: "auto",
      protocolVersion: "2023-06-01",
      manualModelIds: [],
      ...configuration,
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt,
    updatedAt: createdAt,
  });
}

function openAi(baseUrl: string, protocol: string): ProviderInstance {
  return decodeProviderInstance({
    id: "00000000-0000-4000-8000-0000000000aa",
    displayName: "OpenAI",
    driverKind: "openai-compatible",
    configuration: {
      kind: "openai-compatible-http",
      baseUrl,
      authentication: "bearer",
      protocol,
      manualModelIds: [],
    },
    enabled: true,
    environmentPolicy: "inherit-host",
    version: 1,
    createdAt,
    updatedAt: createdAt,
  });
}

describe("which endpoints reach a provider's own search", () => {
  it("names Anthropic's own API and OpenAI's own API on Responses", () => {
    expect(providerOwnSearchOrigin(anthropic("https://api.anthropic.com/v1/"))).toBe(
      "anthropic-api",
    );
    expect(providerOwnSearchOrigin(openAi("https://api.openai.com/v1/", "responses"))).toBe(
      "openai-responses",
    );
  });

  it("names no search for a gateway, Chat Completions, or an unsure protocol", () => {
    expect(
      providerOwnSearchOrigin(anthropic("https://gateway.example/anthropic/")),
    ).toBeUndefined();
    expect(
      providerOwnSearchOrigin(openAi("https://api.openai.com/v1/", "chat-completions")),
    ).toBeUndefined();
    expect(providerOwnSearchOrigin(openAi("https://api.openai.com/v1/", "auto"))).toBeUndefined();
    expect(
      providerOwnSearchOrigin(openAi("https://openrouter.example/v1/", "responses")),
    ).toBeUndefined();
  });
});

describe("what the data policy allows of a provider's own search", () => {
  const origin = "anthropic-api" as const;

  it("lets it run under Any", () => {
    expect(decideProviderOwnSearch({ origin, policy: "any", zdrStated: false })).toEqual({
      kind: "allowed",
      origin,
      basicOnly: false,
    });
  });

  it("needs the person's ZDR statement under ZDR only, and then only the basic search", () => {
    expect(decideProviderOwnSearch({ origin, policy: "zdr-only", zdrStated: false })).toEqual({
      kind: "withheld",
      reason: "zdr-not-stated",
    });
    expect(decideProviderOwnSearch({ origin, policy: "zdr-only", zdrStated: true })).toEqual({
      kind: "allowed",
      origin,
      basicOnly: true,
    });
  });

  it("withholds every provider's own search under both EU policies", () => {
    for (const policy of ["eu-only", "eu-and-zdr"] as const) {
      for (const each of Object.keys(PROVIDER_OWN_SEARCH_OFFERS) as Array<
        keyof typeof PROVIDER_OWN_SEARCH_OFFERS
      >) {
        expect(decideProviderOwnSearch({ origin: each, policy, zdrStated: true })).toEqual({
          kind: "withheld",
          reason: "eu-processing-not-offered",
        });
      }
    }
  });

  it("withholds it where the endpoint has no search Octant can name", () => {
    expect(decideProviderOwnSearch({ origin: undefined, policy: "any", zdrStated: true })).toEqual({
      kind: "withheld",
      reason: "no-own-search",
    });
  });
});

describe("a native harness turn's provider search", () => {
  const base = {
    research: true,
    routing: "automatic" as const,
    origin: "anthropic-api" as const,
    policy: "any" as const,
    zdrStated: false,
    webSearchReady: false,
    tainted: false,
    fullAccess: false,
  };

  it("offers it when the route picks the provider's search, ending at the turn's first step below Full access", () => {
    expect(decideHarnessProviderSearch(base)).toEqual({
      basicOnly: false,
      withdrawAfterFirstStep: true,
    });
    expect(decideHarnessProviderSearch({ ...base, fullAccess: true })).toEqual({
      basicOnly: false,
      withdrawAfterFirstStep: false,
    });
  });

  it("withholds it from a tainted thread below Full access, which searches through web-search when a backend is eligible", () => {
    expect(decideHarnessProviderSearch({ ...base, tainted: true })).toBeUndefined();
    expect(decideHarnessProviderSearch({ ...base, tainted: true, fullAccess: true })).toBeDefined();
    expect(
      decideHarnessProviderSearch({ ...base, routing: "provider-native", tainted: true }),
    ).toBeUndefined();
  });

  it("follows the research route and the data policy", () => {
    expect(decideHarnessProviderSearch({ ...base, research: false })).toBeUndefined();
    expect(decideHarnessProviderSearch({ ...base, routing: "searxng" })).toBeUndefined();
    expect(decideHarnessProviderSearch({ ...base, origin: undefined })).toBeUndefined();
    expect(decideHarnessProviderSearch({ ...base, policy: "eu-only" })).toBeUndefined();
    expect(decideHarnessProviderSearch({ ...base, policy: "zdr-only", zdrStated: true })).toEqual({
      basicOnly: true,
      withdrawAfterFirstStep: true,
    });
  });
});

describe("a provider's own search on the research route", () => {
  it("keeps the provider's report under Any and withholds a search the policy cannot hold under any other", () => {
    const decide = (
      policy: "any" | "zdr-only" | "eu-only",
      origin: "anthropic-api" | undefined,
      zdrStated = false,
    ) =>
      providerNativeResearchUnderPolicy({ nativeResearch: "supported", origin, policy, zdrStated });
    expect(decide("any", undefined)).toEqual({ nativeResearch: "supported", withheld: false });
    expect(decide("eu-only", "anthropic-api", true)).toEqual({
      nativeResearch: "supported",
      withheld: true,
    });
    expect(decide("zdr-only", undefined, true).withheld).toBe(true);
    expect(decide("zdr-only", "anthropic-api", true).withheld).toBe(false);
    expect(
      providerNativeResearchUnderPolicy({
        nativeResearch: "unsupported",
        origin: undefined,
        policy: "eu-only",
        zdrStated: false,
      }),
    ).toEqual({ nativeResearch: "unsupported", withheld: false });
  });

  it("reads a withheld search as unavailable with the data policy as its reason", () => {
    expect(
      resolveResearchBackend({
        researchEnabled: true,
        routing: "provider-native",
        webSearchReady: false,
        appManagedTools: "supported",
        nativeResearch: "supported",
        nativeResearchWithheld: true,
      }),
    ).toEqual({ kind: "unavailable", reason: "native-research-withheld-by-data-policy" });
  });
});
