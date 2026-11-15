import type { TodoClient } from "@octant/client-runtime/todo-client";
import { decodeTodoListView, type TodoCommand, type TodoResult } from "@octant/contracts/todos";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";
import {
  chatShellBootstrap,
  chats,
  client,
  createdChatThreadId,
  projectWindowCapability,
  projects,
  providers,
  windowId,
} from "./App.test-fixtures";

const HOST = "11111111-1111-4111-8111-111111111111";
const TODO = "00000000-0000-4000-8000-0000000000c1";
const AT = "2026-11-14T10:00:00.000Z";

const list = decodeTodoListView({
  kind: "todo-list",
  hostId: HOST,
  todos: [
    {
      id: TODO,
      title: "Draft the launch post",
      notes: "Keep it short.",
      projects: [],
      tags: [],
      state: "open",
      threads: [],
      rank: 0,
      version: 1,
      createdAt: AT,
      updatedAt: AT,
    },
  ],
});

function todoClient() {
  const change = vi.fn(async (_command: TodoCommand): Promise<TodoResult> => list);
  const todos: TodoClient = { read: vi.fn(async () => list), change };
  return { todos, change };
}

/**
 * Start through the whole shell, because the link is made where the draft
 * becomes a thread: the To-dos page opens the ordinary draft, and the create
 * path that the host answers is the one that knows the new thread's id.
 */
/** The band and the thread list both offer New chat, with the same action. */
async function newChatButton(): Promise<HTMLElement> {
  const [button] = await screen.findAllByRole("button", { name: "New chat" });
  if (button === undefined) throw new Error("No New chat button");
  return button;
}

describe("starting a thread from a to-do", () => {
  it("opens a Chat draft from the to-do and links the thread the host creates", async () => {
    const user = userEvent.setup();
    const { todos, change } = todoClient();
    const chatApi = chats();
    render(
      <App
        chatClient={chatApi}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client(chatShellBootstrap())}
        todoClient={todos}
      />,
    );

    await user.click(await screen.findByRole("button", { name: /^To-dos/ }));
    await user.click(await screen.findByRole("button", { name: "Start Draft the launch post" }));
    await user.click(await screen.findByRole("menuitem", { name: "Chat" }));

    const draft = await screen.findByRole("region", { name: "New Octant Chat thread" });
    expect(within(draft).getByText("From to-do")).toBeVisible();
    const prompt = within(draft).getByRole("textbox", { name: "First message" });
    await waitFor(() => expect(prompt).toHaveValue("Draft the launch post\n\nKeep it short."));
    await user.click(within(draft).getByRole("button", { name: "Create thread" }));

    await waitFor(() =>
      expect(change).toHaveBeenCalledWith({
        kind: "link-todo-thread",
        todoId: TODO,
        thread: { hostId: HOST, threadId: createdChatThreadId, mode: "chat" },
      }),
    );
    expect(chatApi.execute).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "create-chat-thread" }),
    );
  });

  it("links nothing when the person removes the label or leaves for another draft before sending", async () => {
    const user = userEvent.setup();
    const { todos, change } = todoClient();
    const chatApi = chats();
    render(
      <App
        chatClient={chatApi}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client(chatShellBootstrap())}
        todoClient={todos}
      />,
    );
    const startIntoChat = async () => {
      await user.click(await screen.findByRole("button", { name: /^To-dos/ }));
      await user.click(await screen.findByRole("button", { name: "Start Draft the launch post" }));
      await user.click(await screen.findByRole("menuitem", { name: "Chat" }));
      return screen.findByRole("region", { name: "New Octant Chat thread" });
    };

    let draft = await startIntoChat();
    await user.click(
      within(draft).getByRole("button", { name: "Do not link this thread to the to-do" }),
    );
    expect(within(draft).queryByText("From to-do")).toBeNull();

    draft = await startIntoChat();
    expect(within(draft).getByText("From to-do")).toBeVisible();
    await user.click(await newChatButton());
    draft = await screen.findByRole("region", { name: "New Octant Chat thread" });
    expect(within(draft).queryByText("From to-do")).toBeNull();
    await user.type(within(draft).getByRole("textbox", { name: "First message" }), "Unrelated");
    await user.click(within(draft).getByRole("button", { name: "Create thread" }));

    await waitFor(() =>
      expect(chatApi.execute).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "create-chat-thread" }),
      ),
    );
    expect(change).not.toHaveBeenCalledWith(expect.objectContaining({ kind: "link-todo-thread" }));
  });

  it("links the thread when Start reuses a Chat draft that was already open", async () => {
    const user = userEvent.setup();
    const { todos, change } = todoClient();
    render(
      <App
        chatClient={chats()}
        launch={{ serverUrl: "http://127.0.0.1:13773", windowId }}
        projectClient={projects()}
        projectWindowCapability={projectWindowCapability}
        providerClient={providers()}
        shellClient={client(chatShellBootstrap())}
        todoClient={todos}
      />,
    );
    await user.click(await newChatButton());
    await screen.findByRole("region", { name: "New Octant Chat thread" });

    await user.click(await screen.findByRole("button", { name: /^To-dos/ }));
    await user.click(await screen.findByRole("button", { name: "Start Draft the launch post" }));
    await user.click(await screen.findByRole("menuitem", { name: "Chat" }));
    const draft = await screen.findByRole("region", { name: "New Octant Chat thread" });
    expect(await within(draft).findByText("From to-do")).toBeVisible();
    await user.click(within(draft).getByRole("button", { name: "Create thread" }));

    await waitFor(() =>
      expect(change).toHaveBeenCalledWith(expect.objectContaining({ kind: "link-todo-thread" })),
    );
  });
});
