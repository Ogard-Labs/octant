import { describe, expect, it, vi } from "vitest";
import type {
  IntegrationAccountEntry,
  IntegrationAccountsSnapshot,
  IntegrationAuthenticationSnapshot,
} from "@octant/contracts/integration";
import type { IntegrationClient } from "@octant/client-runtime/integration-client";
import {
  linearIssuesReadAvailable,
  resolveLinearChipAccount,
  shouldProbeLinearAuthentication,
  withLinearIssuesReadSync,
} from "./linearIssuesReadAvailable";

const readySnapshot: IntegrationAuthenticationSnapshot = {
  state: "ready",
  capabilities: [{ operationId: "list-issues", available: true }],
};

const unauthorizedSnapshot: IntegrationAuthenticationSnapshot = {
  state: "unauthorized",
  capabilities: [{ operationId: "list-issues", available: false }],
};

const acmeAccount: IntegrationAccountEntry = {
  accountRef: "lin_acme",
  state: "ready",
  capabilities: [{ operationId: "list-issues", available: true }],
  account: { login: "alice@acme.dev", workspace: "Acme", source: "oauth", scopes: ["read"] },
  isLegacy: true,
};

const betaAccount: IntegrationAccountEntry = {
  accountRef: "lin_beta",
  state: "ready",
  capabilities: [{ operationId: "list-issues", available: true }],
  account: { login: "alice@beta.dev", workspace: "Beta", source: "oauth", scopes: ["read"] },
};

const expiredBetaAccount: IntegrationAccountEntry = {
  accountRef: "lin_beta",
  state: "unauthorized",
  capabilities: [{ operationId: "list-issues", available: false }],
  account: { login: "alice@beta.dev", workspace: "Beta", source: "oauth", scopes: ["read"] },
};

function makeClient(
  snapshot: IntegrationAuthenticationSnapshot,
  accounts?: IntegrationAccountsSnapshot,
): IntegrationClient {
  return {
    authenticationSnapshot: async () => snapshot,
    ...(accounts === undefined ? {} : { accountsSnapshot: async () => accounts }),
    executeAuthenticationCommand: async () => snapshot,
    executeOperation: async () => ({ kind: "refused", reason: "not used" }),
    listIssues: async () => ({ rows: [], hasNextPage: false }),
    getIssue: async () => {
      throw new Error("not used");
    },
    listIssueFilters: async () => ({ teams: [], states: [], assignees: [], projects: [] }),
    storePersonalCredential: async () => {},
    deletePersonalCredential: async () => {},
  };
}

describe("Linear issues-read capability sync", () => {
  it("probes Linear authentication only in Code when the plugin is effective", () => {
    expect(shouldProbeLinearAuthentication(true, "code")).toBe(true);
    expect(shouldProbeLinearAuthentication(true, "chat")).toBe(false);
    expect(shouldProbeLinearAuthentication(true, "work")).toBe(false);
    expect(shouldProbeLinearAuthentication(false, "code")).toBe(false);
  });

  it("treats a snapshot as available only when list-issues is present and true", () => {
    expect(linearIssuesReadAvailable(readySnapshot)).toBe(true);
    expect(linearIssuesReadAvailable(unauthorizedSnapshot)).toBe(false);
    expect(linearIssuesReadAvailable({ state: "ready", capabilities: [] })).toBe(false);
  });

  it("refreshes availability after a successful authentication command", async () => {
    const onAvailable = vi.fn();
    const client = withLinearIssuesReadSync(makeClient(unauthorizedSnapshot), onAvailable);
    await client.executeAuthenticationCommand({ kind: "logout" });
    expect(onAvailable).toHaveBeenCalledWith(false);
  });

  it("syncs multi-account availability from accountsSnapshot after authentication commands", async () => {
    const onAvailable = vi.fn();
    const onAccountsChanged = vi.fn();
    const multiSnapshot: IntegrationAccountsSnapshot = {
      accounts: [acmeAccount, expiredBetaAccount],
      oauthConfigured: true,
    };
    const client = withLinearIssuesReadSync(
      makeClient(unauthorizedSnapshot, multiSnapshot),
      onAvailable,
      onAccountsChanged,
    );
    await client.executeAuthenticationCommand({ kind: "logout", accountRef: "lin_beta" });
    expect(onAccountsChanged).toHaveBeenCalledWith(multiSnapshot);
    expect(onAvailable).toHaveBeenCalledWith(true);
  });

  it("does not refresh availability when the authentication command fails", async () => {
    const onAvailable = vi.fn();
    const client = withLinearIssuesReadSync(
      {
        ...makeClient(readySnapshot),
        executeAuthenticationCommand: async () => {
          throw new Error("Linear is unavailable.");
        },
      },
      onAvailable,
    );
    await expect(client.executeAuthenticationCommand({ kind: "setup" })).rejects.toThrow(
      "Linear is unavailable.",
    );
    expect(onAvailable).not.toHaveBeenCalled();
  });
});

describe("resolveLinearChipAccount", () => {
  it("resolves an unbound thread when only one Linear account is ready", () => {
    expect(
      resolveLinearChipAccount({
        accounts: [acmeAccount],
        hasProjectLinearTarget: false,
      }),
    ).toEqual({ available: true, accountRef: "lin_acme" });
  });

  it("leaves issue keys as plain text on an unbound thread when two accounts are ready", () => {
    expect(
      resolveLinearChipAccount({
        accounts: [acmeAccount, betaAccount],
        hasProjectLinearTarget: false,
      }),
    ).toEqual({ available: false });
  });

  it("pins a bound Project to its own Linear account and refuses when that account is unavailable", () => {
    expect(
      resolveLinearChipAccount({
        accounts: [acmeAccount, betaAccount],
        hasProjectLinearTarget: true,
        projectAccountRef: "lin_beta",
      }),
    ).toEqual({ available: true, accountRef: "lin_beta" });

    expect(
      resolveLinearChipAccount({
        accounts: [acmeAccount, expiredBetaAccount],
        hasProjectLinearTarget: true,
        projectAccountRef: "lin_beta",
      }),
    ).toEqual({ available: false });
  });

  it("resolves a legacy Project target without accountRef to the legacy account only", () => {
    expect(
      resolveLinearChipAccount({
        accounts: [acmeAccount, betaAccount],
        hasProjectLinearTarget: true,
      }),
    ).toEqual({ available: true, accountRef: "lin_acme" });
  });
});
