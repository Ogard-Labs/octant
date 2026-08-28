import type { GithubClient } from "@octant/client-runtime/github-client";
import type { GithubAuthenticationSnapshot } from "@octant/contracts";

export function githubIssuesReadAvailable(snapshot: GithubAuthenticationSnapshot): boolean {
  return snapshot.capabilities.some(
    (capability) => capability.kind === "issues-read" && capability.available,
  );
}

/**
 * Settings authentication commands return a fresh snapshot. The App-level
 * Issues row has to see that snapshot, because the GitHub client identity
 * itself does not change on setup or logout.
 */
export function withGithubIssuesReadSync(
  client: GithubClient,
  onAvailable: (available: boolean) => void,
): GithubClient {
  return {
    authenticationSnapshot: () => client.authenticationSnapshot(),
    executeAuthenticationCommand: async (command) => {
      const snapshot = await client.executeAuthenticationCommand(command);
      onAvailable(githubIssuesReadAvailable(snapshot));
      return snapshot;
    },
    readCatalogue: (request) => client.readCatalogue(request),
    recordRecentRepository: (command) => client.recordRecentRepository(command),
  };
}
