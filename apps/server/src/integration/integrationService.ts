import { randomUUID } from "node:crypto";
import type { CredentialOperation } from "@octant/plugin-api/credential-request";
import { IntegrationCredentialOperations } from "./integrationCredentialOperations";
import type {
  IntegrationAccount,
  IntegrationAccountEntry,
  IntegrationAccountsSnapshot,
  IntegrationAuthenticationCommand,
  IntegrationAuthenticationSnapshot,
  IntegrationCommand,
  IntegrationExecutionResult,
} from "@octant/contracts/integration";
import {
  decodeIntegrationAccountsSnapshot,
  decodeIntegrationAuthenticationSnapshot,
  decodeIntegrationExecutionResult,
} from "@octant/contracts/integration";
import { LINEAR_ISSUE_LIST_OPERATION } from "@octant/contracts/linear-issues";
import type { IntegrationHostPort, IntegrationRuntime } from "@octant/plugin-api/integration";
import { createIntegrationHostPort } from "./integrationHostPort";
import { constructIntegrationRuntime } from "./integrationLoader";
import {
  createIntegrationOAuthHost,
  type IntegrationConnectionState,
  type IntegrationOAuthHost,
  type StoredOAuthTokens,
} from "./integrationOAuth";
import type { IntegrationConnectionStore } from "./integrationConnectionStore";
import { startLinearOAuthCallbackListener } from "./linearOAuthCallbackListener";
import type { IntegrationSecretVault } from "./integrationCredentialVault";
import { LINEAR_API_KEY_CREDENTIAL_ID, LINEAR_OAUTH_CREDENTIAL_ID } from "./linearCredentialIds";
import {
  computeLinearAccountRef,
  createMemoryLinearAccountIndexStore,
  LEGACY_PENDING_ACCOUNT_REF,
  MAX_LINEAR_ACCOUNTS,
  type LinearAccountIndex,
  type LinearAccountIndexEntry,
  type LinearAccountIndexReadResult,
  type LinearAccountIndexStore,
} from "./linearAccountIndexStore";
import {
  createLinearIntegration,
  LINEAR_AUTHORIZE_URL,
  LINEAR_GRAPHQL_URL,
  LINEAR_OAUTH_SCOPES,
  LINEAR_OAUTH_UNCONFIGURED,
  LINEAR_RECONNECT_REASON,
  LINEAR_REVOKE_URL,
  LINEAR_TOKEN_URL,
  probeLinearAccountIdentity,
  type LinearIntegrationConfig,
} from "../plugins/linear/linearIntegration";
import { linearIssueBrowseCapabilities } from "../plugins/linear/linearIssueBrowse";
import { linearCredentialOperation } from "../plugins/linear/linearCredentialOperation";

export type IntegrationAccountSnapshotEntry = IntegrationAccountEntry;
export type IntegrationAccountsListSnapshot = IntegrationAccountsSnapshot;

export interface StoredLinearAccountSummary {
  readonly accountRef: string;
  readonly viewerId?: string;
  readonly workspaceId?: string;
  readonly login: string;
  readonly displayName?: string;
  readonly workspace?: string;
  readonly source: "oauth" | "personal-api-key";
  readonly reconnectRequired: boolean;
  readonly isLegacy: boolean;
}

export type IntegrationSecretPutOutcome =
  | { readonly kind: "stored" }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface IntegrationService {
  readonly connectionRevision?: (accountRef?: string) => number;
  readonly credentialOperations?: () => ReadonlyArray<CredentialOperation>;
  readonly hasConnectedAccount?: (pluginSlug: string) => boolean;
  readonly storedAccounts?: (pluginSlug: string) => ReadonlyArray<StoredLinearAccountSummary>;
  readonly accountsSnapshot?: (
    pluginSlug: string,
    signal: AbortSignal,
  ) => Promise<IntegrationAccountsListSnapshot>;
  readonly snapshot: (
    pluginSlug: string,
    signal: AbortSignal,
    accountRef?: string,
  ) => Promise<IntegrationAuthenticationSnapshot>;
  readonly execute: (
    pluginSlug: string,
    command: IntegrationAuthenticationCommand,
    signal: AbortSignal,
  ) => Promise<IntegrationAuthenticationSnapshot>;
  readonly executeOperation: (
    pluginSlug: string,
    command: Extract<IntegrationCommand, { kind: "operation" }>,
    signal: AbortSignal,
  ) => Promise<IntegrationExecutionResult>;
  readonly completeAuthorization: (
    pluginSlug: string,
    request: { readonly state: string; readonly code: string },
  ) => Promise<{ readonly kind: "stored" } | { readonly kind: "refused"; readonly reason: string }>;
  readonly putSecret: (
    pluginSlug: string,
    scope: "personal-api-key",
    secret: string,
    accountRef?: string,
  ) => Promise<IntegrationSecretPutOutcome>;
  readonly deleteSecret: (
    pluginSlug: string,
    scope: "personal-api-key",
    accountRef?: string,
  ) => Promise<void>;
  readonly adoptLegacyPersonalCredential?: (
    pluginSlug: string,
    signal: AbortSignal,
  ) => Promise<IntegrationSecretPutOutcome>;
}

const LINEAR_SLUG = "linear";
const LINEAR_API_ORIGIN = new URL(LINEAR_GRAPHQL_URL).origin;
const UNAVAILABLE_REMEDIATION = "That integration is not available on this host.";
const BOUND_CURSOR_PREFIX = "oct1_";
const MAX_LINEAR_CURSOR_LENGTH = 600;
const MAX_TRACKED_RAW_CURSORS = 512;

interface AccountRuntimeSlot {
  readonly key: string;
  readonly oauth: IntegrationOAuthHost;
  readonly hostPort: IntegrationHostPort;
  readonly runtime: IntegrationRuntime;
}

const firstPartyIntegrationFactories = {
  linear: (config: LinearIntegrationConfig) => (hostPort: IntegrationHostPort) =>
    createLinearIntegration(hostPort, config),
} as const;

export function createLinearIntegrationService(options: {
  readonly vault: IntegrationSecretVault;
  readonly config: LinearIntegrationConfig;
  readonly fetch?: (input: Request) => Promise<Response>;
  readonly now?: () => number;
  readonly connectionStore?: IntegrationConnectionStore;
  readonly accountIndexStore?: LinearAccountIndexStore;
  readonly startCallbackListener?: boolean;
  readonly isEffective?: () => boolean;
}): IntegrationService {
  const indexStore = options.accountIndexStore ?? createMemoryLinearAccountIndexStore();
  const runtimes = new Map<string, AccountRuntimeSlot>();
  const accountRevisions = new Map<string, number>();
  const rawCursorOwners = new Map<string, string>();
  const credentialOperations = new IntegrationCredentialOperations();
  let credentialOperationsRegistered = false;
  let globalLegacyRevision = 0;
  let loadedState: LinearAccountIndexReadResult | undefined;
  let vaultLegacyChecked = false;
  let pkceHost: IntegrationOAuthHost | undefined;
  let mutationChain: Promise<unknown> = Promise.resolve();

  const isEffective = (pluginSlug: string): boolean =>
    pluginSlug === LINEAR_SLUG && options.isEffective?.() !== false;

  const ensureCredentialOperations = (): ReadonlyArray<CredentialOperation> => {
    if (!isEffective(LINEAR_SLUG)) return [];
    if (!credentialOperationsRegistered) {
      credentialOperations.register(linearCredentialOperation);
      credentialOperationsRegistered = true;
    }
    return credentialOperations.list();
  };

  const withMutationLock = <T>(work: () => Promise<T>): Promise<T> => {
    const next = mutationChain.then(work, work);
    mutationChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  const bumpRevision = (accountRef: string) => {
    accountRevisions.set(accountRef, (accountRevisions.get(accountRef) ?? 0) + 1);
    if (
      loadedState?.kind === "ok" &&
      (loadedState.index.legacyRef === accountRef ||
        (loadedState.index.legacyRef === undefined &&
          loadedState.index.accounts.length <= 1 &&
          loadedState.index.accounts[0]?.accountRef === accountRef))
    ) {
      globalLegacyRevision += 1;
    }
  };

  const loadIndexSync = (): LinearAccountIndexReadResult => {
    if (loadedState !== undefined) return loadedState;
    const stored = indexStore.read();
    if (stored.kind === "damaged") {
      loadedState = stored;
      return stored;
    }
    if (stored.kind === "ok") {
      loadedState = stored;
      vaultLegacyChecked = true;
      return stored;
    }
    // First start after upgrade: migrate `linear-connection.json` into memory
    // without making any network call or moving secrets in the vault.
    const legacyConnection = options.connectionStore?.read();
    if (legacyConnection !== undefined) {
      const migrated = migrateLegacyConnection(legacyConnection);
      loadedState = { kind: "ok", index: migrated };
      vaultLegacyChecked = true;
      return loadedState;
    }
    loadedState = { kind: "ok", index: { version: 1, accounts: [] } };
    return loadedState;
  };

  const loadIndex = async (checkVault: boolean): Promise<LinearAccountIndexReadResult> => {
    const state = loadIndexSync();
    if (state.kind !== "ok") return state;
    if (
      !checkVault ||
      vaultLegacyChecked ||
      state.index.accounts.length > 0 ||
      state.index.legacyRef !== undefined
    ) {
      return state;
    }
    vaultLegacyChecked = true;
    if (await options.vault.has(LINEAR_OAUTH_CREDENTIAL_ID)) {
      const migrated: LinearAccountIndex = {
        version: 1,
        legacyRef: LEGACY_PENDING_ACCOUNT_REF,
        accounts: [
          {
            accountRef: LEGACY_PENDING_ACCOUNT_REF,
            login: "Linear",
            source: "oauth",
            scopes: ["read"],
            vaultId: LINEAR_OAUTH_CREDENTIAL_ID,
            reconnectRequired: false,
          },
        ],
      };
      loadedState = { kind: "ok", index: migrated };
      return loadedState;
    }
    if (await options.vault.has(LINEAR_API_KEY_CREDENTIAL_ID)) {
      const migrated: LinearAccountIndex = {
        version: 1,
        legacyRef: LEGACY_PENDING_ACCOUNT_REF,
        accounts: [
          {
            accountRef: LEGACY_PENDING_ACCOUNT_REF,
            login: "Linear",
            source: "personal-api-key",
            scopes: ["read"],
            vaultId: LINEAR_API_KEY_CREDENTIAL_ID,
            reconnectRequired: false,
          },
        ],
      };
      loadedState = { kind: "ok", index: migrated };
      return loadedState;
    }
    return state;
  };

  const mirrorLegacyConnectionFile = (index: LinearAccountIndex) => {
    if (options.connectionStore === undefined) return;
    const primary =
      index.legacyRef === undefined
        ? index.accounts[0]
        : (index.accounts.find((entry) => entry.accountRef === index.legacyRef) ??
          index.accounts[0]);
    if (primary === undefined) {
      options.connectionStore.write(undefined);
      return;
    }
    options.connectionStore.write({
      source: primary.source,
      reconnectRequired: primary.reconnectRequired,
      account: entryToIntegrationAccount(primary),
    });
  };

  const persistIndex = (nextIndex: LinearAccountIndex) => {
    const written = indexStore.write(nextIndex);
    if (written.kind === "written") {
      loadedState = { kind: "ok", index: nextIndex };
      mirrorLegacyConnectionFile(nextIndex);
    }
    return written;
  };

  const dropRuntime = async (accountRef: string) => {
    const existing = runtimes.get(accountRef);
    if (existing === undefined) return;
    runtimes.delete(accountRef);
    await existing.runtime.close();
  };

  const getOrCreateRuntime = (entry: LinearAccountIndexEntry): AccountRuntimeSlot => {
    const key = `${entry.accountRef}:${entry.source}:${entry.vaultId}`;
    const existing = runtimes.get(entry.accountRef);
    if (existing !== undefined && existing.key === key) return existing;
    if (existing !== undefined) {
      runtimes.delete(entry.accountRef);
      void existing.runtime.close();
    }
    const credentialIds =
      entry.source === "oauth" ? { oauth: entry.vaultId } : { "personal-api-key": entry.vaultId };
    const perAccountConnectionStore: IntegrationConnectionStore = {
      read: () => {
        if (loadedState?.kind !== "ok") return undefined;
        const current = loadedState.index.accounts.find(
          (candidate) => candidate.vaultId === entry.vaultId,
        );
        if (current === undefined) return undefined;
        return {
          source: current.source,
          reconnectRequired: current.reconnectRequired,
          account: entryToIntegrationAccount(current),
        };
      },
      write: (nextState) => {
        if (loadedState?.kind !== "ok") return;
        const currentIndex = loadedState.index;
        const found = currentIndex.accounts.find(
          (candidate) => candidate.vaultId === entry.vaultId,
        );
        if (found === undefined) return;
        if (nextState === undefined) {
          // Revocation updates are handled by the logout transaction.
          return;
        }
        const updatedEntry: LinearAccountIndexEntry = {
          ...found,
          reconnectRequired: nextState.reconnectRequired,
          ...(nextState.account === undefined
            ? {}
            : {
                login: nextState.account.login,
                scopes: nextState.account.scopes,
                ...(nextState.account.displayName === undefined
                  ? {}
                  : { displayName: nextState.account.displayName }),
                ...(nextState.account.workspace === undefined
                  ? {}
                  : { workspace: nextState.account.workspace }),
              }),
        };
        const changed =
          updatedEntry.reconnectRequired !== found.reconnectRequired ||
          updatedEntry.login !== found.login ||
          updatedEntry.displayName !== found.displayName ||
          updatedEntry.workspace !== found.workspace ||
          updatedEntry.scopes.join(",") !== found.scopes.join(",");
        if (!changed) return;
        const nextIndex: LinearAccountIndex = {
          ...currentIndex,
          accounts: currentIndex.accounts.map((candidate) =>
            candidate.vaultId === entry.vaultId ? updatedEntry : candidate,
          ),
        };
        persistIndex(nextIndex);
        if (updatedEntry.reconnectRequired && !found.reconnectRequired) {
          bumpRevision(found.accountRef);
        }
      },
    };
    const oauth = createIntegrationOAuthHost({
      vault: options.vault,
      credentialIds,
      allowedBearerOrigins: [LINEAR_API_ORIGIN],
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.now === undefined ? {} : { now: options.now }),
      connectionStore: perAccountConnectionStore,
    });
    const hostPort = createIntegrationHostPort({
      fetch: oauth.authorizedFetch,
      requestCredential: oauth.requestCredential,
      beginPkceAuthorization: oauth.beginPkceAuthorization,
      refreshPkceAuthorization: oauth.refreshPkceAuthorization,
      revokeCredential: oauth.revokeCredential,
    });
    const loaded = constructIntegrationRuntime(
      firstPartyIntegrationFactories.linear(options.config),
      hostPort,
      LINEAR_SLUG,
    );
    if (loaded.kind !== "loaded") {
      throw new Error("Linear integration failed to load.");
    }
    const slot: AccountRuntimeSlot = {
      key,
      oauth,
      hostPort,
      runtime: loaded.runtime,
    };
    runtimes.set(entry.accountRef, slot);
    return slot;
  };

  const probeVaultCredential = async (
    vaultId: string,
    source: "oauth" | "personal-api-key",
    signal?: AbortSignal,
  ) => {
    const credentialIds = source === "oauth" ? { oauth: vaultId } : { "personal-api-key": vaultId };
    const probeOAuth = createIntegrationOAuthHost({
      vault: options.vault,
      credentialIds,
      allowedBearerOrigins: [LINEAR_API_ORIGIN],
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    const hostPort = createIntegrationHostPort({
      fetch: probeOAuth.authorizedFetch,
      requestCredential: probeOAuth.requestCredential,
    });
    const granted = await probeOAuth.requestCredential(source);
    if (granted.kind !== "granted") {
      return {
        kind: "unauthorized" as const,
        reconnect: source === "oauth",
        reason: granted.reason,
      };
    }
    return probeLinearAccountIdentity(hostPort, granted.reference, source, signal, granted.scopes);
  };

  const commitVerifiedAccount = async (input: {
    readonly vaultId: string;
    readonly source: "oauth" | "personal-api-key";
    readonly viewerId: string;
    readonly workspaceId: string;
    readonly account: IntegrationAccount;
    readonly deleteVaultIdOnFailure: boolean;
  }): Promise<IntegrationSecretPutOutcome> => {
    const state = await loadIndex(true);
    if (state.kind === "damaged") {
      if (input.deleteVaultIdOnFailure) await options.vault.delete(input.vaultId);
      return { kind: "refused", reason: state.reason };
    }
    if (state.kind !== "ok") {
      if (input.deleteVaultIdOnFailure) await options.vault.delete(input.vaultId);
      return { kind: "refused", reason: "Linear accounts are unavailable." };
    }
    const accountRef = computeLinearAccountRef(input.viewerId, input.workspaceId);
    const existing = state.index.accounts.find((entry) => entry.accountRef === accountRef);
    // An upgraded host whose old connection already needed reconnect holds an
    // unpromoted `legacy` placeholder with no viewer/workspace id yet. When the
    // same account reconnects (or the placeholder had no recorded identity),
    // promote `legacyRef` to its deterministic ref and replace the placeholder
    // so existing bindings without `accountRef` resume working without ever
    // handing them to a different account.
    const unpromotedLegacy =
      existing === undefined && state.index.legacyRef === LEGACY_PENDING_ACCOUNT_REF
        ? state.index.accounts.find(
            (entry) =>
              entry.accountRef === LEGACY_PENDING_ACCOUNT_REF &&
              entry.reconnectRequired &&
              (entry.login === "Linear" ||
                (entry.login.toLowerCase() === input.account.login.toLowerCase() &&
                  (entry.workspace === undefined ||
                    input.account.workspace === undefined ||
                    entry.workspace.toLowerCase() === input.account.workspace.toLowerCase()))),
          )
        : undefined;
    const replacing = existing ?? unpromotedLegacy;
    if (replacing === undefined && state.index.accounts.length >= MAX_LINEAR_ACCOUNTS) {
      if (input.deleteVaultIdOnFailure) await options.vault.delete(input.vaultId);
      return {
        kind: "refused",
        reason: "The maximum number of Linear accounts is already connected.",
      };
    }
    const nextEntry: LinearAccountIndexEntry = {
      accountRef,
      viewerId: input.viewerId,
      workspaceId: input.workspaceId,
      login: input.account.login,
      ...(input.account.displayName === undefined
        ? {}
        : { displayName: input.account.displayName }),
      ...(input.account.workspace === undefined ? {} : { workspace: input.account.workspace }),
      source: input.source,
      scopes: [...input.account.scopes],
      vaultId: input.vaultId,
      reconnectRequired: false,
    };
    const nextAccounts =
      replacing === undefined
        ? [...state.index.accounts, nextEntry]
        : state.index.accounts.map((entry) =>
            entry.accountRef === replacing.accountRef ? nextEntry : entry,
          );
    const nextLegacyRef =
      state.index.legacyRef === undefined || unpromotedLegacy !== undefined
        ? accountRef
        : state.index.legacyRef;
    const nextIndex: LinearAccountIndex = {
      version: 1,
      accounts: nextAccounts,
      legacyRef: nextLegacyRef,
    };
    const written = persistIndex(nextIndex);
    if (written.kind !== "written") {
      if (input.deleteVaultIdOnFailure) await options.vault.delete(input.vaultId);
      return { kind: "refused", reason: written.reason };
    }
    if (replacing !== undefined && replacing.vaultId !== input.vaultId) {
      await options.vault.delete(replacing.vaultId);
    }
    if (unpromotedLegacy !== undefined) {
      await dropRuntime(LEGACY_PENDING_ACCOUNT_REF);
    }
    await dropRuntime(accountRef);
    bumpRevision(accountRef);
    return { kind: "stored" };
  };

  const handleExchangedTokens = async (
    tokens: StoredOAuthTokens,
  ): Promise<{ readonly kind: "stored" } | { readonly kind: "refused"; readonly reason: string }> =>
    withMutationLock(async () => {
      const state = await loadIndex(true);
      if (state.kind === "damaged") {
        return { kind: "refused", reason: state.reason };
      }
      const vaultId = randomUUID();
      const stored = await options.vault.put(vaultId, JSON.stringify(tokens));
      if (stored.kind !== "stored") {
        return { kind: "refused", reason: stored.reason };
      }
      const probed = await probeVaultCredential(vaultId, "oauth");
      if (probed.kind !== "ready") {
        await options.vault.delete(vaultId);
        return { kind: "refused", reason: probed.reason };
      }
      const committed = await commitVerifiedAccount({
        vaultId,
        source: "oauth",
        viewerId: probed.identity.viewerId,
        workspaceId: probed.identity.workspaceId,
        account: probed.identity.account,
        deleteVaultIdOnFailure: true,
      });
      if (committed.kind !== "stored") {
        return { kind: "refused", reason: committed.reason };
      }
      return { kind: "stored" };
    });

  const ensurePkceHost = (): IntegrationOAuthHost => {
    pkceHost ??= createIntegrationOAuthHost({
      vault: options.vault,
      credentialIds: {},
      allowedBearerOrigins: [LINEAR_API_ORIGIN],
      onTokensExchanged: handleExchangedTokens,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.startCallbackListener === false
        ? {}
        : {
            startCallbackListener: ({ onAuthorize }) =>
              startLinearOAuthCallbackListener({ onAuthorize }),
          }),
    });
    return pkceHost;
  };

  const promoteLegacyEntry = async (
    entry: LinearAccountIndexEntry,
    identity: {
      readonly viewerId: string;
      readonly workspaceId: string;
      readonly account: IntegrationAccount;
    },
  ): Promise<LinearAccountIndexEntry> => {
    const promotedRef = computeLinearAccountRef(identity.viewerId, identity.workspaceId);
    const updated: LinearAccountIndexEntry = {
      accountRef: promotedRef,
      viewerId: identity.viewerId,
      workspaceId: identity.workspaceId,
      login: identity.account.login,
      ...(identity.account.displayName === undefined
        ? {}
        : { displayName: identity.account.displayName }),
      ...(identity.account.workspace === undefined
        ? {}
        : { workspace: identity.account.workspace }),
      source: entry.source,
      scopes: [...identity.account.scopes],
      vaultId: entry.vaultId,
      reconnectRequired: false,
    };
    await withMutationLock(async () => {
      if (loadedState?.kind !== "ok") return;
      const current = loadedState.index;
      if (!current.accounts.some((candidate) => candidate.vaultId === entry.vaultId)) return;
      const nextAccounts = current.accounts.map((candidate) =>
        candidate.vaultId === entry.vaultId ? updated : candidate,
      );
      const nextLegacyRef =
        current.legacyRef === entry.accountRef || current.legacyRef === LEGACY_PENDING_ACCOUNT_REF
          ? promotedRef
          : current.legacyRef;
      const nextIndex: LinearAccountIndex = {
        version: 1,
        accounts: nextAccounts,
        ...(nextLegacyRef === undefined ? {} : { legacyRef: nextLegacyRef }),
      };
      const written = persistIndex(nextIndex);
      if (written.kind === "written") {
        const previousSlot = runtimes.get(entry.accountRef);
        if (previousSlot !== undefined && entry.accountRef !== promotedRef) {
          runtimes.delete(entry.accountRef);
          void previousSlot.runtime.close();
        }
      }
    });
    return updated;
  };

  const observeEntrySnapshot = async (
    entry: LinearAccountIndexEntry,
    signal: AbortSignal,
  ): Promise<{
    readonly entry: LinearAccountIndexEntry;
    readonly snapshot: IntegrationAuthenticationSnapshot;
  }> => {
    if (entry.reconnectRequired) {
      return {
        entry,
        snapshot: decodeIntegrationAuthenticationSnapshot({
          state: "unauthorized",
          capabilities: [],
          remediation: LINEAR_RECONNECT_REASON,
        }),
      };
    }
    const slot = getOrCreateRuntime(entry);
    // A legacy entry migrated from `linear-connection.json` has no viewer or
    // workspace id yet; its first identity read fills both and pins `legacyRef`
    // in a single GraphQL call.
    if (entry.viewerId === undefined || entry.workspaceId === undefined) {
      const granted = await slot.oauth.requestCredential(entry.source);
      if (granted.kind === "refused") {
        return {
          entry,
          snapshot: decodeIntegrationAuthenticationSnapshot({
            state: "unauthorized",
            capabilities: [],
            remediation: LINEAR_RECONNECT_REASON,
          }),
        };
      }
      if (granted.kind !== "granted") {
        return {
          entry,
          snapshot: decodeIntegrationAuthenticationSnapshot({
            state: "unauthorized",
            capabilities: [],
            remediation:
              configuredClientId(options.config.clientId) === undefined
                ? LINEAR_OAUTH_UNCONFIGURED
                : "Connect Linear to authorize this host.",
          }),
        };
      }
      const probed = await probeLinearAccountIdentity(
        slot.hostPort,
        granted.reference,
        entry.source,
        signal,
        granted.scopes,
      );
      if (probed.kind === "ready") {
        const promoted = await promoteLegacyEntry(entry, probed.identity);
        return {
          entry: promoted,
          snapshot: decodeIntegrationAuthenticationSnapshot({
            state: "ready",
            account: probed.identity.account,
            capabilities: [...linearIssueBrowseCapabilities()],
            ...(entry.source === "personal-api-key" ? { personalCredentialStored: true } : {}),
          }),
        };
      }
      if (probed.kind === "unauthorized") {
        return {
          entry,
          snapshot: decodeIntegrationAuthenticationSnapshot({
            state: "unauthorized",
            capabilities: [],
            remediation: probed.reason,
            ...(entry.source === "personal-api-key" ? { personalCredentialStored: true } : {}),
          }),
        };
      }
      if (probed.kind === "rate-limited") {
        return {
          entry,
          snapshot: decodeIntegrationAuthenticationSnapshot({
            state: "rate-limited",
            capabilities: [],
            remediation: probed.reason,
            ...(entry.source === "personal-api-key" ? { personalCredentialStored: true } : {}),
          }),
        };
      }
      return {
        entry,
        snapshot: decodeIntegrationAuthenticationSnapshot({
          state: "unavailable",
          capabilities: [],
          remediation: probed.reason,
          ...(entry.source === "personal-api-key" ? { personalCredentialStored: true } : {}),
        }),
      };
    }

    const observation = await slot.runtime.observe(
      { kind: "authenticate", command: { kind: "refresh" } },
      signal,
    );
    if (observation.kind !== "authentication") {
      return {
        entry,
        snapshot: decodeIntegrationAuthenticationSnapshot({
          state: "unavailable",
          capabilities: [],
          remediation: "Linear authentication is unavailable.",
        }),
      };
    }
    if (observation.snapshot.account !== undefined && observation.snapshot.state === "ready") {
      slot.oauth.recordAccount(
        observation.snapshot.account,
        observation.snapshot.account.source === "personal-api-key" ? "personal-api-key" : "oauth",
      );
    }
    const latestEntry =
      loadedState?.kind === "ok"
        ? (loadedState.index.accounts.find((candidate) => candidate.vaultId === entry.vaultId) ??
          entry)
        : entry;
    return {
      entry: latestEntry,
      snapshot: decodeIntegrationAuthenticationSnapshot(observation.snapshot),
    };
  };

  const hasUnusedLegacyPersonalKey = async (index: LinearAccountIndex): Promise<boolean> => {
    if (index.accounts.some((entry) => entry.vaultId === LINEAR_API_KEY_CREDENTIAL_ID)) {
      return false;
    }
    return options.vault.has(LINEAR_API_KEY_CREDENTIAL_ID);
  };

  const bindCursor = (accountRef: string, cursor: string): string => {
    const prefixed = `${BOUND_CURSOR_PREFIX}${accountRef}_${cursor}`;
    if (prefixed.length <= MAX_LINEAR_CURSOR_LENGTH) return prefixed;
    if (rawCursorOwners.size >= MAX_TRACKED_RAW_CURSORS) {
      const oldest = rawCursorOwners.keys().next();
      if (oldest.done !== true) rawCursorOwners.delete(oldest.value);
    }
    rawCursorOwners.set(cursor, accountRef);
    return cursor;
  };

  const unwrapCursorForAccount = (
    accountRef: string,
    cursor: string,
  ): { readonly ok: true; readonly cursor: string } | { readonly ok: false } => {
    if (cursor.startsWith(BOUND_CURSOR_PREFIX)) {
      const rest = cursor.slice(BOUND_CURSOR_PREFIX.length);
      const separator = rest.indexOf("_");
      if (separator <= 0) return { ok: false };
      const ownerRef = rest.slice(0, separator);
      const rawCursor = rest.slice(separator + 1);
      if (ownerRef !== accountRef || rawCursor.length === 0) return { ok: false };
      return { ok: true, cursor: rawCursor };
    }
    const trackedOwner = rawCursorOwners.get(cursor);
    if (trackedOwner !== undefined && trackedOwner !== accountRef) {
      return { ok: false };
    }
    return { ok: true, cursor };
  };

  return {
    connectionRevision: (accountRef) => {
      if (accountRef !== undefined) return accountRevisions.get(accountRef) ?? 0;
      const state = loadIndexSync();
      if (state.kind === "ok" && state.index.legacyRef !== undefined) {
        return accountRevisions.get(state.index.legacyRef) ?? globalLegacyRevision;
      }
      return globalLegacyRevision;
    },
    credentialOperations: ensureCredentialOperations,
    hasConnectedAccount: (pluginSlug) => {
      if (!isEffective(pluginSlug)) return false;
      const state = loadIndexSync();
      if (state.kind !== "ok") return false;
      return state.index.accounts.some((entry) => !entry.reconnectRequired);
    },
    storedAccounts: (pluginSlug) => {
      if (!isEffective(pluginSlug)) return [];
      const state = loadIndexSync();
      if (state.kind !== "ok") return [];
      return state.index.accounts.map((entry) => ({
        accountRef: entry.accountRef,
        ...(entry.viewerId === undefined ? {} : { viewerId: entry.viewerId }),
        ...(entry.workspaceId === undefined ? {} : { workspaceId: entry.workspaceId }),
        login: entry.login,
        ...(entry.displayName === undefined ? {} : { displayName: entry.displayName }),
        ...(entry.workspace === undefined ? {} : { workspace: entry.workspace }),
        source: entry.source,
        reconnectRequired: entry.reconnectRequired,
        isLegacy: state.index.legacyRef === entry.accountRef,
      }));
    },
    accountsSnapshot: async (pluginSlug, signal) => {
      if (!isEffective(pluginSlug)) {
        return {
          accounts: [],
          oauthConfigured: false,
          remediation: UNAVAILABLE_REMEDIATION,
        };
      }
      const oauthConfigured = configuredClientId(options.config.clientId) !== undefined;
      const state = await loadIndex(true);
      if (state.kind === "damaged") {
        return {
          accounts: [],
          oauthConfigured,
          indexDamaged: true,
          remediation: state.reason,
        };
      }
      if (state.kind !== "ok") {
        return {
          accounts: [],
          oauthConfigured,
          remediation: UNAVAILABLE_REMEDIATION,
        };
      }
      const entries: IntegrationAccountSnapshotEntry[] = [];
      for (const entry of state.index.accounts) {
        const observed = await observeEntrySnapshot(entry, signal);
        const latestIndex = loadedState?.kind === "ok" ? loadedState.index : state.index;
        const account = observed.snapshot.account ?? entryToIntegrationAccount(observed.entry);
        entries.push({
          accountRef: observed.entry.accountRef,
          state: observed.snapshot.state,
          account,
          capabilities: observed.snapshot.capabilities,
          ...(observed.snapshot.remediation === undefined
            ? {}
            : { remediation: observed.snapshot.remediation }),
          ...(observed.entry.reconnectRequired ? { reconnectRequired: true } : {}),
          ...(latestIndex.legacyRef === observed.entry.accountRef ? { isLegacy: true } : {}),
        });
      }
      const latestIndex = loadedState?.kind === "ok" ? loadedState.index : state.index;
      const unusedPersonal = await hasUnusedLegacyPersonalKey(latestIndex);
      return decodeIntegrationAccountsSnapshot({
        accounts: entries,
        oauthConfigured,
        ...(unusedPersonal ? { unusedPersonalCredentialStored: true } : {}),
        ...(entries.length === 0 && !oauthConfigured
          ? { remediation: LINEAR_OAUTH_UNCONFIGURED }
          : {}),
      });
    },
    snapshot: async (pluginSlug, signal, accountRef) => {
      if (!isEffective(pluginSlug)) return unavailableAuthentication();
      const state = await loadIndex(true);
      if (state.kind === "damaged") {
        return decodeIntegrationAuthenticationSnapshot({
          state: "unavailable",
          capabilities: [],
          remediation: state.reason,
        });
      }
      if (state.kind !== "ok") return unavailableAuthentication();
      const entry = resolveAccountEntry(state.index, accountRef);
      if (entry === undefined) {
        const clientId = configuredClientId(options.config.clientId);
        return decodeIntegrationAuthenticationSnapshot({
          state: "unauthorized",
          capabilities: [],
          remediation:
            accountRef !== undefined
              ? "That Linear account is not connected on this host."
              : clientId === undefined
                ? LINEAR_OAUTH_UNCONFIGURED
                : "Connect Linear to authorize this host.",
        });
      }
      const observed = await observeEntrySnapshot(entry, signal);
      return observed.snapshot;
    },
    execute: async (pluginSlug, command, signal) => {
      if (!isEffective(pluginSlug)) return unavailableAuthentication();
      const state = await loadIndex(true);
      if (state.kind === "damaged") {
        return decodeIntegrationAuthenticationSnapshot({
          state: "unavailable",
          capabilities: [],
          remediation: state.reason,
        });
      }
      if (state.kind !== "ok") return unavailableAuthentication();

      if (command.kind === "setup") {
        const clientId = configuredClientId(options.config.clientId);
        if (clientId === undefined) {
          return decodeIntegrationAuthenticationSnapshot({
            state: "unauthorized",
            capabilities: [],
            remediation: LINEAR_OAUTH_UNCONFIGURED,
          });
        }
        const began = await ensurePkceHost().beginPkceAuthorization({
          authorizationEndpoint: LINEAR_AUTHORIZE_URL,
          tokenEndpoint: LINEAR_TOKEN_URL,
          clientId,
          redirectUri: options.config.redirectUri,
          scopes: [...LINEAR_OAUTH_SCOPES],
          extraParams: { prompt: "consent", actor: "user" },
        });
        if (began.kind === "refused") {
          return decodeIntegrationAuthenticationSnapshot({
            state: "unauthorized",
            capabilities: [],
            remediation: began.reason,
          });
        }
        return decodeIntegrationAuthenticationSnapshot({
          state: "unauthorized",
          capabilities: [],
          remediation: "Open Linear to approve access, then return here.",
          interaction: {
            kind: "authorization-redirect",
            authorizationUri: began.authorizationUrl,
          },
        });
      }

      if (command.kind === "refresh") {
        const entry = resolveAccountEntry(state.index, command.accountRef);
        if (entry === undefined) {
          return decodeIntegrationAuthenticationSnapshot({
            state: "unauthorized",
            capabilities: [],
            remediation:
              command.accountRef !== undefined
                ? "That Linear account is not connected on this host."
                : "Connect Linear to authorize this host.",
          });
        }
        if (entry.source !== "oauth") {
          return (await observeEntrySnapshot(entry, signal)).snapshot;
        }
        const clientId = configuredClientId(options.config.clientId);
        if (clientId === undefined) {
          return decodeIntegrationAuthenticationSnapshot({
            state: "unauthorized",
            capabilities: [],
            remediation: LINEAR_OAUTH_UNCONFIGURED,
          });
        }
        const slot = getOrCreateRuntime(entry);
        const refreshed = await slot.oauth.refreshPkceAuthorization({
          scope: "oauth",
          tokenEndpoint: LINEAR_TOKEN_URL,
          clientId,
        });
        if (refreshed.kind === "invalid_grant") {
          return decodeIntegrationAuthenticationSnapshot({
            state: "unauthorized",
            capabilities: [],
            remediation: LINEAR_RECONNECT_REASON,
          });
        }
        if (refreshed.kind === "failed") {
          return decodeIntegrationAuthenticationSnapshot({
            state: "unauthorized",
            capabilities: [],
            remediation: refreshed.reason,
          });
        }
        bumpRevision(entry.accountRef);
        return (await observeEntrySnapshot(entry, signal)).snapshot;
      }

      // Logout removes ONLY the targeted account and preserves `legacyRef`.
      return withMutationLock(async () => {
        const latestState = await loadIndex(true);
        if (latestState.kind !== "ok") {
          return decodeIntegrationAuthenticationSnapshot({
            state: "unavailable",
            capabilities: [],
            remediation:
              latestState.kind === "damaged" ? latestState.reason : UNAVAILABLE_REMEDIATION,
          });
        }
        const entry = resolveAccountEntry(latestState.index, command.accountRef);
        if (entry === undefined) {
          return decodeIntegrationAuthenticationSnapshot({
            state: "unauthorized",
            capabilities: [],
            remediation: "Disconnected from Linear on this host.",
          });
        }
        let revoked = false;
        if (entry.source === "oauth") {
          const slot = getOrCreateRuntime(entry);
          const result = await slot.oauth.revokeCredential({
            scope: "oauth",
            revokeEndpoint: LINEAR_REVOKE_URL,
          });
          revoked = result.kind === "revoked";
        } else {
          await options.vault.delete(entry.vaultId);
        }
        const nextIndex: LinearAccountIndex = {
          version: 1,
          accounts: latestState.index.accounts.filter(
            (candidate) => candidate.accountRef !== entry.accountRef,
          ),
          // Preserve `legacyRef` after removal so another account added later
          // never inherits pre-existing targets that omitted `accountRef`.
          ...(latestState.index.legacyRef === undefined
            ? {}
            : { legacyRef: latestState.index.legacyRef }),
        };
        persistIndex(nextIndex);
        await dropRuntime(entry.accountRef);
        bumpRevision(entry.accountRef);
        return decodeIntegrationAuthenticationSnapshot({
          state: "unauthorized",
          capabilities: [],
          remediation:
            entry.source === "personal-api-key" || revoked
              ? "Disconnected from Linear on this host."
              : "Disconnected from Linear on this host. Linear may still show this app as authorized.",
        });
      });
    },
    executeOperation: async (pluginSlug, command, signal) => {
      if (!isEffective(pluginSlug)) return unavailableOperation();
      const state = await loadIndex(true);
      if (state.kind === "damaged") {
        return decodeIntegrationExecutionResult({
          kind: "refused",
          reason: state.reason,
        });
      }
      if (state.kind !== "ok") return unavailableOperation();
      const entry = resolveAccountEntry(state.index, command.accountRef);
      if (entry === undefined) {
        return decodeIntegrationExecutionResult({
          kind: "refused",
          reason:
            command.accountRef !== undefined
              ? "That Linear account is not connected on this host."
              : "Connect Linear to authorize this host.",
        });
      }
      if (entry.reconnectRequired) {
        return decodeIntegrationExecutionResult({
          kind: "refused",
          reason: LINEAR_RECONNECT_REASON,
        });
      }
      let operationInput = command.input;
      if (
        command.operationId === LINEAR_ISSUE_LIST_OPERATION &&
        isRecord(command.input) &&
        typeof command.input.cursor === "string"
      ) {
        const unwrapped = unwrapCursorForAccount(entry.accountRef, command.input.cursor);
        if (!unwrapped.ok) {
          return decodeIntegrationExecutionResult({
            kind: "refused",
            reason: "That Linear pagination cursor belongs to a different account.",
          });
        }
        operationInput = { ...command.input, cursor: unwrapped.cursor };
      }
      const slot = getOrCreateRuntime(entry);
      const observation = await slot.runtime.execute(
        { kind: "operation", operationId: command.operationId, input: operationInput },
        signal,
      );
      if (observation.kind !== "operation") {
        return decodeIntegrationExecutionResult({
          kind: "failed",
          reason: "Linear issue browse is unavailable.",
          retryable: false,
        });
      }
      if (
        command.operationId === LINEAR_ISSUE_LIST_OPERATION &&
        observation.result.kind === "ok" &&
        isRecord(observation.result.value) &&
        typeof observation.result.value.endCursor === "string"
      ) {
        return decodeIntegrationExecutionResult({
          kind: "ok",
          value: {
            ...observation.result.value,
            endCursor: bindCursor(entry.accountRef, observation.result.value.endCursor),
          },
        });
      }
      return decodeIntegrationExecutionResult(observation.result);
    },
    completeAuthorization: async (pluginSlug, request) => {
      if (!isEffective(pluginSlug)) return { kind: "refused", reason: UNAVAILABLE_REMEDIATION };
      return ensurePkceHost().completePkceAuthorization(request);
    },
    putSecret: async (pluginSlug, scope, secret) => {
      if (!isEffective(pluginSlug)) {
        return { kind: "unavailable", reason: UNAVAILABLE_REMEDIATION };
      }
      if (scope !== "personal-api-key") {
        return { kind: "unavailable", reason: "Unknown credential scope." };
      }
      return withMutationLock(async () => {
        const state = await loadIndex(true);
        if (state.kind === "damaged") {
          return { kind: "refused", reason: state.reason };
        }
        const vaultId = randomUUID();
        const stored = await options.vault.put(vaultId, secret);
        if (stored.kind !== "stored") {
          return stored;
        }
        const probed = await probeVaultCredential(vaultId, "personal-api-key");
        if (probed.kind !== "ready") {
          await options.vault.delete(vaultId);
          return { kind: "refused", reason: probed.reason };
        }
        return commitVerifiedAccount({
          vaultId,
          source: "personal-api-key",
          viewerId: probed.identity.viewerId,
          workspaceId: probed.identity.workspaceId,
          account: probed.identity.account,
          deleteVaultIdOnFailure: true,
        });
      });
    },
    deleteSecret: async (pluginSlug, scope, accountRef) => {
      if (!isEffective(pluginSlug) || scope !== "personal-api-key") return;
      await withMutationLock(async () => {
        const state = await loadIndex(true);
        if (state.kind !== "ok") return;
        if (accountRef !== undefined) {
          const entry = state.index.accounts.find(
            (candidate) =>
              candidate.accountRef === accountRef && candidate.source === "personal-api-key",
          );
          if (entry === undefined) return;
          await options.vault.delete(entry.vaultId);
          const nextIndex: LinearAccountIndex = {
            version: 1,
            accounts: state.index.accounts.filter(
              (candidate) => candidate.accountRef !== accountRef,
            ),
            ...(state.index.legacyRef === undefined ? {} : { legacyRef: state.index.legacyRef }),
          };
          persistIndex(nextIndex);
          await dropRuntime(accountRef);
          bumpRevision(accountRef);
          return;
        }
        if (await hasUnusedLegacyPersonalKey(state.index)) {
          await options.vault.delete(LINEAR_API_KEY_CREDENTIAL_ID);
          return;
        }
        const legacy = resolveAccountEntry(state.index, undefined);
        if (legacy === undefined || legacy.source !== "personal-api-key") return;
        await options.vault.delete(legacy.vaultId);
        const nextIndex: LinearAccountIndex = {
          version: 1,
          accounts: state.index.accounts.filter(
            (candidate) => candidate.accountRef !== legacy.accountRef,
          ),
          ...(state.index.legacyRef === undefined ? {} : { legacyRef: state.index.legacyRef }),
        };
        persistIndex(nextIndex);
        await dropRuntime(legacy.accountRef);
        bumpRevision(legacy.accountRef);
      });
    },
    adoptLegacyPersonalCredential: async (pluginSlug, signal) => {
      if (!isEffective(pluginSlug)) {
        return { kind: "unavailable", reason: UNAVAILABLE_REMEDIATION };
      }
      return withMutationLock(async () => {
        const state = await loadIndex(true);
        if (state.kind === "damaged") {
          return { kind: "refused", reason: state.reason };
        }
        if (state.kind !== "ok" || !(await hasUnusedLegacyPersonalKey(state.index))) {
          return {
            kind: "unavailable",
            reason: "No unused Linear personal API key is stored on this host.",
          };
        }
        const probed = await probeVaultCredential(
          LINEAR_API_KEY_CREDENTIAL_ID,
          "personal-api-key",
          signal,
        );
        if (probed.kind !== "ready") {
          return { kind: "refused", reason: probed.reason };
        }
        return commitVerifiedAccount({
          vaultId: LINEAR_API_KEY_CREDENTIAL_ID,
          source: "personal-api-key",
          viewerId: probed.identity.viewerId,
          workspaceId: probed.identity.workspaceId,
          account: probed.identity.account,
          deleteVaultIdOnFailure: false,
        });
      });
    },
  };
}

function migrateLegacyConnection(legacy: IntegrationConnectionState): LinearAccountIndex {
  const vaultId =
    legacy.source === "oauth" ? LINEAR_OAUTH_CREDENTIAL_ID : LINEAR_API_KEY_CREDENTIAL_ID;
  return {
    version: 1,
    legacyRef: LEGACY_PENDING_ACCOUNT_REF,
    accounts: [
      {
        accountRef: LEGACY_PENDING_ACCOUNT_REF,
        login: legacy.account?.login ?? "Linear",
        ...(legacy.account?.displayName === undefined
          ? {}
          : { displayName: legacy.account.displayName }),
        ...(legacy.account?.workspace === undefined ? {} : { workspace: legacy.account.workspace }),
        source: legacy.source,
        scopes: legacy.account?.scopes ?? ["read"],
        vaultId,
        reconnectRequired: legacy.reconnectRequired,
      },
    ],
  };
}

function resolveAccountEntry(
  index: LinearAccountIndex,
  accountRef: string | undefined,
): LinearAccountIndexEntry | undefined {
  if (accountRef !== undefined) {
    return index.accounts.find((entry) => entry.accountRef === accountRef);
  }
  if (index.legacyRef !== undefined) {
    return index.accounts.find((entry) => entry.accountRef === index.legacyRef);
  }
  return index.accounts.length === 1 ? index.accounts[0] : undefined;
}

function entryToIntegrationAccount(entry: LinearAccountIndexEntry): IntegrationAccount {
  return {
    login: entry.login,
    source: entry.source,
    scopes: [...entry.scopes],
    ...(entry.displayName === undefined ? {} : { displayName: entry.displayName }),
    ...(entry.workspace === undefined ? {} : { workspace: entry.workspace }),
  };
}

function configuredClientId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed.length < 8 || trimmed.length > 128) return undefined;
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return undefined;
  return trimmed;
}

function unavailableAuthentication(): IntegrationAuthenticationSnapshot {
  return decodeIntegrationAuthenticationSnapshot({
    state: "unavailable",
    capabilities: [],
    remediation: UNAVAILABLE_REMEDIATION,
  });
}

function unavailableOperation(): IntegrationExecutionResult {
  return decodeIntegrationExecutionResult({
    kind: "refused",
    reason: UNAVAILABLE_REMEDIATION,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
