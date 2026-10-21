import type { GithubClient } from "@octant/client-runtime/github-client";
import type { GithubAuthenticationSnapshot } from "@octant/contracts";

export function githubIssuesReadAvailable(snapshot: GithubAuthenticationSnapshot): boolean {
  return snapshot.capabilities.some(
    (capability) => capability.kind === "issues-read" && capability.available,
  );
}

/**
 * Device sign-in can finish after setup returns. Settings status reads and
 * commands must both update the Issues row, since the client identity does
 * not change when the account becomes ready or loses access.
 */
export function withGithubIssuesReadSync(
  client: GithubClient,
  onAvailable: (available: boolean) => void,
): GithubClient {
  return {
    authenticationSnapshot: async () => {
      const snapshot = await client.authenticationSnapshot();
      onAvailable(githubIssuesReadAvailable(snapshot));
      return snapshot;
    },
    executeAuthenticationCommand: async (command) => {
      const snapshot = await client.executeAuthenticationCommand(command);
      onAvailable(githubIssuesReadAvailable(snapshot));
      return snapshot;
    },
    readCatalogue: (request) => client.readCatalogue(request),
    recordRecentRepository: (command) => client.recordRecentRepository(command),
  };
}
