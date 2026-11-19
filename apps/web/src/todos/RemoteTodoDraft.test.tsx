import type { RemoteSessionBridge } from "@octant/client-runtime";
import { decodeProjectSummary } from "@octant/contracts/projects";
import { decodeTodoListView, type TodoThreadLink } from "@octant/contracts/todos";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ExtensionToolApprovalPrompt } from "../extensions/ExtensionToolApprovalPrompt";
import type { RemoteWorkspaceProps } from "../remote/RemoteWorkspace";
import type { DraftThreadWorkspaceProps } from "../shell/DraftThreadWorkspace";
import { RemoteTodoDraft } from "./RemoteTodoDraft";

const api = vi.hoisted(() => ({
  execute: vi.fn(),
  executeWork: vi.fn(),
  startWork: vi.fn(),
  executeCode: vi.fn(),
  startCode: vi.fn(),
}));
vi.mock("../remote/remoteProductClients", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../remote/remoteProductClients")>()),
  createRemoteProductClients: () => ({
    chat: api,
    workThread: { execute: api.executeWork },
    workTurn: { startFirstTurn: api.startWork },
  }),
}));
vi.mock("../providers/useProviderController", () => ({
  useProviderController: () => ({
    instances: [],
    observedByInstance: new Map(),
    defaults: { providerOrder: [], hiddenModels: [] },
  }),
}));
vi.mock("../projects/useProjectController", () => ({
  useProjectController: () => ({ allProjects: [] }),
}));
vi.mock("../code/useCodeController", () => ({
  useCodeController: () => ({
    execute: api.executeCode,
    startThreadTurn: api.startCode,
    lastExecuteError: { current: undefined },
  }),
}));
vi.mock("../providers/firstSelectableProviderSelection", () => ({
  firstSelectableProviderSelection: () => ({
    providerInstanceId: "10000000-0000-4000-8000-000000000001",
    modelId: "model",
  }),
}));
vi.mock("../remote/RemoteWorkspace", () => ({
  RemoteWorkspace: (props: RemoteWorkspaceProps) => (
    <>
      <p>Created remote thread</p>
      <ExtensionToolApprovalPrompt
        client={props.extensionClient}
        threadId={props.initialThread?.threadId}
        turnActive={false}
        className="thread-column"
      />
    </>
  ),
}));
vi.mock("../shell/DraftThreadWorkspace", () => ({
  DraftThreadWorkspace: (props: DraftThreadWorkspaceProps) => (
    <div>
      {props.todoSource === undefined ? null : (
        <button onClick={props.todoSource.onRemove}>Remove source</button>
      )}
      <button
        disabled={props.creating}
        onClick={() => {
          if (props.mode === "code")
            void props.onCreateCodeThread?.(
              {
                prompt: "Do it",
                executionPolicy: "approval-gated",
                permissionPersistence: "current-session",
                workspace: "current-checkout",
                deliveryTarget: {
                  branchIntent: "main",
                  remoteName: "origin",
                  proposedBaseRepository: "local/test",
                  proposedBaseBranch: "main",
                  outcomeKind: "local-implementation",
                },
                worktreeSource: { startFromOrigin: false, remoteName: "origin" },
              },
              props.projectId,
            );
          else void props.onCreateThread("Do it");
        }}
      >
        Send
      </button>
      {props.errorMessage}
    </div>
  ),
}));

const hostId = "22222222-2222-4222-8222-222222222222";
const threadId = "33333333-3333-4333-8333-333333333333";
const project = decodeProjectSummary({
  id: "44444444-4444-4444-8444-444444444444",
  type: "chat",
  name: "Other computer",
  lifecycle: "active",
  pinned: false,
  rank: "0/1",
  version: 1,
  createdAt: "2026-11-16T10:00:00.000Z",
  updatedAt: "2026-11-16T10:00:00.000Z",
});
const todo = decodeTodoListView({
  kind: "todo-list",
  hostId,
  todos: [
    {
      id: "55555555-5555-4555-8555-555555555555",
      title: "Do it",
      notes: "",
      projects: [],
      tags: [],
      state: "open",
      threads: [],
      rank: 0,
      version: 1,
      createdAt: "2026-11-16T10:00:00.000Z",
      updatedAt: "2026-11-16T10:00:00.000Z",
    },
  ],
}).todos[0];
if (todo === undefined) throw new Error("Expected the to-do fixture.");

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("a to-do draft on its Project's paired computer", () => {
  it("creates there, links the returned host and thread, then sends its first turn", async () => {
    const order: string[] = [];
    api.execute.mockImplementation(async (command) => {
      order.push(command.kind);
      const thread = { id: threadId, version: 1 };
      if (command.kind === "create-chat-thread") return { kind: "thread-created", thread };
      if (command.kind === "change-chat-provider") return { kind: "thread-updated", thread };
      return { kind: "turn-created" };
    });
    let finishLink: (() => void) | undefined;
    const onCreated = vi.fn(async (_link: TodoThreadLink) => {
      order.push("linked");
      await new Promise<void>((resolve) => {
        finishLink = resolve;
      });
    });
    render(
      <RemoteTodoDraft
        bridge={{ connection: () => undefined } as RemoteSessionBridge}
        hostId={hostId}
        connected
        project={project}
        todo={todo}
        onCreated={onCreated}
        onClose={() => undefined}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(screen.queryByText("Created remote thread")).toBeNull();
    expect(api.execute).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "send-chat-turn" }),
    );
    await act(async () => {
      finishLink?.();
    });
    await waitFor(() =>
      expect(api.execute).toHaveBeenCalledWith(expect.objectContaining({ kind: "send-chat-turn" })),
    );
    expect(onCreated).toHaveBeenCalledWith({ hostId, threadId, mode: "chat" });
    expect(order.indexOf("linked")).toBeGreaterThan(order.indexOf("create-chat-thread"));
    expect(order.indexOf("linked")).toBeLessThan(order.indexOf("send-chat-turn"));
    expect(api.execute).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "create-chat-thread", projectId: project.id }),
    );
  });

  it("keeps the draft and writes no link when the destination refuses creation", async () => {
    api.execute.mockResolvedValue({ kind: "refused", message: "Project access refused" });
    const onCreated = vi.fn();
    render(
      <RemoteTodoDraft
        bridge={{ connection: () => undefined } as RemoteSessionBridge}
        hostId={hostId}
        connected
        project={project}
        todo={todo}
        onCreated={onCreated}
        onClose={() => undefined}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("The host refused to create the thread.")).toBeVisible();
    expect(onCreated).not.toHaveBeenCalled();
    expect(api.execute).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Remove source" })).toBeVisible();
  });
  it.each(["work", "code"] as const)(
    "creates and links a %s thread on the selected host before its first turn",
    async (mode) => {
      const destination = decodeProjectSummary({
        ...project,
        type: mode,
        binding: { canonicalRoot: "/projects/test" },
        bindingRevisionId: "66666666-6666-4666-8666-666666666666",
        ...(mode === "code" ? { codeAccessPersistence: "current-session" } : {}),
      });
      const order: string[] = [];
      const thread = {
        id: threadId,
        version: 1,
        checkoutId: "77777777-7777-4777-8777-777777777777",
      };
      api.executeWork.mockImplementation(async () => {
        order.push("created");
        return { kind: "thread-created", thread };
      });
      api.startWork.mockImplementation(async () => {
        order.push("turn");
        return { kind: "accepted" };
      });
      api.executeCode.mockImplementation(async (command) => {
        if (command.kind === "prepare-code-project-checkout")
          return {
            kind: "checkout-prepared",
            bindingRevisionId: "66666666-6666-4666-8666-666666666666",
            checkout: {
              id: thread.checkoutId,
              repositoryId: `repo_${"a".repeat(64)}`,
              kind: "existing-worktree",
              availability: "available",
              head: { kind: "branch", name: "main", oid: "b".repeat(40) },
              observedAt: "2026-11-16T10:00:00.000Z",
            },
          };
        order.push("created");
        return { kind: "thread-created", thread };
      });
      api.startCode.mockImplementation(async () => {
        order.push("turn");
        return false;
      });
      const onCreated = vi.fn(async (_link: TodoThreadLink) => {
        order.push("linked");
      });
      render(
        <RemoteTodoDraft
          bridge={{ connection: () => undefined } as RemoteSessionBridge}
          hostId={hostId}
          connected
          project={destination}
          todo={todo}
          onCreated={onCreated}
          onClose={() => undefined}
        />,
      );
      await userEvent.click(screen.getByRole("button", { name: "Send" }));
      await waitFor(() => expect(order).toContain("turn"));
      expect(order).toEqual(["created", "linked", "turn"]);
      expect(onCreated).toHaveBeenCalledWith({ hostId, threadId, mode });
      expect(screen.getByText("Created remote thread")).toBeVisible();
      expect(screen.queryByRole("button", { name: "Send" })).toBeNull();
    },
  );
  it("shows and answers the destination's tool approval inside the linked thread dialog", async () => {
    const approvalId = "88888888-8888-4888-8888-888888888888";
    let pending = true;
    const authenticatedFetch = vi.fn(
      async (input: {
        readonly method: string;
        readonly path: string;
        readonly body?: string | Uint8Array;
        readonly headers?: Readonly<Record<string, string>>;
      }) => {
        if (input.path === "/api/extensions/tool-approvals") {
          const body = JSON.parse(String(input.body));
          if (body.kind === "decide") {
            pending = false;
            return Response.json({ accepted: true });
          }
          return Response.json(
            pending
              ? [
                  {
                    approvalId,
                    threadId,
                    extensionId: "99999999-9999-4999-8999-999999999999",
                    packageId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    componentId: "files-server",
                    serverName: "files",
                    providerToolName: "plugin__files__read",
                    mcpToolName: "read_file",
                    inputJson: '{"path":"README.md"}',
                    requestedAt: "2026-11-16T10:00:00.000Z",
                    rememberable: false,
                    answerCovers: "call",
                  },
                ]
              : [],
          );
        }
        return Response.json({ message: "Unavailable" }, { status: 403 });
      },
    );
    const unexpected = (): never => {
      throw new Error("Unexpected connection operation.");
    };
    const connection: NonNullable<ReturnType<RemoteSessionBridge["connection"]>> = {
      state: unexpected,
      onStateChange: unexpected,
      connect: unexpected,
      reconnect: unexpected,
      disconnect: unexpected,
      refresh: unexpected,
      renewIfSpent: unexpected,
      deviceIdentity: unexpected,
      updateFetch: unexpected,
      issueServerProxySession: unexpected,
      session: () => ({
        hostId,
        deviceId: "device",
        sessionId: "session",
        credentialGeneration: 1,
        origin: "https://paired.example",
        protocolVersion: 1,
        authenticationVersion: 1,
        capabilityDigest: "digest",
        csrfToken: "csrf",
        issuedAt: "2026-11-16T10:00:00.000Z",
        idleExpiresAt: "2026-11-16T11:00:00.000Z",
        absoluteExpiresAt: "2026-11-16T12:00:00.000Z",
      }),
      authenticatedFetch,
    };
    const bridge: RemoteSessionBridge = {
      getState: unexpected,
      subscribe: unexpected,
      connect: unexpected,
      resume: unexpected,
      forgetDeviceKey: unexpected,
      stageDeviceKeyRotation: unexpected,
      reconnect: unexpected,
      disconnect: unexpected,
      connection: () => connection,
    };
    let finishTurn: ((result: { kind: string }) => void) | undefined;
    api.execute.mockImplementation(async (command) => {
      if (command.kind === "send-chat-turn")
        return new Promise((resolve) => {
          finishTurn = resolve;
        });
      return {
        kind: command.kind === "create-chat-thread" ? "thread-created" : "thread-updated",
        thread: { id: threadId, version: 1 },
      };
    });
    render(
      <RemoteTodoDraft
        bridge={bridge}
        hostId={hostId}
        connected
        project={project}
        todo={todo}
        onCreated={async () => undefined}
        onClose={() => undefined}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Send" }));
    await userEvent.click(await screen.findByRole("button", { name: "Approve once" }));
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Extension tool approval" })).toBeNull(),
    );
    const decide = authenticatedFetch.mock.calls
      .map(([input]) => input)
      .find((input) => typeof input.body === "string" && input.body.includes('"kind":"decide"'));
    expect(decide).toMatchObject({ method: "POST", path: "/api/extensions/tool-approvals" });
    expect(JSON.parse(String(decide?.body))).toEqual({
      kind: "decide",
      approvalId,
      decision: "approved",
    });
    expect(decide?.headers ?? {}).not.toHaveProperty("x-octant-window-capability");
    await act(async () => {
      finishTurn?.({ kind: "turn-created" });
    });
  });
});
