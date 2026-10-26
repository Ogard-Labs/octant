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

  it("carries a directory sign-in's tenant, client, audience, and endpoint, and no URL or scope", () => {
    const directory = {
      descriptorId: "azure-foundry-directory",
      dialect: "directory-oidc",
      flow: "authorization-code-pkce",
      clientId: "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d",
      tenantId: "6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
      audience: "https://cognitiveservices.azure.com",
      endpointOrigin: "https://contoso.openai.azure.com",
      scopes: [],
      termsId: "azure-foundry-directory-1",
    } as const;
    expect(decodeHostOAuthDescriptor(directory)).toEqual(directory);

    // The broker builds the authority from its closed issuer host, so a
    // directory descriptor that names a URL could point a sign-in elsewhere.
    for (const extra of [
      { tokenEndpoint: "https://login.example/token" },
      { authorizationEndpoint: "https://login.example/authorize" },
      { scopes: ["https://other.example/.default"] },
      { tenantId: "common" },
      { clientId: "octant" },
      { endpointOrigin: "https://contoso.openai.azure.com/openai/v1/" },
    ]) {
      expect(() => decodeHostOAuthDescriptor({ ...directory, ...extra })).toThrow();
    }
    // Every other flow still names its token endpoint and no directory field.
    expect(() =>
      decodeHostOAuthDescriptor({
        descriptorId: "openrouter",
        dialect: "openrouter-pkce",
        flow: "authorization-code-pkce",
        authorizationEndpoint: "https://openrouter.ai/auth",
        scopes: [],
        termsId: "openrouter-terms-1",
      }),
    ).toThrow();
  });

  it("lets only the directory dialect pair with a device-code sign-in, still naming no URL", () => {
    const directory = {
      descriptorId: "azure-foundry-directory",
      dialect: "directory-oidc",
      flow: "device-code",
      clientId: "0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d",
      tenantId: "6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
      audience: "https://cognitiveservices.azure.com",
      endpointOrigin: "https://contoso.openai.azure.com",
      scopes: [],
      termsId: "azure-foundry-directory-1",
    } as const;
    expect(decodeHostOAuthDescriptor(directory)).toEqual(directory);
    // The broker builds the tenant's device authorization URL itself.
    expect(() =>
      decodeHostOAuthDescriptor({
        ...directory,
        deviceAuthorizationEndpoint: "https://login.example/devicecode",
      }),
    ).toThrow();
    // Every other dialect's wire shape is not OAuth's, so none pairs with a device code.
    expect(() =>
      decodeHostOAuthDescriptor({
        descriptorId: "mcp-server",
        dialect: "mcp-authorization",
        flow: "device-code",
        clientId: "public-client",
        tokenEndpoint: "https://idp.example/token",
        deviceAuthorizationEndpoint: "https://idp.example/device",
        resource: "https://mcp.example/",
        scopes: [],
        termsId: "mcp-terms-1",
      }),
    ).toThrow();
  });

  it("names a directory account on a finished sign-in and a sign-in the organization wants repeated in person", () => {
    expect(
      decodeHostOAuthSignInState({
        kind: "signed-in",
        attemptId: "80000000-0000-4000-8000-000000000001",
        descriptorId: "azure-foundry-directory",
        credentialRef: "80000000-0000-4000-8000-000000000002",
        accountLabel: "person@contoso.example",
      }),
    ).toMatchObject({ accountLabel: "person@contoso.example" });
    expect(
      decodeHostOAuthSignInState({
        kind: "sign-in-again",
        credentialRef: "80000000-0000-4000-8000-000000000002",
        reason: "interaction-required",
      }),
    ).toMatchObject({ reason: "interaction-required" });
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
