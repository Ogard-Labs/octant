import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  decodeCodeThread,
  decodeCodeThreadId,
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeThreadRetentionThreadId,
  decodeUtcTimestamp,
  decodeWindowId,
  type CodeThread,
} from "@octant/contracts";
import { decodePersonMemoryCommand } from "@octant/contracts/person-memory";
import {
  SERVER_ATTACHMENT_CLEANUP_AGGREGATE,
  SERVER_ATTACHMENT_CLEANUP_EVENT_NAMES,
  type ServerProject,
} from "@octant/contracts/server-projects";
import type { ShieldServer } from "@octant/contracts/shield-servers";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { purgeThreadArtifacts } from "../persistence/threadArtifactPurge";
import { PersonMemoryStore } from "../personMemory/personMemoryStore";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { ThreadRetentionService } from "../threadRetentionService";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { ServerAttachmentCleanup } from "./serverAttachmentCleanup";
import {
  isSafeServerAttachmentThreadId,
  removeServerThreadAttachments,
  transferServerAttachments,
} from "./serverAttachments";
import {
  ServerConnection,
  type ServerAddress,
  type ServerCall,
  type ServerCallInput,
} from "./serverConnection";
import { SERVER_THREAD_ATTACHMENTS } from "./serverFiles";
import { createServerProjectRouteHandler } from "./serverProjectRoutes";
import { ServerProjectStore } from "./serverProjectStore";
import { serverCodeCheckout } from "./serverProjectThreads";
import {
  canRunThrowawaySshd,
  startThrowawaySshd,
  type ThrowawaySshd,
} from "./throwawaySshd.test-support";

const NOW = "2026-11-19T12:00:00.000Z";
const WEB: ShieldServer = {
  serverId: "5e7e1111-0000-4000-8000-000000000001" as ShieldServer["serverId"],
  alias: "web1",
  user: "deploy",
  profile: "operate",
  deployCommands: [],
};
const OTHER_SERVER: ShieldServer = {
  serverId: "5e7e1111-0000-4000-8000-000000000002" as ShieldServer["serverId"],
  alias: "web2",
  user: "deploy",
  profile: "operate",
  deployCommands: [],
};

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function scratch(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "octant-server-attach-cleanup-")));
  directories.push(directory);
  return directory;
}

function openHarness(directory: string) {
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => NOW);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => NOW,
  });
  return { connection, journal, runtime };
}

/** A controllable SSH connection fake that can switch between reachable and unreachable. */
function controllableConnection() {
  const listeners = new Set<(server: ServerAddress) => void>();
  const calls: Array<{
    readonly server: ServerAddress;
    readonly script: string;
    readonly args: ReadonlyArray<string>;
    readonly freshConnection?: true;
  }> = [];
  let responder: (
    server: ServerAddress,
    input: ServerCallInput,
  ) => Promise<ServerCall> | ServerCall = () => ({
    status: "ran",
    exitCode: 0,
    output: Buffer.from("/srv/app\n"),
    truncated: false,
    errorOutput: "",
  });
  return {
    calls,
    setResponder(
      next: (server: ServerAddress, input: ServerCallInput) => Promise<ServerCall> | ServerCall,
    ) {
      responder = next;
    },
    connection: {
      subscribeConnected(listener: (server: ServerAddress) => void): () => void {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      async run(server: ServerAddress, input: ServerCallInput): Promise<ServerCall> {
        calls.push({
          server,
          script: input.script,
          args: input.args ?? [],
          ...(input.freshConnection === true ? { freshConnection: true as const } : {}),
        });
        const result = await responder(server, input);
        if (result.status === "ran" && input.freshConnection !== true) {
          for (const listener of listeners) listener(server);
        }
        return result;
      },
    },
  };
}

function appendServerCodeThread(
  journal: Journal,
  project: ServerProject,
  threadId: string,
): CodeThread {
  const derived = serverCodeCheckout(project);
  const thread = decodeCodeThread({
    id: decodeCodeThreadId(threadId),
    projectId: project.id,
    bindingRevisionId: derived.bindingRevisionId,
    repositoryId: derived.checkout.repositoryId,
    checkoutId: derived.checkout.id,
    title: "Server Code task",
    lifecycle: "active",
    pinned: false,
    providerInstanceId: decodeProviderInstanceId("5e7e2222-0000-4000-8000-000000000001"),
    modelId: decodeProviderModelId("gpt-5"),
    executionPolicy: "approval-gated",
    permissionPersistence: "current-session",
    deliveryTarget: {
      branchIntent: "server-cleanup-test",
      remoteName: "origin",
      proposedBaseRepository: "local/app",
      proposedBaseBranch: "main",
      outcomeKind: "local-implementation",
      confirmedAt: NOW,
    },
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
  });
  journal.append({
    aggregate: { aggregateType: "code-thread", aggregateId: threadId },
    expectedVersion: 0,
    events: [
      {
        eventId: randomUUID(),
        eventName: "code.thread-created@1",
        eventVersion: 1,
        correlationId: randomUUID(),
        actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
        occurredAt: NOW,
        payload: { kind: "thread-created", thread },
      },
    ],
  });
  return thread;
}

function makeCleanup(input: {
  readonly journal: Journal;
  readonly store: ServerProjectStore;
  readonly connection: ConstructorParameters<typeof ServerAttachmentCleanup>[0]["connection"];
  readonly serverProjectForThread: (
    mode: "chat" | "work" | "code",
    threadId: string,
  ) => ServerProject | undefined;
  readonly listThreadsForProject?: (projectId: string) => ReadonlyArray<string>;
  readonly inlineTimeoutMs?: number;
}) {
  const cleanup = new ServerAttachmentCleanup({
    journal: input.journal,
    personActor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    uuid: randomUUID,
    clock: () => NOW,
    connection: input.connection,
    store: input.store,
    serverProjectForThread: input.serverProjectForThread,
    listThreadsForProject: input.listThreadsForProject ?? (() => []),
    ...(input.inlineTimeoutMs === undefined ? {} : { inlineTimeoutMs: input.inlineTimeoutMs }),
  });
  cleanup.load();
  return cleanup;
}

function makeRetention(input: {
  readonly connection: SqliteConnection;
  readonly journal: Journal;
  readonly dataDirectory: string;
  readonly cleanup: ServerAttachmentCleanup;
  readonly workThreads?: ReadonlyArray<{
    readonly id: string;
    readonly projectId: ServerProject["id"];
    readonly updatedAt: string;
  }>;
}) {
  return new ThreadRetentionService({
    connection: input.connection,
    journal: input.journal,
    clock: () => NOW,
    uuid: randomUUID,
    listWorkThreads: () => input.workThreads ?? [],
    purgeThreadArtifacts: ({ mode, threadId }) =>
      purgeThreadArtifacts({
        connection: input.connection,
        dataDirectory: input.dataDirectory,
        mode,
        threadId: String(threadId),
        managedWorktreeRootPath: (root) => root,
        purgeChatAttachments: async () => undefined,
        purgeWorkAttachments: async () => undefined,
        purgeCodeAttachments: async () => undefined,
        purgeServerAttachments: async (scope) => {
          await input.cleanup.removeForThreadScope(scope);
        },
        purgeGeneratedImages: async () => undefined,
        purgeBrowserCaptures: async () => undefined,
        purgeAgentMessages: async () => undefined,
      }),
  });
}

describe("server attachment cleanup", () => {
  it("refuses unsafe thread identifiers before touching SSH", async () => {
    const fake = controllableConnection();
    const unsafeIds = [
      "",
      ".",
      "..",
      "../etc",
      "../../root",
      "thread/nested",
      "/etc/passwd",
      "thread; rm -rf /",
      "$(whoami)",
      "`id`",
      ".hidden",
      "-rf",
      "a..b",
      "thread with space",
      "thread\nrm -rf /",
      "thread\0null",
      "a".repeat(129),
    ];
    for (const threadId of unsafeIds) {
      expect(isSafeServerAttachmentThreadId(threadId)).toBe(false);
      expect(
        await removeServerThreadAttachments({
          connection: fake.connection,
          server: { alias: WEB.alias, user: WEB.user },
          threadIds: [threadId],
        }),
      ).toEqual({ status: "refused", reason: "unsafe-thread-id" });
      expect(
        await transferServerAttachments({
          connection: fake.connection,
          server: { alias: WEB.alias, user: WEB.user },
          threadId,
          files: [
            {
              attachmentId: "att-1",
              displayName: "note.txt",
              mediaType: "text/plain",
              bytes: new TextEncoder().encode("x"),
            },
          ],
        }),
      ).toMatchObject({ status: "refused" });
    }
    expect(fake.calls).toEqual([]);
  });

  it("removes remote attachment folders over SSH when purging server Code or Work threads", async () => {
    const directory = scratch();
    const { connection, journal } = openHarness(directory);
    const fake = controllableConnection();
    const store = new ServerProjectStore({
      journal,
      personActor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      uuid: randomUUID,
      clock: () => NOW,
      servers: () => [WEB],
      connection: fake.connection,
    });
    store.load();
    const codeBind = await store.bind({
      name: "App",
      serverId: String(WEB.serverId),
      folder: "/srv/app",
      principal: "local-window",
    });
    const workBind = await store.bind({
      name: "Notes",
      serverId: String(WEB.serverId),
      folder: "/srv/notes",
      mode: "work",
      principal: "local-window",
    });
    if (
      codeBind.kind !== "changed" ||
      codeBind.project === undefined ||
      workBind.kind !== "changed" ||
      workBind.project === undefined
    ) {
      throw new Error("Expected server Projects to bind.");
    }
    const codeProject = codeBind.project;
    const workProject = workBind.project;
    const codeThreadId = "5e7e3333-0000-4000-8000-000000000001";
    const workThreadId = "5e7e3333-0000-4000-8000-000000000002";
    appendServerCodeThread(journal, codeProject, codeThreadId);

    const cleanup = makeCleanup({
      journal,
      store,
      connection: fake.connection,
      serverProjectForThread: (mode, id) => {
        if (mode === "code" && id === codeThreadId) return codeProject;
        if (mode === "work" && id === workThreadId) return workProject;
        return undefined;
      },
    });
    const retention = makeRetention({
      connection,
      journal,
      dataDirectory: directory,
      cleanup,
      workThreads: [{ id: workThreadId, projectId: workProject.id, updatedAt: NOW }],
    });

    fake.calls.length = 0;
    const codePurge = await retention.purge(
      {
        scope: {
          kind: "thread",
          mode: "code",
          threadId: decodeThreadRetentionThreadId(codeThreadId),
        },
        confirm: true,
      },
      "local-window",
    );
    expect("purged" in codePurge && codePurge.purged).toHaveLength(1);

    const workPurge = await retention.purge(
      {
        scope: {
          kind: "thread",
          mode: "work",
          threadId: decodeThreadRetentionThreadId(workThreadId),
        },
        confirm: true,
      },
      "local-window",
    );
    expect("purged" in workPurge && workPurge.purged).toHaveLength(1);

    expect(fake.calls.map((call) => ({ alias: call.server.alias, args: call.args }))).toEqual([
      { alias: WEB.alias, args: [codeThreadId] },
      { alias: WEB.alias, args: [workThreadId] },
    ]);
    expect(cleanup.pending()).toEqual([]);
    cleanup.close();
  });

  it("removes remote attachment folders over SSH when a server thread is marked Leave no trace", async () => {
    const directory = scratch();
    const { connection, journal } = openHarness(directory);
    const fake = controllableConnection();
    const store = new ServerProjectStore({
      journal,
      personActor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      uuid: randomUUID,
      clock: () => NOW,
      servers: () => [WEB],
      connection: fake.connection,
    });
    store.load();
    const bound = await store.bind({
      name: "Work Notes",
      serverId: String(WEB.serverId),
      folder: "/srv/notes",
      mode: "work",
      principal: "local-window",
    });
    if (bound.kind !== "changed" || bound.project === undefined) {
      throw new Error("Expected server Work Project to bind.");
    }
    const workProject = bound.project;
    const threadId = "5e7e3333-0000-4000-8000-000000000010";
    const personMemory = new PersonMemoryStore({
      connection,
      journal,
      uuid: randomUUID,
      clock: () => decodeUtcTimestamp(NOW),
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    });
    const cleanup = makeCleanup({
      journal,
      store,
      connection: fake.connection,
      serverProjectForThread: (mode, id) =>
        mode === "work" && id === threadId ? workProject : undefined,
    });

    fake.calls.length = 0;
    const result = personMemory.change(
      decodePersonMemoryCommand({
        kind: "set-thread-leaves-no-trace",
        mode: "work",
        threadId,
        title: "Private server notes",
        leavesNoTrace: true,
      }),
    );
    expect(result.kind).toBe("person-memory");
    await cleanup.whenIdle();

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.server).toEqual({ alias: WEB.alias, user: WEB.user });
    expect(fake.calls[0]?.args).toEqual([threadId]);
    expect(cleanup.pending()).toEqual([]);
    cleanup.close();
    personMemory.close();
  });

  it("never holds up deletion or Leave no trace when the server is unreachable, replays pending removals across restarts, and settles them on the next successful SSH connection", async () => {
    const directory = scratch();
    const { connection, journal } = openHarness(directory);
    const fake = controllableConnection();
    const store = new ServerProjectStore({
      journal,
      personActor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      uuid: randomUUID,
      clock: () => NOW,
      servers: () => [WEB, OTHER_SERVER],
      connection: fake.connection,
    });
    store.load();
    const bound = await store.bind({
      name: "App",
      serverId: String(WEB.serverId),
      folder: "/srv/app",
      principal: "local-window",
    });
    if (bound.kind !== "changed" || bound.project === undefined) {
      throw new Error("Expected server Project to bind.");
    }
    const project = bound.project;
    const purgedThreadId = "5e7e4444-0000-4000-8000-000000000001";
    const untracedThreadId = "5e7e4444-0000-4000-8000-000000000002";
    appendServerCodeThread(journal, project, purgedThreadId);
    appendServerCodeThread(journal, project, untracedThreadId);

    const personMemory = new PersonMemoryStore({
      connection,
      journal,
      uuid: randomUUID,
      clock: () => decodeUtcTimestamp(NOW),
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    });
    const cleanup = makeCleanup({
      journal,
      store,
      connection: fake.connection,
      serverProjectForThread: (mode, id) =>
        mode === "code" && (id === purgedThreadId || id === untracedThreadId) ? project : undefined,
    });
    const retention = makeRetention({
      connection,
      journal,
      dataDirectory: directory,
      cleanup,
    });

    // Server goes unreachable before purge and Leave no trace.
    fake.setResponder(() => ({ status: "unreachable", message: "Connection refused" }));
    fake.calls.length = 0;

    const purgeOutcome = await retention.purge(
      {
        scope: {
          kind: "thread",
          mode: "code",
          threadId: decodeThreadRetentionThreadId(purgedThreadId),
        },
        confirm: true,
      },
      "local-window",
    );
    expect("purged" in purgeOutcome && purgeOutcome.purged).toHaveLength(1);

    const lntResult = personMemory.change(
      decodePersonMemoryCommand({
        kind: "set-thread-leaves-no-trace",
        mode: "code",
        threadId: untracedThreadId,
        leavesNoTrace: true,
      }),
    );
    expect(lntResult.kind).toBe("person-memory");
    await cleanup.whenIdle();

    expect(
      cleanup
        .pending()
        .map((entry) => entry.threadId)
        .sort(),
    ).toEqual([purgedThreadId, untracedThreadId]);
    cleanup.close();
    personMemory.close();

    // Simulate a host restart: replay must restore both pending removals without calling SSH.
    fake.calls.length = 0;
    const restarted = makeCleanup({
      journal,
      store,
      connection: fake.connection,
      serverProjectForThread: () => undefined,
    });
    expect(fake.calls).toEqual([]);
    expect(
      restarted
        .pending()
        .map((entry) => entry.threadId)
        .sort(),
    ).toEqual([purgedThreadId, untracedThreadId]);

    // Server comes back, but a read-only setup probe (`freshConnection: true`) and a call to
    // another server must NOT trigger cleanup for `web1`.
    fake.setResponder(() => ({
      status: "ran",
      exitCode: 0,
      output: Buffer.alloc(0),
      truncated: false,
      errorOutput: "",
    }));
    await fake.connection.run(
      { alias: WEB.alias, user: WEB.user },
      { script: "pwd -P", freshConnection: true, timeoutMs: 5_000, maxOutputBytes: 1_024 },
    );
    await fake.connection.run(
      { alias: OTHER_SERVER.alias, user: OTHER_SERVER.user },
      { script: "true", timeoutMs: 5_000, maxOutputBytes: 1_024 },
    );
    await restarted.whenIdle();
    expect(restarted.pending()).toHaveLength(2);

    // Next regular SSH call to `web1` triggers automatic drain and settles both pending records.
    fake.calls.length = 0;
    await fake.connection.run(
      { alias: WEB.alias, user: WEB.user },
      { script: "echo ok", timeoutMs: 5_000, maxOutputBytes: 1_024 },
    );
    await restarted.whenIdle();

    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]?.server).toEqual({ alias: WEB.alias, user: WEB.user });
    expect([...(fake.calls[1]?.args ?? [])].sort()).toEqual([purgedThreadId, untracedThreadId]);
    expect(restarted.pending()).toEqual([]);

    // Journal holds both pending and settled events, and a second restart replays empty.
    const events = journal
      .replayAggregateType({
        aggregateType: SERVER_ATTACHMENT_CLEANUP_AGGREGATE,
        afterSequence: 0,
        limit: 20,
      })
      .map((envelope) => envelope.eventName);
    expect(
      events.filter((name) => name === SERVER_ATTACHMENT_CLEANUP_EVENT_NAMES.pending),
    ).toHaveLength(2);
    expect(
      events.filter((name) => name === SERVER_ATTACHMENT_CLEANUP_EVENT_NAMES.settled),
    ).toHaveLength(2);

    restarted.close();
    const afterSettleRestart = makeCleanup({
      journal,
      store,
      connection: fake.connection,
      serverProjectForThread: () => undefined,
    });
    expect(afterSettleRestart.pending()).toEqual([]);
    afterSettleRestart.close();
  });

  it("removes a whole server Project cleanly when reachable and returns a notice naming the remote folder when unreachable", async () => {
    const directory = scratch();
    const { journal } = openHarness(directory);
    const fake = controllableConnection();
    let servers: ReadonlyArray<ShieldServer> = [WEB];
    const store = new ServerProjectStore({
      journal,
      personActor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      uuid: randomUUID,
      clock: () => NOW,
      servers: () => servers,
      connection: fake.connection,
    });
    store.load();

    const firstBind = await store.bind({
      name: "Site",
      serverId: String(WEB.serverId),
      folder: "/srv/site",
      principal: "local-window",
    });
    const secondBind = await store.bind({
      name: "Api",
      serverId: String(WEB.serverId),
      folder: "/srv/api",
      principal: "local-window",
    });
    if (
      firstBind.kind !== "changed" ||
      firstBind.project === undefined ||
      secondBind.kind !== "changed" ||
      secondBind.project === undefined
    ) {
      throw new Error("Expected server Projects to bind.");
    }
    const site = firstBind.project;
    const api = secondBind.project;
    const siteThread = "5e7e5555-0000-4000-8000-000000000001";
    const apiThread = "5e7e5555-0000-4000-8000-000000000002";

    const cleanup = makeCleanup({
      journal,
      store,
      connection: fake.connection,
      serverProjectForThread: () => undefined,
      listThreadsForProject: (projectId) =>
        projectId === String(site.id)
          ? [siteThread]
          : projectId === String(api.id)
            ? [apiThread]
            : [],
    });

    const windowId = decodeWindowId("00000000-0000-4000-8000-000000000470");
    const capability = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBA";
    const windows = new WindowAuthorityStore();
    windows.register({ windowId, capability, now: 0 });
    const handler = createServerProjectRouteHandler({
      windowAuthorityStore: windows,
      store,
      prepareProjectRemoval: (input) => cleanup.prepareProjectRemoval(input),
      removeProjectAttachments: (input) => cleanup.removeForProject(input),
      now: () => 1,
    });
    const remove = async (projectId: ServerProject["id"]) =>
      (
        await handler(
          new Request("http://127.0.0.1/api/server-projects", {
            method: "POST",
            body: JSON.stringify({ kind: "remove-server-project", projectId }),
            headers: { "x-octant-window-capability": capability },
          }),
        )
      )?.json() as Promise<Record<string, unknown>>;

    // Reachable removal deletes only `site`'s thread folder and returns no leftover notice.
    fake.calls.length = 0;
    const reachableBody = await remove(site.id);
    expect(reachableBody).toMatchObject({
      kind: "server-projects-updated",
      view: { projects: [{ id: api.id }] },
    });
    expect(reachableBody.notice).toBeUndefined();
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]?.args).toEqual([siteThread]);

    // Unreachable removal still succeeds and returns a notice naming the remote attachment folder.
    fake.setResponder(() => ({ status: "unreachable", message: "Connection refused" }));
    const unreachableBody = await remove(api.id);
    expect(unreachableBody).toMatchObject({
      kind: "server-projects-updated",
      view: { projects: [] },
    });
    expect(typeof unreachableBody.notice).toBe("string");
    expect(String(unreachableBody.notice)).toContain(
      `~/${SERVER_THREAD_ATTACHMENTS}/${apiThread}/`,
    );
    expect(String(unreachableBody.notice)).toContain(WEB.alias);
    expect(store.projects()).toEqual([]);

    // Removing a Project whose server is no longer registered also succeeds with a notice naming the folder.
    fake.setResponder(() => ({
      status: "ran",
      exitCode: 0,
      output: Buffer.from("/srv/docs\n"),
      truncated: false,
      errorOutput: "",
    }));
    const thirdBind = await store.bind({
      name: "Docs",
      serverId: String(WEB.serverId),
      folder: "/srv/docs",
      principal: "local-window",
    });
    if (thirdBind.kind !== "changed" || thirdBind.project === undefined) {
      throw new Error("Expected third server Project to bind.");
    }
    servers = [];
    const unregisteredBody = await remove(thirdBind.project.id);
    expect(unregisteredBody).toMatchObject({
      kind: "server-projects-updated",
      view: { projects: [] },
    });
    expect(String(unregisteredBody.notice)).toContain(`~/${SERVER_THREAD_ATTACHMENTS}/`);
    cleanup.close();
  });

  it("drains and settles owed cleanup before uploading a new attachment to a still-live untraced thread", async () => {
    const directory = scratch();
    const { connection, journal } = openHarness(directory);
    const fake = controllableConnection();
    const store = new ServerProjectStore({
      journal,
      personActor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      uuid: randomUUID,
      clock: () => NOW,
      servers: () => [WEB],
      connection: fake.connection,
    });
    store.load();
    const bound = await store.bind({
      name: "App",
      serverId: String(WEB.serverId),
      folder: "/srv/app",
      principal: "local-window",
    });
    if (bound.kind !== "changed" || bound.project === undefined) {
      throw new Error("Expected server Project to bind.");
    }
    const project = bound.project;
    const threadId = "5e7e6666-0000-4000-8000-000000000001";
    const personMemory = new PersonMemoryStore({
      connection,
      journal,
      uuid: randomUUID,
      clock: () => decodeUtcTimestamp(NOW),
      actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    });
    const cleanup = makeCleanup({
      journal,
      store,
      connection: fake.connection,
      serverProjectForThread: (mode, id) =>
        mode === "code" && id === threadId ? project : undefined,
    });

    // Mark Leave no trace while offline -> pending cleanup is journaled.
    fake.setResponder(() => ({ status: "unreachable", message: "Offline" }));
    personMemory.change(
      decodePersonMemoryCommand({
        kind: "set-thread-leaves-no-trace",
        mode: "code",
        threadId,
        leavesNoTrace: true,
      }),
    );
    await cleanup.whenIdle();
    expect(cleanup.pending().map((entry) => entry.threadId)).toEqual([threadId]);

    // Connectivity returns, and the very first SSH action is uploading a new attachment.
    const events: string[] = [];
    const newBytes = new TextEncoder().encode("fresh attachment\n");
    const sha256 = (await import("node:crypto"))
      .createHash("sha256")
      .update(newBytes)
      .digest("hex");
    fake.calls.length = 0;
    fake.setResponder((_server, input) => {
      const isUpload = input.script.includes("sha256sum");
      events.push(isUpload ? "upload" : "remove");
      return isUpload
        ? {
            status: "ran",
            exitCode: 0,
            output: Buffer.from(
              `/home/deploy/${SERVER_THREAD_ATTACHMENTS}/${threadId}/att-new/fresh.txt\0${sha256}`,
            ),
            truncated: false,
            errorOutput: "",
          }
        : {
            status: "ran",
            exitCode: 0,
            output: Buffer.alloc(0),
            truncated: false,
            errorOutput: "",
          };
    });

    const uploaded = await transferServerAttachments({
      connection: fake.connection,
      server: { alias: WEB.alias, user: WEB.user },
      threadId,
      files: [
        {
          attachmentId: "att-new",
          displayName: "fresh.txt",
          mediaType: "text/plain",
          bytes: newBytes,
        },
      ],
      guard: cleanup.guardTransfer,
    });
    await cleanup.whenIdle();

    expect(uploaded.status).toBe("transferred");
    // Cleanup ran and settled strictly BEFORE the upload; no post-upload removal deleted it.
    expect(events).toEqual(["remove", "upload"]);
    expect(cleanup.pending()).toEqual([]);

    cleanup.close();
    personMemory.close();
  });

  it("stops retrying immediately when settlement persistence fails and aborts active drains cleanly on close", async () => {
    const directory = scratch();
    const { journal } = openHarness(directory);
    const fake = controllableConnection();
    const store = new ServerProjectStore({
      journal,
      personActor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      uuid: randomUUID,
      clock: () => NOW,
      servers: () => [WEB],
      connection: fake.connection,
    });
    store.load();
    const bound = await store.bind({
      name: "App",
      serverId: String(WEB.serverId),
      folder: "/srv/app",
      principal: "local-window",
    });
    if (bound.kind !== "changed" || bound.project === undefined) {
      throw new Error("Expected server Project to bind.");
    }
    const project = bound.project;
    const threadId = "5e7e7777-0000-4000-8000-000000000001";

    // Queue one pending entry while server is unreachable.
    let failSettlement = false;
    const wrappedJournal: ConstructorParameters<typeof ServerAttachmentCleanup>[0]["journal"] = {
      append: (request) => {
        const events =
          typeof request === "object" &&
          request !== null &&
          "events" in request &&
          Array.isArray(request.events)
            ? request.events
            : [];
        if (
          failSettlement &&
          events.some(
            (event) =>
              typeof event === "object" &&
              event !== null &&
              "eventName" in event &&
              event.eventName === SERVER_ATTACHMENT_CLEANUP_EVENT_NAMES.settled,
          )
        ) {
          throw new Error("SQLite database is closed");
        }
        return journal.append(request);
      },
      replayAggregateType: (input) => journal.replayAggregateType(input),
      aggregateVersions: (aggregateType) => journal.aggregateVersions(aggregateType),
      subscribeCommitted: (listener) => journal.subscribeCommitted(listener),
    };
    const cleanup = new ServerAttachmentCleanup({
      journal: wrappedJournal,
      personActor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      uuid: randomUUID,
      clock: () => NOW,
      connection: fake.connection,
      store,
      serverProjectForThread: () => project,
      listThreadsForProject: () => [],
    });
    cleanup.load();

    fake.setResponder(() => ({ status: "unreachable", message: "Offline" }));
    expect(await cleanup.removeForThread({ project, threadId })).toEqual({ status: "pending" });
    expect(cleanup.pending()).toHaveLength(1);

    // Server answers cleanly, but settlement append throws -> must run SSH once and stop.
    failSettlement = true;
    fake.calls.length = 0;
    fake.setResponder(() => ({
      status: "ran",
      exitCode: 0,
      output: Buffer.alloc(0),
      truncated: false,
      errorOutput: "",
    }));
    await cleanup.drainForServer({ alias: WEB.alias, user: WEB.user });
    expect(fake.calls).toHaveLength(1);
    expect(cleanup.pending()).toHaveLength(1);

    // Calling close() during an active SSH drain aborts the in-flight call and refuses new work.
    failSettlement = false;
    let observedAbort = false;
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    fake.calls.length = 0;
    fake.setResponder(
      (_server, input) =>
        new Promise<ServerCall>((resolve) => {
          startedResolve?.();
          input.signal?.addEventListener(
            "abort",
            () => {
              observedAbort = true;
              resolve({ status: "cancelled", output: Buffer.alloc(0), truncated: false });
            },
            { once: true },
          );
        }),
    );
    const activeDrain = cleanup.drainForServer({ alias: WEB.alias, user: WEB.user });
    await started;
    cleanup.close();
    await activeDrain;
    await cleanup.whenIdle();

    expect(observedAbort).toBe(true);
    expect(cleanup.pending()).toHaveLength(1);
    fake.calls.length = 0;
    await cleanup.drainForServer({ alias: WEB.alias, user: WEB.user });
    expect(fake.calls).toEqual([]);
  });

  it("durably journals cleanup intent before starting SSH so a restart mid-call recovers both thread and Project cleanups", async () => {
    const directory = scratch();
    const { journal } = openHarness(directory);
    const fake = controllableConnection();
    const store = new ServerProjectStore({
      journal,
      personActor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      uuid: randomUUID,
      clock: () => NOW,
      servers: () => [WEB],
      connection: fake.connection,
    });
    store.load();
    const firstBind = await store.bind({
      name: "ThreadApp",
      serverId: String(WEB.serverId),
      folder: "/srv/thread-app",
      principal: "local-window",
    });
    const secondBind = await store.bind({
      name: "ProjectApp",
      serverId: String(WEB.serverId),
      folder: "/srv/project-app",
      principal: "local-window",
    });
    if (
      firstBind.kind !== "changed" ||
      firstBind.project === undefined ||
      secondBind.kind !== "changed" ||
      secondBind.project === undefined
    ) {
      throw new Error("Expected server Projects to bind.");
    }
    const threadProject = firstBind.project;
    const removedProject = secondBind.project;
    const threadId = "5e7e8888-0000-4000-8000-000000000001";
    const projectThreadId = "5e7e8888-0000-4000-8000-000000000002";

    const cleanup = makeCleanup({
      journal,
      store,
      connection: fake.connection,
      serverProjectForThread: () => threadProject,
      listThreadsForProject: (projectId) =>
        projectId === String(removedProject.id) ? [projectThreadId] : [],
    });

    const windowId = decodeWindowId("00000000-0000-4000-8000-000000000471");
    const capability = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCA";
    const windows = new WindowAuthorityStore();
    windows.register({ windowId, capability, now: 0 });
    const handler = createServerProjectRouteHandler({
      windowAuthorityStore: windows,
      store,
      prepareProjectRemoval: (input) => cleanup.prepareProjectRemoval(input),
      removeProjectAttachments: (input) => cleanup.removeForProject(input),
      now: () => 1,
    });

    // Hold SSH calls open so we can simulate host exit while SSH is still in flight.
    let sshCallsStarted = 0;
    let bothStartedResolve: (() => void) | undefined;
    const bothStarted = new Promise<void>((resolve) => {
      bothStartedResolve = resolve;
    });
    fake.setResponder(
      (_server, input) =>
        new Promise<ServerCall>((resolve) => {
          sshCallsStarted += 1;
          if (sshCallsStarted === 2) bothStartedResolve?.();
          input.signal?.addEventListener(
            "abort",
            () => resolve({ status: "cancelled", output: Buffer.alloc(0), truncated: false }),
            { once: true },
          );
        }),
    );

    const inFlightThread = cleanup.removeForThread({ project: threadProject, threadId });
    const inFlightProject = handler(
      new Request("http://127.0.0.1/api/server-projects", {
        method: "POST",
        body: JSON.stringify({
          kind: "remove-server-project",
          projectId: removedProject.id,
        }),
        headers: { "x-octant-window-capability": capability },
      }),
    );
    await bothStarted;

    // BEFORE either SSH call finishes, both pending intents are already committed in the journal.
    const committedBeforeSsh = journal
      .replayAggregateType({
        aggregateType: SERVER_ATTACHMENT_CLEANUP_AGGREGATE,
        afterSequence: 0,
        limit: 20,
      })
      .map((envelope) => ({
        eventName: envelope.eventName,
        threadId: (envelope.payload as { readonly threadId: string }).threadId,
      }));
    expect(committedBeforeSsh).toEqual([
      { eventName: SERVER_ATTACHMENT_CLEANUP_EVENT_NAMES.pending, threadId },
      { eventName: SERVER_ATTACHMENT_CLEANUP_EVENT_NAMES.pending, threadId: projectThreadId },
    ]);

    // Simulate crash/exit before SSH returns.
    cleanup.close();
    await Promise.all([inFlightThread, inFlightProject]);

    // Restarted cleanup recovers both intents and settles them on the next SSH connection.
    const restarted = makeCleanup({
      journal,
      store,
      connection: fake.connection,
      serverProjectForThread: () => undefined,
    });
    expect(
      restarted
        .pending()
        .map((entry) => entry.threadId)
        .sort(),
    ).toEqual([threadId, projectThreadId]);

    fake.calls.length = 0;
    fake.setResponder(() => ({
      status: "ran",
      exitCode: 0,
      output: Buffer.alloc(0),
      truncated: false,
      errorOutput: "",
    }));
    await fake.connection.run(
      { alias: WEB.alias, user: WEB.user },
      { script: "true", timeoutMs: 5_000, maxOutputBytes: 256 },
    );
    await restarted.whenIdle();
    expect(restarted.pending()).toEqual([]);
    restarted.close();
  });
});

describe.skipIf(!canRunThrowawaySshd)(
  "server attachment cleanup over a throwaway SSH server",
  () => {
    let sshd: ThrowawaySshd;
    let sshConnection: ServerConnection;

    beforeAll(async () => {
      sshd = await startThrowawaySshd();
      sshConnection = new ServerConnection({
        agentSocket: () => sshd.agentSocket,
        configFile: sshd.configFile,
      });
    }, 30_000);

    afterAll(() => sshd?.stop());

    it("deletes read-only attached files over SSH, never follows symlinks outside the thread folder, and leaves sibling threads untouched", async () => {
      const removedThread = randomUUID();
      const keptThread = randomUUID();
      const symlinkThread = randomUUID();
      const base = join(homedir(), SERVER_THREAD_ATTACHMENTS);
      const removedFolder = join(base, removedThread);
      const keptFolder = join(base, keptThread);
      const symlinkSlot = join(base, symlinkThread);
      const outside = scratch();
      const outsideFile = join(outside, "precious.txt");
      writeFileSync(outsideFile, "do not delete\n");

      try {
        const bytes = new TextEncoder().encode("copied attachment\n");
        const first = await transferServerAttachments({
          connection: sshConnection,
          server: { alias: sshd.alias, user: sshd.user },
          threadId: removedThread,
          files: [
            {
              attachmentId: "att-1",
              displayName: "report.txt",
              mediaType: "text/plain",
              bytes,
            },
          ],
        });
        const second = await transferServerAttachments({
          connection: sshConnection,
          server: { alias: sshd.alias, user: sshd.user },
          threadId: keptThread,
          files: [
            {
              attachmentId: "att-2",
              displayName: "keep.txt",
              mediaType: "text/plain",
              bytes,
            },
          ],
        });
        expect(first.status).toBe("transferred");
        expect(second.status).toBe("transferred");
        expect(existsSync(removedFolder)).toBe(true);
        expect(existsSync(keptFolder)).toBe(true);

        // Plant a symlink at a thread slot pointing outside `~/.octant/thread-attachments/`.
        symlinkSync(outside, symlinkSlot);

        const removed = await removeServerThreadAttachments({
          connection: sshConnection,
          server: { alias: sshd.alias, user: sshd.user },
          threadIds: [removedThread, symlinkThread],
        });
        expect(removed).toEqual({ status: "removed" });
        expect(existsSync(removedFolder)).toBe(false);
        expect(existsSync(symlinkSlot)).toBe(false);
        // The outside target of the symlink and the sibling thread's folder both stay intact.
        expect(readFileSync(outsideFile, "utf8")).toBe("do not delete\n");
        expect(existsSync(keptFolder)).toBe(true);
      } finally {
        rmSync(removedFolder, { recursive: true, force: true });
        rmSync(keptFolder, { recursive: true, force: true });
        rmSync(symlinkSlot, { recursive: true, force: true });
      }
    });

    it("queues pending cleanup while the server is unreachable and deletes the real remote folder on the next SSH call", async () => {
      const directory = scratch();
      const { connection, journal } = openHarness(directory);
      const threadId = randomUUID();
      const folder = join(homedir(), SERVER_THREAD_ATTACHMENTS, threadId);
      const projectFolder = join(sshd.root, `proj-${randomUUID()}`);
      mkdirSync(projectFolder, { recursive: true });
      const liveServer: ShieldServer = {
        ...WEB,
        alias: sshd.alias,
        user: sshd.user,
      };
      let reachable = true;
      const store = new ServerProjectStore({
        journal,
        personActor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
        uuid: randomUUID,
        clock: () => NOW,
        servers: () => [liveServer],
        connection: sshConnection,
      });
      store.load();

      const bound = await store.bind({
        name: "Live",
        serverId: String(liveServer.serverId),
        folder: projectFolder,
        principal: "local-window",
      });
      if (bound.kind !== "changed" || bound.project === undefined) {
        throw new Error("Expected throwaway SSH Project to bind.");
      }
      const project = bound.project;
      appendServerCodeThread(journal, project, threadId);

      // Wrap `sshConnection` so we can simulate the server being unreachable during purge
      // and then reconnect over the real throwaway sshd.
      const gatedConnection: ConstructorParameters<
        typeof ServerAttachmentCleanup
      >[0]["connection"] = {
        subscribeConnected: (listener) => sshConnection.subscribeConnected(listener),
        run: (server, input) =>
          reachable
            ? sshConnection.run(server, input)
            : Promise.resolve({ status: "unreachable", message: "Simulated offline server" }),
      };

      const cleanup = makeCleanup({
        journal,
        store,
        connection: gatedConnection,
        serverProjectForThread: (mode, id) =>
          mode === "code" && id === threadId ? project : undefined,
      });
      const retention = makeRetention({
        connection,
        journal,
        dataDirectory: directory,
        cleanup,
      });

      try {
        const copied = await transferServerAttachments({
          connection: sshConnection,
          server: { alias: sshd.alias, user: sshd.user },
          threadId,
          files: [
            {
              attachmentId: "att-live",
              displayName: "spec.txt",
              mediaType: "text/plain",
              bytes: new TextEncoder().encode("live attachment\n"),
            },
          ],
        });
        expect(copied.status).toBe("transferred");
        expect(existsSync(folder)).toBe(true);

        // Server goes unreachable: purge completes locally and queues a pending removal.
        reachable = false;
        const purged = await retention.purge(
          {
            scope: {
              kind: "thread",
              mode: "code",
              threadId: decodeThreadRetentionThreadId(threadId),
            },
            confirm: true,
          },
          "local-window",
        );
        expect("purged" in purged && purged.purged).toHaveLength(1);
        expect(existsSync(folder)).toBe(true);
        expect(cleanup.pending()).toHaveLength(1);
        cleanup.close();

        // Restart cleanup service, bring the server back, and run one ordinary SSH call.
        reachable = true;
        const restarted = makeCleanup({
          journal,
          store,
          connection: sshConnection,
          serverProjectForThread: () => undefined,
        });
        expect(restarted.pending()).toHaveLength(1);

        const probe = await sshConnection.run(
          { alias: sshd.alias, user: sshd.user },
          { script: "printf ok", timeoutMs: 10_000, maxOutputBytes: 256 },
        );
        expect(probe.status).toBe("ran");
        await restarted.whenIdle();

        expect(existsSync(folder)).toBe(false);
        expect(restarted.pending()).toEqual([]);
        restarted.close();
      } finally {
        cleanup.close();
        rmSync(folder, { recursive: true, force: true });
      }
    });

    it("removes the old remote file and preserves a newly uploaded attachment when an untraced thread reconnects via upload", async () => {
      const directory = scratch();
      const { connection, journal } = openHarness(directory);
      const threadId = randomUUID();
      const folder = join(homedir(), SERVER_THREAD_ATTACHMENTS, threadId);
      const projectFolder = join(sshd.root, `proj-${randomUUID()}`);
      mkdirSync(projectFolder, { recursive: true });
      const liveServer: ShieldServer = {
        ...WEB,
        alias: sshd.alias,
        user: sshd.user,
      };
      let reachable = true;
      const store = new ServerProjectStore({
        journal,
        personActor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
        uuid: randomUUID,
        clock: () => NOW,
        servers: () => [liveServer],
        connection: sshConnection,
      });
      store.load();

      const bound = await store.bind({
        name: "Live",
        serverId: String(liveServer.serverId),
        folder: projectFolder,
        principal: "local-window",
      });
      if (bound.kind !== "changed" || bound.project === undefined) {
        throw new Error("Expected throwaway SSH Project to bind.");
      }
      const project = bound.project;
      const gatedConnection: ConstructorParameters<
        typeof ServerAttachmentCleanup
      >[0]["connection"] = {
        subscribeConnected: (listener) => sshConnection.subscribeConnected(listener),
        run: (server, input) =>
          reachable
            ? sshConnection.run(server, input)
            : Promise.resolve({ status: "unreachable", message: "Simulated offline server" }),
      };
      const personMemory = new PersonMemoryStore({
        connection,
        journal,
        uuid: randomUUID,
        clock: () => decodeUtcTimestamp(NOW),
        actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
      });
      const cleanup = makeCleanup({
        journal,
        store,
        connection: gatedConnection,
        serverProjectForThread: (mode, id) =>
          mode === "code" && id === threadId ? project : undefined,
      });

      try {
        const oldCopy = await transferServerAttachments({
          connection: sshConnection,
          server: { alias: sshd.alias, user: sshd.user },
          threadId,
          files: [
            {
              attachmentId: "att-old",
              displayName: "old.txt",
              mediaType: "text/plain",
              bytes: new TextEncoder().encode("old secret\n"),
            },
          ],
          guard: cleanup.guardTransfer,
        });
        expect(oldCopy.status).toBe("transferred");
        const oldPath = oldCopy.status === "transferred" ? (oldCopy.files[0]?.path ?? "") : "";
        expect(existsSync(oldPath)).toBe(true);

        // Server goes offline; person marks the live thread Leave no trace.
        reachable = false;
        personMemory.change(
          decodePersonMemoryCommand({
            kind: "set-thread-leaves-no-trace",
            mode: "code",
            threadId,
            leavesNoTrace: true,
          }),
        );
        await cleanup.whenIdle();
        expect(cleanup.pending()).toHaveLength(1);
        expect(existsSync(oldPath)).toBe(true);

        // Server reconnects and the first SSH operation is uploading a new attachment to the same thread.
        reachable = true;
        const newCopy = await transferServerAttachments({
          connection: sshConnection,
          server: { alias: sshd.alias, user: sshd.user },
          threadId,
          files: [
            {
              attachmentId: "att-new",
              displayName: "new.txt",
              mediaType: "text/plain",
              bytes: new TextEncoder().encode("new upload\n"),
            },
          ],
          guard: cleanup.guardTransfer,
        });
        await cleanup.whenIdle();

        expect(newCopy.status).toBe("transferred");
        const newPath = newCopy.status === "transferred" ? (newCopy.files[0]?.path ?? "") : "";
        expect(existsSync(oldPath)).toBe(false);
        expect(existsSync(newPath)).toBe(true);
        expect(readFileSync(newPath, "utf8")).toBe("new upload\n");
        expect(cleanup.pending()).toEqual([]);
      } finally {
        cleanup.close();
        personMemory.close();
        rmSync(folder, { recursive: true, force: true });
      }
    });
  },
);
