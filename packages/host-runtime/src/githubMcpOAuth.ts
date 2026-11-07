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

export const GITHUB_MCP_REPOSITORY_PROFILE = "github-repositories-read-write";
export type GithubMcpPermissionProfile = typeof GITHUB_MCP_REPOSITORY_PROFILE;
/** An omitted profile is always the original profile-read policy. */
export function githubMcpRequiredScopes(profile?: GithubMcpPermissionProfile): readonly string[] {
  return profile === GITHUB_MCP_REPOSITORY_PROFILE
    ? [GITHUB_MCP_OAUTH_APP.readScope, "repo"]
    : [GITHUB_MCP_OAUTH_APP.readScope];
}

interface Binding {
  readonly mcpPermissionProfile?: unknown;
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
    (value.mcpPermissionProfile === undefined ||
      value.mcpPermissionProfile === GITHUB_MCP_REPOSITORY_PROFILE) &&
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
  const selected = value.scopes;
  return (
    isGithubMcpGrantBinding(value) &&
    value.authorizationEndpoint === GITHUB_MCP_OAUTH_APP.authorizationEndpoint &&
    value.redirectHostname === undefined &&
    Number.isInteger(value.redirectPort) &&
    Number(value.redirectPort) >= 1024 &&
    Number(value.redirectPort) <= 65535 &&
    Array.isArray(selected) &&
    selected.length === (value.mcpPermissionProfile === GITHUB_MCP_REPOSITORY_PROFILE ? 3 : 2) &&
    githubMcpRequiredScopes(
      value.mcpPermissionProfile === GITHUB_MCP_REPOSITORY_PROFILE
        ? value.mcpPermissionProfile
        : undefined,
    ).every((scope) => selected.includes(scope)) &&
    selected.includes(GITHUB_MCP_OAUTH_APP.rotationScope)
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
export function decodeGithubMcpAccount(
  value: unknown,
  profile?: GithubMcpPermissionProfile,
): McpOAuthAccount | undefined {
  const expected = githubMcpRequiredScopes(profile);
  if (
    !object(value) ||
    Object.keys(value).some((key) => key !== "userId" && key !== "grantedScopes") ||
    !userId(value.userId)
  )
    return undefined;
  const reported = value.grantedScopes;
  if (
    reported !== undefined &&
    (!Array.isArray(reported) ||
      reported.length !== expected.length ||
      !expected.every((scope) => reported.includes(scope)))
  )
    return undefined;
  return {
    userId: value.userId,
    ...(value.grantedScopes === undefined ? {} : { grantedScopes: [...expected] }),
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
  readonly profile?: GithubMcpPermissionProfile;
}): GithubMcpAccountResult {
  const expected = githubMcpRequiredScopes(input.profile);
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
    if (parsed.some((entry) => !expected.includes(entry))) return { kind: "permission-mismatch" };
    if (!expected.every((scope) => parsed.includes(scope))) return { kind: "permission-missing" };
    reported.push([...parsed]);
  }
  const latest = reported[reported.length - 1] ?? input.previous?.grantedScopes;
  if (latest === undefined || !expected.every((scope) => latest.includes(scope)))
    return { kind: "permission-missing" };
  return { kind: "valid", account: { userId: currentId, grantedScopes: [...expected] } };
}
