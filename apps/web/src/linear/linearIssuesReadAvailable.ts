import type { IntegrationClient } from "@octant/client-runtime/integration-client";
import type { IntegrationAuthenticationSnapshot } from "@octant/contracts/integration";
import { linearIssueBrowseAvailable } from "@octant/contracts/linear-issues";

export function linearIssuesReadAvailable(snapshot: IntegrationAuthenticationSnapshot): boolean {
  return linearIssueBrowseAvailable(snapshot.capabilities);
}

/**
 * Integration stays Code-mode-safe. Tracker chips must not probe Linear from
 * Chat or Work, and a disabled plugin contributes no authentication request.
 */
export function shouldProbeLinearAuthentication(
  pluginEffective: boolean,
  mode: "chat" | "work" | "code",
): boolean {
  return pluginEffective && mode === "code";
}

/**
 * Settings authentication commands return a fresh snapshot. The App-level
 * Linear issues row has to see that snapshot, because the integration client
 * identity itself does not change on setup or logout.
 */
export function withLinearIssuesReadSync(
  client: IntegrationClient,
  onAvailable: (available: boolean) => void,
): IntegrationClient {
  return {
    authenticationSnapshot: () => client.authenticationSnapshot(),
    executeAuthenticationCommand: async (command) => {
      const snapshot = await client.executeAuthenticationCommand(command);
      onAvailable(linearIssuesReadAvailable(snapshot));
      return snapshot;
    },
    executeOperation: (operationId, input) => client.executeOperation(operationId, input),
    listIssues: (input) => client.listIssues(input),
    getIssue: (input) => client.getIssue(input),
    listIssueFilters: () => client.listIssueFilters(),
    storePersonalCredential: (credential) => client.storePersonalCredential(credential),
    deletePersonalCredential: () => client.deletePersonalCredential(),
  };
}
