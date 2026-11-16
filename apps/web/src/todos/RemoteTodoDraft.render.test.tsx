import type { RemoteSessionBridge } from "@octant/client-runtime";
import { decodeProjectSummary } from "@octant/contracts/projects";
import { decodeTodoListView } from "@octant/contracts/todos";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chats, codes, projects, providersWithToolModel } from "../App.test-fixtures";
import { RemoteTodoDraft } from "./RemoteTodoDraft";
const ports = vi.hoisted(() => ({ clients: {} }));
vi.mock("../remote/remoteProductClients", () => ({
  createRemoteProductClients: () => ports.clients,
}));
afterEach(cleanup);
const now = "2026-11-16T10:00:00.000Z";
const hostId = "22222222-2222-4222-8222-222222222222";
const todo = decodeTodoListView({
  kind: "todo-list",
  hostId,
  todos: [
    {
      id: "55555555-5555-4555-8555-555555555555",
      title: "Draft on the other computer",
      notes: "Keep these notes.",
      projects: [],
      tags: [],
      state: "open",
      threads: [],
      rank: 0,
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
  ],
}).todos[0];
if (todo === undefined) throw new Error("Expected a to-do fixture.");

describe("the ordinary composer on a paired computer", () => {
  it.each(["chat", "work", "code"] as const)(
    "renders the %s Project and to-do prompt without creating a thread",
    async (mode) => {
      const project = decodeProjectSummary({
        id: "44444444-4444-4444-8444-444444444444",
        type: mode,
        name: "Laptop Project",
        lifecycle: "active",
        pinned: false,
        rank: "0/1",
        version: 1,
        createdAt: now,
        updatedAt: now,
        ...(mode === "chat"
          ? {}
          : {
              binding: { canonicalRoot: "/project" },
              bindingRevisionId: "66666666-6666-4666-8666-666666666666",
            }),
        ...(mode === "code" ? { codeAccessPersistence: "current-session" } : {}),
      });
      const chat = chats();
      const code = codes();
      const projectClient = projects({
        active: [project],
        archived: [],
        availability: [],
        memory: [],
      });
      ports.clients = { chat, code, project: projectClient, provider: providersWithToolModel() };
      render(
        <RemoteTodoDraft
          bridge={{} as RemoteSessionBridge}
          hostId={hostId}
          hostName="Laptop"
          connected
          project={project}
          todo={todo}
          onCreated={async () => undefined}
          onClose={() => undefined}
        />,
      );
      expect(await screen.findByText("From to-do", { exact: true })).toBeVisible();
      await waitFor(() =>
        expect(screen.getByRole("textbox", { name: "First message" })).toHaveValue(
          "Draft on the other computer\n\nKeep these notes.",
        ),
      );
      expect(screen.getByText("On Laptop")).toBeVisible();
      expect(chat.execute).not.toHaveBeenCalled();
      expect(code.execute).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: "create-code-thread" }),
      );
      expect(code.execute).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: "create-managed-code-thread" }),
      );
    },
  );
});
