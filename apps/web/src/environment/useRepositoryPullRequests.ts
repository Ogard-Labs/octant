import type { GithubClient } from "@octant/client-runtime/github-client";
import type { GithubCatalogueReadResponse, GithubPullRequestRow } from "@octant/contracts";
import { useEffect, useState } from "react";
import { describeGithubRemediation } from "../github/githubRemediation";

export interface RepositoryRef {
  readonly owner: string;
  readonly name: string;
}

export type RepositoryPullRequestState =
  | { readonly status: "idle" | "loading"; readonly rows: ReadonlyArray<GithubPullRequestRow> }
  | {
      readonly status: "ready";
      readonly rows: ReadonlyArray<GithubPullRequestRow>;
      readonly stale: boolean;
    }
  | { readonly status: "unavailable"; readonly message: string };

/**
 * The open pull requests of one repository, read through the authenticated
 * GitHub catalogue.
 *
 * Shared rather than owned by the Environment panel: the dock's tab launcher
 * offers the same pull requests as places to open, and two independent reads
 * of the same list would drift and cost twice.
 */
export function useRepositoryPullRequests(options: {
  readonly client?: GithubClient | undefined;
  /** The confirmed delivery target, normally in owner/name form. */
  readonly repository?: string | undefined;
  readonly enabled: boolean;
  /** Bumped by a caller to re-read. */
  readonly refreshKey?: number;
}): RepositoryPullRequestState {
  const [state, setState] = useState<RepositoryPullRequestState>({ status: "idle", rows: [] });
  const repository = parseRepository(options.repository);
  const { client, enabled, refreshKey } = options;
  const owner = repository?.owner;
  const name = repository?.name;

  useEffect(() => {
    if (!enabled || client === undefined || owner === undefined || name === undefined) {
      setState({ status: "idle", rows: [] });
      return;
    }
    let cancelled = false;
    setState((current) => ({
      status: "loading",
      rows: current.status === "ready" ? current.rows : [],
    }));
    void client
      .readCatalogue({ kind: "pull-requests", owner, name, pageSize: 20, state: "open" })
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
  }, [client, enabled, name, owner, refreshKey]);

  return state;
}

function toPullRequestState(response: GithubCatalogueReadResponse): RepositoryPullRequestState {
  if (response.kind === "unavailable") {
    return {
      status: "unavailable",
      message:
        response.remediation === undefined
          ? "Pull requests are unavailable from GitHub."
          : describeGithubRemediation(response.remediation),
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

export function parseRepository(value: string | undefined): RepositoryRef | undefined {
  if (value === undefined) return undefined;
  const match =
    /^([A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38})\/([A-Za-z0-9_.-]{1,100})$/.exec(
      value.trim(),
    );
  if (match === null || match[1] === undefined || match[2] === undefined) return undefined;
  return { owner: match[1], name: match[2] };
}
