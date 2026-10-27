import {
  decodeDirectoryClientId,
  decodeDirectoryIssuer,
  decodeDirectoryIssuerClientId,
  decodeDirectoryResourceScope,
  decodeDirectoryTenantId,
} from "@octant/contracts";
import { decodeHostOAuthDescriptor } from "@octant/contracts/host-oauth";
import { describe, expect, it } from "vitest";
import { azureFoundryDirectoryDescriptor, gatewayDirectoryDescriptor } from "./directorySignIn";

const directory = {
  tenantId: decodeDirectoryTenantId("6f1c2d3e-4a5b-4c6d-8e7f-9a0b1c2d3e4f"),
  clientId: decodeDirectoryClientId("0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d"),
};

describe("Azure AI Foundry organization sign-in", () => {
  it("binds a sign-in to the endpoint's origin, the Foundry audience, and the instance's tenant and client", () => {
    const descriptor = azureFoundryDirectoryDescriptor({
      baseUrl: "https://Contoso.services.ai.azure.com/openai/v1/",
      directory,
    });

    expect(decodeHostOAuthDescriptor(descriptor)).toEqual({
      descriptorId: "azure-foundry-directory",
      dialect: "directory-oidc",
      flow: "authorization-code-pkce",
      clientId: directory.clientId,
      tenantId: directory.tenantId,
      audience: "https://cognitiveservices.azure.com",
      endpointOrigin: "https://contoso.services.ai.azure.com",
      scopes: [],
      termsId: "azure-foundry-directory-1",
    });
  });

  it("begins a device-code sign-in with the same binding when one is asked for", () => {
    const descriptor = azureFoundryDirectoryDescriptor(
      { baseUrl: "https://contoso.openai.azure.com/openai/v1/", directory },
      "device-code",
    );

    expect(decodeHostOAuthDescriptor(descriptor)).toMatchObject({
      dialect: "directory-oidc",
      flow: "device-code",
      tenantId: directory.tenantId,
      clientId: directory.clientId,
      endpointOrigin: "https://contoso.openai.azure.com",
    });
  });

  it.each([
    ["a host off the Foundry list", "https://models.example.com/openai/v1/"],
    ["a look-alike host", "https://contoso.openai.azure.com.example.com/openai/v1/"],
    ["the bare suffix", "https://openai.azure.com/openai/v1/"],
    ["plain http", "http://contoso.openai.azure.com/openai/v1/"],
    ["embedded credentials", "https://user:pass@contoso.openai.azure.com/openai/v1/"],
  ])("offers no sign-in for %s", (_label, baseUrl) => {
    expect(azureFoundryDirectoryDescriptor({ baseUrl, directory })).toBeUndefined();
  });
});

describe("Gateway organization sign-in", () => {
  const gateway = {
    issuer: decodeDirectoryIssuer("https://login.example.test/oauth2/gateway"),
    clientId: decodeDirectoryIssuerClientId("0oa1octantDesktop"),
    scope: decodeDirectoryResourceScope("gateway.models"),
  };

  it("binds a sign-in to the gateway's origin and the instance's own issuer, client, and scope", () => {
    const descriptor = gatewayDirectoryDescriptor({
      baseUrl: "https://LLM.example.test/v1/",
      directory: gateway,
    });

    expect(decodeHostOAuthDescriptor(descriptor)).toEqual({
      descriptorId: "gateway-directory",
      dialect: "issuer-oidc",
      flow: "authorization-code-pkce",
      clientId: gateway.clientId,
      issuer: gateway.issuer,
      endpointOrigin: "https://llm.example.test",
      scopes: [gateway.scope],
      termsId: "gateway-directory-1",
    });
  });

  it.each([
    ["plain http", "http://llm.example.test/v1/"],
    ["loopback http", "http://127.0.0.1:4000/v1/"],
    ["embedded credentials", "https://user:pass@llm.example.test/v1/"],
    ["an address that is not a URL", "llm.example.test"],
  ])("offers no sign-in for %s", (_label, baseUrl) => {
    expect(gatewayDirectoryDescriptor({ baseUrl, directory: gateway })).toBeUndefined();
  });
});
