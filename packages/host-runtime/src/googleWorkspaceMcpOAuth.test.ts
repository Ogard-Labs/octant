import { describe, expect, it } from "vitest";
import {
  GOOGLE_WORKSPACE_MCP_OAUTH,
  googleWorkspaceMcpScopeMatches,
  isGoogleWorkspaceMcpDescriptorBinding,
} from "./googleWorkspaceMcpOAuth";

const binding = {
  resource: "https://gmailmcp.googleapis.com/mcp/v1",
  authorizationEndpoint: GOOGLE_WORKSPACE_MCP_OAUTH.authorizationEndpoint,
  tokenEndpoint: GOOGLE_WORKSPACE_MCP_OAUTH.tokenEndpoint,
  clientId: "123-test.apps.googleusercontent.com",
  scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
};

describe("Google Workspace broker binding", () => {
  it("refuses an endpoint substitution, a non-native client shape, or a confidential client on the public native flow", () => {
    expect(isGoogleWorkspaceMcpDescriptorBinding(binding)).toBe(true);
    expect(
      isGoogleWorkspaceMcpDescriptorBinding({
        ...binding,
        tokenEndpoint: "https://attacker.example/token",
      }),
    ).toBe(false);
    expect(
      isGoogleWorkspaceMcpDescriptorBinding({ ...binding, clientId: "not-a-google-client" }),
    ).toBe(false);
    expect(
      isGoogleWorkspaceMcpDescriptorBinding({
        ...binding,
        clientAuthentication: { secretRef: "not-allowed" },
      }),
    ).toBe(false);
  });

  it("refuses missing, expanded, cross-service, and duplicate token scopes", () => {
    for (const scope of [
      "",
      "https://mail.google.com/",
      "https://www.googleapis.com/auth/drive.readonly",
      `${binding.scopes[0]} https://www.googleapis.com/auth/gmail.send`,
      `${binding.scopes[0]} ${binding.scopes[0]}`,
    ]) {
      expect(googleWorkspaceMcpScopeMatches(binding.resource, scope)).toBe(false);
    }
    expect(googleWorkspaceMcpScopeMatches(binding.resource, binding.scopes.join(" "))).toBe(true);
  });
});
