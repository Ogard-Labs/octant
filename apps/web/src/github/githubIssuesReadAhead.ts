import { useEffect, useState } from "react";
import type { GithubClient } from "@octant/client-runtime/github-client";
import type { GithubAuthenticationSnapshot } from "@octant/contracts";
import { loadList } from "../composer/createFromCache";

export function issuesReadIsAvailable(snapshot: GithubAuthenticationSnapshot): boolean {
  return (
    snapshot !== null &&
    typeof snapshot === "object" &&
    Array.isArray(snapshot.capabilities) &&
    snapshot.capabilities.some(
      (capability) => capability.kind === "issues-read" && capability.available,
    )
  );
}

export function useGithubIssuesCreateAvailable(
  client: GithubClient | undefined,
  pluginEnabled: boolean,
): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (client === undefined || !pluginEnabled) {
      setAvailable(false);
      return;
    }
    const readSnapshot = client.authenticationSnapshot;
    if (typeof readSnapshot !== "function") {
      setAvailable(false);
      return;
    }
    const pending = thenableFrom(readSnapshot.call(client));
    if (pending === undefined) {
      setAvailable(false);
      return;
    }
    let cancelled = false;
    void pending
      .then((snapshot) => {
        if (!cancelled)
          setAvailable(issuesReadIsAvailable(snapshot as GithubAuthenticationSnapshot));
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, pluginEnabled]);
  return available;
}

function thenableFrom(value: unknown): Promise<unknown> | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof value.then === "function"
  ) {
    return value as Promise<unknown>;
  }
  return undefined;
}

export type GithubIssuesResponse = Awaited<ReturnType<GithubClient["readCatalogue"]>>;

export const GITHUB_ISSUE_PAGE_SIZE = 30;

export const githubIssuesCacheKey = (owner: string, name: string) =>
  `github-issues:${owner}/${name}`;

/** A repository's first page of issues, shared with whoever reads ahead of the person choosing it. */
export function loadGithubIssues(
  client: GithubClient,
  owner: string,
  name: string,
): Promise<GithubIssuesResponse> {
  return loadList(
    client,
    githubIssuesCacheKey(owner, name),
    () =>
      client.readCatalogue({
        kind: "issues",
        owner,
        name,
        pageSize: GITHUB_ISSUE_PAGE_SIZE as never,
      }),
    { keep: (response) => response.kind === "issues" },
  );
}
