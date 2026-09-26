import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import { EventActor, MAX_OPEN_SIDE_TASKS } from "@octant/contracts";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite, type SqliteConnection } from "../persistence/sqlitePort";
import { dismissSideTask, startSideTask } from "./sideTaskStart";
import { registerSideTaskEvents, SideTaskStore } from "./sideTaskStore";
import { createSideTaskTools } from "./sideTaskTools";

const directories: string[] = [];
const now = "2026-09-26T12:00:00.000Z";
const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: "77777777-7777-4777-8777-777777777777",
});
const threadId = "00000000-0000-4000-8000-000000000020";
const projectId = "00000000-0000-4000-8000-0000000000bb";
const windowId = "00000000-0000-4000-8000-0000000000f0";
const claude = { providerInstanceId: "00000000-0000-4000-8000-000000000001", modelId: "sonnet" };

function openConnection(): SqliteConnection {
  const directory = mkdtempSync(join(tmpdir(), "octant-side-tasks-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  return connection;
}

afterEach(() => {
  while (directories.length > 0) rmSync(directories.pop()!, { recursive: true, force: true });
});

function uuidFactory() {
  let counter = 0;
  return () => `aaaaaaaa-aaaa-4aaa-8aaa-${(++counter).toString(16).padStart(12, "0")}`;
}

function storeOn(connection: SqliteConnection) {
  return new SideTaskStore({
    journal: new Journal({
      connection,
      registry: registerSideTaskEvents(new EventRegistry()),
      projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
      clock: () => now,
    }),
    uuid: uuidFactory(),
    actor,
    clock: () => now,
  });
}

function toolsFor(store: SideTaskStore, mode: "chat" | "work" | "code", uuid = uuidFactory()) {
  return createSideTaskTools({
    store,
    threadId,
    mode,
    projectId,
    suggestedBy: claude,
    uuid,
    clock: () => now,
  });
}

const offer = {
  title: "Fix stale install docs",
  reason: "The README still names the removed setup script.",
  prompt: "Update README.md so the install steps match scripts/setup.ts.",
};

describe("side tasks", () => {
  it("records a model's offer as a card that survives a restart, defaulting Code to a worktree", async () => {
    const connection = openConnection();
    const store = storeOn(connection);
    const answer = await toolsFor(store, "code").execute({
      name: "octant_offer_side_task",
      inputJson: JSON.stringify(offer),
    });
    expect(answer).toMatchObject({ result: { status: "offered" } });
    expect(storeOn(connection).read(threadId).tasks).toMatchObject([
      { status: "offered", offer: { ...offer, target: "new-worktree", mode: "code", projectId } },
    ]);
  });

  it("refuses a worktree outside Code and a model that keeps offering past the open limit", async () => {
    const store = storeOn(openConnection());
    const tools = toolsFor(store, "work");
    expect(tools.definitions[0]?.inputSchema).not.toHaveProperty("properties.target");
    const worktree = await tools.execute({
      name: "octant_offer_side_task",
      inputJson: JSON.stringify({ ...offer, target: "new-worktree" }),
    });
    expect(worktree).toMatchObject({ isError: true, result: { status: "refused" } });

    for (let index = 0; index < MAX_OPEN_SIDE_TASKS; index += 1) {
      await tools.execute({ name: "octant_offer_side_task", inputJson: JSON.stringify(offer) });
    }
    const past = await tools.execute({
      name: "octant_offer_side_task",
      inputJson: JSON.stringify(offer),
    });
    expect(past).toMatchObject({ isError: true });
    expect(store.read(threadId).tasks).toHaveLength(MAX_OPEN_SIDE_TASKS);
  });

  it("starts a side task once: creates the thread on the offering model, sends the prompt, and refuses a second start", async () => {
    const store = storeOn(openConnection());
    await toolsFor(store, "code").execute({
      name: "octant_offer_side_task",
      inputJson: JSON.stringify(offer),
    });
    const sideTaskId = String(store.read(threadId).tasks[0]?.offer.id);
    const create = vi.fn(async () => ({
      kind: "created" as const,
      created: {
        kind: "new-worktree" as const,
        mode: "code" as const,
        projectId: projectId as never,
        title: offer.title,
        threadId: "00000000-0000-4000-8000-000000000099",
      },
      onSuggestingModel: true,
    }));
    const sendFirstMessage = vi.fn(async () => true);
    const dependencies = { store, create, sendFirstMessage, clock: () => now };

    const started = await startSideTask(dependencies, { threadId, windowId, sideTaskId });
    expect(started).toMatchObject({
      kind: "side-task-started",
      mode: "code",
      threadId: "00000000-0000-4000-8000-000000000099",
      sent: true,
    });
    expect(create).toHaveBeenCalledWith({
      windowId,
      view: { threadId, mode: "code", projectId, suggestedBy: claude },
      creation: { kind: "new-worktree", mode: "code", projectId, title: offer.title },
    });
    expect(sendFirstMessage).toHaveBeenCalledWith({
      windowId,
      mode: "code",
      threadId: "00000000-0000-4000-8000-000000000099",
      prompt: offer.prompt,
    });
    expect(store.read(threadId).tasks[0]).toMatchObject({
      status: "started",
      startedThreadId: "00000000-0000-4000-8000-000000000099",
    });
    expect(await startSideTask(dependencies, { threadId, windowId, sideTaskId })).toMatchObject({
      kind: "side-task-refused",
      reason: "already-settled",
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("keeps a created thread started when its first message did not go out, and lets a person dismiss the rest", async () => {
    const store = storeOn(openConnection());
    const tools = toolsFor(store, "chat");
    await tools.execute({ name: "octant_offer_side_task", inputJson: JSON.stringify(offer) });
    await tools.execute({ name: "octant_offer_side_task", inputJson: JSON.stringify(offer) });
    const [first, second] = store.read(threadId).tasks;
    const result = await startSideTask(
      {
        store,
        create: async () => ({
          kind: "created",
          created: {
            kind: "new-thread",
            mode: "chat",
            title: offer.title,
            threadId: "00000000-0000-4000-8000-000000000098",
          },
          onSuggestingModel: true,
        }),
        sendFirstMessage: async () => {
          throw new Error("provider unavailable");
        },
        clock: () => now,
      },
      { threadId, windowId, sideTaskId: String(first?.offer.id) },
    );
    expect(result).toMatchObject({ kind: "side-task-started", sent: false });
    expect(store.read(threadId).tasks[0]?.status).toBe("started");

    expect(
      dismissSideTask(
        { store, clock: () => now },
        { threadId, sideTaskId: String(second?.offer.id) },
      ),
    ).toMatchObject({ kind: "side-task-dismissed" });
    expect(store.read(threadId).tasks[1]?.status).toBe("dismissed");
  });

  it("opens the thread without sending when it could not keep the offering model", async () => {
    const store = storeOn(openConnection());
    await toolsFor(store, "chat").execute({
      name: "octant_offer_side_task",
      inputJson: JSON.stringify(offer),
    });
    const sendFirstMessage = vi.fn(async () => true);
    const result = await startSideTask(
      {
        store,
        create: async () => ({
          kind: "created",
          created: {
            kind: "new-thread",
            mode: "chat",
            title: offer.title,
            threadId: "00000000-0000-4000-8000-000000000097",
          },
          onSuggestingModel: false,
        }),
        sendFirstMessage,
        clock: () => now,
      },
      { threadId, windowId, sideTaskId: String(store.read(threadId).tasks[0]?.offer.id) },
    );
    expect(result).toMatchObject({ kind: "side-task-started", sent: false });
    expect(sendFirstMessage).not.toHaveBeenCalled();
  });

  it("refuses a dismissal while the same side task is being started", async () => {
    const store = storeOn(openConnection());
    await toolsFor(store, "chat").execute({
      name: "octant_offer_side_task",
      inputJson: JSON.stringify(offer),
    });
    const sideTaskId = String(store.read(threadId).tasks[0]?.offer.id);
    let dismissal: unknown;
    const result = await startSideTask(
      {
        store,
        create: async () => {
          dismissal = dismissSideTask({ store, clock: () => now }, { threadId, sideTaskId });
          return {
            kind: "created",
            created: {
              kind: "new-thread",
              mode: "chat",
              title: offer.title,
              threadId: "00000000-0000-4000-8000-000000000096",
            },
            onSuggestingModel: true,
          };
        },
        sendFirstMessage: async () => true,
        clock: () => now,
      },
      { threadId, windowId, sideTaskId },
    );
    expect(dismissal).toMatchObject({ kind: "side-task-refused", reason: "already-settled" });
    expect(result).toMatchObject({ kind: "side-task-started", sent: true });
    expect(store.read(threadId).tasks[0]?.status).toBe("started");
  });
});
