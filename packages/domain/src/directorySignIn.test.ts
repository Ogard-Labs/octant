import { decodeDirectoryClientId, decodeDirectoryTenantId } from "@octant/contracts";
import { decodeHostOAuthDescriptor } from "@octant/contracts/host-oauth";
import { describe, expect, it } from "vitest";
import { azureFoundryDirectoryDescriptor } from "./directorySignIn";

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
