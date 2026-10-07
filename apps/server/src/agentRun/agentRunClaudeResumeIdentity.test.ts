import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  decodeAgentRun,
  decodeProviderSessionId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  type AgentRun,
} from "@octant/contracts";
import { openSqlite } from "../persistence/sqlitePort";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { Effect, Exit, Scope, Stream } from "effect";
import {
  agentRunContentSubject,
  purgeAgentRunSubjectContent,
} from "../persistence/agentRunContentStore";
import { makeClaudeDriver } from "../providers/claudeDriver";
import type { ClaudeAgentSdkPort, ClaudeQueryPort } from "../providers/claudeAgentSdkPort";
import { ProviderRuntimeRegistry } from "../providers/providerRuntimeRegistry";
import type { ClaudeResumeIdentity } from "../providers/claudeDriver";
import { AgentRunSessionStore } from "./agentRunSessionStore";
import { createAgentRunClaudeResumeIdentityPort } from "./agentRunClaudeResumeIdentity";

const now = "2026-10-03T10:00:00.000Z";
const providerInstanceId = "55555555-5555-4555-8555-555555555555";
const sessionId = decodeProviderSessionId("99999999-9999-4999-8999-999999999999");
const modelId = "claude-haiku-4-5";
const permissions = {
  filesystem: false,
  shell: false,
  git: false,
  network: false,
  tools: true,
  subagents: false,
};
const run = decodeAgentRun({
  id: "11111111-1111-4111-8111-111111111111",
  requestId: "22222222-2222-4222-8222-222222222222",
  parentThreadId: "33333333-3333-4333-8333-333333333333",
  depth: 0,
  role: "research",
  task: "Summarise the incident report",
  creationPosture: "automatic",
  executionKind: "octant-managed",
  lifecycleStatus: "starting",
  authority: { ...permissions, executionPolicy: "plan", permissionPersistence: "current-session" },
  routingReceipt: {
    executionResolution: {
      providerInstanceId,
      modelId,
      hostId: "local",
      executionPolicy: "plan",
      permissionPersistence: "current-session",
      effectivePermissions: permissions,
      source: "project-default",
      fallbackChain: ["project-default"],
      downgradeReasons: [],
    },
    selectedExecutionKind: "octant-managed",
    attemptedExecutionKind: "octant-managed",
    selectedProviderInstanceId: providerInstanceId,
    selectedModelId: modelId,
    fallbackCandidates: [],
    capabilityDegradations: [],
    contextSnapshotId: "66666666-6666-4666-8666-666666666666",
    effectiveAuthorityDigest: "digest",
    usageQuality: "unavailable",
    hostId: "local",
    mode: "chat",
  },
  workspaceReceipt: { kind: "chat-virtual", mode: "chat" },
  resultAcknowledgement: { required: false, acknowledged: false },
  version: 1,
  createdAt: now,
  updatedAt: now,
});
const identity: ClaudeResumeIdentity = {
  providerInstanceId: run.routingReceipt.selectedProviderInstanceId,
  octantSessionId: sessionId,
  sdkSessionId: "adapter-issued-session",
  projectRoot: "/tmp/octant-child",
  modelId: run.routingReceipt.selectedModelId,
  authentication: "subscription",
};
const key = {
  providerInstanceId: identity.providerInstanceId,
  sdkSessionId: identity.sdkSessionId,
};
const signal = () => new AbortController().signal;
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "octant-child-identity-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "child.sqlite");
  let current: AgentRun | undefined = run;
  let available = true;
  const open = () => {
    const connection = openSqlite(path);
    cleanups.push(() => {
      try {
        connection.close();
      } catch {
        /* Already closed for reopen. */
      }
    });
    applyMigrations(connection, MIGRATIONS, () => now);
    const store = new AgentRunSessionStore({
      connection,
      getById: (id) => (current?.id === id ? current : undefined),
    });
    const makePort = (child = run) =>
      createAgentRunClaudeResumeIdentityPort({
        run: child,
        store,
        isProviderAvailable: () => available,
      });
    return { connection, store, makePort, port: makePort() };
  };
  return {
    open,
    setRun: (value: AgentRun | undefined) => {
      current = value;
    },
    setAvailable: (value: boolean) => {
      available = value;
    },
  };
}
function saveSession(store: AgentRunSessionStore, cursor = false) {
  expect(
    store.sessions.write(run, {
      binding: "admitted-binding",
      sessionId,
      ...(cursor ? { resumeCursor: { driverKind: "claude", value: identity.sdkSessionId } } : {}),
    }),
  ).toBe(true);
}

it("restores only the adapter-written identity after SQLite and the child port reopen", async () => {
  const f = fixture();
  const first = f.open();
  saveSession(first.store);
  await first.port.put(identity, signal());
  expect(await first.port.lookup(key, signal())).toBeUndefined();
  saveSession(first.store, true);
  first.connection.close();
  const second = f.open();
  expect(await second.port.lookup(key, signal())).toEqual(identity);
});

it("does not turn a durable cursor into an identity the adapter never wrote", async () => {
  const first = fixture().open();
  saveSession(first.store, true);
  expect(await first.port.lookup(key, signal())).toBeUndefined();
});

it("refuses identities for a different provider, model, child session, or cursor", async () => {
  const f = fixture().open();
  saveSession(f.store, true);
  for (const changed of [
    {
      ...identity,
      providerInstanceId: decodeProviderInstanceId("77777777-7777-4777-8777-777777777777"),
    },
    { ...identity, modelId: decodeProviderModelId("another-model") },
    {
      ...identity,
      octantSessionId: decodeProviderSessionId("88888888-8888-4888-8888-888888888888"),
    },
    { ...identity, sdkSessionId: "unrelated-provider-history" },
  ]) {
    await expect(f.port.put(changed, signal())).rejects.toThrow("admitted session");
  }
  expect(f.store.readProviderIdentity(run)).toBeUndefined();
  await f.port.put(identity, signal());
  expect(
    await f.port.lookup({ ...key, sdkSessionId: "unrelated-provider-history" }, signal()),
  ).toBeUndefined();
  expect(
    await f.port.lookup(
      {
        ...key,
        providerInstanceId: decodeProviderInstanceId("77777777-7777-4777-8777-777777777777"),
      },
      signal(),
    ),
  ).toBeUndefined();
  const other = decodeAgentRun({ ...run, id: "44444444-4444-4444-8444-444444444444" });
  expect(await f.makePort(other).lookup(key, signal())).toBeUndefined();
  await expect(f.makePort(other).put(identity, signal())).rejects.toThrow();
});

it("refuses old identities and stale port writes when a session binding changes", async () => {
  const f = fixture().open();
  saveSession(f.store, true);
  await f.port.put(identity, signal());
  expect(
    f.store.sessions.write(run, {
      sessionId,
      binding: "different-admission",
      resumeCursor: { driverKind: "claude", value: identity.sdkSessionId },
    }),
  ).toBe(true);
  expect(await f.makePort().lookup(key, signal())).toBeUndefined();
  await expect(f.port.put(identity, signal())).rejects.toThrow();
  await f.makePort().put(identity, signal());
  await f.port.remove(key, signal());
  expect(await f.makePort().lookup(key, signal())).toEqual(identity);
});

it("refuses restoration or late writes from a cancelled or changed admission", async () => {
  const fixtureState = fixture();
  const f = fixtureState.open();
  saveSession(f.store, true);
  await f.port.put(identity, signal());
  for (const changed of [
    decodeAgentRun({ ...run, lifecycleStatus: "cancelled" }),
    decodeAgentRun({ ...run, authority: { ...run.authority, tools: false } }),
    decodeAgentRun({
      ...run,
      routingReceipt: {
        ...run.routingReceipt,
        contextSnapshotId: "77777777-7777-4777-8777-777777777777",
      },
    }),
  ]) {
    fixtureState.setRun(changed);
    expect(await f.port.lookup(key, signal())).toBeUndefined();
    await expect(f.port.put(identity, signal())).rejects.toThrow();
  }
});

it("observes cancellation before identity writes or removals commit", async () => {
  const f = fixture().open();
  saveSession(f.store, true);
  const abortPut = new AbortController();
  const pendingPut = f.port.put(identity, abortPut.signal);
  abortPut.abort();
  await expect(pendingPut).rejects.toThrow();
  expect(f.store.readProviderIdentity(run)).toBeUndefined();
  await f.port.put(identity, signal());
  for (const remove of [
    (abort: AbortSignal) => f.port.remove(key, abort),
    (abort: AbortSignal) => f.store.removeProviderIdentities(identity.providerInstanceId, abort),
  ]) {
    const abortRemove = new AbortController();
    const pendingRemove = remove(abortRemove.signal);
    abortRemove.abort();
    await expect(pendingRemove).rejects.toThrow();
    expect(await f.port.lookup(key, signal())).toEqual(identity);
  }
  const alreadyAborted = AbortSignal.abort();
  await expect(f.port.lookup(key, alreadyAborted)).rejects.toThrow();
  await expect(f.port.put(identity, alreadyAborted)).rejects.toThrow();
});

it("purges identities with their parent and prevents resurrection after the tombstone", async () => {
  const f = fixture().open();
  saveSession(f.store, true);
  await f.port.put(identity, signal());
  purgeAgentRunSubjectContent(f.connection, agentRunContentSubject(run));
  f.connection
    .prepare(
      "INSERT INTO thread_purge_tombstone(mode, thread_id, purged_at, last_sequence) VALUES (?, ?, ?, 1)",
    )
    .run("chat", String(run.parentThreadId), now);
  expect(f.connection.prepare("SELECT content_id FROM agent_run_content_store").all()).toEqual([]);
  expect(await f.port.lookup(key, signal())).toBeUndefined();
  await expect(f.port.put(identity, signal())).rejects.toThrow();
  expect(f.store.sessions.write(run, { sessionId, binding: "admitted-binding" })).toBe(false);
});

it("removes provider identities without deleting child history and refuses late writes from its driver", async () => {
  const state = fixture();
  const f = state.open();
  saveSession(f.store, true);
  await f.port.put(identity, signal());
  await f.store.removeProviderIdentities(
    decodeProviderInstanceId("77777777-7777-4777-8777-777777777777"),
    signal(),
  );
  expect(await f.port.lookup(key, signal())).toEqual(identity);
  state.setAvailable(false);
  const pending = f.port.put(identity, signal());
  await f.store.removeProviderIdentities(identity.providerInstanceId, signal());
  await expect(pending).rejects.toThrow();
  expect(f.connection.prepare("SELECT content_kind FROM agent_run_content_store").all()).toEqual([
    { content_kind: "managed-session" },
  ]);
  expect(await f.port.lookup(key, signal())).toBeUndefined();
  state.setAvailable(true);
  expect(await f.makePort().lookup(key, signal())).toBeUndefined();
});

it("bounds private payload bytes and fails closed for malformed stored identities", async () => {
  const f = fixture().open();
  saveSession(f.store, true);
  await f.port.put(identity, signal());
  const record = f.store.readProviderIdentity(run);
  if (record === undefined) throw new Error("Expected the persisted identity");
  expect(f.store.writeProviderIdentity(run, { ...record, value: "🙂".repeat(20000) })).toBe(false);
  await expect(
    f.port.put({ ...identity, sdkSessionId: "x".repeat(4097) }, signal()),
  ).rejects.toThrow("invalid");
  expect(await f.port.lookup(key, signal())).toEqual(identity);
  for (const text of [
    "{broken",
    JSON.stringify({ ...record, value: "{broken" }),
    JSON.stringify({
      ...record,
      value: JSON.stringify({ ...identity, authentication: "unknown" }),
    }),
    "x".repeat(65537),
  ]) {
    f.connection
      .prepare(
        "UPDATE agent_run_content_store SET body_text = ? WHERE content_kind = 'managed-provider-identity'",
      )
      .run(text);
    expect(await f.makePort().lookup(key, signal())).toBeUndefined();
  }
});

// The adapter is real; only the external SDK/process are deterministic. No
// installed Claude runtime, credentials, network, or provider process is used.
async function driverFixture(port: ReturnType<typeof createAgentRunClaudeResumeIdentityPort>) {
  const initialization: ClaudeQueryPort["initialization"] = {
    models: [
      {
        id: modelId,
        resolvedId: modelId,
        displayName: "Claude Haiku",
        description: "Fixture",
        supportsEffort: false,
        supportedEffortLevels: [],
      },
    ],
    account: { ready: true, apiProvider: "firstParty" },
  };
  const closed = vi.fn(() => Effect.void);
  const query: ClaudeQueryPort = {
    initialization,
    sessionId: Effect.succeed(identity.sdkSessionId),
    messages: Stream.never,
    send: () => Effect.void,
    interrupt: () => Effect.void,
    setPermissionMode: () => Effect.void,
    supportedModels: () => Effect.succeed(initialization.models),
    accountInfo: () => Effect.succeed(initialization.account),
    close: closed,
  };
  const openQuery = vi.fn<ClaudeAgentSdkPort["openQuery"]>(() =>
    Effect.acquireRelease(Effect.succeed(query), (opened) => opened.close()),
  );
  const findSession = vi.fn<ClaudeAgentSdkPort["findSession"]>(() =>
    Effect.succeed({
      sessionId: identity.sdkSessionId,
      projectRoot: identity.projectRoot,
      lastModified: 10,
    }),
  );
  const driver = makeClaudeDriver({
    instanceId: identity.providerInstanceId,
    binaryPath: "/unused/claude",
    authentication: "subscription",
    process: {
      probeVersion: () => Effect.succeed("2.1.211"),
      probeSubscription: () => Effect.succeed("authenticated"),
      spawn: () => {
        throw new Error("This deterministic fixture must never spawn a process");
      },
    },
    sdk: { openQuery, findSession },
    // A Chat child runs confined, so it signs in with Claude for helpers.
    helperSignIn: {
      read: async () => ({ kind: "connected", token: "helper-token-fixture-0123456789" }),
      markExpired: async () => undefined,
    },
    runtimeRegistry: new ProviderRuntimeRegistry(),
    resumeIdentityPort: port,
    makeEnvironmentScope: () => Effect.succeed({ environment: { PATH: "/usr/bin" } }),
    isProjectConfinedPath: (root, path) => path.startsWith(`${root}/`),
    clock: () => now,
    startupTimeoutMs: 100,
    interruptTimeoutMs: 100,
  });
  expect(
    (
      await Effect.runPromise(
        Effect.scoped(driver.probe({ instanceId: identity.providerInstanceId })),
      )
    ).readiness,
  ).toBe("ready");
  openQuery.mockClear();
  const acquire = async (projectRoot = identity.projectRoot) => {
    const scope = await Effect.runPromise(Scope.make());
    const connection = await Effect.runPromise(
      driver
        .acquire({ instanceId: identity.providerInstanceId, projectRoot, mode: "chat" })
        .pipe(Effect.provideService(Scope.Scope, scope)),
    );
    return { connection, close: () => Effect.runPromise(Scope.close(scope, Exit.void)) };
  };
  return { acquire, openQuery, findSession };
}

it("the actual Claude adapter resumes its exact session after the driver and SQLite reopen", async () => {
  const state = fixture();
  const first = state.open();
  saveSession(first.store);
  const firstDriver = await driverFixture(first.port);
  const firstConnection = await firstDriver.acquire();
  try {
    const started = await Effect.runPromise(
      firstConnection.connection.start({
        sessionId,
        modelId: identity.modelId,
        executionPolicy: "plan",
      }),
    );
    expect(started.resumeCursor).toEqual({ driverKind: "claude", value: identity.sdkSessionId });
    expect(first.store.readProviderIdentity(run)?.value).toBe(JSON.stringify(identity));
    // This mirrors the runtime's cursor write only; identity was written above
    // by the actual adapter through its existing port.
    expect(
      first.store.sessions.write(run, {
        sessionId,
        binding: "admitted-binding",
        ...(started.resumeCursor === undefined ? {} : { resumeCursor: started.resumeCursor }),
      }),
    ).toBe(true);
  } finally {
    await firstConnection.close();
  }
  first.connection.close();

  const second = state.open();
  const secondDriver = await driverFixture(second.port);
  const record = second.store.sessions.read(run);
  if (record?.resumeCursor === undefined) throw new Error("Expected a durable child cursor");
  const resume = {
    sessionId: record.sessionId,
    resumeCursor: record.resumeCursor,
    modelId: identity.modelId,
    executionPolicy: "plan" as const,
  };
  const secondConnection = await secondDriver.acquire();
  try {
    const resumed = await Effect.runPromise(secondConnection.connection.resume(resume));
    expect(resumed.resumeCursor).toEqual(record.resumeCursor);
    expect(secondDriver.findSession).toHaveBeenCalledExactlyOnceWith({
      sessionId: identity.sdkSessionId,
      projectRoot: identity.projectRoot,
    });
    expect(secondDriver.openQuery).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        resumeSessionId: identity.sdkSessionId,
        projectRoot: identity.projectRoot,
        model: modelId,
      }),
    );
  } finally {
    await secondConnection.close();
  }

  // Existing driver authority checks must still reject a different workspace.
  const wrongRoot = await secondDriver.acquire("/tmp/another-child");
  try {
    expect(
      await Effect.runPromise(Effect.either(wrongRoot.connection.resume(resume))),
    ).toMatchObject({ _tag: "Left", left: { category: "stale-resume" } });
    expect(secondDriver.openQuery).toHaveBeenCalledTimes(1);
  } finally {
    await wrongRoot.close();
  }

  secondDriver.findSession.mockImplementation(() => Effect.succeed(undefined));
  const missingHistory = await secondDriver.acquire();
  try {
    expect(
      await Effect.runPromise(Effect.either(missingHistory.connection.resume(resume))),
    ).toMatchObject({ _tag: "Left", left: { category: "stale-resume" } });
    expect(secondDriver.openQuery).toHaveBeenCalledTimes(1);
    expect(await second.port.lookup(key, signal())).toBeUndefined();
  } finally {
    await missingHistory.close();
  }
});
