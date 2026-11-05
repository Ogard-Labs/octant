/** Google's native-client wire rules, independently checked inside the credential broker. */
export const GOOGLE_WORKSPACE_MCP_OAUTH = {
  issuer: "https://accounts.google.com",
  authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenEndpoint: "https://oauth2.googleapis.com/token",
} as const;

const READ_SCOPES: Readonly<Record<string, ReadonlyArray<string>>> = {
  "https://gmailmcp.googleapis.com/mcp/v1": ["https://www.googleapis.com/auth/gmail.readonly"],
  "https://drivemcp.googleapis.com/mcp/v1": ["https://www.googleapis.com/auth/drive.readonly"],
  "https://calendarmcp.googleapis.com/mcp/v1": [
    "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events.readonly",
  ],
};

export function googleWorkspaceMcpScopes(
  resource: string | undefined,
): ReadonlyArray<string> | undefined {
  return resource === undefined || !Object.hasOwn(READ_SCOPES, resource)
    ? undefined
    : READ_SCOPES[resource];
}

export function googleWorkspaceMcpScopeMatches(
  resource: string | undefined,
  scope: string,
): boolean {
  const expected = googleWorkspaceMcpScopes(resource);
  if (expected === undefined) return false;
  const granted = scope.split(/\s+/).filter(Boolean);
  return (
    granted.length === expected.length &&
    new Set(granted).size === expected.length &&
    expected.every((entry) => granted.includes(entry))
  );
}

export function isGoogleWorkspaceMcpDescriptorBinding(value: {
  readonly resource?: string;
  readonly authorizationEndpoint?: string;
  readonly tokenEndpoint?: string;
  readonly clientId?: string;
  readonly scopes: ReadonlyArray<string>;
  readonly clientAuthentication?: unknown;
  readonly redirectHostname?: string;
  readonly mcpIssuer?: string;
  readonly mcpTransportUrl?: string;
}): boolean {
  return (
    googleWorkspaceMcpScopes(value.resource) !== undefined &&
    value.authorizationEndpoint === GOOGLE_WORKSPACE_MCP_OAUTH.authorizationEndpoint &&
    value.tokenEndpoint === GOOGLE_WORKSPACE_MCP_OAUTH.tokenEndpoint &&
    typeof value.clientId === "string" &&
    /^[A-Za-z0-9_-]{1,200}\.apps\.googleusercontent\.com$/.test(value.clientId) &&
    value.clientAuthentication === undefined &&
    value.redirectHostname === undefined &&
    value.mcpIssuer === undefined &&
    value.mcpTransportUrl === undefined &&
    googleWorkspaceMcpScopeMatches(value.resource, value.scopes.join(" "))
  );
}

export function isGoogleWorkspaceMcpGrantBinding(value: {
  readonly resource?: unknown;
  readonly tokenEndpoint?: unknown;
  readonly clientId?: unknown;
  readonly clientAuthentication?: unknown;
}): boolean {
  return (
    typeof value.resource === "string" &&
    googleWorkspaceMcpScopes(value.resource) !== undefined &&
    value.tokenEndpoint === GOOGLE_WORKSPACE_MCP_OAUTH.tokenEndpoint &&
    typeof value.clientId === "string" &&
    /^[A-Za-z0-9_-]{1,200}\.apps\.googleusercontent\.com$/.test(value.clientId) &&
    value.clientAuthentication === undefined
  );
}

/** Fresh account consent obtains the missing local refresh grant; ordinary reconnect never enters it. */
export function googleWorkspaceMcpAuthorizationRequest(authorizationUrl: string): string {
  const url = new URL(authorizationUrl);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "select_account consent");
  url.searchParams.set("include_granted_scopes", "false");
  return url.href;
}
