import type { McpOAuthAccount } from "./mcpOAuthAccount";
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

/** Only verified, exact vendor transports may name a distinct OAuth resource. */
export function mcpOAuthResourceForTransport(transportUrl: string): string {
  if (transportUrl === SLACK_MCP_USER_OAUTH.transportUrl) return SLACK_MCP_USER_OAUTH.resource;
  // Airtable's published metadata names its origin, while MCP uses /mcp.
  if (transportUrl === "https://mcp.airtable.com/mcp") return "https://mcp.airtable.com";
  return transportUrl;
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
    readonly redirectHostname?: unknown;
    readonly redirectPort?: unknown;
    readonly scopes?: unknown;
  },
): boolean {
  return (
    isSlackMcpUserGrantBinding(binding) &&
    binding.redirectHostname === "localhost" &&
    Number.isInteger(binding.redirectPort) &&
    Number(binding.redirectPort) >= 1024 &&
    Number(binding.redirectPort) <= 65535 &&
    binding.authorizationEndpoint === SLACK_MCP_USER_OAUTH.authorizationEndpoint &&
    Array.isArray(binding.scopes) &&
    binding.scopes.length === 1 &&
    binding.scopes[0] === SLACK_MCP_USER_OAUTH.readScope
  );
}

/** Exact localhost callback, chosen by the app owner before consent. */
export function isSlackMcpCallbackUri(value: string): boolean {
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return (
      Number.isInteger(port) &&
      port >= 1024 &&
      port <= 65535 &&
      value === `http://localhost:${port}/oauth/callback`
    );
  } catch {
    return false;
  }
}

/** Last account facts reported by the dedicated token endpoint, never JWT-derived names. */
export type SlackMcpAccount = McpOAuthAccount;

export function decodeSlackMcpAccount(value: unknown): SlackMcpAccount | undefined {
  if (
    !accountObject(value) ||
    Object.keys(value).some((key) => !["workspaceId", "userId", "grantedScopes"].includes(key))
  )
    return undefined;
  if (value.workspaceId !== undefined && !accountId(value.workspaceId)) return undefined;
  if (value.userId !== undefined && !accountId(value.userId)) return undefined;
  if (
    value.grantedScopes !== undefined &&
    (!Array.isArray(value.grantedScopes) ||
      value.grantedScopes.length > 64 ||
      !value.grantedScopes.every(
        (scope) =>
          typeof scope === "string" &&
          scope.length <= 128 &&
          /^[\x21\x23-\x5B\x5D-\x7E]+$/.test(scope),
      ) ||
      !value.grantedScopes.includes(SLACK_MCP_USER_OAUTH.readScope))
  )
    return undefined;
  if (
    value.workspaceId === undefined &&
    value.userId === undefined &&
    value.grantedScopes === undefined
  )
    return undefined;
  return {
    ...(typeof value.workspaceId === "string" ? { workspaceId: value.workspaceId } : {}),
    ...(typeof value.userId === "string" ? { userId: value.userId } : {}),
    ...(Array.isArray(value.grantedScopes) ? { grantedScopes: value.grantedScopes } : {}),
  };
}

export function slackMcpReportedAccount(
  body: Record<string, unknown>,
  previous?: SlackMcpAccount,
):
  | { readonly kind: "valid"; readonly account?: SlackMcpAccount }
  | { readonly kind: "invalid" | "account-changed" | "permission-missing" } {
  const team = body.team;
  const user = body.authed_user;
  if ((team !== undefined && !accountObject(team)) || (user !== undefined && !accountObject(user)))
    return { kind: "invalid" };
  const workspaceId = accountObject(team) ? team.id : undefined;
  const userId = accountObject(user) ? user.id : undefined;
  if (
    (workspaceId !== undefined && !accountId(workspaceId)) ||
    (userId !== undefined && !accountId(userId))
  )
    return { kind: "invalid" };
  if (
    (workspaceId !== undefined &&
      previous?.workspaceId !== undefined &&
      workspaceId !== previous.workspaceId) ||
    (userId !== undefined && previous?.userId !== undefined && userId !== previous.userId)
  )
    return { kind: "account-changed" };
  const scope = accountObject(user) ? user.scope : undefined;
  let grantedScopes: readonly string[] | undefined = previous?.grantedScopes;
  if (scope !== undefined) {
    if (typeof scope !== "string" || scope.length > 8192 || /[^\x20-\x7E]/.test(scope))
      return { kind: "invalid" };
    const parsed = [...new Set(scope.split(/[ ,]+/).filter(Boolean))].sort();
    if (
      parsed.length > 64 ||
      parsed.some((value) => value.length > 128 || !/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(value))
    )
      return { kind: "invalid" };
    if (!parsed.includes(SLACK_MCP_USER_OAUTH.readScope)) return { kind: "permission-missing" };
    grantedScopes = parsed;
  }
  const account = {
    ...(typeof workspaceId === "string"
      ? { workspaceId }
      : previous?.workspaceId === undefined
        ? {}
        : { workspaceId: previous.workspaceId }),
    ...(typeof userId === "string"
      ? { userId }
      : previous?.userId === undefined
        ? {}
        : { userId: previous.userId }),
    ...(grantedScopes === undefined ? {} : { grantedScopes }),
  };
  return { kind: "valid", ...(Object.keys(account).length === 0 ? {} : { account }) };
}

function accountObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function accountId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9]{1,128}$/.test(value);
}
