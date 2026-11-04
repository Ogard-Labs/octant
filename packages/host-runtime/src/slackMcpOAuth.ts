/** The dedicated user-token response labels its identity "user", not its HTTP auth scheme. */
export const SLACK_MCP_USER_OAUTH = {
  dialect: "slack-mcp-user",
  transportUrl: "https://mcp.slack.com/mcp",
  resource: "https://mcp.slack.com",
  issuer: "https://mcp.slack.com",
  readScope: "search:read.public",
  authorizationEndpoint: "https://slack.com/oauth/v2_user/authorize",
  tokenEndpoint: "https://slack.com/api/oauth.v2.user.access",
} as const;

/** This exact alias is host-owned; every other server keeps exact transport/resource equality. */
export function mcpOAuthResourceForTransport(transportUrl: string): string {
  return transportUrl === SLACK_MCP_USER_OAUTH.transportUrl
    ? SLACK_MCP_USER_OAUTH.resource
    : transportUrl;
}

interface GrantBinding {
  readonly resource?: unknown;
  readonly tokenEndpoint?: unknown;
  readonly mcpTransportUrl?: unknown;
  readonly mcpIssuer?: unknown;
  readonly clientAuthentication?:
    | {
        readonly method?: unknown;
        readonly tokenEndpoint?: unknown;
      }
    | undefined;
}

/** Public none and Basic are not advertised by the observed dedicated authorization server. */
export function isSlackMcpUserGrantBinding(binding: GrantBinding): boolean {
  return (
    binding.resource === SLACK_MCP_USER_OAUTH.resource &&
    binding.tokenEndpoint === SLACK_MCP_USER_OAUTH.tokenEndpoint &&
    binding.mcpTransportUrl === SLACK_MCP_USER_OAUTH.transportUrl &&
    binding.mcpIssuer === SLACK_MCP_USER_OAUTH.issuer &&
    binding.clientAuthentication?.method === "client_secret_post" &&
    binding.clientAuthentication.tokenEndpoint === SLACK_MCP_USER_OAUTH.tokenEndpoint
  );
}

export function isSlackMcpUserDescriptorBinding(
  binding: GrantBinding & {
    readonly authorizationEndpoint?: unknown;
    readonly scopes?: unknown;
  },
): boolean {
  return (
    isSlackMcpUserGrantBinding(binding) &&
    binding.authorizationEndpoint === SLACK_MCP_USER_OAUTH.authorizationEndpoint &&
    Array.isArray(binding.scopes) &&
    binding.scopes.length === 1 &&
    binding.scopes[0] === SLACK_MCP_USER_OAUTH.readScope
  );
}
