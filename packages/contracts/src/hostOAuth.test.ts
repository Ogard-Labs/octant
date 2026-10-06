import { describe, expect, it } from "vitest";
import {
  decodeHostOAuthDescriptor,
  decodeHostOAuthJournalRecord,
  decodeHostOAuthSignInOffer,
  decodeHostOAuthSignInState,
  decodeSubscriptionOAuthOffer,
} from "./hostOAuth";

describe("host OAuth contracts", () => {
  it("rejects a journal record that carries a token", () => {
    expect(() =>
      decodeHostOAuthJournalRecord({
        name: "host-oauth.sign-in-completed",
        descriptorId: "sample-http",
        attemptId: "6b0d0c2e-0d3a-4f0b-9c1a-6e5d4c3b2a19",
        credentialRef: "7c1e1d3f-1e4b-4051-8d2b-7f6e5d4c3b2a",
        accessToken: "must-not-decode",
      }),
    ).toThrow();
  });

  it("rejects a sign-in state that carries a refresh token", () => {
    expect(() =>
      decodeHostOAuthSignInState({
        kind: "signed-in",
        attemptId: "6b0d0c2e-0d3a-4f0b-9c1a-6e5d4c3b2a19",
        descriptorId: "sample-http",
        credentialRef: "7c1e1d3f-1e4b-4051-8d2b-7f6e5d4c3b2a",
        refreshToken: "must-not-decode",
      }),
    ).toThrow();
  });

  it("requires the API-key path on every sign-in offer", () => {
    const offer = decodeHostOAuthSignInOffer({
      oauth: { available: true, termsRequired: true },
      apiKey: { available: true },
    });
    expect(offer.apiKey.available).toBe(true);
    expect(() =>
      decodeHostOAuthSignInOffer({
        oauth: { available: true, termsRequired: false },
        apiKey: { available: false },
      }),
    ).toThrow();
  });

  it("round-trips a dialect descriptor without a client ID or scopes", () => {
    const decoded = decodeHostOAuthDescriptor({
      descriptorId: "openrouter",
      dialect: "openrouter-pkce",
      flow: "authorization-code-pkce",
      authorizationEndpoint: "https://openrouter.ai/auth",
      tokenEndpoint: "https://openrouter.ai/api/v1/auth/keys",
      scopes: [],
      termsId: "openrouter-terms-1",
    });
    expect(decoded.dialect).toBe("openrouter-pkce");
    expect(decoded.clientId).toBeUndefined();
    expect(decoded.scopes).toEqual([]);
  });

  it("requires a client ID and one scope for a standard flow", () => {
    expect(() =>
      decodeHostOAuthDescriptor({
        descriptorId: "sample-http",
        flow: "authorization-code-pkce",
        authorizationEndpoint: "https://example.com/authorize",
        tokenEndpoint: "https://example.com/token",
        scopes: [],
        termsId: "terms-1",
      }),
    ).toThrow();
    expect(() =>
      decodeHostOAuthDescriptor({
        descriptorId: "sample-http",
        clientId: "client",
        flow: "authorization-code-pkce",
        authorizationEndpoint: "https://example.com/authorize",
        tokenEndpoint: "https://example.com/token",
        scopes: [],
        termsId: "terms-1",
      }),
    ).toThrow();
  });

  it("refuses a dialect paired with a device-code grant", () => {
    expect(() =>
      decodeHostOAuthDescriptor({
        descriptorId: "openrouter",
        dialect: "openrouter-pkce",
        flow: "device-code",
        tokenEndpoint: "https://openrouter.ai/api/v1/auth/keys",
        deviceAuthorizationEndpoint: "https://openrouter.ai/api/v1/auth/device",
        scopes: [],
        termsId: "openrouter-terms-1",
      }),
    ).toThrow();
  });

  it("requires an allowed endpoint on every catalog offer", () => {
    const offer = decodeSubscriptionOAuthOffer({
      descriptor: {
        descriptorId: "openrouter",
        dialect: "openrouter-pkce",
        flow: "authorization-code-pkce",
        authorizationEndpoint: "https://openrouter.ai/auth",
        tokenEndpoint: "https://openrouter.ai/api/v1/auth/keys",
        scopes: [],
        termsId: "openrouter-terms-1",
      },
      accountLabel: "OpenRouter account",
      termsSummary: "Terms.",
      driverKinds: ["openai-compatible"],
      allowedEndpoint: "https://openrouter.ai/api/v1",
    });
    expect(offer.allowedEndpoint).toBe("https://openrouter.ai/api/v1");
    expect(() =>
      decodeSubscriptionOAuthOffer({
        descriptor: {
          descriptorId: "openrouter",
          dialect: "openrouter-pkce",
          flow: "authorization-code-pkce",
          authorizationEndpoint: "https://openrouter.ai/auth",
          tokenEndpoint: "https://openrouter.ai/api/v1/auth/keys",
          scopes: [],
          termsId: "openrouter-terms-1",
        },
        accountLabel: "OpenRouter account",
        termsSummary: "Terms.",
        driverKinds: ["openai-compatible"],
      }),
    ).toThrow();
  });
});
