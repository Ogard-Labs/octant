import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CanvasCreationContext } from "./CreateCanvasDraft";
import { CanvasThreadReferenceCard } from "./CanvasThreadReferenceCard";
import { CreateCanvasDraft } from "./CreateCanvasDraft";
import { CanvasCreatePanel } from "./CanvasCreatePanel";
import { CanvasThreadReferenceCardList } from "./CanvasThreadReferenceCardList";
import type { CanvasClient } from "@octant/client-runtime/canvas-client";

const threadId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";

const chatContext: CanvasCreationContext = {
  hostId: "local" as import("@octant/contracts/host").HostId,
  mode: "chat",
  workspace: { kind: "chat-virtual", projectId: null },
  originThreadId: threadId as import("@octant/contracts/canvas-cards").CanvasOriginThreadId,
  requestedAuthority: {
    filesystem: false,
    shell: false,
    git: false,
    network: false,
    tools: true,
    subagents: false,
    executionPolicy: "plan",
    permissionPersistence: "current-session",
  },
  sourceManifest: [],
};

const workContext: CanvasCreationContext = {
  ...chatContext,
  mode: "work",
  workspace: {
    kind: "work-root",
    projectId: projectId as import("@octant/contracts/projects").ProjectId,
    rootId:
      "33333333-3333-4333-8333-333333333333" as import("@octant/contracts/thread-creation").ThreadCreationRootId,
  },
};

const codeContext: CanvasCreationContext = {
  ...chatContext,
  mode: "code",
  workspace: {
    kind: "code-worktree",
    projectId: projectId as import("@octant/contracts/projects").ProjectId,
    repositoryId:
      "repo_12345678901234567890123456789012" as import("@octant/contracts/code").CodeRepositoryId,
    bindingRevisionId:
      "44444444-4444-4444-8444-444444444444" as import("@octant/contracts/projects").BindingRevisionId,
    checkoutId:
      "55555555-5555-4555-8555-555555555555" as import("@octant/contracts/code").CodeCheckoutId,
    verified: true,
  },
};

function referenceCardFixture(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    kind: "canvas-reference-card" as const,
    cardId: "20000000-0000-4000-8000-000000000001",
    canvasId: "20000000-0000-4000-8000-000000000002",
    versionId: "20000000-0000-4000-8000-000000000003",
    title: "Canvas card",
    scope: {
      hostId: "local",
      mode: "chat" as const,
      workspace: { kind: "chat-virtual" as const, projectId: null },
    },
    originThreadId: threadId,
    status: "ready" as const,
    authority: {
      filesystem: false,
      shell: false,
      git: false,
      network: false,
      tools: true,
      subagents: false,
      executionPolicy: "plan" as const,
      permissionPersistence: "current-session" as const,
    },
    actorId: "99999999-9999-4999-8999-999999999999",
    providerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    modelId: "octant-test-model",
    createdAt: "2026-08-01T21:00:00.000Z",
    actionCount: 0,
    ...overrides,
  } as import("@octant/contracts/canvas-cards").CanvasThreadReferenceCard;
}

describe("CanvasThreadReferenceCard", () => {
  it("renders title, status, and scope", () => {
    render(<CanvasThreadReferenceCard card={referenceCardFixture()} />);
    expect(screen.getByTestId("canvas-card-title")).toHaveTextContent("Canvas card");
    expect(screen.getByTestId("canvas-card-status")).toHaveTextContent("ready");
    expect(screen.getByTestId("canvas-card-scope")).toHaveTextContent("chat / chat-virtual");
  });

  it("shows summary when present", () => {
    render(<CanvasThreadReferenceCard card={referenceCardFixture({ summary: "Summary text" })} />);
    expect(screen.getByTestId("canvas-card-summary")).toHaveTextContent("Summary text");
  });

  it("hides summary when absent", () => {
    render(<CanvasThreadReferenceCard card={referenceCardFixture()} />);
    expect(screen.queryByTestId("canvas-card-summary")).not.toBeInTheDocument();
  });

  it("shows action count", () => {
    render(<CanvasThreadReferenceCard card={referenceCardFixture({ actionCount: 5 })} />);
    expect(screen.getByTestId("canvas-card-actions")).toHaveTextContent("5");
  });
});

describe("CreateCanvasDraft", () => {
  function receiptFixture() {
    return {
      schemaVersion: 1,
      kind: "canvas-create-receipt" as const,
      receiptId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      canvasId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      versionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      intent: "prompt" as const,
      originThreadId: threadId,
      scope: {
        hostId: "local",
        mode: "chat" as const,
        workspace: { kind: "chat-virtual" as const, projectId },
      },
      title: "Generated canvas",
      effectiveAuthority: {
        filesystem: false,
        shell: false,
        git: false,
        network: false,
        tools: true,
        subagents: false,
        executionPolicy: "plan" as const,
        permissionPersistence: "current-session" as const,
      },
      outcome: "ready" as const,
      createdAt: "2026-08-01T21:00:00.000Z",
    };
  }

  it("passes context fields through unchanged", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(receiptFixture());
    render(<CreateCanvasDraft context={chatContext} onCreate={onCreate} />);

    await user.type(screen.getByTestId("title-input"), "My canvas");
    await user.type(screen.getByTestId("prompt-input"), "Build a plan");
    await user.click(screen.getByTestId("create-button"));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalledTimes(1);
    });
    const request = (onCreate.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(request.mode).toBe("chat");
    expect(request.kind).toBe("canvas-create");
    expect(request.hostId).toBe("local");
    expect(request.originThreadId).toBe(threadId);
    expect(request.workspace).toEqual({ kind: "chat-virtual", projectId: null });
    expect(request.requestedAuthority).toEqual(chatContext.requestedAuthority);
    expect(request.sourceManifest).toEqual([]);
  });

  it("shows the success screen after create", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(receiptFixture());
    render(<CreateCanvasDraft context={chatContext} onCreate={onCreate} />);

    await user.type(screen.getByTestId("title-input"), "My canvas");
    await user.type(screen.getByTestId("prompt-input"), "Build a plan");
    await user.click(screen.getByTestId("create-button"));

    await waitFor(() => {
      expect(screen.getByTestId("canvas-create-success")).toBeInTheDocument();
    });
    expect(screen.getByTestId("receipt-status")).toHaveTextContent("ready");
  });

  it("keeps the form visible when onCreate returns null", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(null);
    render(<CreateCanvasDraft context={chatContext} onCreate={onCreate} />);

    await user.click(screen.getByTestId("create-button"));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("canvas-create-success")).not.toBeInTheDocument();
    expect(screen.getByTestId("canvas-create-form")).toBeInTheDocument();
  });

  it("sets intent to prompt when prompt is provided", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(receiptFixture());
    render(<CreateCanvasDraft context={codeContext} onCreate={onCreate} />);

    await user.type(screen.getByTestId("prompt-input"), "Build a plan");
    await user.click(screen.getByTestId("create-button"));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalled();
    });
    const request = (onCreate.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(request.intent).toBe("prompt");
    expect(request.mode).toBe("code");
  });

  it("sets intent to blank when no prompt is provided", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(receiptFixture());
    render(<CreateCanvasDraft context={workContext} onCreate={onCreate} />);

    await user.type(screen.getByTestId("title-input"), "Code canvas");
    await user.click(screen.getByTestId("create-button"));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalled();
    });
    const request = (onCreate.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(request.intent).toBe("blank");
    expect(request.mode).toBe("work");
  });

  it("does not fabricate any provenance fields", async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn().mockResolvedValue(receiptFixture());
    render(<CreateCanvasDraft context={chatContext} onCreate={onCreate} />);

    await user.click(screen.getByTestId("create-button"));

    await waitFor(() => {
      expect(onCreate).toHaveBeenCalled();
    });
    const request = (onCreate.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(typeof request.requestId).toBe("string");
    expect((request.requestId as string).length).toBeGreaterThan(0);
  });
});

describe("Canvas create panel and card list", () => {
  it("surfaces a typed create denial", async () => {
    const user = userEvent.setup();
    const client = {
      create: vi.fn().mockResolvedValue({
        kind: "denied",
        denialCode: "unauthorized",
        message: "Canvas creation is not authorized.",
      }),
    } as unknown as CanvasClient;
    render(<CanvasCreatePanel client={client} context={chatContext} />);
    await user.click(screen.getByTestId("create-button"));
    await waitFor(() => {
      expect(screen.getByTestId("canvas-create-panel-denial")).toHaveTextContent(
        "Canvas creation is not authorized.",
      );
    });
  });

  it("loads and renders durable thread cards", async () => {
    const card = referenceCardFixture();
    const client = {
      threadReferenceCards: vi.fn().mockResolvedValue({
        mode: "chat",
        threadId,
        projectId: null,
        cards: [card],
      }),
    } as unknown as CanvasClient;
    render(
      <CanvasThreadReferenceCardList
        client={client}
        mode="chat"
        projectId={null}
        threadId={threadId as never}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("canvas-card-title")).toHaveTextContent("Canvas card");
    });
    expect(client.threadReferenceCards).toHaveBeenCalledWith({
      mode: "chat",
      threadId,
      projectId: null,
    });
  });
});
