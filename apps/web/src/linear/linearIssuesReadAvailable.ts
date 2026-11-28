import type { IntegrationClient } from "@octant/client-runtime/integration-client";
import type {
  IntegrationAccountEntry,
  IntegrationAccountsSnapshot,
  IntegrationAuthenticationSnapshot,
} from "@octant/contracts/integration";
import { linearIssueBrowseAvailable } from "@octant/contracts/linear-issues";

export function linearIssuesReadAvailable(snapshot: IntegrationAuthenticationSnapshot): boolean {
  return linearIssueBrowseAvailable(snapshot.capabilities);
}

export function linearAccountsReadAvailable(
  accounts: ReadonlyArray<IntegrationAccountEntry>,
): boolean {
  return accounts.some((entry) => linearIssueBrowseAvailable(entry.capabilities));
}

export function readyLinearAccounts(
  accounts: ReadonlyArray<IntegrationAccountEntry>,
): ReadonlyArray<IntegrationAccountEntry> {
  return accounts.filter((entry) => linearIssueBrowseAvailable(entry.capabilities));
}

export function linearAccountDisplayLabel(entry: IntegrationAccountEntry): string {
  return entry.account?.workspace ?? entry.account?.login ?? entry.accountRef;
}

/**
 * Resolves which Linear account (if any) may resolve inline issue-key chips.
 * - With a bound Project: uses only that Project's account (or the legacy
 *   account when the binding omits `accountRef`).
 * - With no Project binding and a single ready account: uses that account.
 * - With no Project binding and multiple ready accounts: returns unavailable so
 *   issue keys stay plain text rather than probing workspaces in turn.
 */
export function resolveLinearChipAccount(input: {
  readonly accounts: ReadonlyArray<IntegrationAccountEntry>;
  readonly projectAccountRef?: string | undefined;
  readonly hasProjectLinearTarget: boolean;
}): { readonly available: boolean; readonly accountRef?: string } {
  const ready = readyLinearAccounts(input.accounts);
  if (ready.length === 0) return { available: false };
  if (input.hasProjectLinearTarget) {
    if (input.projectAccountRef !== undefined) {
      const matched = ready.find((entry) => entry.accountRef === input.projectAccountRef);
      return matched === undefined
        ? { available: false }
        : { available: true, accountRef: matched.accountRef };
    }
    const legacy = ready.find((entry) => entry.isLegacy === true);
    if (legacy !== undefined) return { available: true, accountRef: legacy.accountRef };
    return ready.length === 1 && ready[0] !== undefined
      ? { available: true, accountRef: ready[0].accountRef }
      : { available: false };
  }
  if (ready.length === 1 && ready[0] !== undefined) {
    return { available: true, accountRef: ready[0].accountRef };
  }
  return { available: false };
}

/**
 * Integration stays Code-mode-safe. Tracker chips must not probe Linear from
 * Chat or Work, and a disabled plugin contributes no authentication request.
 */
export function shouldProbeLinearAuthentication(
  pluginEffective: boolean,
  mode: "chat" | "work" | "code",
): boolean {
  return pluginEffective && mode === "code";
}

/**
 * Settings authentication commands return a fresh snapshot. The App-level
 * Linear issues row has to see that snapshot, because the integration client
 * identity itself does not change on setup or logout.
 */
export function withLinearIssuesReadSync(
  client: IntegrationClient,
  onAvailable: (available: boolean) => void,
  onAccountsChanged?: (snapshot: IntegrationAccountsSnapshot) => void,
): IntegrationClient {
  const getByIdentifier = client.getIssueByIdentifier;
  const accountsSnapshot = client.accountsSnapshot;
  const adoptLegacyPersonalCredential = client.adoptLegacyPersonalCredential;

  const syncAccounts = async () => {
    if (accountsSnapshot === undefined) return;
    try {
      const next = await accountsSnapshot.call(client);
      onAccountsChanged?.(next);
      onAvailable(linearAccountsReadAvailable(next.accounts));
    } catch {
      // Older hosts without `/accounts` sync from the single-account snapshot.
    }
  };

  return {
    authenticationSnapshot: () => client.authenticationSnapshot(),
    ...(accountsSnapshot === undefined
      ? {}
      : {
          accountsSnapshot: async () => {
            const snapshot = await accountsSnapshot.call(client);
            onAccountsChanged?.(snapshot);
            onAvailable(linearAccountsReadAvailable(snapshot.accounts));
            return snapshot;
          },
        }),
    executeAuthenticationCommand: async (command) => {
      const snapshot = await client.executeAuthenticationCommand(command);
      if (accountsSnapshot !== undefined) {
        await syncAccounts();
      } else {
        onAvailable(linearIssuesReadAvailable(snapshot));
      }
      return snapshot;
    },
    executeOperation: (operationId, input, accountRef) =>
      client.executeOperation(operationId, input, accountRef),
    listIssues: (input, accountRef) => client.listIssues(input, accountRef),
    getIssue: (input, accountRef) => client.getIssue(input, accountRef),
    ...(getByIdentifier === undefined
      ? {}
      : {
          getIssueByIdentifier: (input, accountRef) =>
            getByIdentifier.call(client, input, accountRef),
        }),
    listIssueFilters: (accountRef) => client.listIssueFilters(accountRef),
    storePersonalCredential: async (credential, accountRef) => {
      await client.storePersonalCredential(credential, accountRef);
      await syncAccounts();
    },
    deletePersonalCredential: async (accountRef) => {
      await client.deletePersonalCredential(accountRef);
      await syncAccounts();
    },
    ...(adoptLegacyPersonalCredential === undefined
      ? {}
      : {
          adoptLegacyPersonalCredential: async () => {
            await adoptLegacyPersonalCredential.call(client);
            await syncAccounts();
          },
        }),
  };
}
