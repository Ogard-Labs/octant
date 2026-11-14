import { decodeTodoListView, type Todo, type TodoProjectLink } from "@octant/contracts/todos";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TODO_FILTER,
  NO_PROJECT,
  countTodos,
  filterTodos,
  parseQuickAdd,
  projectKey,
  todoStateSentence,
  withoutQuickAddWord,
} from "./todoListModel";

const HOST = "11111111-1111-4111-8111-111111111111";
const AT = "2026-11-14T10:00:00.000Z";

function link(projectId: string, name: string): TodoProjectLink {
  const [todo] = decodeTodoListView({
    kind: "todo-list",
    hostId: HOST,
    todos: [todoInput({ projects: [{ hostId: HOST, projectId, name }] })],
  }).todos;
  const found = todo?.projects[0];
  if (found === undefined) throw new Error("no link");
  return found;
}

function todoInput(fields: Record<string, unknown>) {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    title: "A to-do",
    notes: "",
    projects: [],
    tags: [],
    state: "open",
    threads: [],
    rank: 0,
    version: 1,
    createdAt: AT,
    updatedAt: AT,
    ...fields,
  };
}

function todos(...inputs: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<Todo> {
  return decodeTodoListView({
    kind: "todo-list",
    hostId: HOST,
    todos: inputs.map((fields, index) =>
      todoInput({ id: `00000000-0000-4000-8000-00000000000${String(index + 1)}`, ...fields }),
    ),
  }).todos;
}

const web = link("00000000-0000-4000-8000-0000000000a1", "Octant web");
const api = link("00000000-0000-4000-8000-0000000000a2", "Payments API");
const choices = [{ link: web }, { link: api }];

describe("quick add", () => {
  it("lifts tags and Projects out of the title", () => {
    expect(parseQuickAdd("Fix the #bug redirect loop @octantweb #bug", choices)).toEqual({
      title: "Fix the redirect loop",
      tags: ["bug"],
      projects: [web],
    });
  });

  it("picks a Project from the start of its name, and keeps a word that names none or several", () => {
    expect(parseQuickAdd("Seed data @pay", choices).projects).toEqual([api]);
    expect(parseQuickAdd("Email @someone", choices)).toMatchObject({
      title: "Email @someone",
      projects: [],
    });
    const twins = [
      { link: web },
      { link: link("00000000-0000-4000-8000-0000000000a3", "Octant website") },
    ];
    expect(parseQuickAdd("Ship @octant", twins)).toMatchObject({
      title: "Ship @octant",
      projects: [],
    });
  });

  it("removes one chip's word and leaves the rest of the text", () => {
    expect(withoutQuickAddWord("Fix #bug it @octantweb", { tag: "bug" }, choices)).toBe(
      "Fix it @octantweb",
    );
    expect(withoutQuickAddWord("Fix #bug it @octantweb", { project: web }, choices)).toBe(
      "Fix #bug it ",
    );
  });
});

describe("the list's filters", () => {
  const list = todos(
    {
      title: "Open",
      tags: ["bug"],
      projects: [
        { hostId: HOST, projectId: "00000000-0000-4000-8000-0000000000a1", name: "Octant web" },
      ],
    },
    {
      title: "Started",
      threads: [{ hostId: HOST, threadId: "thread-1", mode: "code" }],
    },
    { title: "Done", state: "done", tags: ["errand"] },
    { title: "Dropped", state: "dropped" },
  );
  const titles = (filter: Partial<typeof DEFAULT_TODO_FILTER>) =>
    filterTodos(list, { ...DEFAULT_TODO_FILTER, ...filter }).map((todo) => todo.title);

  it("shows open to-dos first, and dropped ones only when asked", () => {
    expect(titles({})).toEqual(["Open", "Started"]);
    expect(titles({ state: "started" })).toEqual(["Started"]);
    expect(titles({ state: "done" })).toEqual(["Done"]);
    expect(titles({ state: "all" })).toEqual(["Open", "Started", "Done"]);
    expect(titles({ state: "all", showDropped: true })).toEqual([
      "Open",
      "Started",
      "Done",
      "Dropped",
    ]);
  });

  it("keeps to-dos in any chosen Project or tag, including no Project", () => {
    expect(titles({ state: "all", projects: new Set([projectKey(web)]) })).toEqual(["Open"]);
    expect(titles({ projects: new Set([NO_PROJECT]) })).toEqual(["Started"]);
    expect(titles({ state: "all", tags: new Set(["bug", "errand"]) })).toEqual(["Open", "Done"]);
  });

  it("counts open and started to-dos for the page and the badge", () => {
    const counts = countTodos(list);
    expect(counts).toEqual({ open: 2, started: 1, waiting: 1 });
    expect(todoStateSentence(counts)).toBe("2 open, 1 started");
    expect(todoStateSentence(countTodos([]))).toBe("Nothing is open.");
  });
});
