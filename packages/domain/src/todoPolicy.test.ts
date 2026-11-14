import { decodeUtcTimestamp } from "@octant/contracts";
import {
  TODO_LIST_MAX,
  TODO_MAX_THREAD_LINKS,
  TODO_TITLE_MAX_CHARACTERS,
  TODO_CREATED,
  TodoCreated,
  decodeTodoCommand,
} from "@octant/contracts/todos";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  applyTodoEvent,
  decideTodoCommand,
  todosInOrder,
  type TodoListState,
  type TodoRecord,
} from "./todoPolicy";

const HOST = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const at = decodeUtcTimestamp("2026-11-14T10:00:00.000Z");

function id(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

/** A small list host: decides each command and applies what it appends, as the store does. */
function list() {
  const todos = new Map<string, TodoRecord>();
  const deleted = new Set<string>();
  const state: TodoListState = { todos, deleted };
  const run = (input: Record<string, unknown>) => {
    const decision = decideTodoCommand(state, decodeTodoCommand(input));
    if (decision.kind === "append") {
      for (const { todoId, expectedVersion, event } of decision.appends) {
        const key = String(todoId);
        expect(expectedVersion).toBe(todos.get(key)?.todo.version ?? 0);
        const next = applyTodoEvent(todos.get(key), event, {
          version: expectedVersion + 1,
          occurredAt: at,
        });
        if (next === undefined) {
          todos.delete(key);
          deleted.add(key);
        } else todos.set(key, next);
      }
    }
    return decision;
  };
  const titles = () => todosInOrder([...todos.values()].map((r) => r.todo)).map((t) => t.title);
  const get = (n: number) => todos.get(id(n))?.todo;
  return { run, titles, get, todos };
}

describe("to-do decisions", () => {
  it("puts each new to-do on top and adds a resent draft only once", () => {
    const l = list();
    l.run({ kind: "add-todo", todoId: id(1), title: "First" });
    l.run({ kind: "add-todo", todoId: id(2), title: "Second" });
    expect(l.run({ kind: "add-todo", todoId: id(2), title: "Second again" }).kind).toBe(
      "unchanged",
    );
    expect(l.titles()).toEqual(["Second", "First"]);
  });

  it("does not bring back a deleted to-do when its draft is sent again", () => {
    const l = list();
    l.run({ kind: "add-todo", todoId: id(1), title: "Gone" });
    l.run({ kind: "delete-todo", todoId: id(1) });
    expect(l.run({ kind: "add-todo", todoId: id(1), title: "Gone" }).kind).toBe("unchanged");
    expect(l.titles()).toEqual([]);
  });

  it("refuses an edit when the text changed on another device after the version it was made on", () => {
    const l = list();
    l.run({ kind: "add-todo", todoId: id(1), title: "Draft" });
    l.run({ kind: "edit-todo", todoId: id(1), expectedVersion: 1, title: "Phone", notes: "" });
    const stale = l.run({
      kind: "edit-todo",
      todoId: id(1),
      expectedVersion: 1,
      title: "Laptop",
      notes: "",
    });
    expect(stale).toMatchObject({ kind: "refused", reason: "changed-elsewhere" });
    expect(l.get(1)?.title).toBe("Phone");
  });

  it("keeps an edit when only the state or tags changed since it was read", () => {
    const l = list();
    l.run({ kind: "add-todo", todoId: id(1), title: "Draft" });
    l.run({ kind: "set-todo-state", todoId: id(1), state: "done" });
    l.run({ kind: "set-todo-tags", todoId: id(1), tags: ["home"] });
    const edit = l.run({
      kind: "edit-todo",
      todoId: id(1),
      expectedVersion: 1,
      title: "Better title",
      notes: "More",
    });
    expect(edit.kind).toBe("append");
    expect(l.get(1)).toMatchObject({ title: "Better title", notes: "More", state: "done" });
  });

  it("replaces secret-shaped text before it reaches the journal", () => {
    const l = list();
    const key = `sk-ant-api03-${"a".repeat(90)}`;
    l.run({ kind: "add-todo", todoId: id(1), title: `Rotate ${key}`, notes: `old ${key}` });
    expect(l.get(1)?.title).not.toContain(key);
    expect(l.get(1)?.notes).not.toContain(key);
    expect(l.get(1)?.title.length).toBeLessThanOrEqual(TODO_TITLE_MAX_CHARACTERS);
  });

  it("replaces secret-shaped tags and Project names before they reach the journal", () => {
    const l = list();
    // An access-key id's shape, built here so no key-shaped text sits in the source.
    const key = `AKIA${"Q".repeat(16)}`;
    l.run({
      kind: "add-todo",
      todoId: id(1),
      title: "Rotate the key",
      tags: [key],
      projects: [{ hostId: HOST, projectId: PROJECT, name: `Ops ${key}` }],
    });
    l.run({ kind: "set-todo-tags", todoId: id(1), tags: ["ops", key] });
    l.run({
      kind: "set-todo-projects",
      todoId: id(1),
      projects: [{ hostId: HOST, projectId: PROJECT, name: `Infra ${key}` }],
    });
    const todo = l.get(1);
    expect(JSON.stringify(todo)).not.toContain(key);
    expect(todo?.tags[0]).toBe("ops");
    expect(todo?.projects[0]?.name.startsWith("Infra ")).toBe(true);
  });

  it("keeps each tag and each Project once, in the order given", () => {
    const l = list();
    l.run({
      kind: "add-todo",
      todoId: id(1),
      title: "Tagged",
      tags: ["home", "Home", "home"],
      projects: [
        { hostId: HOST, projectId: PROJECT, name: "Site" },
        { hostId: HOST, projectId: PROJECT, name: "Site renamed" },
      ],
    });
    expect(l.get(1)?.tags).toEqual(["home", "Home"]);
    expect(l.get(1)?.projects.map((p) => p.name)).toEqual(["Site"]);
  });

  it("moves a to-do between two others and to the bottom", () => {
    const l = list();
    for (const n of [1, 2, 3]) l.run({ kind: "add-todo", todoId: id(n), title: `T${String(n)}` });
    expect(l.titles()).toEqual(["T3", "T2", "T1"]);
    l.run({ kind: "move-todo", todoId: id(1), beforeTodoId: id(2) });
    expect(l.titles()).toEqual(["T3", "T1", "T2"]);
    l.run({ kind: "move-todo", todoId: id(3) });
    expect(l.titles()).toEqual(["T1", "T2", "T3"]);
    expect(l.run({ kind: "move-todo", todoId: id(3) }).kind).toBe("unchanged");
  });

  it("keeps the order right after more moves into one gap than a rank can halve", () => {
    const l = list();
    for (const n of [1, 2, 3, 4])
      l.run({ kind: "add-todo", todoId: id(n), title: `T${String(n)}` });
    // T4 T3 T2 T1: alternately put T1 and T2 just before T3 so the gap
    // between T4 and T3 is halved again and again.
    for (let round = 0; round < 80; round += 1) {
      l.run({ kind: "move-todo", todoId: id(round % 2 === 0 ? 1 : 2), beforeTodoId: id(3) });
    }
    expect(l.titles()).toEqual(["T4", "T1", "T2", "T3"]);
    l.run({ kind: "move-todo", todoId: id(2), beforeTodoId: id(1) });
    expect(l.titles()).toEqual(["T4", "T2", "T1", "T3"]);
  });

  it("remembers each thread once and only the newest threads past the limit", () => {
    const l = list();
    l.run({ kind: "add-todo", todoId: id(1), title: "Ship it" });
    const link = (n: number) => ({
      kind: "link-todo-thread",
      todoId: id(1),
      thread: { hostId: HOST, threadId: `thread-${String(n)}`, mode: "code" },
    });
    l.run(link(0));
    expect(l.run(link(0)).kind).toBe("unchanged");
    for (let n = 1; n <= TODO_MAX_THREAD_LINKS; n += 1) l.run(link(n));
    const threads = l.get(1)?.threads ?? [];
    expect(threads).toHaveLength(TODO_MAX_THREAD_LINKS);
    expect(String(threads[0]?.threadId)).toBe("thread-1");
  });

  it("refuses a change to a to-do the list does not hold", () => {
    const l = list();
    expect(l.run({ kind: "set-todo-state", todoId: id(9), state: "done" })).toMatchObject({
      kind: "refused",
      reason: "not-found",
    });
  });

  it("refuses a new to-do once the list is full", () => {
    const todos = new Map<string, TodoRecord>();
    const record = applyTodoEvent(
      undefined,
      {
        eventName: TODO_CREATED,
        payload: Schema.decodeUnknownSync(TodoCreated)({
          todoId: id(100),
          title: "Filler",
          notes: "",
          projects: [],
          tags: [],
          rank: 0,
        }),
      },
      { version: 1, occurredAt: at },
    );
    if (record === undefined) throw new Error("created to-do missing");
    for (let n = 0; n < TODO_LIST_MAX; n += 1) todos.set(id(n + 100), record);
    const decision = decideTodoCommand(
      { todos, deleted: new Set() },
      decodeTodoCommand({ kind: "add-todo", todoId: id(1), title: "One more" }),
    );
    expect(decision).toMatchObject({ kind: "refused", reason: "list-full" });
  });
});
