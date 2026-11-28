import { describe, expect, it, vi } from "vitest";
import {
  LINEAR_ISSUE_GET_OPERATION,
  LINEAR_ISSUE_LIST_OPERATION,
} from "@octant/contracts/linear-issues";
import { createMemoryConnectionStore } from "./integrationConnectionStore";
import {
  createMemorySecretVault,
  createUnavailableSecretVault,
} from "./integrationCredentialVault";
import {
  computeLinearAccountRef,
  createMemoryLinearAccountIndexStore,
} from "./linearAccountIndexStore";
import { LINEAR_API_KEY_CREDENTIAL_ID, LINEAR_OAUTH_CREDENTIAL_ID } from "./linearCredentialIds";
import { createLinearIntegrationService } from "./integrationService";
import {
  LINEAR_OAUTH_UNCONFIGURED,
  LINEAR_RECONNECT_REASON,
} from "../plugins/linear/linearConstants";

const redirectUri = "http://127.0.0.1:52693/oauth/linear/callback";
const clientId = "linear-public-client";
const signal = () => new AbortController().signal;

interface FixtureAccount {
  readonly code: string;
  readonly token: string;
  readonly refreshToken: string;
  readonly viewerId: string;
  readonly viewerName: string;
  readonly orgId: string;
  readonly orgName: string;
  readonly urlKey: string;
  readonly issues: ReadonlyArray<{
    readonly id: string;
    readonly identifier: string;
    readonly title: string;
  }>;
  readonly endCursor?: string;
}

const ACCOUNT_A: FixtureAccount = {
  code: "code-a",
  token: "token_account_a_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  refreshToken: "refresh_account_a_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  viewerId: "viewer-a",
  viewerName: "Ada Personal",
  orgId: "org-a",
  orgName: "Personal",
  urlKey: "personal",
  issues: [
    { id: "11111111-1111-4111-8111-111111111111", identifier: "ENG-1", title: "Personal task" },
  ],
  endCursor: "cursorA1",
};

const ACCOUNT_B: FixtureAccount = {
  code: "code-b",
  token: "token_account_b_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  refreshToken: "refresh_account_b_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  viewerId: "viewer-b",
  viewerName: "Ada Company",
  orgId: "org-b",
  orgName: "Company",
  urlKey: "company",
  issues: [
    { id: "22222222-2222-4222-8222-222222222222", identifier: "ENG-1", title: "Company task" },
  ],
  endCursor: "cursorB1",
};

function makeFixtureUpstream(
  accounts: ReadonlyArray<FixtureAccount>,
  options: {
    readonly failIdentityForToken?: ReadonlySet<string>;
    readonly expiredRefreshTokens?: ReadonlySet<string>;
  } = {},
) {
  const byCode = new Map(accounts.map((account) => [account.code, account]));
  const byToken = new Map(accounts.map((account) => [account.token, account]));
  const graphqlCalls: Array<{ readonly token: string | null; readonly query: string }> = [];
  const revokedTokens: string[] = [];

  const fetch = vi.fn(async (input: Request) => {
    if (input.url === "https://api.linear.app/oauth/token") {
      const form = new URLSearchParams(await input.text());
      const grantType = form.get("grant_type");
      if (grantType === "refresh_token") {
        const refresh = form.get("refresh_token") ?? "";
        if (options.expiredRefreshTokens?.has(refresh)) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        const matched = accounts.find((account) => account.refreshToken === refresh);
        if (matched === undefined)
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({
          access_token: matched.token,
          refresh_token: matched.refreshToken,
          token_type: "Bearer",
          expires_in: 86_399,
          scope: "read write",
        });
      }
      const code = form.get("code") ?? "";
      const account = byCode.get(code);
      if (account === undefined) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({
        access_token: account.token,
        refresh_token: account.refreshToken,
        token_type: "Bearer",
        expires_in: 86_399,
        scope: "read write",
      });
    }
    if (input.url === "https://api.linear.app/oauth/revoke") {
      const form = new URLSearchParams(await input.text());
      revokedTokens.push(form.get("token") ?? "");
      return new Response(null, { status: 200 });
    }
    if (input.url === "https://api.linear.app/graphql") {
      const auth = input.headers.get("authorization");
      const token = auth?.startsWith("Bearer ") ? auth.slice("Bearer ".length) : null;
      const body = JSON.parse(await input.text()) as {
        readonly query: string;
        readonly variables?: Readonly<Record<string, unknown>>;
      };
      graphqlCalls.push({ token, query: body.query });
      const account = token === null ? undefined : byToken.get(token);
      if (account === undefined || options.failIdentityForToken?.has(token ?? "")) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      if (body.query.includes("viewer {")) {
        return Response.json({
          data: {
            viewer: {
              id: account.viewerId,
              name: account.viewerName,
              organization: {
                id: account.orgId,
                name: account.orgName,
                urlKey: account.urlKey,
              },
            },
          },
        });
      }
      if (body.query.includes("BrowseIssues")) {
        return Response.json({
          data: {
            issues: {
              pageInfo: {
                hasNextPage: account.endCursor !== undefined,
                endCursor: account.endCursor ?? null,
              },
              nodes: account.issues.map((issue) => ({
                id: issue.id,
                identifier: issue.identifier,
                title: issue.title,
                url: `https://linear.app/${account.urlKey}/issue/${issue.identifier}`,
                team: { id: `${account.orgId}-team`, key: "ENG" },
                state: { name: "Todo", type: "unstarted" },
                assignee: { name: account.viewerName },
              })),
            },
          },
        });
      }
      if (body.query.includes("IssueDetail")) {
        const id = body.variables?.id;
        const found = account.issues.find((issue) => issue.id === id);
        return Response.json({
          data: {
            issue:
              found === undefined
                ? null
                : {
                    id: found.id,
                    identifier: found.identifier,
                    title: found.title,
                    description: `Detail in ${account.orgName}`,
                    url: `https://linear.app/${account.urlKey}/issue/${found.identifier}`,
                    team: { id: `${account.orgId}-team`, key: "ENG" },
                    state: { name: "Todo", type: "unstarted" },
                    assignee: { name: account.viewerName },
                    comments: { nodes: [] },
                  },
          },
        });
      }
    }
    return new Response(null, { status: 500 });
  });

  return { fetch, graphqlCalls, revokedTokens };
}

async function connectOAuthAccount(
  service: ReturnType<typeof createLinearIntegrationService>,
  code: string,
) {
  const started = await service.execute("linear", { kind: "setup" }, signal());
  expect(started.interaction?.kind).toBe("authorization-redirect");
  if (started.interaction?.kind !== "authorization-redirect") {
    throw new Error("Expected authorization redirect.");
  }
  const state = new URL(started.interaction.authorizationUri).searchParams.get("state") ?? "";
  return service.completeAuthorization("linear", { state, code });
}

function createService(options: { readonly isEffective?: () => boolean } = {}) {
  const fetch = vi.fn(async () => new Response(null, { status: 500 }));
  const vault = createMemorySecretVault();
  const has = vi.spyOn(vault, "has");
  return {
    fetch,
    has,
    service: createLinearIntegrationService({
      vault,
      config: { redirectUri },
      fetch,
      startCallbackListener: false,
      ...(options.isEffective === undefined ? {} : { isEffective: options.isEffective }),
    }),
  };
}

describe("Linear integration service construction", () => {
  it("does not construct Linear GraphQL or OAuth when the integration is not effective", async () => {
    const { service, fetch, has } = createService({ isEffective: () => false });
    await expect(service.snapshot("linear", signal())).resolves.toEqual({
      state: "unavailable",
      capabilities: [],
      remediation: "That integration is not available on this host.",
    });
    await expect(
      service.executeOperation(
        "linear",
        { kind: "operation", operationId: LINEAR_ISSUE_GET_OPERATION, input: { id: "issue" } },
        signal(),
      ),
    ).resolves.toEqual({
      kind: "refused",
      reason: "That integration is not available on this host.",
    });
    await expect(service.execute("linear", { kind: "setup" }, signal())).resolves.toEqual({
      state: "unavailable",
      capabilities: [],
      remediation: "That integration is not available on this host.",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(has).not.toHaveBeenCalled();
  });

  it("loads Linear through the integration loader when the integration is effective", async () => {
    const { service, fetch, has } = createService({ isEffective: () => true });
    await expect(service.snapshot("linear", signal())).resolves.toEqual({
      state: "unauthorized",
      capabilities: [],
      remediation: LINEAR_OAUTH_UNCONFIGURED,
    });
    expect(has).toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("multi-account Linear integration service", () => {
  it("connects a second account without replacing the first, isolates tokens and cursors, and removes either account cleanly", async () => {
    const vault = createMemorySecretVault();
    const indexStore = createMemoryLinearAccountIndexStore();
    const upstream = makeFixtureUpstream([ACCOUNT_A, ACCOUNT_B]);
    const service = createLinearIntegrationService({
      vault,
      accountIndexStore: indexStore,
      config: { clientId, redirectUri },
      fetch: upstream.fetch,
      startCallbackListener: false,
    });

    expect(await connectOAuthAccount(service, ACCOUNT_A.code)).toEqual({ kind: "stored" });
    expect(await connectOAuthAccount(service, ACCOUNT_B.code)).toEqual({ kind: "stored" });

    const refA = computeLinearAccountRef(ACCOUNT_A.viewerId, ACCOUNT_A.orgId);
    const refB = computeLinearAccountRef(ACCOUNT_B.viewerId, ACCOUNT_B.orgId);
    const accounts = await service.accountsSnapshot?.("linear", signal());
    expect(accounts?.accounts.map((entry) => entry.accountRef)).toEqual([refA, refB]);

    upstream.graphqlCalls.length = 0;
    const listA = await service.executeOperation(
      "linear",
      { kind: "operation", operationId: LINEAR_ISSUE_LIST_OPERATION, input: {}, accountRef: refA },
      signal(),
    );
    const listB = await service.executeOperation(
      "linear",
      { kind: "operation", operationId: LINEAR_ISSUE_LIST_OPERATION, input: {}, accountRef: refB },
      signal(),
    );
    expect(listA.kind).toBe("ok");
    expect(listB.kind).toBe("ok");
    if (listA.kind !== "ok" || listB.kind !== "ok") return;
    expect(listA.value).toMatchObject({ rows: [{ title: "Personal task", identifier: "ENG-1" }] });
    expect(listB.value).toMatchObject({ rows: [{ title: "Company task", identifier: "ENG-1" }] });
    // Each call carried only its own account's bearer token.
    expect(upstream.graphqlCalls.map((call) => call.token)).toEqual([
      ACCOUNT_A.token,
      ACCOUNT_B.token,
    ]);

    // A cursor issued for account A is refused on account B without calling Linear.
    const cursorA = (listA.value as { readonly endCursor?: string }).endCursor;
    expect(cursorA).toBeDefined();
    upstream.graphqlCalls.length = 0;
    const crossCursor = await service.executeOperation(
      "linear",
      {
        kind: "operation",
        operationId: LINEAR_ISSUE_LIST_OPERATION,
        input: { cursor: cursorA },
        accountRef: refB,
      },
      signal(),
    );
    expect(crossCursor).toMatchObject({ kind: "refused" });
    expect(upstream.graphqlCalls).toHaveLength(0);

    // Account A cannot read account B's issue by id.
    const crossGet = await service.executeOperation(
      "linear",
      {
        kind: "operation",
        operationId: LINEAR_ISSUE_GET_OPERATION,
        input: { id: ACCOUNT_B.issues[0]?.id },
        accountRef: refA,
      },
      signal(),
    );
    expect(crossGet).toMatchObject({ kind: "refused" });

    // Removing account B revokes only B, keeps A working, and does not bump A's revision.
    const revABefore = service.connectionRevision?.(refA);
    const revBBefore = service.connectionRevision?.(refB);
    await service.execute("linear", { kind: "logout", accountRef: refB }, signal());
    expect(upstream.revokedTokens).toEqual([ACCOUNT_B.token]);
    expect(service.connectionRevision?.(refA)).toBe(revABefore);
    expect(service.connectionRevision?.(refB)).toBe((revBBefore ?? 0) + 1);
    const afterRemoveB = await service.accountsSnapshot?.("linear", signal());
    expect(afterRemoveB?.accounts.map((entry) => entry.accountRef)).toEqual([refA]);
    const stillReadsA = await service.executeOperation(
      "linear",
      { kind: "operation", operationId: LINEAR_ISSUE_LIST_OPERATION, input: {}, accountRef: refA },
      signal(),
    );
    expect(stillReadsA.kind).toBe("ok");
  });

  it("deletes newly stored secrets when identity verification or index write fails, and refuses Connect when vault is unavailable", async () => {
    const vault = createMemorySecretVault();
    const putSpy = vi.spyOn(vault, "put");
    const deleteSpy = vi.spyOn(vault, "delete");
    let shouldFailWrite = false;
    const indexStore = createMemoryLinearAccountIndexStore(
      { kind: "absent" },
      { failWrites: () => shouldFailWrite },
    );
    const upstream = makeFixtureUpstream([ACCOUNT_A, ACCOUNT_B], {
      failIdentityForToken: new Set([ACCOUNT_A.token]),
    });
    const service = createLinearIntegrationService({
      vault,
      accountIndexStore: indexStore,
      config: { clientId, redirectUri },
      fetch: upstream.fetch,
      startCallbackListener: false,
    });

    // Failed identity check stores nothing.
    const failedIdentity = await connectOAuthAccount(service, ACCOUNT_A.code);
    expect(failedIdentity).toMatchObject({ kind: "refused" });
    const failedVaultId = putSpy.mock.calls[0]?.[0] ?? "";
    expect(failedVaultId.length).toBeGreaterThan(0);
    expect(putSpy.mock.calls.every(([id]) => id === failedVaultId)).toBe(true);
    expect(deleteSpy).toHaveBeenCalledWith(failedVaultId);
    expect(await vault.has(failedVaultId)).toBe(false);

    // Failed index write deletes the newly stored secret and refuses Connect.
    putSpy.mockClear();
    deleteSpy.mockClear();
    shouldFailWrite = true;
    const failedWrite = await connectOAuthAccount(service, ACCOUNT_B.code);
    expect(failedWrite).toMatchObject({ kind: "refused" });
    const rolledBackVaultId = putSpy.mock.calls[0]?.[0] ?? "";
    expect(deleteSpy).toHaveBeenCalledWith(rolledBackVaultId);
    expect(await vault.has(rolledBackVaultId)).toBe(false);

    // Same rollback applies to personal API keys.
    putSpy.mockClear();
    deleteSpy.mockClear();
    const failedKeyWrite = await service.putSecret("linear", "personal-api-key", ACCOUNT_B.token);
    expect(failedKeyWrite).toMatchObject({ kind: "refused" });
    const rolledBackKeyId = putSpy.mock.calls[0]?.[0] ?? "";
    expect(deleteSpy).toHaveBeenCalledWith(rolledBackKeyId);
    expect(await vault.has(rolledBackKeyId)).toBe(false);

    // Unavailable vault refuses Connect cleanly.
    const unavailableService = createLinearIntegrationService({
      vault: createUnavailableSecretVault(),
      config: { clientId, redirectUri },
      fetch: upstream.fetch,
      startCallbackListener: false,
    });
    expect(await connectOAuthAccount(unavailableService, ACCOUNT_B.code)).toMatchObject({
      kind: "refused",
    });
    expect(
      await unavailableService.putSecret("linear", "personal-api-key", ACCOUNT_B.token),
    ).toMatchObject({ kind: "unavailable" });
  });

  it("migrates legacy single-account state without startup calls, pins omitted accountRef to the legacy account only, and adopts an unused personal API key", async () => {
    const vault = createMemorySecretVault(
      new Map([
        [
          LINEAR_OAUTH_CREDENTIAL_ID,
          JSON.stringify({
            accessToken: ACCOUNT_A.token,
            refreshToken: ACCOUNT_A.refreshToken,
            tokenType: "Bearer",
            expiresAt: Date.now() + 60_000,
            scope: "read write",
            clientId,
            tokenEndpoint: "https://api.linear.app/oauth/token",
          }),
        ],
        [LINEAR_API_KEY_CREDENTIAL_ID, ACCOUNT_B.token],
      ]),
    );
    const connectionStore = createMemoryConnectionStore({
      source: "oauth",
      reconnectRequired: false,
      account: { login: "personal", source: "oauth", scopes: ["read", "write"] },
    });
    const indexStore = createMemoryLinearAccountIndexStore({ kind: "absent" });
    const upstream = makeFixtureUpstream([ACCOUNT_A, ACCOUNT_B]);
    const service = createLinearIntegrationService({
      vault,
      connectionStore,
      accountIndexStore: indexStore,
      config: { clientId, redirectUri },
      fetch: upstream.fetch,
      startCallbackListener: false,
    });

    // Construction performs zero upstream calls and moves no tokens.
    expect(upstream.fetch).not.toHaveBeenCalled();
    expect(service.hasConnectedAccount?.("linear")).toBe(true);
    expect(await vault.has(LINEAR_OAUTH_CREDENTIAL_ID)).toBe(true);

    // First snapshot promotes the legacy entry and populates `legacyRef`.
    const snap = await service.snapshot("linear", signal());
    expect(snap.state).toBe("ready");
    const refA = computeLinearAccountRef(ACCOUNT_A.viewerId, ACCOUNT_A.orgId);
    const refB = computeLinearAccountRef(ACCOUNT_B.viewerId, ACCOUNT_B.orgId);
    const stored = indexStore.read();
    expect(stored.kind).toBe("ok");
    if (stored.kind === "ok") {
      expect(stored.index.legacyRef).toBe(refA);
      expect(stored.index.accounts[0]?.vaultId).toBe(LINEAR_OAUTH_CREDENTIAL_ID);
    }

    // Legacy personal API key beside OAuth is surfaced as unused and can be adopted without moving it.
    const accountsBeforeAdopt = await service.accountsSnapshot?.("linear", signal());
    expect(accountsBeforeAdopt?.unusedPersonalCredentialStored).toBe(true);
    expect(accountsBeforeAdopt?.accounts.map((entry) => entry.accountRef)).toEqual([refA]);

    expect(await service.adoptLegacyPersonalCredential?.("linear", signal())).toEqual({
      kind: "stored",
    });
    const accountsAfterAdopt = await service.accountsSnapshot?.("linear", signal());
    expect(accountsAfterAdopt?.unusedPersonalCredentialStored).toBeUndefined();
    expect(accountsAfterAdopt?.accounts.map((entry) => entry.accountRef)).toEqual([refA, refB]);

    // Omitted accountRef still resolves to the legacy account A.
    upstream.graphqlCalls.length = 0;
    const legacyList = await service.executeOperation(
      "linear",
      { kind: "operation", operationId: LINEAR_ISSUE_LIST_OPERATION, input: {} },
      signal(),
    );
    expect(legacyList.kind).toBe("ok");
    expect(upstream.graphqlCalls.map((call) => call.token)).toEqual([ACCOUNT_A.token]);

    // After removing legacy account A, omitted accountRef resolves to NOTHING (never falls back to B).
    await service.execute("linear", { kind: "logout", accountRef: refA }, signal());
    upstream.graphqlCalls.length = 0;
    const legacyAfterRemoval = await service.executeOperation(
      "linear",
      { kind: "operation", operationId: LINEAR_ISSUE_LIST_OPERATION, input: {} },
      signal(),
    );
    expect(legacyAfterRemoval).toMatchObject({ kind: "refused" });
    expect(upstream.graphqlCalls).toHaveLength(0);

    // Reconnecting account A restores omitted accountRef resolution.
    expect(await connectOAuthAccount(service, ACCOUNT_A.code)).toEqual({ kind: "stored" });
    const legacyRestored = await service.executeOperation(
      "linear",
      { kind: "operation", operationId: LINEAR_ISSUE_LIST_OPERATION, input: {} },
      signal(),
    );
    expect(legacyRestored.kind).toBe("ok");
  });

  it("refuses reads and leaves secrets intact when the account index is damaged", async () => {
    const vault = createMemorySecretVault(new Map([[LINEAR_OAUTH_CREDENTIAL_ID, "secret-token"]]));
    const indexStore = createMemoryLinearAccountIndexStore({
      kind: "damaged",
      reason: "The Linear accounts index is damaged.",
    });
    const upstream = makeFixtureUpstream([ACCOUNT_A]);
    const service = createLinearIntegrationService({
      vault,
      accountIndexStore: indexStore,
      config: { clientId, redirectUri },
      fetch: upstream.fetch,
      startCallbackListener: false,
    });

    const accounts = await service.accountsSnapshot?.("linear", signal());
    expect(accounts?.accounts).toEqual([]);
    expect(accounts?.indexDamaged).toBe(true);
    expect(
      await service.executeOperation(
        "linear",
        { kind: "operation", operationId: LINEAR_ISSUE_LIST_OPERATION, input: {} },
        signal(),
      ),
    ).toMatchObject({ kind: "refused" });
    expect(upstream.fetch).not.toHaveBeenCalled();
    expect(await vault.has(LINEAR_OAUTH_CREDENTIAL_ID)).toBe(true);
  });

  it("marks only the expired account as requiring reconnect while the other account stays ready", async () => {
    const vault = createMemorySecretVault();
    const indexStore = createMemoryLinearAccountIndexStore();
    const expired = new Set<string>();
    const upstream = makeFixtureUpstream([ACCOUNT_A, ACCOUNT_B], {
      expiredRefreshTokens: expired,
    });
    const service = createLinearIntegrationService({
      vault,
      accountIndexStore: indexStore,
      config: { clientId, redirectUri },
      fetch: upstream.fetch,
      startCallbackListener: false,
    });

    expect(await connectOAuthAccount(service, ACCOUNT_A.code)).toEqual({ kind: "stored" });
    expect(await connectOAuthAccount(service, ACCOUNT_B.code)).toEqual({ kind: "stored" });
    const refA = computeLinearAccountRef(ACCOUNT_A.viewerId, ACCOUNT_A.orgId);
    const refB = computeLinearAccountRef(ACCOUNT_B.viewerId, ACCOUNT_B.orgId);

    expired.add(ACCOUNT_A.refreshToken);
    const refreshedA = await service.execute(
      "linear",
      { kind: "refresh", accountRef: refA },
      signal(),
    );
    expect(refreshedA.state).toBe("unauthorized");
    expect(refreshedA.remediation).toBe(LINEAR_RECONNECT_REASON);

    const accounts = await service.accountsSnapshot?.("linear", signal());
    const entryA = accounts?.accounts.find((entry) => entry.accountRef === refA);
    const entryB = accounts?.accounts.find((entry) => entry.accountRef === refB);
    expect(entryA?.reconnectRequired).toBe(true);
    expect(entryA?.remediation).toBe(LINEAR_RECONNECT_REASON);
    expect(entryB?.state).toBe("ready");
    expect(entryB?.reconnectRequired).toBeUndefined();
  });

  it("promotes an unpromoted reconnect-required legacy account when that same account reconnects", async () => {
    const vault = createMemorySecretVault();
    const indexStore = createMemoryLinearAccountIndexStore();
    const upstream = makeFixtureUpstream([ACCOUNT_A, ACCOUNT_B]);
    const legacyStore = createMemoryConnectionStore({
      source: "oauth",
      reconnectRequired: true,
      account: {
        login: ACCOUNT_A.urlKey,
        displayName: ACCOUNT_A.viewerName,
        workspace: ACCOUNT_A.orgName,
        source: "oauth",
        scopes: ["read"],
      },
    });
    const service = createLinearIntegrationService({
      vault,
      accountIndexStore: indexStore,
      connectionStore: legacyStore,
      config: { clientId, redirectUri },
      fetch: upstream.fetch,
      startCallbackListener: false,
    });

    // Connecting an unrelated account B must NOT take over the unpromoted legacy bindings.
    expect(await connectOAuthAccount(service, ACCOUNT_B.code)).toEqual({ kind: "stored" });
    const refA = computeLinearAccountRef(ACCOUNT_A.viewerId, ACCOUNT_A.orgId);
    const refB = computeLinearAccountRef(ACCOUNT_B.viewerId, ACCOUNT_B.orgId);
    const afterB = await service.accountsSnapshot?.("linear", signal());
    expect(afterB?.accounts.find((entry) => entry.accountRef === refB)?.isLegacy).toBeUndefined();
    expect(afterB?.accounts.some((entry) => entry.accountRef === "legacy")).toBe(true);

    // Reconnecting account A promotes `legacyRef` to refA and replaces the placeholder.
    expect(await connectOAuthAccount(service, ACCOUNT_A.code)).toEqual({ kind: "stored" });
    const afterA = await service.accountsSnapshot?.("linear", signal());
    expect(afterA?.accounts.some((entry) => entry.accountRef === "legacy")).toBe(false);
    expect(afterA?.accounts.find((entry) => entry.accountRef === refA)?.isLegacy).toBe(true);
    expect(
      await service.executeOperation(
        "linear",
        { kind: "operation", operationId: LINEAR_ISSUE_LIST_OPERATION, input: {} },
        signal(),
      ),
    ).toMatchObject({ kind: "ok" });
  });
});
