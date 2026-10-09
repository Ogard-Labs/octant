import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CanvasCreationContext } from "./CreateCanvasDraft";
import { CanvasThreadReferenceCard } from "./CanvasThreadReferenceCard";
import { CreateCanvasDraft } from "./CreateCanvasDraft";
import { CanvasCreatePanel } from "./CanvasCreatePanel";
import { CanvasThreadReferenceCardList } from "./CanvasThreadReferenceCardList";
import { InlineThreadCanvas } from "./InlineThreadCanvas";
import { useThreadCanvasCards } from "./useThreadCanvasCards";
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
  it("names the Canvas and when it changed, without the host's internal scope", () => {
    render(<CanvasThreadReferenceCard card={referenceCardFixture()} />);
    expect(screen.getByTestId("canvas-card-title")).toHaveTextContent("Canvas card");
    expect(screen.getByTestId("canvas-card-meta")).toHaveTextContent(/^Canvas · Updated /);
    expect(screen.queryByText("chat-virtual", { exact: false })).not.toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows summary when present", () => {
    render(<CanvasThreadReferenceCard card={referenceCardFixture({ summary: "Summary text" })} />);
    expect(screen.getByTestId("canvas-card-summary")).toHaveTextContent("Summary text");
  });

  it("hides summary when absent", () => {
    render(<CanvasThreadReferenceCard card={referenceCardFixture()} />);
    expect(screen.queryByTestId("canvas-card-summary")).not.toBeInTheDocument();
  });

  it("says when a Canvas is not ready, and how many actions it offers", () => {
    render(
      <CanvasThreadReferenceCard
        card={referenceCardFixture({ status: "stale", actionCount: 5 })}
      />,
    );
    expect(screen.getByTestId("canvas-card-meta")).toHaveTextContent(
      /^Out of date · 5 actions · Updated /,
    );
  });

  it("previews a plan and says how far it has got and what comes next", async () => {
    const definition = {
      schemaVersion: 4,
      title: "Launch plan",
      provenance: {
        mode: "chat",
        hostId: "local",
        projectId,
        threadId,
        actor: { kind: "agent", actorId: "99999999-9999-4999-8999-999999999999" },
        providerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        modelId: "octant-test-model",
        createdAt: "2026-08-01T21:00:00.000Z",
      },
      sourceManifest: [],
      blocks: [
        {
          blockId: "plan",
          schemaVersion: 1,
          kind: "plan",
          title: "Launch",
          phases: [{ phaseId: "ship", title: "Ship" }],
          tasks: [
            { taskId: "fix", phaseId: "ship", title: "Ship the fix", status: "done" },
            { taskId: "note", phaseId: "ship", title: "Write the note", status: "todo" },
          ],
        },
      ],
    };
    const client = {
      get: vi.fn().mockResolvedValue({
        kind: "ready",
        version: {
          schemaVersion: 4,
          canvasId: "20000000-0000-4000-8000-000000000002",
          versionId: "20000000-0000-4000-8000-000000000003",
          sequence: 1,
          definition,
          createdBy: definition.provenance.actor,
          createdAt: "2026-08-01T21:00:00.000Z",
        },
      }),
    } as unknown as CanvasClient;
    const { container } = render(
      <CanvasThreadReferenceCard card={referenceCardFixture()} client={client} onOpen={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("canvas-card-meta")).toHaveTextContent(
        /^Plan · 2 tasks · next: Write the note · Updated /,
      );
    });
    expect(container.querySelector(".canvas-ref__progress-label")).toHaveTextContent("1 of 2 done");
    expect(screen.getByTestId("canvas-card")).toHaveAttribute("data-kind", "plan");
    // The miniature is decorative: nothing inside it is reachable or announced.
    const preview = container.querySelector(".canvas-ref__preview");
    expect(preview).toHaveAttribute("aria-hidden", "true");
    expect(preview).toHaveAttribute("inert");
    expect(screen.getAllByRole("button")).toHaveLength(1);
  });

  it("opens the Canvas from the whole row", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<CanvasThreadReferenceCard card={referenceCardFixture()} onOpen={onOpen} />);
    await user.click(screen.getByRole("button", { name: /Canvas card/ }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ title: "Canvas card" }));
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

describe("Start a Canvas from a recipe", () => {
  const recipes = [
    {
      id: "implementation-plan",
      title: "Implementation plan",
      summary: "Goal, phased tasks with status, risks, and what done means.",
      whenToUse: "When someone asks to write a plan.",
      skeleton: [
        { kind: "heading", role: "Goal" },
        { kind: "plan", role: "Phases and tasks." },
      ],
    },
    {
      id: "field-notes",
      title: "Field notes",
      whenToUse: "When a skill offers field notes.",
      skeleton: [{ kind: "rich-text", role: "The notes." }],
    },
  ];

  function createdReceipt(intent: "blank" | "template" = "template") {
    return {
      schemaVersion: 1,
      kind: "canvas-create-receipt",
      receiptId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      canvasId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      versionId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      intent,
      originThreadId: threadId,
      scope: {
        hostId: "local",
        mode: "chat",
        workspace: { kind: "chat-virtual", projectId: null },
      },
      title: "Implementation plan",
      effectiveAuthority: chatContext.requestedAuthority,
      outcome: "ready",
      createdAt: "2026-08-01T21:00:00.000Z",
    };
  }

  function recipeClient() {
    return {
      recipes: vi.fn().mockResolvedValue({ recipes }),
      create: vi.fn().mockResolvedValue({
        kind: "accepted",
        receipt: createdReceipt(),
        card: referenceCardFixture(),
      }),
    };
  }

  it("offers Blank and every recipe, each with one line, as one keyboard radio group", async () => {
    const user = userEvent.setup();
    const client = recipeClient();
    render(<CanvasCreatePanel client={client as unknown as CanvasClient} context={chatContext} />);

    const group = await screen.findByRole("radiogroup", { name: "Start from" });
    const options = within(group).getAllByRole("radio");
    expect(options.map((option) => option.getAttribute("aria-label"))).toEqual([
      "Blank",
      "Implementation plan",
      "Field notes",
    ]);
    expect(options[0]).toHaveAttribute("aria-checked", "true");
    expect(options[1]).toHaveAccessibleDescription(
      "Goal, phased tasks with status, risks, and what done means.",
    );
    // A contributed recipe without a summary still says when it fits.
    expect(options[2]).toHaveAccessibleDescription("When a skill offers field notes.");
    // One tab stop; arrows move the choice.
    expect(options.map((option) => option.tabIndex)).toEqual([0, -1, -1]);
    options[0]?.focus();
    await user.keyboard("{ArrowDown}");
    expect(options[1]).toHaveAttribute("aria-checked", "true");
    expect(options[1]).toHaveFocus();
    await user.keyboard("{End}");
    expect(options[2]).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(options[0]).toHaveAttribute("aria-checked", "true");
  });

  it("starts the recipe's skeleton without asking anyone when no thread is attached", async () => {
    const user = userEvent.setup();
    const client = recipeClient();
    render(<CanvasCreatePanel client={client as unknown as CanvasClient} context={chatContext} />);

    await user.click(await screen.findByRole("radio", { name: "Implementation plan" }));
    expect(screen.queryByRole("checkbox", { name: /fill it in/i })).toBeNull();
    expect(screen.queryByTestId("prompt-input")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Create Canvas" }));

    await waitFor(() => expect(client.create).toHaveBeenCalledOnce());
    const request = client.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(request).toMatchObject({
      intent: "template",
      templateId: "implementation-plan",
      title: "Implementation plan",
      requestedAuthority: chatContext.requestedAuthority,
    });
    expect(request).not.toHaveProperty("prompt");
  });

  it("asks the attached thread's agent to fill the new Canvas, after it exists", async () => {
    const user = userEvent.setup();
    const client = recipeClient();
    const order: string[] = [];
    client.create.mockImplementation(async () => {
      order.push("create");
      return { kind: "accepted", receipt: createdReceipt(), card: referenceCardFixture() };
    });
    const onAskAgentToFill = vi.fn(async () => {
      order.push("fill");
      return true;
    });
    render(
      <CanvasCreatePanel
        client={client as unknown as CanvasClient}
        context={chatContext}
        onAskAgentToFill={onAskAgentToFill}
      />,
    );

    await user.click(await screen.findByRole("radio", { name: "Implementation plan" }));
    expect(
      screen.getByRole("checkbox", { name: "Ask this thread's agent to fill it in" }),
    ).toBeChecked();
    await user.type(screen.getByLabelText("What should it cover?"), "The sync rewrite");
    await user.click(screen.getByRole("button", { name: "Create and ask agent" }));

    await waitFor(() => expect(onAskAgentToFill).toHaveBeenCalledOnce());
    expect(order).toEqual(["create", "fill"]);
    expect(onAskAgentToFill).toHaveBeenCalledWith({
      receipt: expect.objectContaining({ canvasId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" }),
      recipe: expect.objectContaining({ id: "implementation-plan" }),
      notes: "The sync rewrite",
    });
  });

  it("creates only the skeleton when the person unticks the fill-in", async () => {
    const user = userEvent.setup();
    const client = recipeClient();
    const onAskAgentToFill = vi.fn(async () => true);
    render(
      <CanvasCreatePanel
        client={client as unknown as CanvasClient}
        context={chatContext}
        onAskAgentToFill={onAskAgentToFill}
      />,
    );
    await user.click(await screen.findByRole("radio", { name: "Implementation plan" }));
    await user.click(
      screen.getByRole("checkbox", { name: "Ask this thread's agent to fill it in" }),
    );
    await user.click(screen.getByRole("button", { name: "Create Canvas" }));
    await waitFor(() => expect(client.create).toHaveBeenCalledOnce());
    expect(onAskAgentToFill).not.toHaveBeenCalled();
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
    function ThreadCards() {
      const loaded = useThreadCanvasCards({
        client,
        mode: "chat",
        projectId: null,
        threadId: threadId as never,
      });
      return <CanvasThreadReferenceCardList cards={loaded.cards} error={loaded.error} />;
    }
    render(<ThreadCards />);
    await waitFor(() => {
      expect(screen.getByTestId("canvas-card-title")).toHaveTextContent("Canvas card");
    });
    expect(client.threadReferenceCards).toHaveBeenCalledWith({
      mode: "chat",
      threadId,
      projectId: null,
    });
  });

  it("drops the previous thread's Canvases as soon as another thread opens", async () => {
    const otherThread = "33333333-3333-4333-8333-333333333333";
    const threadReferenceCards = vi
      .fn()
      .mockResolvedValueOnce({
        mode: "chat",
        threadId,
        projectId: null,
        cards: [referenceCardFixture()],
      })
      // The other thread's read never settles, so only the reset can clear the list.
      .mockReturnValueOnce(new Promise(() => undefined));
    const client = { threadReferenceCards } as unknown as CanvasClient;
    function ThreadCards(props: { readonly threadId: string }) {
      const loaded = useThreadCanvasCards({
        client,
        mode: "chat",
        projectId: null,
        threadId: props.threadId as never,
      });
      return <CanvasThreadReferenceCardList cards={loaded.cards} error={loaded.error} />;
    }
    const view = render(<ThreadCards threadId={threadId} />);
    await screen.findByTestId("canvas-card-title");

    view.rerender(<ThreadCards threadId={otherThread} />);
    expect(screen.queryByTestId("canvas-card-title")).not.toBeInTheDocument();
  });

  it("keeps the thread's Canvases on screen while its project resolves", async () => {
    const threadReferenceCards = vi
      .fn()
      .mockResolvedValueOnce({
        mode: "work",
        threadId,
        projectId: null,
        cards: [referenceCardFixture()],
      })
      // The re-read for the resolved project never settles, so only a reset could clear the row.
      .mockReturnValueOnce(new Promise(() => undefined));
    const client = { threadReferenceCards } as unknown as CanvasClient;
    function ThreadCards(props: { readonly projectId: string | null }) {
      const loaded = useThreadCanvasCards({
        client,
        mode: "work",
        projectId: props.projectId as never,
        threadId: threadId as never,
      });
      return <CanvasThreadReferenceCardList cards={loaded.cards} error={loaded.error} />;
    }
    const view = render(<ThreadCards projectId={null} />);
    await screen.findByTestId("canvas-card-title");

    view.rerender(<ThreadCards projectId="44444444-4444-4444-8444-444444444444" />);
    expect(screen.getByTestId("canvas-card-title")).toBeInTheDocument();
  });
  describe("a Canvas drawn inside its thread", () => {
    const definition = {
      schemaVersion: 4,
      title: "Weekly signups",
      provenance: {
        mode: "chat",
        hostId: "local",
        projectId,
        threadId,
        actor: { kind: "agent", actorId: "99999999-9999-4999-8999-999999999999" },
        providerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        modelId: "octant-test-model",
        createdAt: "2026-08-01T21:00:00.000Z",
      },
      sourceManifest: [],
      presentation: "inline",
      blocks: [
        {
          blockId: "signups",
          schemaVersion: 1,
          kind: "metric",
          label: "Signups this week",
          value: 1284,
        },
      ],
    };
    const inlineCard = () =>
      referenceCardFixture({
        title: "Weekly signups",
        presentation: "inline",
        canvasCreatedAt: "2026-08-01T21:00:00.000Z",
      }) as never;
    const clientWith = () =>
      ({
        get: vi.fn().mockResolvedValue({
          kind: "ready",
          version: {
            schemaVersion: 4,
            canvasId: "20000000-0000-4000-8000-000000000002",
            versionId: "20000000-0000-4000-8000-000000000003",
            sequence: 1,
            definition,
            createdBy: definition.provenance.actor,
            createdAt: "2026-08-01T21:00:00.000Z",
          },
        }),
      }) as unknown as CanvasClient;

    it("draws the Canvas's blocks in the conversation and opens the same Canvas in the sidebar", async () => {
      const user = userEvent.setup();
      const onOpen = vi.fn();
      const client = clientWith();
      render(<InlineThreadCanvas card={inlineCard()} client={client} onOpen={onOpen} />);

      expect(await screen.findByText("Signups this week")).toBeInTheDocument();
      expect(client.get).toHaveBeenCalledWith("20000000-0000-4000-8000-000000000002");
      // The frame names the Canvas once; the document inside does not repeat it as a page title.
      expect(screen.queryByRole("heading", { level: 1 })).toBeNull();

      await user.click(screen.getByRole("button", { name: "Open in sidebar" }));
      expect(onOpen).toHaveBeenCalledWith(
        expect.objectContaining({ canvasId: "20000000-0000-4000-8000-000000000002" }),
      );
    });

    it("folds to a card on request and stays folded when the thread is opened again", async () => {
      const user = userEvent.setup();
      localStorage.clear();
      const first = render(<InlineThreadCanvas card={inlineCard()} client={clientWith()} />);
      await screen.findByText("Signups this week");

      await user.click(screen.getByRole("button", { name: "Show as card" }));
      expect(screen.queryByText("Signups this week")).toBeNull();
      first.unmount();

      const client = clientWith();
      render(<InlineThreadCanvas card={inlineCard()} client={client} />);
      expect(screen.getByRole("button", { name: "Show in thread" })).toBeInTheDocument();
      expect(client.get).not.toHaveBeenCalled();
      localStorage.clear();
    });
  });
});
