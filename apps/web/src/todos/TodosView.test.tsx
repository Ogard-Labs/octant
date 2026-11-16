import type { TodoClient } from "@octant/client-runtime/todo-client";
import { decodeProjectId, decodeUtcTimestamp } from "@octant/contracts";
import { decodeStableHostId } from "@octant/contracts/remote-access";
import {
  TODO_DELETED,
  decodeTodoCommand,
  decodeTodoListView,
  type TodoCommand,
  type TodoListView,
  type TodoResult,
} from "@octant/contracts/todos";
import {
  applyTodoEvent,
  decideTodoCommand,
  todosInOrder,
  type TodoRecord,
} from "@octant/domain/todo-policy";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { TodosView, type TodoStartProps } from "./TodosView";
import { useTodoList } from "./useTodoList";

const HOST = decodeStableHostId("11111111-1111-4111-8111-111111111111");
const WEB = decodeProjectId("00000000-0000-4000-8000-0000000000a1");
const AT = decodeUtcTimestamp("2026-11-14T10:00:00.000Z");

/** A host that decides every change with the list host's own rules. */
function fakeHost() {
  const todos = new Map<string, TodoRecord>();
  const deleted = new Set<string>();
  const view = (): TodoListView =>
    decodeTodoListView({
      kind: "todo-list",
      hostId: HOST,
      todos: todosInOrder([...todos.values()].map((record) => record.todo)),
    });
  /** Takes a plain command, as another device would send it. */
  const apply = (input: unknown): TodoResult => {
    const command: TodoCommand = decodeTodoCommand(input);
    const decision = decideTodoCommand({ todos, deleted }, command);
    if (decision.kind === "refused") {
      return { kind: "todo-refused", reason: decision.reason, message: decision.message };
    }
    if (decision.kind === "append") {
      for (const { todoId, event } of decision.appends) {
        const id = String(todoId);
        const record = todos.get(id);
        const next = applyTodoEvent(record, event, {
          version: (record?.todo.version ?? 0) + 1,
          occurredAt: AT,
        });
        if (event.eventName === TODO_DELETED || next === undefined) {
          todos.delete(id);
          deleted.add(id);
        } else todos.set(id, next);
      }
    }
    return view();
  };
  const client: TodoClient = {
    read: async () => view(),
    change: async (command) => apply(command),
  };
  return { client, apply, view };
}

function Page(props: {
  readonly client: TodoClient;
  readonly start?: TodoStartProps;
  readonly revision?: number;
}) {
  const list = useTodoList(props.client, props.revision);
  return (
    <TodosView
      list={list}
      onClose={() => undefined}
      projects={[{ id: WEB, name: "Octant web" }]}
      {...(props.start === undefined ? {} : { start: props.start })}
    />
  );
}

function startProps(overrides: Partial<TodoStartProps> = {}): TodoStartProps {
  return {
    threadStates: new Map(),
    onStart: vi.fn(),
    onOpenThread: vi.fn(),
    unlinked: new Map(),
    onLink: vi.fn(),
    ...overrides,
  };
}

const THREAD = "00000000-0000-4000-8000-0000000000d1";

function rowTitles(): ReadonlyArray<string> {
  return within(screen.getByRole("list", { name: "To-dos" }))
    .getAllByRole("checkbox")
    .map((check) => check.getAttribute("aria-label") ?? "");
}

describe("the To-dos page", () => {
  it("adds a to-do with its tags and Project from one line, newest on top", async () => {
    const user = userEvent.setup();
    const host = fakeHost();
    render(<Page client={host.client} />);
    const field = await screen.findByRole("textbox", { name: "New to-do" });

    await user.type(field, "Fix the login loop #bug @octantweb");
    const chips = screen.getByRole("list", { name: "Added with this to-do" });
    expect(within(chips).getByText("bug")).toBeVisible();
    expect(within(chips).getByText("Octant web")).toBeVisible();
    await user.keyboard("{Enter}");
    await user.type(field, "Seed staging data{Enter}");

    expect(rowTitles()).toEqual(["Seed staging data", "Fix the login loop"]);
    expect(host.view().todos[1]).toMatchObject({
      tags: ["bug"],
      projects: [{ hostId: HOST, projectId: WEB, name: "Octant web" }],
    });
    expect(field).toHaveValue("");
    expect(screen.getByText("2 open")).toBeVisible();
  });

  it("ticks a to-do off out of the open list and finds it under Done", async () => {
    const user = userEvent.setup();
    const host = fakeHost();
    host.apply({
      kind: "add-todo",
      todoId: crypto.randomUUID(),
      title: "Book the venue",
    });
    render(<Page client={host.client} />);

    await user.click(await screen.findByRole("checkbox", { name: "Book the venue" }));
    expect(await screen.findByText("No to-do matches these filters.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /^Done/ }));
    expect(screen.getByRole("checkbox", { name: "Book the venue" })).toBeChecked();
  });

  it("keeps the person's text when another device changed it first, and saves it on the second try", async () => {
    const user = userEvent.setup();
    const host = fakeHost();
    const todoId = crypto.randomUUID();
    host.apply({ kind: "add-todo", todoId: todoId, title: "Draft" });
    render(<Page client={host.client} />);

    await user.click(await screen.findByRole("button", { name: "Draft" }));
    const title = screen.getByRole("textbox", { name: "Title" });
    await user.clear(title);
    await user.type(title, "Edited on the laptop");
    host.apply({
      kind: "edit-todo",
      todoId: todoId,
      expectedVersion: 1,
      title: "Edited on the phone",
      notes: "",
    });
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/It now reads “Edited on the phone”/)).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Edited on the laptop");
    await user.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("checkbox", { name: "Edited on the laptop" })).toBeVisible();
    expect(host.view().todos[0]?.title).toBe("Edited on the laptop");
  });

  it("lets the person unlink a Project of this host that was removed, and keeps the field focused for the next to-do", async () => {
    const user = userEvent.setup();
    const host = fakeHost();
    host.apply({
      kind: "add-todo",
      todoId: crypto.randomUUID(),
      title: "Old work",
      projects: [{ hostId: HOST, projectId: "00000000-0000-4000-8000-0000000000b9", name: "Gone" }],
    });
    render(<Page client={host.client} />);

    await user.click(await screen.findByRole("button", { name: /^Old work/ }));
    await user.click(screen.getByRole("checkbox", { name: "Project removed" }));
    await user.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByRole("checkbox", { name: "Old work" });
    expect(host.view().todos[0]?.projects).toEqual([]);

    const field = screen.getByRole("textbox", { name: "New to-do" });
    await user.click(field);
    await user.keyboard("One{Enter}");
    await screen.findByRole("checkbox", { name: "One" });
    expect(field).toHaveFocus();
  });

  it("adds a to-do once when the host saved it but its answer was lost", async () => {
    const user = userEvent.setup();
    const host = fakeHost();
    let lose = true;
    const client: TodoClient = {
      read: host.client.read,
      change: async (command) => {
        const answer = await host.client.change(command);
        if (lose) {
          lose = false;
          throw new Error("The to-do could not be saved.");
        }
        return answer;
      },
    };
    render(<Page client={client} />);
    const field = await screen.findByRole("textbox", { name: "New to-do" });

    await user.type(field, "Renew the passport{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("could not be saved");
    await user.type(field, "{Enter}");

    await screen.findByRole("checkbox", { name: "Renew the passport" });
    expect(host.view().todos.map((todo) => todo.title)).toEqual(["Renew the passport"]);
  });

  it("keeps a tag that holds a comma when only the title is edited", async () => {
    const user = userEvent.setup();
    const host = fakeHost();
    host.apply({ kind: "add-todo", todoId: crypto.randomUUID(), title: "Plan", tags: ["one,two"] });
    render(<Page client={host.client} />);

    await user.click(await screen.findByRole("button", { name: /^Plan/ }));
    await user.type(screen.getByRole("textbox", { name: "Title" }), " the trip");
    await user.click(screen.getByRole("button", { name: "Save" }));

    await screen.findByRole("checkbox", { name: "Plan the trip" });
    expect(host.view().todos[0]?.tags).toEqual(["one,two"]);
  });

  it("moves a to-do down from its menu", async () => {
    const user = userEvent.setup();
    const host = fakeHost();
    for (const title of ["Third", "Second", "First"]) {
      host.apply({ kind: "add-todo", todoId: crypto.randomUUID(), title: title });
    }
    render(<Page client={host.client} />);
    await screen.findByRole("checkbox", { name: "First" });

    await user.click(screen.getByRole("button", { name: "Actions for First" }));
    await user.click(await screen.findByRole("menuitem", { name: "Move down" }));

    await screen.findByText("Second");
    expect(host.view().todos.map((todo) => todo.title)).toEqual(["Second", "First", "Third"]);
    expect(rowTitles()).toEqual(["Second", "First", "Third"]);
  });
});

describe("starting from a to-do", () => {
  it("starts in the to-do's only Project at once, and offers Chat or a Project when it has none", async () => {
    const user = userEvent.setup();
    const host = fakeHost();
    host.apply({
      kind: "add-todo",
      todoId: crypto.randomUUID(),
      title: "Loose end",
    });
    host.apply({
      kind: "add-todo",
      todoId: crypto.randomUUID(),
      title: "Web fix",
      projects: [{ hostId: HOST, projectId: WEB, name: "Octant web" }],
    });
    const start = startProps();
    render(<Page client={host.client} start={start} />);

    await user.click(await screen.findByRole("button", { name: "Start Web fix" }));
    expect(start.onStart).toHaveBeenLastCalledWith(expect.objectContaining({ title: "Web fix" }), {
      kind: "project",
      projectId: String(WEB),
      name: "Octant web",
    });

    await user.click(screen.getByRole("button", { name: "Start Loose end" }));
    const choices = await screen.findAllByRole("menuitem");
    expect(choices.map((choice) => choice.textContent)).toEqual(["Chat", "Octant web"]);
    await user.click(choices[0] ?? document.body);
    expect(start.onStart).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Loose end" }),
      {
        kind: "chat",
      },
    );
  });

  it("shows the newest thread's state, opens it, and offers Tick off once it is done", async () => {
    const user = userEvent.setup();
    const host = fakeHost();
    const todoId = crypto.randomUUID();
    host.apply({ kind: "add-todo", todoId, title: "Ship it" });
    host.apply({
      kind: "link-todo-thread",
      todoId,
      thread: { hostId: HOST, threadId: THREAD, mode: "code" },
    });
    const done = new Map([
      [`${HOST}:code:${THREAD}`, { phase: "done" as const, label: "Done", title: "Ship the fix" }],
    ]);
    const start = startProps({ threadStates: done });
    render(<Page client={host.client} start={start} />);

    await user.click(await screen.findByRole("button", { name: "Done: open Ship the fix" }));
    expect(start.onOpenThread).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: THREAD, mode: "code" }),
      "Ship the fix",
    );
    await user.click(screen.getByRole("button", { name: "Tick off" }));
    expect(await screen.findByText("No to-do matches these filters.")).toBeVisible();
    expect(host.view().todos[0]?.state).toBe("done");
  });

  it("says when a started thread was not linked, and links it again on request", async () => {
    const user = userEvent.setup();
    const host = fakeHost();
    const todoId = crypto.randomUUID();
    host.apply({ kind: "add-todo", todoId, title: "Write notes" });
    const start = startProps({ unlinked: new Map([[todoId, { threadId: THREAD, mode: "chat" }]]) });
    render(<Page client={host.client} start={start} />);

    expect(await screen.findByText("Thread started, not linked")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Link" }));
    expect(start.onLink).toHaveBeenCalledWith(todoId);
  });
});

describe("a change made elsewhere", () => {
  it("shows a to-do another device added as soon as the host says the list changed", async () => {
    const host = fakeHost();
    const view = render(<Page client={host.client} revision={0} />);
    expect(await screen.findByText(/Write down what you mean to do/)).toBeVisible();

    host.apply({ kind: "add-todo", todoId: crypto.randomUUID(), title: "Added on the phone" });
    view.rerender(<Page client={host.client} revision={1} />);

    expect(await screen.findByRole("checkbox", { name: "Added on the phone" })).toBeVisible();
  });
});

describe("a list host that cannot be reached", () => {
  it("shows the last list read-only, keeps a quick add on this device, and sends it on request", async () => {
    globalThis.localStorage.clear();
    const user = userEvent.setup();
    const host = fakeHost();
    host.apply({ kind: "add-todo", todoId: crypto.randomUUID(), title: "Already there" });
    function Unreachable(props: { readonly away: boolean }) {
      const list = useTodoList(host.client, undefined, {
        key: "other-host:studio",
        ...(props.away ? { unreachable: "Studio Mac cannot be reached." } : {}),
      });
      return (
        <TodosView list={list} onClose={() => undefined} projects={[]} readOnly={props.away} />
      );
    }
    const view = render(<Unreachable away={false} />);
    await screen.findByRole("checkbox", { name: "Already there" });

    view.rerender(<Unreachable away />);
    expect(await screen.findByText(/^Studio Mac cannot be reached\./)).toBeVisible();
    expect(screen.getByRole("checkbox", { name: "Already there" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Actions for Already there" })).toBeNull();

    await user.type(screen.getByRole("textbox", { name: "New to-do" }), "Call the bank{Enter}");
    const held = screen.getByRole("region", { name: "Not sent" });
    expect(within(held).getByText("Call the bank")).toBeVisible();
    expect(within(held).getByRole("button", { name: "Send Call the bank" })).toBeDisabled();
    expect(host.view().todos.map((todo) => todo.title)).toEqual(["Already there"]);

    view.rerender(<Unreachable away={false} />);
    await user.click(within(held).getByRole("button", { name: "Send Call the bank" }));
    expect(await screen.findByRole("checkbox", { name: "Call the bank" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "Not sent" })).toBeNull();
    expect(host.view().todos.map((todo) => todo.title)).toEqual(["Call the bank", "Already there"]);
  });

  it("draws nothing of the previous host's list after the list moves", async () => {
    const first = fakeHost();
    first.apply({ kind: "add-todo", todoId: crypto.randomUUID(), title: "On this computer" });
    const second = fakeHost();
    second.apply({ kind: "add-todo", todoId: crypto.randomUUID(), title: "On the hub" });
    function Moving(props: { readonly onHub: boolean }) {
      const list = useTodoList(props.onHub ? second.client : first.client, undefined, {
        key: props.onHub ? "other-host:hub" : "this-host",
      });
      return <TodosView list={list} onClose={() => undefined} projects={[]} />;
    }
    const view = render(<Moving onHub={false} />);
    await screen.findByRole("checkbox", { name: "On this computer" });
    view.rerender(<Moving onHub />);
    expect(screen.queryByRole("checkbox", { name: "On this computer" })).toBeNull();
    expect(await screen.findByRole("checkbox", { name: "On the hub" })).toBeVisible();
  });
});

describe("unsent drafts", () => {
  it("belong to the list host they were written for", async () => {
    globalThis.localStorage.clear();
    const user = userEvent.setup();
    const host = fakeHost();
    function Held(props: { readonly listKey: string }) {
      const list = useTodoList(host.client, undefined, {
        key: props.listKey,
        unreachable: "That computer cannot be reached.",
      });
      return (
        <TodosView
          list={list}
          listKey={props.listKey}
          onClose={() => undefined}
          projects={[]}
          readOnly
        />
      );
    }
    const view = render(<Held listKey="other-host:studio" />);
    await user.type(
      await screen.findByRole("textbox", { name: "New to-do" }),
      "For the studio{Enter}",
    );
    expect(screen.getByRole("region", { name: "Not sent" })).toBeVisible();

    view.rerender(<Held listKey="other-host:hub" />);
    expect(screen.queryByRole("region", { name: "Not sent" })).toBeNull();
    view.rerender(<Held listKey="other-host:studio" />);
    expect(await screen.findByText("For the studio")).toBeVisible();
  });
});

describe("unsent drafts in two windows", () => {
  it("keeps both windows' drafts for the same list", async () => {
    globalThis.localStorage.clear();
    const user = userEvent.setup();
    const host = fakeHost();
    function Window(props: { readonly label: string }) {
      const list = useTodoList(host.client, undefined, {
        key: "other-host:studio",
        unreachable: "That computer cannot be reached.",
      });
      return (
        <section aria-label={props.label}>
          <TodosView
            list={list}
            listKey="other-host:studio"
            onClose={() => undefined}
            projects={[]}
            readOnly
          />
        </section>
      );
    }
    render(
      <>
        <Window label="First window" />
        <Window label="Second window" />
      </>,
    );
    const first = screen.getByRole("region", { name: "First window" });
    const second = screen.getByRole("region", { name: "Second window" });
    await user.type(
      within(first).getByRole("textbox", { name: "New to-do" }),
      "From the first{Enter}",
    );
    await user.type(
      within(second).getByRole("textbox", { name: "New to-do" }),
      "From the second{Enter}",
    );

    const stored = JSON.parse(
      globalThis.localStorage.getItem("octant.todos.unsent.v1:other-host:studio") ?? "[]",
    ) as ReadonlyArray<{ readonly title: string }>;
    expect(stored.map((draft) => draft.title)).toEqual(["From the first", "From the second"]);
    expect(within(second).getByText("From the first")).toBeVisible();
  });
});
