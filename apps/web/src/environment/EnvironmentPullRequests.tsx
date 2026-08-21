import type { GithubClient } from "@octant/client-runtime/github-client";
import type { GithubCatalogueReadResponse, GithubPullRequestRow } from "@octant/contracts";
import { ExternalLink, GitPullRequest, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";

interface RepositoryRef {
  readonly owner: string;
  readonly name: string;
}

type PullRequestState =
  | { readonly status: "idle" | "loading"; readonly rows: ReadonlyArray<GithubPullRequestRow> }
  | {
      readonly status: "ready";
      readonly rows: ReadonlyArray<GithubPullRequestRow>;
      readonly stale: boolean;
    }
  | { readonly status: "unavailable"; readonly message: string };

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
  const [state, setState] = useState<PullRequestState>({ status: "idle", rows: [] });
  const [refreshKey, setRefreshKey] = useState(0);
  const repository = parseRepository(props.repository);

  useEffect(() => {
    if (!props.enabled || props.client === undefined || repository === undefined) {
      setState({ status: "idle", rows: [] });
      return;
    }
    let cancelled = false;
    setState((current) => ({
      status: "loading",
      rows: current.status === "ready" ? current.rows : [],
    }));
    void props.client
      .readCatalogue({
        kind: "pull-requests",
        owner: repository.owner,
        name: repository.name,
        pageSize: 20,
        state: "open",
      })
      .then((response) => {
        if (!cancelled) setState(toPullRequestState(response));
      })
      .catch(() => {
        if (!cancelled) {
          setState({
            status: "unavailable",
            message: "Pull requests could not be loaded from GitHub.",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [props.client, props.enabled, refreshKey, repository?.name, repository?.owner]);

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
        <RefreshCw aria-hidden="true" size={13} strokeWidth={1.8} />
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
              <GitPullRequest aria-hidden="true" size={13} strokeWidth={1.8} />
              <span>{`#${row.number} ${row.title}`}</span>
              <ExternalLink aria-hidden="true" size={11} strokeWidth={1.8} />
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

function toPullRequestState(response: GithubCatalogueReadResponse): PullRequestState {
  if (response.kind === "unavailable") {
    return {
      status: "unavailable",
      message: response.remediation ?? "Pull requests are unavailable from GitHub.",
    };
  }
  if (response.kind !== "pull-requests") {
    return { status: "unavailable", message: "GitHub returned no pull-request list." };
  }
  return {
    status: "ready",
    rows: response.page.rows.filter((row) => row.state === "open" || row.state === "draft"),
    stale: response.page.freshness.status === "stale",
  };
}

function parseRepository(value: string | undefined): RepositoryRef | undefined {
  if (value === undefined) return undefined;
  const match =
    /^([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/([A-Za-z0-9_.-]{1,100})$/.exec(
      value.trim(),
    );
  if (match === null || match[1] === undefined || match[2] === undefined) return undefined;
  return { owner: match[1], name: match[2] };
}
