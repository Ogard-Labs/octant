import type { RemoteSessionBridge } from "@octant/client-runtime";
import type { CodeClient } from "@octant/client-runtime/code-client";
import { decodeMentionableThreadId } from "@octant/contracts";
import { decodeStableHostId } from "@octant/contracts/remote-access";
import { decodeProjectSummary } from "@octant/contracts/projects";
import { decodeTodoListView } from "@octant/contracts/todos";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chats,
  codeThreadId,
  codes,
  projectId,
  projects,
  providersWithToolModel,
} from "../App.test-fixtures";
import { readyPairedBridge } from "../host/pairedComputerTestBridge.test-support";
import { createRemoteProductClients } from "../remote/remoteProductClients";
import { RemoteTodoDraft } from "./RemoteTodoDraft";
const ports = vi.hoisted(() => ({ clients: {} as { code?: CodeClient; [key: string]: unknown } }));
vi.mock("../remote/remoteProductClients", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../remote/remoteProductClients")>()),
  createRemoteProductClients: vi.fn(
    (_bridge: RemoteSessionBridge, options?: { readonly threadEvents?: "poll" }) => {
      if (options?.threadEvents !== undefined && ports.clients.code !== undefined) {
        ports.clients = {
          ...ports.clients,
          code: { ...ports.clients.code, threadEvents: options.threadEvents },
        };
      }
      return ports.clients;
    },
  ),
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
      vi.clearAllMocks();
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
          bridge={{ connection: () => undefined } as RemoteSessionBridge}
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
      expect(createRemoteProductClients).toHaveBeenCalledWith(expect.anything(), {
        threadEvents: "poll",
      });
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

  it("renders a destination turn received while polling a linked Code thread", async () => {
    vi.clearAllMocks();
    const project = decodeProjectSummary({
      id: String(projectId),
      type: "code",
      name: "Laptop Project",
      lifecycle: "active",
      pinned: false,
      rank: "0/1",
      version: 1,
      createdAt: now,
      updatedAt: now,
      binding: { canonicalRoot: "/project" },
      bindingRevisionId: "66666666-6666-4666-8666-666666666666",
      codeAccessPersistence: "current-session",
    });
    const destinationLink = {
      hostId: decodeStableHostId(hostId),
      threadId: decodeMentionableThreadId(String(codeThreadId)),
      mode: "code" as const,
    };
    const baseCode = codes();
    const initialView = await baseCode.thread(codeThreadId);
    let received = false;
    let subscriptionCount = 0;
    const updatedThread = {
      ...initialView.thread,
      version: 2 as never,
      updatedAt: "2026-11-16T10:01:00.000Z" as never,
    };
    const frame = {
      threadId: codeThreadId,
      sequence: 1,
      event: { kind: "thread-updated", thread: updatedThread },
    } as never;
    const promptContentId = "60000000-0000-4000-8000-000000000001";
    const replyContentId = "60000000-0000-4000-8000-000000000002";
    const destinationTurn = {
      operationId: "70000000-0000-4000-8000-000000000001" as never,
      providerInstanceId: initialView.thread.providerInstanceId,
      modelId: initialView.thread.modelId,
      sessionId: "80000000-0000-4000-8000-000000000001" as never,
      prompt: {
        contentId: promptContentId as never,
        digest: "a".repeat(64) as never,
        byteLength: 18,
      },
      assistant: [
        {
          contentId: replyContentId as never,
          digest: "b".repeat(64) as never,
          byteLength: 28,
        },
      ],
      status: "completed" as const,
      startedAt: now as never,
      updatedAt: now as never,
    };
    const readOperationContent: CodeClient["operationContent"] = async (
      _threadId,
      _operationId,
      contentId,
    ) =>
      new TextEncoder().encode(
        String(contentId) === promptContentId
          ? "The linked Code thread prompt."
          : "A destination turn arrived.",
      );
    const code: CodeClient = {
      ...baseCode,
      subscribe: vi.fn(async function* (_threadId, _afterSequence, signal) {
        subscriptionCount += 1;
        if (subscriptionCount === 1) return;
        if (subscriptionCount === 2 && ports.clients.code?.threadEvents === "poll") {
          received = true;
          yield frame;
        }
        await new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        );
      }),
      thread: vi.fn(async () => ({
        ...initialView,
        thread: received ? updatedThread : initialView.thread,
        lastSequence: received ? (1 as typeof initialView.lastSequence) : initialView.lastSequence,
      })),
      conversation: vi.fn(async () => ({
        version: 3 as const,
        threadId: codeThreadId,
        turns: received ? [destinationTurn] : [],
        nextCursor: received ? 1 : 0,
        hasMore: false,
      })),
      operationContent: vi.fn(readOperationContent),
    };
    const sent: URL[] = [];
    const bridge = await readyPairedBridge(sent);
    const actualClients = await vi
      .importActual<typeof import("../remote/remoteProductClients")>(
        "../remote/remoteProductClients",
      )
      .then((module) => module.createRemoteProductClients(bridge));
    ports.clients = {
      ...actualClients,
      chat: chats(),
      code,
      project: projects({ active: [project], archived: [], availability: [], memory: [] }),
      provider: providersWithToolModel(),
      replyDetail: { read: vi.fn(async () => undefined) },
    };

    render(
      <RemoteTodoDraft
        bridge={bridge}
        hostId={hostId}
        hostName="Laptop"
        connected
        project={project}
        todo={todo}
        thread={destinationLink}
        onCreated={async () => undefined}
        onClose={() => undefined}
      />,
    );

    await waitFor(() => expect(screen.getByText("A destination turn arrived.")).toBeVisible(), {
      timeout: 5_000,
    });
    expect(createRemoteProductClients).toHaveBeenCalledWith(bridge, { threadEvents: "poll" });
    expect(ports.clients.code?.threadEvents).toBe("poll");
    expect(code.subscribe).toHaveBeenCalledTimes(2);
  });

  it("loads thread video clips when opening a linked Code thread at Read only access", async () => {
    vi.clearAllMocks();
    const project = decodeProjectSummary({
      id: projectId,
      type: "code",
      name: "Laptop Project",
      lifecycle: "active",
      pinned: false,
      rank: "0/1",
      version: 1,
      createdAt: now,
      updatedAt: now,
      binding: { canonicalRoot: "/project" },
      bindingRevisionId: "66666666-6666-4666-8666-666666666666",
      codeAccessPersistence: "current-session",
    });
    const destinationLink = {
      hostId: decodeStableHostId(hostId),
      mode: "code" as const,
      threadId: decodeMentionableThreadId(codeThreadId),
    };
    const sent: URL[] = [];
    const bridge = await readyPairedBridge(sent, {
      actsAsHostPerson: false,
      wrapFetch: (inner) => async (input, init) => {
        const response = await inner(input, init);
        const url = input instanceof Request ? input.url : String(input);
        if (url.endsWith("/api/remote/auth/device") && response.ok) {
          const payload = (await response.json()) as Record<string, unknown>;
          return Response.json({
            ...payload,
            actsAsHostPerson: false,
            accessLevel: "read-only",
          });
        }
        return response;
      },
    });
    const listVideo = vi.fn(async () => ({ jobs: [] }));
    const actualClients = await vi
      .importActual<typeof import("../remote/remoteProductClients")>(
        "../remote/remoteProductClients",
      )
      .then((module) => module.createRemoteProductClients(bridge));
    ports.clients = {
      ...actualClients,
      chat: chats(),
      code: codes(),
      project: projects({ active: [project], archived: [], availability: [], memory: [] }),
      provider: providersWithToolModel(),
      replyDetail: { read: vi.fn(async () => undefined) },
      videoResults: { list: listVideo, clipUrl: vi.fn() },
    };

    render(
      <RemoteTodoDraft
        bridge={bridge}
        hostId={hostId}
        hostName="Laptop"
        connected
        project={project}
        todo={todo}
        thread={destinationLink}
        onCreated={async () => undefined}
        onClose={() => undefined}
      />,
    );

    await waitFor(() =>
      expect(listVideo).toHaveBeenCalledWith({
        threadKind: "code-thread",
        scopeId: codeThreadId,
      }),
    );
  });
});
