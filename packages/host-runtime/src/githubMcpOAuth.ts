import type { McpOAuthAccount } from "./mcpOAuthAccount";

/** Closed GitHub.com OAuth App policy; PAT and GitHub App installation permissions are separate. */
export const GITHUB_MCP_OAUTH_APP = {
  dialect: "github-mcp-oauth-app",
  transportUrl: "https://api.githubcopilot.com/mcp/",
  resource: "https://api.githubcopilot.com/mcp/",
  issuer: "https://github.com/login/oauth",
  authorizationEndpoint: "https://github.com/login/oauth/authorize",
  tokenEndpoint: "https://github.com/login/oauth/access_token",
  identityEndpoint: "https://api.github.com/user",
  readScope: "read:user",
  rotationScope: "offline_access",
  apiVersion: "2026-03-10",
  userAgent: "Octant",
} as const;

interface Binding {
  readonly clientId?: unknown;
  readonly resource?: unknown;
  readonly tokenEndpoint?: unknown;
  readonly mcpTransportUrl?: unknown;
  readonly mcpIssuer?: unknown;
  readonly clientAuthentication?:
    | { readonly method?: unknown; readonly tokenEndpoint?: unknown }
    | undefined;
}
export function isGithubMcpGrantBinding(value: Binding): boolean {
  return (
    typeof value.clientId === "string" &&
    /^[^\s/?#]{1,256}$/.test(value.clientId) &&
    value.resource === GITHUB_MCP_OAUTH_APP.resource &&
    value.mcpTransportUrl === GITHUB_MCP_OAUTH_APP.transportUrl &&
    value.mcpIssuer === GITHUB_MCP_OAUTH_APP.issuer &&
    value.tokenEndpoint === GITHUB_MCP_OAUTH_APP.tokenEndpoint &&
    value.clientAuthentication?.method === "client_secret_post" &&
    value.clientAuthentication.tokenEndpoint === GITHUB_MCP_OAUTH_APP.tokenEndpoint
  );
}
export function isGithubMcpCallbackUri(value: string): boolean {
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return (
      Number.isInteger(port) &&
      port >= 1024 &&
      port <= 65535 &&
      value === `http://127.0.0.1:${port}/oauth/callback`
    );
  } catch {
    return false;
  }
}
export function isGithubMcpDescriptorBinding(
  value: Binding & {
    readonly authorizationEndpoint?: unknown;
    readonly redirectHostname?: unknown;
    readonly redirectPort?: unknown;
    readonly scopes?: unknown;
  },
): boolean {
  return (
    isGithubMcpGrantBinding(value) &&
    value.authorizationEndpoint === GITHUB_MCP_OAUTH_APP.authorizationEndpoint &&
    value.redirectHostname === undefined &&
    Number.isInteger(value.redirectPort) &&
    Number(value.redirectPort) >= 1024 &&
    Number(value.redirectPort) <= 65535 &&
    Array.isArray(value.scopes) &&
    value.scopes.length === 2 &&
    value.scopes.includes(GITHUB_MCP_OAUTH_APP.readScope) &&
    value.scopes.includes(GITHUB_MCP_OAUTH_APP.rotationScope)
  );
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function userId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[1-9][0-9]{0,15}$/.test(value) &&
    Number.isSafeInteger(Number(value))
  );
}
/** Strict persisted projection; no login/email/repository inventory or fabricated workspace. */
export function decodeGithubMcpAccount(value: unknown): McpOAuthAccount | undefined {
  if (
    !object(value) ||
    Object.keys(value).some((key) => key !== "userId" && key !== "grantedScopes") ||
    !userId(value.userId)
  )
    return undefined;
  if (
    value.grantedScopes !== undefined &&
    (!Array.isArray(value.grantedScopes) ||
      value.grantedScopes.length !== 1 ||
      value.grantedScopes[0] !== GITHUB_MCP_OAUTH_APP.readScope)
  )
    return undefined;
  return {
    userId: value.userId,
    ...(value.grantedScopes === undefined
      ? {}
      : { grantedScopes: [GITHUB_MCP_OAUTH_APP.readScope] }),
  };
}

export type GithubMcpAccountResult =
  | { readonly kind: "valid"; readonly account: McpOAuthAccount }
  | { readonly kind: "invalid" | "account-changed" | "permission-missing" | "permission-mismatch" };
function scopes(value: unknown): readonly string[] | undefined {
  if (typeof value !== "string" || value.length > 512 || !/^[\x20-\x7E]*$/.test(value))
    return undefined;
  const values = [...new Set(value.split(/[ ,]+/).filter(Boolean))];
  return values.length <= 16 &&
    values.every((entry) => /^[\x21\x23-\x5B\x5D-\x7E]{1,128}$/.test(entry))
    ? values.filter((entry) => entry !== GITHUB_MCP_OAUTH_APP.rotationScope)
    : undefined;
}
/** The fixed authenticated /user response supplies durable numeric identity, never login text. */
export function githubMcpReportedAccount(input: {
  readonly token: Readonly<Record<string, unknown>>;
  readonly identity: Readonly<Record<string, unknown>>;
  readonly oauthScopes: string | null;
  readonly previous?: McpOAuthAccount;
}): GithubMcpAccountResult {
  const id = input.identity.id;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return { kind: "invalid" };
  const currentId = String(id);
  if (input.previous?.userId !== undefined && input.previous.userId !== currentId)
    return { kind: "account-changed" };
  const reported: string[][] = [];
  for (const value of [input.token.scope, input.oauthScopes ?? undefined]) {
    if (value === undefined) continue;
    const parsed = scopes(value);
    if (parsed === undefined) return { kind: "invalid" };
    if (parsed.some((entry) => entry !== GITHUB_MCP_OAUTH_APP.readScope))
      return { kind: "permission-mismatch" };
    if (!parsed.includes(GITHUB_MCP_OAUTH_APP.readScope)) return { kind: "permission-missing" };
    reported.push([...parsed]);
  }
  const latest = reported[reported.length - 1] ?? input.previous?.grantedScopes;
  if (latest === undefined) return { kind: "permission-missing" };
  return { kind: "valid", account: { userId: currentId, grantedScopes: [...latest] } };
}
