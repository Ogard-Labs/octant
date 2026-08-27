import type { GithubClient } from "@octant/client-runtime/github-client";
import { GitHubConnectionSettings } from "./GitHubConnectionSettings";

export interface GitHubSettingsSectionModuleProps {
  readonly githubClient?: GithubClient | undefined;
}

/**
 * Adapter that exposes the host-compiled GitHub connection settings as a
 * plugin-loadable settings-section module. The entry point is declared in the
 * bundled GitHub integration manifest; this adapter keeps the concrete client
 * dependency inside the host module registry rather than leaking it into the
 * generic plugin seam.
 */
export default function GitHubSettingsSectionModule(props: GitHubSettingsSectionModuleProps) {
  if (props.githubClient === undefined) {
    return (
      <section aria-label="GitHub" id="settings-github">
        <p>
          The GitHub connection is managed on the owning host. Open Settings on that host to set it
          up or inspect the account.
        </p>
      </section>
    );
  }
  return <GitHubConnectionSettings client={props.githubClient} />;
}
