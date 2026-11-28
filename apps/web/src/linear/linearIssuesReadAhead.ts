import { useEffect, useState } from "react";
import type { IntegrationClient } from "@octant/client-runtime/integration-client";
import type { ProjectLinearTarget } from "@octant/contracts";
import type {
  IntegrationAccountsSnapshot,
  IntegrationAuthenticationSnapshot,
} from "@octant/contracts/integration";
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
    const readAccounts = client.accountsSnapshot;
    const readSnapshot = client.authenticationSnapshot;
    if (typeof readAccounts !== "function" && typeof readSnapshot !== "function") {
      setAvailable(false);
      return;
    }
    let cancelled = false;
    const fallbackSingle = () => {
      if (typeof readSnapshot !== "function") {
        if (!cancelled) setAvailable(false);
        return;
      }
      const pending = thenableFrom(readSnapshot.call(client));
      if (pending === undefined) {
        if (!cancelled) setAvailable(false);
        return;
      }
      void pending.then(
        (snapshot) => {
          if (!cancelled) {
            setAvailable(
              linearIssueBrowseAvailable(
                (snapshot as IntegrationAuthenticationSnapshot).capabilities,
              ),
            );
          }
        },
        () => {
          if (!cancelled) setAvailable(false);
        },
      );
    };
    if (typeof readAccounts === "function") {
      const pending = thenableFrom(readAccounts.call(client));
      if (pending !== undefined) {
        void pending.then(
          (snapshot) => {
            if (!cancelled) {
              const accounts = (snapshot as IntegrationAccountsSnapshot).accounts;
              setAvailable(
                accounts.some((entry) => linearIssueBrowseAvailable(entry.capabilities)),
              );
            }
          },
          () => fallbackSingle(),
        );
        return () => {
          cancelled = true;
        };
      }
    }
    fallbackSingle();
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

export function linearIssuesCacheKey(target?: ProjectLinearTarget, accountRef?: string): string {
  const account = accountRef ?? target?.accountRef ?? "";
  if (target === undefined) {
    return account === "" ? LINEAR_ISSUES_KEY : `${LINEAR_ISSUES_KEY}:${account}`;
  }
  return `${LINEAR_ISSUES_KEY}:${account}:${target.teamId}:${target.projectId ?? ""}`;
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
  accountRef?: string,
): Promise<LinearIssueListPage> {
  const listIssues = client.listIssues;
  if (typeof listIssues !== "function") {
    return Promise.reject(new Error("Linear issues are unavailable."));
  }
  const effectiveAccount = accountRef ?? target?.accountRef;
  const filter = linearFilterForTarget(target);
  return loadList(client, linearIssuesCacheKey(target, effectiveAccount), () =>
    effectiveAccount === undefined
      ? listIssues.call(client, filter === undefined ? {} : { filter })
      : listIssues.call(client, filter === undefined ? {} : { filter }, effectiveAccount),
  );
}
