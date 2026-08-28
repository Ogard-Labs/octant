export const LINEAR_AUTHORIZE_URL = "https://linear.app/oauth/authorize";
export const LINEAR_TOKEN_URL = "https://api.linear.app/oauth/token";
export const LINEAR_REVOKE_URL = "https://api.linear.app/oauth/revoke";
export const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";
export const LINEAR_OAUTH_SCOPES = ["read"] as const;

export const LINEAR_OAUTH_UNCONFIGURED =
  "Linear OAuth is not configured on this host. Set OCTANT_LINEAR_OAUTH_CLIENT_ID to a public OAuth client id.";

export const LINEAR_RECONNECT_REASON = "The Linear authorization expired. Reconnect to continue.";
