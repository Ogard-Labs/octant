import { useEffect, useState } from "react";
import type { IntegrationClient } from "@octant/client-runtime/integration-client";
import type { ProjectLinearTarget } from "@octant/contracts";
import type { IntegrationAuthenticationSnapshot } from "@octant/contracts/integration";
import {
  linearIssueBrowseAvailable,
  type LinearIssueListPage,
} from "@octant/contracts/linear-issues";
import { loadList } from "../composer/createFromCache";

export function useLinearIssuesCreateAvailable(
  client: IntegrationClient | undefined,
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
        if (!cancelled) {
          setAvailable(
            linearIssueBrowseAvailable(
              (snapshot as IntegrationAuthenticationSnapshot).capabilities,
            ),
          );
        }
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

const LINEAR_ISSUES_KEY = "linear-issues";

export function linearIssuesCacheKey(target?: ProjectLinearTarget): string {
  if (target === undefined) return LINEAR_ISSUES_KEY;
  return `${LINEAR_ISSUES_KEY}:${target.teamId}:${target.projectId ?? ""}`;
}

export function linearFilterForTarget(target?: ProjectLinearTarget) {
  if (target === undefined) return undefined;
  return {
    teamId: target.teamId,
    ...(target.projectId === undefined ? {} : { projectId: target.projectId }),
  };
}

/** The first page of issues, shared with whoever reads ahead of the popup opening. */
export function loadLinearIssues(
  client: IntegrationClient,
  target?: ProjectLinearTarget,
): Promise<LinearIssueListPage> {
  const listIssues = client.listIssues;
  if (typeof listIssues !== "function") {
    return Promise.reject(new Error("Linear issues are unavailable."));
  }
  const filter = linearFilterForTarget(target);
  return loadList(client, linearIssuesCacheKey(target), () =>
    listIssues.call(client, filter === undefined ? {} : { filter }),
  );
}
