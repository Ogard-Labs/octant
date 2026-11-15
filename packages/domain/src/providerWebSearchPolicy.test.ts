import { decodeProviderInstance, type ProviderInstance } from "@octant/contracts/providers";
import type { UtcTimestamp } from "@octant/contracts/events";
import { describe, expect, it } from "vitest";
import { setProviderSearchZdr } from "./providerPolicy";
import { resolveProviderNativeSetup } from "./providerNativeSetupPolicy";
import {
  PROVIDER_OWN_SEARCH_OFFERS,
  decideProviderOwnSearch,
  providerOwnSearchOrigin,
} from "./providerWebSearchPolicy";

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

describe("the endpoint's ZDR statement for its own search", () => {
  const at = "2026-11-14T12:01:00.000Z" as UtcTimestamp;

  it("is kept for Anthropic's own API and withdrawn when the person unticks it", () => {
    const stated = setProviderSearchZdr(anthropic("https://api.anthropic.com/v1/"), true, at);
    expect(stated.providerSearchZdr).toBe(true);
    expect(setProviderSearchZdr(stated, false, at).providerSearchZdr).toBeUndefined();
  });

  it("is refused for an endpoint whose provider offers no search Octant can hold to it", () => {
    expect(() =>
      setProviderSearchZdr(anthropic("https://gateway.example/anthropic/"), true, at),
    ).toThrow("This endpoint's provider does not offer web search with no record kept.");
  });
});

describe("a vendor runtime's own web tools under the data policy", () => {
  const input = {
    driverKind: "claude" as const,
    mode: "code" as const,
    executionPolicy: "full-access" as const,
    accountAllows: true,
    projectTrusts: false,
  };

  it("follow the native-setup policy under Any", () => {
    expect(resolveProviderNativeSetup({ ...input, webSearchPolicy: "any" })?.webTools).toBe(true);
  });

  it("stay off under every other policy while the rest of the setup still loads", () => {
    for (const webSearchPolicy of ["zdr-only", "eu-only", "eu-and-zdr"] as const) {
      const setup = resolveProviderNativeSetup({ ...input, webSearchPolicy });
      expect(setup?.webTools).toBe(false);
      expect(setup?.subagents).toBe(true);
    }
  });
});
