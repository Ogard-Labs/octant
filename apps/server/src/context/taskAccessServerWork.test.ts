import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createContextClient } from "@octant/client-runtime/context-client";
import {
  decodeContextSubjectRef,
  decodeWindowId,
  decodeWorkThread,
  type WorkThread,
} from "@octant/contracts";
import { Schema } from "effect";
import { ShieldServer } from "@octant/contracts/shield-servers";
import { resolveGuardrail } from "@octant/domain/guardrail-policy";
import { createTaskAccessSubjectReader } from "./taskAccessSubject";
import { createTaskAccessFacts } from "./taskAccessFacts";
import { CodeSessionAuthorityStore } from "../code/codeSessionAuthorityStore";
import { WorkThreadProjection } from "../work/workThreadProjection";
import { ServerProjectStore } from "../serverProjects/serverProjectStore";
import {
  serverWorkBindingRevisionId,
  serverWorkProjectOf,
} from "../serverProjects/serverWorkThreads";
import { Journal } from "../persistence/journal";
import { openSqlite } from "../persistence/sqlitePort";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { createPhase1RuntimeRegistries } from "../persistence/runtimeRegistry";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import { createContextRouteHandler } from "../contextRoutes";
import { WindowAuthorityStore } from "../windowAuthorityStore";
const windowId = decodeWindowId("82000000-0000-4000-8000-000000000001");
const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const now = "2026-11-03T06:00:00.000Z";
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});
async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "octant-task-access-server-work-"));
  const database = openSqlite(join(directory, "events.sqlite3"));
  cleanup.push(() => {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  applyMigrations(database, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection: database,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  const server = Schema.decodeUnknownSync(ShieldServer)({
    serverId: "5e7e1111-0000-4000-8000-000000000001",
    alias: "notes",
    user: "person",
    profile: "operate",
    deployCommands: [],
  });
  const remote = vi.fn(async () => ({
    status: "ran" as const,
    exitCode: 0,
    output: Buffer.from("/srv/private-notes\n"),
    truncated: false,
    errorOutput: "",
  }));
  const store = new ServerProjectStore({
    journal,
    personActor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
    uuid: randomUUID,
    clock: () => now,
    servers: () => [server],
    connection: { run: remote },
  });
  store.load();
  const bound = await store.bind({
    name: "Notes",
    serverId: String(server.serverId),
    folder: "/srv/private-notes",
    mode: "work",
    principal: "local-window",
  });
  if (bound.kind !== "changed" || bound.project === undefined)
    throw new Error("Server Work Project fixture did not bind");
  const project = bound.project;
  const projection = new WorkThreadProjection();
  const thread = decodeWorkThread({
    id: "82000000-0000-4000-8000-000000000002",
    projectId: project.id,
    bindingRevisionId: serverWorkBindingRevisionId(project),
    title: "Notes",
    lifecycle: "active",
    providerInstanceId: "82000000-0000-4000-8000-000000000010",
    modelId: "model",
    access: "full-access",
    version: 1,
    createdAt: now,
    updatedAt: now,
  });
  projection.apply({ kind: "thread-created", thread });
  const localProject = vi.fn(() => undefined);
  const standing: { value: "project-unavailable" | "binding-changed" | undefined } = {
    value: undefined,
  };
  const reader = createTaskAccessSubjectReader({
    code: () => undefined,
    work: (id) => projection.read(id),
    project: localProject,
    codeSettings: () => undefined,
    workSettings: () => ({ defaultAccess: "ask-first" }),
    canAccessCodeProject: () => false,
    session: new CodeSessionAuthorityStore(),
    activeCode: (current) => current,
    runningWork: () => undefined,
    workStanding: () => standing.value,
    tainted: () => false,
    holdsServerWorkThread: (candidate: WorkThread) =>
      serverWorkProjectOf(store, candidate) !== undefined,
  });
  const instance = vi.fn(() => undefined);
  const facts = createTaskAccessFacts({
    subject: reader,
    instance,
    observed: () => undefined,
    reviewer: (_id, access) => ({
      resolution: resolveGuardrail({
        access,
        capabilities: { providerReview: false, providerSandbox: false },
      }),
      modelUnavailable: false,
    }),
    clock: () => now,
  });
  const authority = new WindowAuthorityStore();
  authority.register({ windowId, capability, now: 0 });
  let wait = Promise.resolve();
  let enter: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const route = createContextRouteHandler({
    service: {
      inspect: () => {
        throw new Error("No context plan");
      },
      execute: () => {
        throw new Error("No mutation");
      },
      compactionState: () => {
        throw new Error("No compaction");
      },
      taskAccess: (subject, _principal, scope) => facts(subject, scope),
    },
    windowAuthorityStore: authority,
    windowCanOpenProject: async () => false,
    windowCanOpenThread: async (_scope, kind, id) => {
      const current = projection.read(thread.id);
      const allowed =
        kind === "work-thread" &&
        id === String(thread.id) &&
        current?.lifecycle === "active" &&
        serverWorkProjectOf(store, current) !== undefined;
      enter();
      await wait;
      return allowed;
    },
    now: () => 1,
  });
  const subject = decodeContextSubjectRef({ aggregateType: "work-thread", aggregateId: thread.id });
  const client = createContextClient({
    baseUrl: "http://127.0.0.1",
    windowCapability: capability,
    fetch: vi.fn<typeof globalThis.fetch>().mockImplementation(async (input, init) => {
      const response = await route(new Request(input, init));
      if (response === undefined) throw new Error("Missing route");
      return response;
    }),
  });
  return {
    store,
    projection,
    project,
    thread,
    subject,
    client,
    localProject,
    instance,
    remote,
    entered,
    standing,
    hold: (gate: Promise<void>) => {
      wait = gate;
    },
  };
}
describe("server Work standing through authenticated task access", () => {
  it("reports a real catalog-held Work thread without manufacturing a local Project", async () => {
    const f = await fixture();
    expect(serverWorkProjectOf(f.store, f.thread)).toEqual(f.project);
    const report = await f.client.taskAccess?.(f.subject);
    expect(report).toMatchObject({
      standing: "active",
      selectedMode: "full-access",
      effectiveMode: "full-access",
      default: { status: "known", scope: "global", mode: "ask-first", matchesSelected: false },
    });
    expect(JSON.stringify(report)).not.toContain("/srv/private-notes");
    f.store.load();
    expect(await f.client.taskAccess?.(f.subject)).toMatchObject({
      standing: "active",
      default: { scope: "global", mode: "ask-first" },
    });
    expect(f.localProject).not.toHaveBeenCalled();
    expect(f.remote).toHaveBeenCalledTimes(1);
  });
  it.each(["removed", "binding-changed"] as const)(
    "refuses private facts if server Work standing is %s while ordinary read admission waits",
    async (change) => {
      const f = await fixture();
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      f.hold(held);
      const answer = f.client.taskAccess?.(f.subject);
      try {
        await f.entered;
        if (change === "removed")
          expect(
            f.store.remove({ projectId: String(f.project.id), principal: "local-window" }).kind,
          ).toBe("changed");
        else
          f.projection.apply({
            kind: "thread-updated",
            thread: decodeWorkThread({
              ...f.thread,
              bindingRevisionId: serverWorkBindingRevisionId({
                ...f.project,
                folder: "/srv/rebound",
              }),
              version: 2,
            }),
          });
        release();
        await expect(answer).rejects.toMatchObject({ category: "unavailable" });
        expect(f.instance).not.toHaveBeenCalled();
      } finally {
        release();
        await answer?.catch(() => undefined);
      }
    },
  );
  it("does not grant a Work report to a thread naming a Code server Project", async () => {
    const f = await fixture();
    const bound = await f.store.bind({
      name: "Code",
      serverId: String(f.project.serverId),
      folder: f.project.folder,
      principal: "local-window",
    });
    if (bound.kind !== "changed" || bound.project === undefined)
      throw new Error("Code server fixture did not bind");
    f.projection.apply({
      kind: "thread-updated",
      thread: decodeWorkThread({
        ...f.thread,
        projectId: bound.project.id,
        bindingRevisionId: serverWorkBindingRevisionId(bound.project),
        version: 2,
      }),
    });
    await expect(f.client.taskAccess?.(f.subject)).rejects.toMatchObject({
      category: "unauthorized",
    });
    expect(f.instance).not.toHaveBeenCalled();
  });
  it("keeps useful existing turn-refusal and Done facts without reporting an executable level", async () => {
    const f = await fixture();
    f.standing.value = "binding-changed";
    const refused = await f.client.taskAccess?.(f.subject);
    expect(refused?.standing).toBe("active");
    expect(refused?.effectiveMode).toBeUndefined();
    expect(refused?.limitations).toContainEqual(
      expect.objectContaining({
        kind: "unavailable",
        message: expect.stringContaining("binding changed"),
      }),
    );
    f.standing.value = undefined;
    f.projection.apply({
      kind: "thread-updated",
      thread: decodeWorkThread({ ...f.thread, completionConfirmed: true, version: 2 }),
    });
    const done = await f.client.taskAccess?.(f.subject);
    expect(done?.standing).toBe("completed");
    expect(done?.effectiveMode).toBeUndefined();
    expect(f.localProject).not.toHaveBeenCalled();
  });
});
