import type { GithubClient } from "@octant/client-runtime/github-client";
import type { GithubPullRequestRow } from "@octant/contracts";
import { ExternalLink, GitPullRequest, RefreshCw } from "lucide-react";
import { useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { useRepositoryPullRequests } from "./useRepositoryPullRequests";

export interface EnvironmentPullRequestsProps {
  readonly client?: GithubClient;
  /** The confirmed delivery target, normally in owner/name form. */
  readonly repository?: string;
  readonly enabled: boolean;
}

/**
 * Reads the repository's open pull requests through the authenticated GitHub
 * catalogue. The panel never invents a repository from a folder name, and an
 * unavailable catalogue stays visible as an honest status rather than a blank
 * section.
 */
export function EnvironmentPullRequests(props: EnvironmentPullRequestsProps) {
  const [refreshKey, setRefreshKey] = useState(0);
  const state = useRepositoryPullRequests({
    ...(props.client === undefined ? {} : { client: props.client }),
    ...(props.repository === undefined ? {} : { repository: props.repository }),
    enabled: props.enabled,
    refreshKey,
  });

  if (state.status !== "ready" && state.status !== "unavailable") {
    return (
      <div className="environment-pull-requests">
        {state.rows.length === 0 ? (
          <p className="environment-pull-requests__status" role="status">
            {state.status === "loading" ? "Loading pull requests…" : "Pull requests unavailable."}
          </p>
        ) : (
          <PullRequestList rows={state.rows} />
        )}
      </div>
    );
  }

  if (state.status === "unavailable") {
    return (
      <div className="environment-pull-requests">
        <p className="environment-pull-requests__status" role="alert">
          {state.message}
        </p>
      </div>
    );
  }

  return (
    <div className="environment-pull-requests">
      {state.stale ? (
        <p className="environment-pull-requests__stale" role="status">
          Showing the last known GitHub list.
        </p>
      ) : null}
      {state.rows.length === 0 ? (
        <p className="environment-pull-requests__status" role="status">
          No open pull requests.
        </p>
      ) : (
        <PullRequestList rows={state.rows} />
      )}
      <OctantButton
        aria-label="Refresh pull requests"
        className="environment-pull-requests__refresh"
        onClick={() => setRefreshKey((current) => current + 1)}
        size="icon"
        type="button"
        variant="ghost"
      >
        <RefreshCw aria-hidden="true" size={14} strokeWidth={1.8} />
      </OctantButton>
    </div>
  );
}

function PullRequestList(props: { readonly rows: ReadonlyArray<GithubPullRequestRow> }) {
  return (
    <ul className="environment-pull-requests__list">
      {props.rows.map((row) => (
        <li key={row.url}>
          <a
            className="environment-pull-requests__row"
            href={row.url}
            rel="noreferrer"
            target="_blank"
          >
            <span className="environment-pull-requests__title">
              <GitPullRequest aria-hidden="true" size={14} strokeWidth={1.8} />
              <span>{`#${row.number} ${row.title}`}</span>
              <ExternalLink aria-hidden="true" size={12} strokeWidth={1.8} />
            </span>
            <span className="environment-pull-requests__branches">
              {row.headBranch ?? "unknown branch"} → {row.baseBranch ?? "default branch"}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}
