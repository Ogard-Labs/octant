import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventActor, decodeUtcTimestamp, decodeWindowId } from "@octant/contracts";
import { Schema } from "effect";
import {
  TODO_AGGREGATE_TYPE,
  decodeTodoCommand,
  decodeTodoListView,
} from "@octant/contracts/todos";
import { afterEach, describe, expect, it } from "vitest";
import { classifyProductAction } from "../authenticatedProductRoutes";
import { AggregateHeadsProjection } from "../persistence/aggregateHeadsProjection";
import { EventRegistry } from "../persistence/eventRegistry";
import { Journal } from "../persistence/journal";
import { applyMigrations, MIGRATIONS } from "../persistence/migrations";
import { ProjectionRegistry } from "../persistence/projection";
import { openSqlite } from "../persistence/sqlitePort";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { createRemoteRoutePolicy } from "../remoteRoutePolicy";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { createTodoRouteHandler } from "./todoRoutes";
import { registerTodoEvents, TodoStore } from "./todoStore";

const START = "2026-11-14T10:00:00.000Z";
const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000a01");
const DEVICE = "55000000-0000-4000-8000-000000000a02";
const TODO_1 = "00000000-0000-4000-8000-000000000001";
const TODO_2 = "00000000-0000-4000-8000-000000000002";
const actor = Schema.decodeUnknownSync(EventActor)({
  kind: "local-user",
  actorId: "99999999-9999-4999-8999-999999999999",
});

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function host() {
  const directory = mkdtempSync(join(tmpdir(), "octant-todos-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "events.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => START);
  const journal = new Journal({
    connection,
    registry: registerTodoEvents(new EventRegistry()),
    projections: new ProjectionRegistry().register(new AggregateHeadsProjection()),
    clock: () => START,
  });
  // Set to make the journal refuse the append with that index (1 is the first) from now on.
  const failing = { atAppend: 0, seen: 0 };
  const start = () =>
    new TodoStore({
      journal: {
        replayAggregateType: (cursor) => journal.replayAggregateType(cursor),
        transaction: (body) => journal.transaction(body),
        append: (input) => {
          failing.seen += 1;
          if (failing.atAppend !== 0 && failing.seen === failing.atAppend) {
            throw new Error("disk full");
          }
          return journal.append(input);
        },
      },
      uuid: () => crypto.randomUUID(),
      clock: () => decodeUtcTimestamp(START),
    });
  const store = start();
  const windows = new WindowAuthorityStore();
  windows.register({ windowId, capability, now: 0 });
  const routes = createTodoRouteHandler({ store, windowAuthorityStore: windows, now: () => 0 });

  const fromWindow = (path: string, body?: unknown) =>
    routes(
      new Request(`http://127.0.0.1${path}`, {
        ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) as BodyInit }),
        headers: { "x-octant-window-capability": capability, "content-type": "application/json" },
      }),
    );

  const fromDevice = (
    admittedBy: "host-person" | "hub-roster" | undefined,
    path: string,
    body?: unknown,
    origin = "https://phone.example",
  ) => {
    const request = new Request(`http://127.0.0.1${path}`, {
      ...(body === undefined ? {} : { method: "POST", body: JSON.stringify(body) as BodyInit }),
      headers: { "content-type": "application/json" },
    });
    bindPrincipalRouteContext(request, {
      principal: {
        kind: "remote-device",
        hostId: "11111111-1111-4111-8111-111111111111",
        deviceId: DEVICE,
        credentialGeneration: 1,
        origin,
        protocolVersion: 1,
        capabilityDigest: "a".repeat(64),
        sessionId: "55000000-0000-4000-8000-0000000009aa",
        ...(admittedBy === undefined ? {} : { admittedBy }),
      } as never,
      scopeId: DEVICE as never,
    });
    return routes(request);
  };

  const actors = () =>
    journal
      .replayAggregateType({ aggregateType: TODO_AGGREGATE_TYPE, afterSequence: 0, limit: 100 })
      .map((envelope) => ({ eventName: envelope.eventName, actor: envelope.actor }));

  return { store, start, fromWindow, fromDevice, actors, failing };
}

async function list(response: Response | undefined) {
  expect(response?.status).toBe(200);
  return decodeTodoListView(await response?.json());
}

describe("the person's to-do list", () => {
  it("is the same list after the host restarts", async () => {
    const h = host();
    await h.fromWindow("/api/todos/commands", {
      kind: "add-todo",
      todoId: TODO_1,
      title: "Fix the auth redirect loop",
      tags: ["bug"],
    });
    await h.fromWindow("/api/todos/commands", {
      kind: "add-todo",
      todoId: TODO_2,
      title: "Seed staging data",
    });
    await h.fromWindow("/api/todos/commands", {
      kind: "set-todo-state",
      todoId: TODO_1,
      state: "done",
    });
    await h.fromWindow("/api/todos/commands", { kind: "move-todo", todoId: TODO_2 });
    const before = h.store.view();
    expect(before.todos.map((todo) => todo.title)).toEqual([
      "Fix the auth redirect loop",
      "Seed staging data",
    ]);
    expect(h.start().view()).toEqual(before);
  });

  it("lets a window and a device the person paired read and change it, and records which one did", async () => {
    const h = host();
    await h.fromDevice("host-person", "/api/todos/commands", {
      kind: "add-todo",
      todoId: TODO_1,
      title: "From the phone",
    });
    await h.fromWindow("/api/todos/commands", {
      kind: "set-todo-tags",
      todoId: TODO_1,
      tags: ["errand"],
    });
    const fromPhone = await list(await h.fromDevice("host-person", "/api/todos"));
    expect(fromPhone.todos[0]).toMatchObject({ title: "From the phone", tags: ["errand"] });
    expect(h.actors()).toEqual([
      { eventName: "todo.created@1", actor: expect.objectContaining({ kind: "remote-device" }) },
      { eventName: "todo.tags-set@1", actor: expect.objectContaining({ kind: "local-user" }) },
    ]);
  });

  it("refuses a hub-introduced device, an unproved pairing and an agent grant, reads included", async () => {
    const h = host();
    await h.fromWindow("/api/todos/commands", { kind: "add-todo", todoId: TODO_1, title: "Mine" });
    const callers = [
      () => h.fromDevice("hub-roster", "/api/todos"),
      () => h.fromDevice(undefined, "/api/todos"),
      () => h.fromDevice(undefined, "/api/todos", undefined, "octant-agent-access"),
      () =>
        h.fromDevice("hub-roster", "/api/todos/commands", {
          kind: "delete-todo",
          todoId: TODO_1,
        }),
      () =>
        h.fromDevice(
          undefined,
          "/api/todos/commands",
          { kind: "delete-todo", todoId: TODO_1 },
          "octant-agent-access",
        ),
    ];
    for (const call of callers) {
      const response = await call();
      expect(response?.status).toBe(403);
      expect(await response?.json()).toMatchObject({
        kind: "todo-refused",
        reason: "unauthorized",
      });
    }
    expect(h.store.view().todos.map((todo) => todo.title)).toEqual(["Mine"]);
  });

  it("keeps the old order everywhere when a renumbering move fails partway", () => {
    const h = host();
    const ids = [1, 2, 3, 4].map((n) => `00000000-0000-4000-8000-00000000010${String(n)}`);
    for (const todoId of ids) {
      h.store.change(decodeTodoCommand({ kind: "add-todo", todoId, title: todoId }), actor);
    }
    const [first, second, third] = [ids[0], ids[1], ids[2]].map((todoId) => {
      if (todoId === undefined) throw new Error("missing id");
      return todoId;
    });
    // Moving two to-dos back and forth before a third halves one gap until a
    // move has to renumber every to-do.
    let renumbered = false;
    for (let round = 0; round < 80 && !renumbered; round += 1) {
      const before = h.store.view();
      const moving = round % 2 === 0 ? first : second;
      const move = decodeTodoCommand({ kind: "move-todo", todoId: moving, beforeTodoId: third });
      h.failing.seen = 0;
      h.failing.atAppend = 2;
      const result = (() => {
        try {
          return h.store.change(move, actor);
        } catch {
          return undefined;
        }
      })();
      h.failing.atAppend = 0;
      if (result === undefined) {
        renumbered = true;
        expect(h.store.view()).toEqual(before);
        expect(h.start().view()).toEqual(before);
      }
    }
    expect(renumbered).toBe(true);
  });

  it("refuses a request without the window's capability", async () => {
    const h = host();
    const response = await createTodoRouteHandler({
      store: h.store,
      windowAuthorityStore: new WindowAuthorityStore(),
      now: () => 0,
    })(new Request("http://127.0.0.1/api/todos"));
    expect(response?.status).toBe(401);
  });

  it("answers a stale edit with the text another device saved", async () => {
    const h = host();
    await h.fromWindow("/api/todos/commands", { kind: "add-todo", todoId: TODO_1, title: "Draft" });
    await h.fromDevice("host-person", "/api/todos/commands", {
      kind: "edit-todo",
      todoId: TODO_1,
      expectedVersion: 1,
      title: "Edited on the phone",
      notes: "",
    });
    const stale = await h.fromWindow("/api/todos/commands", {
      kind: "edit-todo",
      todoId: TODO_1,
      expectedVersion: 1,
      title: "Edited on the laptop",
      notes: "",
    });
    expect(stale?.status).toBe(409);
    expect(await stale?.json()).toMatchObject({ reason: "changed-elsewhere" });
    const current = await list(await h.fromWindow("/api/todos"));
    expect(current.todos[0]?.title).toBe("Edited on the phone");
  });

  it("refuses a malformed change and a change to a to-do it does not hold", async () => {
    const h = host();
    const malformed = await h.fromWindow("/api/todos/commands", {
      kind: "add-todo",
      todoId: TODO_1,
      title: "Two\nlines",
    });
    expect(malformed?.status).toBe(400);
    const missing = await h.fromWindow("/api/todos/commands", {
      kind: "set-todo-state",
      todoId: TODO_2,
      state: "done",
    });
    expect(missing?.status).toBe(404);
    expect(h.store.view().todos).toEqual([]);
  });

  it("is forwarded by the private listener and held to the catalogue for every device but the person's", () => {
    const origin = "https://octant.example:8443";
    const policy = createRemoteRoutePolicy({ origin });
    for (const [path, method] of [
      ["/api/todos", "GET"],
      ["/api/todos/commands", "POST"],
    ] as const) {
      const forwarded = new Request(`${origin}${path}`, {
        method,
        headers: {
          host: "octant.example:8443",
          origin,
          "sec-fetch-site": "same-origin",
          ...(method === "POST" ? { "content-type": "application/json" } : {}),
        },
      });
      expect(policy.inspect(forwarded).kind).toBe("allow");
      expect(classifyProductAction(forwarded)).toBeUndefined();
    }
    const elsewhere = new Request(`${origin}/api/todos/export`, {
      headers: { host: "octant.example:8443", origin, "sec-fetch-site": "same-origin" },
    });
    expect(policy.inspect(elsewhere).kind).not.toBe("allow");
  });
});
