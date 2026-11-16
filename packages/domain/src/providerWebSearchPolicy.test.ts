import { decodeProviderInstance, type ProviderInstance } from "@octant/contracts/providers";
import { describe, expect, it } from "vitest";
import { decideHarnessProviderSearch, providerOwnSearchOrigin } from "./providerWebSearchPolicy";

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

describe("a native harness turn's provider search", () => {
  const base = {
    research: true,
    routing: "automatic" as const,
    origin: "anthropic-api" as const,
    webSearchReady: false,
    tainted: false,
    fullAccess: false,
    strict: true,
  };

  it("outside Strict keeps offering it to a thread that read outside content, for the whole turn", () => {
    expect(decideHarnessProviderSearch({ ...base, strict: false })).toEqual({
      withdrawAfterFirstStep: false,
    });
    expect(decideHarnessProviderSearch({ ...base, strict: false, tainted: true })).toEqual({
      withdrawAfterFirstStep: false,
    });
  });

  it("offers it when the route picks the provider's search, ending at the turn's first step below Full access", () => {
    expect(decideHarnessProviderSearch(base)).toEqual({ withdrawAfterFirstStep: true });
    expect(decideHarnessProviderSearch({ ...base, fullAccess: true })).toEqual({
      withdrawAfterFirstStep: false,
    });
  });

  it("under Strict withholds it from a tainted thread below Full access, which searches through web-search when a backend is eligible", () => {
    expect(decideHarnessProviderSearch({ ...base, tainted: true })).toBeUndefined();
    expect(decideHarnessProviderSearch({ ...base, tainted: true, fullAccess: true })).toBeDefined();
    expect(
      decideHarnessProviderSearch({ ...base, routing: "provider-native", tainted: true }),
    ).toBeUndefined();
  });

  it("follows the research route, offering it first on Automatic even when a backend is eligible", () => {
    expect(decideHarnessProviderSearch({ ...base, research: false })).toBeUndefined();
    expect(decideHarnessProviderSearch({ ...base, routing: "searxng" })).toBeUndefined();
    expect(decideHarnessProviderSearch({ ...base, origin: undefined })).toBeUndefined();
    expect(decideHarnessProviderSearch({ ...base, webSearchReady: true })).toEqual({
      withdrawAfterFirstStep: true,
    });
  });
});
