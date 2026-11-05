import { describe, expect, it } from "vitest";
import { decodeHostOAuthDescriptor } from "./hostOAuth";

const descriptor = {
  descriptorId: "slack-user-fixture",
  dialect: "slack-mcp-user",
  flow: "authorization-code-pkce",
  clientId: "owned-fixture-client",
  termsId: "mcp-terms-fixture",
  scopes: ["search:read.public"],
  redirectPort: 43125,
  resource: "https://mcp.slack.com",
  mcpIssuer: "https://mcp.slack.com",
  mcpTransportUrl: "https://mcp.slack.com/mcp",
  authorizationEndpoint: "https://slack.com/oauth/v2_user/authorize",
  tokenEndpoint: "https://slack.com/api/oauth.v2.user.access",
  clientAuthentication: {
    method: "client_secret_post",
    secretRef: "55000000-0000-4000-8000-000000000001",
    tokenEndpoint: "https://slack.com/api/oauth.v2.user.access",
  },
};
describe("closed Slack MCP user-token contract", () => {
  it("keeps transport, OAuth origin resource, issuer and endpoints distinct and pinned", () => {
    expect(decodeHostOAuthDescriptor(descriptor)).toEqual(descriptor);
  });
  it.each([
    { resource: "https://mcp.slack.com/mcp" },
    { resource: "https://other.example" },
    { mcpIssuer: "https://other.example" },
    { mcpTransportUrl: "https://mcp.slack.com/other" },
    { mcpTransportUrl: "https://mcp.slack.com/mcp?tools=all" },
    { authorizationEndpoint: "https://slack.com/oauth/v2/authorize" },
    { tokenEndpoint: "https://slack.com/api/oauth.v2.access" },
    { mcpIssuer: undefined },
    { clientAuthentication: undefined },
    { clientAuthentication: { ...descriptor.clientAuthentication, method: "client_secret_basic" } },
    { scopes: ["search:read.public", "chat:write"] },
    { scopes: [] },
    { dialect: "mcp-authorization" },
  ])("rejects a widened or incomplete vendor tuple before beginning", (changed) => {
    expect(() => decodeHostOAuthDescriptor({ ...descriptor, ...changed })).toThrow();
  });
});
