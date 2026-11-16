import { decodeTodoListView } from "@octant/contracts/todos";
import { describe, expect, it } from "vitest";
import {
  mobileQuickAdd,
  mobileTickCommand,
  mobileTodoDetail,
  mobileTodoLinkCommand,
  mobileTodoSections,
  mobileTodoStartDraft,
} from "./todosPresentation";

const AT = "2026-11-14T10:00:00.000Z";
const HOST = "11111111-1111-4111-8111-111111111111";

function todos(...rows: ReadonlyArray<Record<string, unknown>>) {
  return decodeTodoListView({
    kind: "todo-list",
    hostId: HOST,
    todos: rows.map((row, index) => ({
      id: `00000000-0000-4000-8000-00000000000${String(index + 1)}`,
      title: "A to-do",
      notes: "",
      projects: [],
      tags: [],
      state: "open",
      threads: [],
      rank: index,
      version: 1,
      createdAt: AT,
      updatedAt: AT,
      ...row,
    })),
  }).todos;
}

describe("the phone's to-do list", () => {
  it("shows open to-dos, then the ticked-off ones, and leaves dropped ones out", () => {
    const sections = mobileTodoSections(
      todos(
        { title: "Open" },
        { title: "Done", state: "done" },
        { title: "Dropped", state: "dropped" },
      ),
    );
    expect(sections.open.map((todo) => todo.title)).toEqual(["Open"]);
    expect(sections.done.map((todo) => todo.title)).toEqual(["Done"]);
  });

  it("says which Projects and tags a to-do has, and that it was started", () => {
    const [todo] = todos({
      tags: ["errand"],
      projects: [{ hostId: HOST, projectId: "00000000-0000-4000-8000-0000000000a1", name: "Home" }],
      threads: [{ hostId: HOST, threadId: "00000000-0000-4000-8000-0000000000b1", mode: "chat" }],
    });
    expect(todo === undefined ? undefined : mobileTodoDetail(todo)).toBe(
      "Home · #errand · Started",
    );
  });

  it("adds one trimmed line under the id it was given, and refuses an empty or overlong one", () => {
    const id = "00000000-0000-4000-8000-0000000000c1";
    expect(mobileQuickAdd("  Buy   milk ", id)).toMatchObject({
      status: "ready",
      command: { kind: "add-todo", todoId: id, title: "Buy milk" },
    });
    expect(mobileQuickAdd("   ", id)).toEqual({ status: "empty" });
    expect(mobileQuickAdd("x".repeat(281), id)).toEqual({ status: "too-long" });
  });

  it("ticks an open to-do off and opens a done one again", () => {
    const [open, done] = todos({}, { state: "done" });
    expect(open === undefined ? undefined : mobileTickCommand(open)).toMatchObject({
      state: "done",
    });
    expect(done === undefined ? undefined : mobileTickCommand(done)).toMatchObject({
      state: "open",
    });
  });

  it("says a to-do whose started thread could not be linked, instead of Started", () => {
    const [todo] = todos({ tags: ["errand"] });
    expect(todo === undefined ? undefined : mobileTodoDetail(todo, { unlinked: true })).toBe(
      "#errand · Thread started, not linked",
    );
  });
});

describe("starting a thread from a to-do on the phone", () => {
  const OTHER_HOST = "22222222-2222-4222-8222-222222222222";
  const WORK = "00000000-0000-4000-8000-0000000000a1";
  const CODE = "00000000-0000-4000-8000-0000000000a2";
  const projectsHere = {
    hostId: HOST,
    workProjects: [{ projectId: WORK, name: "Home" }],
    codeProjects: [{ projectId: CODE, name: "App" }],
  };

  it("puts the title and the notes under it in the prompt, in the to-do's Project and its mode", () => {
    const [todo] = todos({
      title: "Fix the login",
      notes: "It fails on the second try.",
      projects: [{ hostId: HOST, projectId: CODE, name: "App" }],
    });
    expect(todo === undefined ? undefined : mobileTodoStartDraft(todo, projectsHere)).toEqual({
      prompt: "Fix the login\n\nIt fails on the second try.",
      mode: "code",
      projectId: CODE,
    });
  });

  it("starts a Chat when no Project of the to-do lives on the computer new threads go to", () => {
    const [todo] = todos({
      title: "Plan the trip",
      projects: [
        { hostId: OTHER_HOST, projectId: WORK, name: "Home" },
        { hostId: HOST, projectId: "00000000-0000-4000-8000-0000000000a9", name: "Gone" },
      ],
    });
    expect(todo === undefined ? undefined : mobileTodoStartDraft(todo, projectsHere)).toEqual({
      prompt: "Plan the trip",
      mode: "chat",
    });
  });

  it("links the thread on the computer that made it", () => {
    const thread = "00000000-0000-4000-8000-0000000000b1";
    const todoId = "00000000-0000-4000-8000-000000000001";
    expect(
      mobileTodoLinkCommand(todoId, { hostId: OTHER_HOST, threadId: thread, mode: "work" }),
    ).toEqual({
      kind: "link-todo-thread",
      todoId,
      thread: { hostId: OTHER_HOST, threadId: thread, mode: "work" },
    });
  });
});
