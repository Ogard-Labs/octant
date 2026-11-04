import { describe, expect, it } from "vitest";
import { decodeMcpServerSignInRequest } from "./extensionRpc";
import { decodeHostOAuthDescriptor, decodeMcpOAuthClientRegistration } from "./hostOAuth";

const descriptor = {
  descriptorId: "slack-user-fixture",
  dialect: "slack-mcp-user",
  flow: "authorization-code-pkce",
  clientId: "owned-fixture-client",
  termsId: "mcp-terms-fixture",
  scopes: ["search:read.public"],
  redirectPort: 43125,
  redirectHostname: "localhost",
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
  it("retains an explicit registered Slack localhost choice without widening other registrations", () => {
    const registration = {
      kind: "registered",
      resource: descriptor.resource,
      issuer: descriptor.mcpIssuer,
      clientId: descriptor.clientId,
      redirectPort: descriptor.redirectPort,
      redirectHostname: "localhost",
      clientAuthentication: descriptor.clientAuthentication,
    };
    expect(decodeMcpOAuthClientRegistration(registration)).toEqual(registration);
    expect(
      decodeMcpServerSignInRequest({
        kind: "configure-client",
        extensionId: "44000000-0000-4000-8000-000000000002",
        componentId: "slack-fixture",
        registration,
      }),
    ).toMatchObject({ registration });
    expect(() =>
      decodeMcpOAuthClientRegistration({ ...registration, resource: "https://other.example/mcp" }),
    ).toThrow();
    expect(() =>
      decodeMcpOAuthClientRegistration({ ...registration, issuer: "https://other.example" }),
    ).toThrow();
    expect(() =>
      decodeHostOAuthDescriptor({
        ...descriptor,
        dialect: "mcp-authorization",
        mcpTransportUrl: undefined,
        mcpIssuer: undefined,
        resource: "https://other.example/mcp",
        authorizationEndpoint: "https://other.example/authorize",
        tokenEndpoint: "https://other.example/token",
        clientAuthentication: undefined,
      }),
    ).toThrow();
  });
  it("keeps transport, OAuth origin resource, issuer and endpoints distinct and pinned", () => {
    expect(decodeHostOAuthDescriptor(descriptor)).toEqual(descriptor);
  });
  it.each([
    { redirectHostname: undefined },
    { redirectHostname: "127.0.0.1" },
    { redirectPort: undefined },
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
