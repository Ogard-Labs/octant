/** Last reported account facts only; the dialect validates their meaning and ownership. */
export interface McpOAuthAccount {
  readonly workspaceId?: string;
  readonly userId?: string;
  readonly grantedScopes?: readonly string[];
}
