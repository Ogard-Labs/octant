import { queueTestHost } from "../messageQueue/queueTestHost.test-fixture";
import {
  decodeWorkThreadTranscript,
  decodeWorkAttachmentReference,
  type ThreadMessageQueueResult,
} from "@octant/contracts";
import type { WorkTurnClient } from "@octant/client-runtime/work-turn-client";
import type { WorkThreadClient } from "@octant/client-runtime/work-thread-client";
import { WorkTurnClientFailure } from "@octant/client-runtime/work-turn-client";
import { decodeProjectSummary, decodeWorkThread, decodeWorkThreadId } from "@octant/contracts";
import type { PickerGroup } from "@octant/domain";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { CanvasThreadReferenceCard } from "@octant/contracts/canvas-cards";
import { Profiler } from "react";
import { describe, expect, it, vi } from "vitest";
import { WorkThreadWorkspace } from "./WorkThreadWorkspace";
import { createComposerThreadDraftStore } from "../composer/composerThreadDraftStore";

const threadId = decodeWorkThreadId("10000000-0000-4000-8000-000000000101");
const providerId = "80000000-0000-4000-8000-0000000000b1" as never;
const modelId = "model-one" as never;
const alternateProviderId = "80000000-0000-4000-8000-0000000000b2" as never;
const alternateModelId = "model-two" as never;

function queuedWorkClients() {
  const threadClient: WorkThreadClient = {
    bootstrap: vi.fn(),
    navigation: vi.fn(),
    execute: vi.fn(),
    queryBoard: vi.fn(),
  };
  const turnClient: WorkTurnClient = {
    transcript: vi.fn(async () =>
      decodeWorkThreadTranscript({ threadId, turns: [workTurn({ status: "running" })] }),
    ),
    startFirstTurn: vi.fn(),
    lookupFirstTurn: vi.fn(),
    cancelFirstTurn: vi.fn(),
    subscribe: vi.fn(),
    putAttachment: vi.fn(async (input) =>
      decodeWorkAttachmentReference({
        attachmentId: input.attachmentId,
        displayName: input.displayName,
        mediaType: input.mediaType,
        byteLength: input.bytes.byteLength,
        digest: "a".repeat(64),
      }),
    ),
    discardAttachment: vi.fn(async () => undefined),
  };
  return { threadClient, turnClient };
}

describe("Work host queue", () => {
  it("uploads before queueing and preserves newer text and images through acknowledgment", async () => {
    const host = queueTestHost();
    const clients = queuedWorkClients();
    const user = userEvent.setup();
    const response = Promise.withResolvers<ThreadMessageQueueResult>();
    host.execute.mockImplementationOnce(() => response.promise);
    const { unmount } = render(
      <WorkThreadWorkspace
        initialThread={workThread()}
        messageQueueClient={host}
        {...clients}
        threadId={threadId}
        title="Draft brief"
      />,
    );
    const composer = await screen.findByLabelText("Work prompt");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Queue message" })).toBeInTheDocument(),
    );
    await user.type(composer, "First");
    fireEvent.paste(composer, {
      clipboardData: {
        files: [new File(["image"], "first.png", { type: "image/png" })],
        items: [],
      },
    });
    await screen.findByAltText("first.png");
    await user.click(screen.getByRole("button", { name: "Queue message" }));
    await waitFor(() => expect(host.execute).toHaveBeenCalledOnce());
    expect(clients.turnClient.putAttachment).toHaveBeenCalledOnce();
    const command = host.execute.mock.calls[0]?.[0];
    if (command?.kind !== "enqueue") throw new Error("Expected enqueue");
    expect(command.payload).toEqual(
      expect.objectContaining({
        mode: "work",
        prompt: "First",
        attachmentIds: [expect.any(String)],
      }),
    );
    expect(composer).toHaveValue("First");
    await user.clear(composer);
    await user.type(composer, "New draft");
    fireEvent.paste(composer, {
      clipboardData: {
        files: [new File(["image"], "later.png", { type: "image/png" })],
        items: [],
      },
    });
    await screen.findByAltText("later.png");
    await act(async () => {
      response.resolve(host.apply(command));
    });
    expect(composer).toHaveValue("New draft");
    expect(screen.queryByAltText("first.png")).not.toBeInTheDocument();
    expect(screen.getByAltText("later.png")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Queue message" }));
    expect(await screen.findByRole("button", { name: "2 queued" })).toBeVisible();
    unmount();
    expect(clients.turnClient.startFirstTurn).not.toHaveBeenCalled();
    expect(clients.turnClient.discardAttachment).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "keeps files with the draft and releases uploads after a definite queue refusal on retry=%s",
    async (retry) => {
      const host = queueTestHost();
      const clients = queuedWorkClients();
      const user = userEvent.setup();
      if (retry) host.execute.mockRejectedValueOnce(new Error("offline"));
      host.execute.mockImplementation(async (command) => ({
        status: "refused",
        requestId: command.requestId,
        reason: "queue-full",
      }));
      render(
        <WorkThreadWorkspace
          initialThread={workThread()}
          messageQueueClient={host}
          {...clients}
          threadId={threadId}
          title="Draft brief"
        />,
      );
      const composer = await screen.findByLabelText("Work prompt");
      await user.type(composer, "Keep this");
      fireEvent.paste(composer, {
        clipboardData: {
          files: [new File(["image"], "kept.png", { type: "image/png" })],
          items: [],
        },
      });
      await screen.findByAltText("kept.png");
      await user.click(screen.getByRole("button", { name: "Queue message" }));
      if (retry) {
        await screen.findByText(/host has not confirmed/);
        fireEvent.paste(composer, {
          clipboardData: {
            files: [new File(["later"], "later.png", { type: "image/png" })],
            items: [],
          },
        });
        await screen.findByAltText("later.png");
        await user.click(screen.getByRole("button", { name: "Check queue" }));
        expect(screen.getByAltText("later.png")).toBeVisible();
      }
      await waitFor(() => expect(clients.turnClient.discardAttachment).toHaveBeenCalledOnce());
      expect(composer).toHaveValue("Keep this");
      expect(screen.getByAltText("kept.png")).toBeVisible();
      expect(clients.turnClient.startFirstTurn).not.toHaveBeenCalled();
    },
  );

  it("retains the draft when an older host has no queue route", async () => {
    const clients = queuedWorkClients();
    const user = userEvent.setup();
    render(
      <WorkThreadWorkspace
        initialThread={workThread()}
        {...clients}
        threadId={threadId}
        title="Draft brief"
      />,
    );
    const composer = await screen.findByLabelText("Work prompt");
    await user.type(composer, "Keep this");
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Queue message" })).toBeDisabled();
    expect(composer).toHaveValue("Keep this");
    expect(clients.turnClient.startFirstTurn).not.toHaveBeenCalled();
  });
});

describe("WorkThreadWorkspace", () => {
  it.each([true, false])(
    "shows the working folder without borrowing a different binding root (matching: %s)",
    async (matching) => {
      const thread = workThread();
      const project = decodeProjectSummary({
        id: thread.projectId,
        type: "work",
        name: "Research",
        lifecycle: "active",
        pinned: false,
        rank: "0/1",
        version: 1,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
        binding: { canonicalRoot: "/Users/example/Research" },
        bindingRevisionId: matching
          ? thread.bindingRevisionId
          : "30000000-0000-4000-8000-000000000102",
      });
      render(
        <WorkThreadWorkspace
          initialThread={thread}
          projects={[project]}
          threadClient={{
            bootstrap: vi.fn(),
            navigation: vi.fn(),
            execute: vi.fn(),
            queryBoard: vi.fn(),
          }}
          threadId={thread.id}
          title={thread.title}
        />,
      );
      const strip = await screen.findByRole("group", { name: "Project and folder" });
      expect(within(strip).getByText("Research")).toBeVisible();
      expect(within(strip).getByText("research/brief")).toHaveAttribute(
        "title",
        matching ? "/Users/example/Research/research/brief" : "research/brief",
      );
      expect(strip.closest(".thread-composer__context")).not.toBeNull();
    },
  );

  it("keeps a Browser approval visible and explains a failed decision", async () => {
    const user = userEvent.setup();
    const approval = {
      approvalId: "90000000-0000-4000-8000-000000000001",
      threadId: String(threadId),
      mode: "work",
      origin: "https://example.com",
      requestedAt: "2026-09-09T10:00:00.000Z",
    };
    const browserAutomationClient = {
      listApprovals: vi.fn(async () => [approval]),
      decideApproval: vi.fn(async () => {
        throw new Error("offline");
      }),
    };
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    render(
      <WorkThreadWorkspace
        browserAutomationClient={browserAutomationClient as never}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
      />,
    );

    const row = await screen.findByRole("group", { name: "Browser origin approval" });
    await user.click(within(row).getByRole("button", { name: "Approve once" }));
    expect(await within(row).findByRole("alert")).toHaveTextContent(
      "Browser approval could not be sent. Keep this request open and retry.",
    );
    expect(screen.getByRole("group", { name: "Browser origin approval" })).toBeInTheDocument();
  });

  it("asks before a selected MCP server's tool runs in this Work thread", async () => {
    const user = userEvent.setup();
    const approval = {
      approvalId: "90000000-0000-4000-8000-000000000002",
      threadId: String(threadId),
      packageId: "90000000-0000-4000-8000-000000000003",
      componentId: "notes-server",
      providerToolName: "plugin__notes__search",
      mcpToolName: "search",
      inputJson: '{"q":"plan"}',
      requestedAt: "2026-09-09T10:00:00.000Z",
    };
    const otherThread = {
      ...approval,
      approvalId: "90000000-0000-4000-8000-000000000004",
      threadId: "10000000-0000-4000-8000-000000000999",
      mcpToolName: "elsewhere",
    };
    const extensionClient = {
      listToolApprovals: vi.fn(async () => [otherThread, approval]),
      decideToolApproval: vi.fn(async () => undefined),
    };
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    render(
      <WorkThreadWorkspace
        extensionClient={extensionClient as never}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
      />,
    );

    const row = await screen.findByRole("group", { name: "Extension tool approval" });
    expect(row).toHaveTextContent("Allow search?");
    expect(row).toHaveTextContent('{"q":"plan"}');
    await user.click(within(row).getByRole("button", { name: "Approve once" }));
    expect(extensionClient.decideToolApproval).toHaveBeenCalledWith({
      approvalId: approval.approvalId,
      decision: "approved",
    });
    await waitFor(() =>
      expect(screen.queryByRole("group", { name: "Extension tool approval" })).toBeNull(),
    );
  });

  it("keeps an MCP tool approval open and explains a failed decision", async () => {
    const user = userEvent.setup();
    const approval = {
      approvalId: "90000000-0000-4000-8000-000000000005",
      threadId: String(threadId),
      packageId: "90000000-0000-4000-8000-000000000003",
      componentId: "notes-server",
      providerToolName: "plugin__notes__search",
      mcpToolName: "search",
      inputJson: "{}",
      requestedAt: "2026-09-09T10:00:00.000Z",
    };
    const extensionClient = {
      listToolApprovals: vi.fn(async () => [approval]),
      decideToolApproval: vi.fn(async () => {
        throw new Error("offline");
      }),
    };
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    render(
      <WorkThreadWorkspace
        extensionClient={extensionClient as never}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
      />,
    );

    const row = await screen.findByRole("group", { name: "Extension tool approval" });
    await user.click(within(row).getByRole("button", { name: "Deny" }));
    expect(await within(row).findByRole("alert")).toHaveTextContent(
      "The approval could not be sent. Keep this request open and retry.",
    );
    expect(screen.getByRole("group", { name: "Extension tool approval" })).toBeInTheDocument();
  });

  it("saves reasoning for the current Work model and restores its default", async () => {
    const user = userEvent.setup();
    const execute = vi.fn<WorkThreadClient["execute"]>(async (command) => ({
      kind: "thread-updated",
      thread: workThread({
        modelOptionValues: "modelOptionValues" in command ? command.modelOptionValues : {},
        version: 2,
      }),
    }));
    const group = providerGroup();
    render(
      <WorkThreadWorkspace
        providerGroups={[
          {
            ...group,
            sections: group.sections.map((section) => ({
              ...section,
              models: section.models.map((entry) => ({
                ...entry,
                model: {
                  ...entry.model,
                  options: [
                    {
                      kind: "selection",
                      id: "effort",
                      displayName: "Effort",
                      values: ["low", "high"],
                    },
                  ],
                },
              })),
            })),
          },
        ]}
        threadClient={{
          bootstrap: vi.fn(async () => ({ threads: [workThread()], runtime: [] })),
          navigation: vi.fn(),
          queryBoard: vi.fn(),
          execute,
        }}
        threadId={threadId}
        title="Draft brief"
      />,
    );
    await screen.findByLabelText("Bound provider and model");
    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    const levels = await screen.findByRole("slider", { name: "Effort level" });
    fireEvent.change(levels, { target: { value: levels.getAttribute("max") } });
    await waitFor(() =>
      expect(execute).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "change-work-thread-provider",
          providerInstanceId: providerId,
          modelId,
          modelOptionValues: { effort: "high" },
        }),
      ),
    );
    expect(levels).toHaveAttribute("aria-valuetext", "High");
    fireEvent.change(levels, { target: { value: "0" } });
    await waitFor(() =>
      expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ modelOptionValues: {} })),
    );
  });

  it("changes provider and model through the authoritative Work command", async () => {
    const user = userEvent.setup();
    const execute = vi.fn(async () => ({
      kind: "thread-updated" as const,
      thread: workThread({
        providerInstanceId: alternateProviderId,
        modelId: alternateModelId,
      }),
    }));
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute,
    } as unknown as WorkThreadClient;

    render(
      <WorkThreadWorkspace
        providerGroups={[providerGroup(), alternateProviderGroup()]}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
      />,
    );

    await screen.findByLabelText("Bound provider and model");
    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    await user.click(screen.getByRole("option", { name: "Remote Provider" }));
    await user.click(screen.getByRole("option", { name: "Model Two" }));

    expect(execute).toHaveBeenCalledWith({
      kind: "change-work-thread-provider",
      threadId,
      expectedVersion: 1,
      providerInstanceId: alternateProviderId,
      modelId: alternateModelId,
    });
  });

  it("notifies the sidebar after an authoritative Work thread update", async () => {
    const user = userEvent.setup();
    const updated = workThread({
      providerInstanceId: alternateProviderId,
      modelId: alternateModelId,
      updatedAt: "2026-08-01T20:01:00.000Z",
      version: 2,
    });
    const onThreadUpdated = vi.fn();
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(async () => ({
        kind: "thread-updated" as const,
        thread: updated,
      })),
    } as unknown as WorkThreadClient;

    render(
      <WorkThreadWorkspace
        onThreadUpdated={onThreadUpdated}
        providerGroups={[providerGroup(), alternateProviderGroup()]}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
      />,
    );

    await screen.findByLabelText("Bound provider and model");
    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    await user.click(screen.getByRole("option", { name: "Remote Provider" }));
    await user.click(screen.getByRole("option", { name: "Model Two" }));
    expect(onThreadUpdated).toHaveBeenCalledWith(updated);
  });

  it("keeps Work actions out of a separate row above the conversation", async () => {
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    render(
      <WorkThreadWorkspace
        providerGroups={[providerGroup()]}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
      />,
    );
    await screen.findByLabelText("Bound provider and model");
    expect(screen.queryByRole("toolbar", { name: "Work tools" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Mark this task complete" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Task actions" }).closest(".composer-row"),
    ).not.toBeNull();
  });

  it("stops the running turn through the host", async () => {
    const user = userEvent.setup();
    const running = workTurn({ status: "running" });
    const cancelFirstTurn = vi.fn(async () => ({
      kind: "turn-cancelled" as const,
      requestId: running.requestId,
      threadId: running.threadId,
      turnId: running.turnId,
      status: "cancelled" as const,
    }));
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    const turnClient = {
      transcript: vi.fn(async () => ({ threadId, turns: [running], liveCursor: 0 })),
      cancelFirstTurn,
    };

    render(
      <WorkThreadWorkspace
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
        turnClient={turnClient as never}
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Stop turn" }));
    expect(cancelFirstTurn).toHaveBeenCalledWith({
      kind: "cancel-work-turn",
      requestId: running.requestId,
      threadId: running.threadId,
      turnId: running.turnId,
    });
  });

  it("disables Stop turn for a running turn from another thread", async () => {
    const otherThreadId = decodeWorkThreadId("10000000-0000-4000-8000-000000000102");
    const running = workTurn({ status: "running", threadId: otherThreadId });
    const cancelFirstTurn = vi.fn();
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    const turnClient = {
      transcript: vi.fn(async () => ({ threadId, turns: [running], liveCursor: 0 })),
      cancelFirstTurn,
    };

    render(
      <WorkThreadWorkspace
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
        turnClient={turnClient as never}
      />,
    );

    const stop = await screen.findByRole("button", { name: "Stop turn" });
    expect(stop).toBeDisabled();
    expect(cancelFirstTurn).not.toHaveBeenCalled();
  });

  it("confirms completion through the user-facing Work action", async () => {
    const user = userEvent.setup();
    const execute = vi.fn(async () => ({
      kind: "thread-completion-confirmed" as const,
      thread: workThread({ version: 2, completionConfirmed: true }),
    }));
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute,
    } as unknown as WorkThreadClient;

    render(
      <WorkThreadWorkspace
        providerGroups={[providerGroup()]}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
      />,
    );

    await screen.findByLabelText("Bound provider and model");
    await user.click(screen.getByRole("button", { name: "Task actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Mark complete" }));
    await user.type(
      screen.getByRole("textbox", { name: "What this task delivered" }),
      "The reviewed draft is saved in the bound folder.",
    );
    await user.click(
      screen.getByRole("button", {
        name: "Confirm this task is complete",
      }),
    );

    expect(execute).toHaveBeenCalledWith({
      kind: "confirm-work-thread-completion",
      threadId,
      expectedVersion: 1,
      deliveryTarget: "Draft brief",
      satisfactionEvidence: "The reviewed draft is saved in the bound folder.",
    });
    expect(await screen.findByText("Delivery marked complete.")).toBeInTheDocument();
  });

  it("blocks artifact and provider mutations after completion until reactivation", async () => {
    const threadClient = {
      bootstrap: vi.fn(async () => ({
        threads: [workThread({ completionConfirmed: true })],
      })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;

    render(
      <WorkThreadWorkspace
        mutationClient={{ mutate: vi.fn() } as never}
        providerGroups={[providerGroup()]}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
      />,
    );

    expect(await screen.findByLabelText("Bound provider and model")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Work prompt" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Provider and model" })).toBeDisabled();
    expect(screen.getByText(/Reactivate this task/)).toBeInTheDocument();
  });

  it("keeps post-preview Canvas tools out of the live thread toolbar", async () => {
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;

    render(
      <WorkThreadWorkspace
        canvasClient={{ threadReferenceCards: async () => ({ cards: [] }) } as never}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
      />,
    );

    await screen.findByLabelText("Bound provider and model");
    expect(screen.queryByRole("button", { name: "Canvas" })).not.toBeInTheDocument();
  });

  it("shows the Canvas the task authored and offers to open it", async () => {
    const user = userEvent.setup();
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    const card = {
      schemaVersion: 1,
      kind: "canvas-reference-card",
      cardId: "20000000-0000-4000-8000-000000000001",
      canvasId: "20000000-0000-4000-8000-000000000002",
      versionId: "20000000-0000-4000-8000-000000000003",
      title: "Launch plan",
      scope: { hostId: "local", mode: "work", workspace: { kind: "work-root", projectId: null } },
      originThreadId: threadId,
      status: "ready",
      authority: {
        filesystem: false,
        shell: false,
        git: false,
        network: false,
        tools: true,
        subagents: false,
        executionPolicy: "plan",
        permissionPersistence: "current-session",
      },
      actorId: "99999999-9999-4999-8999-999999999999",
      providerInstanceId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      modelId: "octant-test-model",
      createdAt: "2026-08-01T21:00:00.000Z",
      actionCount: 0,
    } as unknown as CanvasThreadReferenceCard;
    const threadReferenceCards = vi.fn(async () => ({ cards: [card] }));
    const onCanvasReferencesObserved = vi.fn();
    const onOpenCanvas = vi.fn();

    render(
      <WorkThreadWorkspace
        canvasClient={{ threadReferenceCards } as never}
        onCanvasReferencesObserved={onCanvasReferencesObserved}
        onOpenCanvas={onOpenCanvas}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
      />,
    );

    await user.click(await screen.findByRole("button", { name: "Open Canvas" }));
    expect(threadReferenceCards).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "work", threadId: String(threadId) }),
    );
    expect(onCanvasReferencesObserved).toHaveBeenCalledWith(String(threadId), [card]);
    expect(onOpenCanvas).toHaveBeenCalledWith(card);
  });

  it("shows the files a turn changed instead of narrating them in prose", async () => {
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    const turnClient = {
      transcript: vi.fn(async () => ({
        threadId,
        turns: [
          {
            requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            threadId,
            turnId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            projectId: "20000000-0000-4000-8000-000000000101",
            authority: {
              hostId: "local",
              projectId: "20000000-0000-4000-8000-000000000101",
              bindingRevisionId: "30000000-0000-4000-8000-000000000101",
              workingDirectory: ".",
              confinementPosture: "project-root-confined",
              providerInstanceId: providerId,
              modelId,
            },
            status: "completed",
            prompt: "Draft the brief",
            transcript: [
              { role: "user", text: "Draft the brief" },
              { role: "assistant", text: "Done." },
            ],
            wroteFiles: { paths: ["brief.md", "research/notes.txt"], truncated: false },
            capabilities: {
              workspace: "project-backed",
              confinement: "project-root-confined",
              shell: "denied",
              git: "denied",
              worktree: "denied",
              pullRequest: "denied",
              code: "denied",
            },
            version: 2,
            acceptedAt: "2026-09-04T20:00:00.000Z",
            updatedAt: "2026-09-04T20:01:00.000Z",
          },
        ],
      })),
    };

    render(
      <WorkThreadWorkspace
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
        turnClient={turnClient as never}
      />,
    );

    const files = await screen.findByRole("region", { name: "Files this turn changed" });
    // Observed, not attributed: the host watched the folder and never learned
    // who wrote what, so the heading says what happened rather than who did it.
    expect(within(files).getByText("2 files changed while this ran")).toBeVisible();
    expect(within(files).getByText("brief.md")).toBeVisible();
    expect(within(files).getByText("research/notes.txt")).toBeVisible();
  });

  it("shows the provider's task list on the turn that reported it", async () => {
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    const turnClient = {
      transcript: vi.fn(async () => ({
        threadId,
        turns: [
          {
            requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            threadId,
            turnId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            projectId: "20000000-0000-4000-8000-000000000101",
            authority: {
              hostId: "local",
              projectId: "20000000-0000-4000-8000-000000000101",
              bindingRevisionId: "30000000-0000-4000-8000-000000000101",
              workingDirectory: ".",
              confinementPosture: "project-root-confined",
              providerInstanceId: providerId,
              modelId,
            },
            status: "completed",
            prompt: "Draft the brief",
            transcript: [
              { role: "user", text: "Draft the brief" },
              { role: "assistant", text: "Done." },
            ],
            tasks: [
              { taskId: "task-1", state: "completed", summary: "Read the brief" },
              { taskId: "task-2", state: "pending", summary: "Commit the evidence" },
            ],
            capabilities: {
              workspace: "project-backed",
              confinement: "project-root-confined",
              shell: "denied",
              git: "denied",
              worktree: "denied",
              pullRequest: "denied",
              code: "denied",
            },
            version: 2,
            acceptedAt: "2026-09-04T20:00:00.000Z",
            updatedAt: "2026-09-04T20:01:00.000Z",
          },
        ],
      })),
    };

    render(
      <WorkThreadWorkspace
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
        turnClient={turnClient as never}
      />,
    );

    expect(await screen.findByRole("region", { name: "Agent tasks" })).toBeVisible();
    expect(screen.getByText("1 of 2 tasks completed")).toBeVisible();
  });

  it("renders the durable transcript and pending request projection", async () => {
    const user = userEvent.setup();
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    const turnClient = {
      transcript: vi.fn(async () => ({
        threadId,
        turns: [
          {
            requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            threadId,
            turnId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            projectId: "20000000-0000-4000-8000-000000000101",
            authority: {
              hostId: "local",
              projectId: "20000000-0000-4000-8000-000000000101",
              bindingRevisionId: "30000000-0000-4000-8000-000000000101",
              workingDirectory: "research/brief",
              confinementPosture: "project-root-confined",
              providerInstanceId: providerId,
              modelId,
            },
            status: "completed",
            prompt: "Summarize the brief",
            transcript: [
              { role: "user", text: "Summarize the brief" },
              { role: "assistant", text: "Here is the confined summary." },
            ],
            capabilities: {
              workspace: "project-backed",
              confinement: "project-root-confined",
              shell: "denied",
              git: "denied",
              worktree: "denied",
              pullRequest: "denied",
              code: "denied",
            },
            version: 2,
            acceptedAt: "2026-08-01T20:00:00.000Z",
            updatedAt: "2026-08-01T20:01:00.000Z",
          },
        ],
      })),
    };
    const requestClient = {
      list: vi.fn(async () => ({
        requests: [
          {
            requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            projectId: "20000000-0000-4000-8000-000000000101",
            threadId,
            status: "pending",
            detail: {
              kind: "approval",
              action: "write-file",
              description: "Save notes.md in the Project root.",
            },
            version: 1,
          },
        ],
      })),
      execute: vi.fn(async () => ({ kind: "work-request-resolved" })),
    };

    render(
      <WorkThreadWorkspace
        requestClient={requestClient as never}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
        turnClient={turnClient as never}
      />,
    );

    expect(await screen.findByText("Summarize the brief")).toBeInTheDocument();
    expect(screen.getByText("Here is the confined summary.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Approve" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Approve" })).not.toBeInTheDocument(),
    );
    expect(requestClient.execute).toHaveBeenCalledWith({
      kind: "resolve-work-request",
      requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      expectedVersion: 1,
      resolution: { kind: "approval", approved: true },
    });
    expect(turnClient.transcript).toHaveBeenCalledWith(threadId, expect.any(AbortSignal));
    expect(requestClient.list).toHaveBeenCalledWith(
      "20000000-0000-4000-8000-000000000101",
      threadId,
      expect.any(AbortSignal),
    );
  });

  it("says why a turn failed instead of leaving the transcript silent", async () => {
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    const turnClient = {
      transcript: vi.fn(async () => ({
        threadId,
        turns: [
          workTurn({
            status: "failed",
            transcript: [{ role: "user", text: "Summarize the brief" }],
            failure: { category: "failed", message: "Claude message stream failed." },
          }),
        ],
      })),
    };
    const requestClient = { list: vi.fn(async () => ({ requests: [] })) };

    render(
      <WorkThreadWorkspace
        requestClient={requestClient as never}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
        turnClient={turnClient as never}
      />,
    );

    expect(await screen.findByText("Claude message stream failed.")).toBeVisible();
  });

  it("windows long Work transcripts instead of mounting every message", async () => {
    const turns = Array.from({ length: 200 }, (_, index) =>
      workTurn({
        requestId: `request-${String(index)}`,
        prompt: `Prompt ${String(index)}`,
        transcript: [{ role: "user", text: `Prompt ${String(index)}` }],
      }),
    );
    const { container } = render(
      <WorkThreadWorkspace
        initialThread={workThread()}
        threadClient={{ execute: vi.fn() } as unknown as WorkThreadClient}
        threadId={threadId}
        title="Long brief"
        turnClient={
          {
            transcript: vi.fn(async () => ({ threadId, turns, liveCursor: 0 })),
          } as never
        }
      />,
    );

    await waitFor(() =>
      expect(container.querySelector("[data-transcript-window]")).toBeInTheDocument(),
    );
    expect(container.querySelectorAll("[data-transcript-row]").length).toBeLessThan(200);
  });

  it("starts transcript and pending-request reads together from the navigation thread", async () => {
    const transcript = deferred<{ readonly threadId: typeof threadId; readonly turns: [] }>();
    const requests = deferred<{ readonly requests: [] }>();
    const threadClient = {
      bootstrap: vi.fn(async () => {
        throw new Error("full bootstrap must not gate an opened thread");
      }),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    const turnClient = { transcript: vi.fn(() => transcript.promise) };
    const requestClient = { list: vi.fn(() => requests.promise) };

    render(
      <WorkThreadWorkspace
        initialThread={workThread()}
        requestClient={requestClient as never}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
        turnClient={turnClient as never}
      />,
    );

    await waitFor(() => {
      expect(turnClient.transcript).toHaveBeenCalledWith(threadId, expect.any(AbortSignal));
      expect(requestClient.list).toHaveBeenCalledWith(
        "20000000-0000-4000-8000-000000000101",
        threadId,
        expect.any(AbortSignal),
      );
    });
    expect(threadClient.bootstrap).not.toHaveBeenCalled();

    transcript.resolve({ threadId, turns: [] });
    requests.resolve({ requests: [] });
  });

  it("keeps the live transcript mounted when navigation refreshes the same thread", async () => {
    const transcript = vi.fn(async () => ({ threadId, turns: [], liveCursor: 0 }));
    const subscribe = vi.fn(async function* (
      _threadId: typeof threadId,
      _cursor: number,
      signal: AbortSignal,
    ) {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      yield* [];
    });
    const turnClient = { transcript, subscribe } as never;
    const threadClient = { execute: vi.fn() } as unknown as WorkThreadClient;
    const { rerender } = render(
      <WorkThreadWorkspace
        initialThread={workThread()}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
        turnClient={turnClient}
      />,
    );
    await waitFor(() => expect(subscribe).toHaveBeenCalledOnce());

    rerender(
      <WorkThreadWorkspace
        initialThread={workThread({ title: "Refreshed navigation title" })}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
        turnClient={turnClient}
      />,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transcript).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledOnce();
  });

  it("aborts obsolete transcript reads when the user switches Work threads", async () => {
    const nextThreadId = decodeWorkThreadId("10000000-0000-4000-8000-000000000102");
    let firstSignal: AbortSignal | undefined;
    const transcript = vi.fn((requestedThreadId, signal?: AbortSignal) => {
      if (requestedThreadId === threadId) firstSignal = signal;
      return new Promise(() => undefined);
    });
    const threadClient = { execute: vi.fn() } as unknown as WorkThreadClient;
    const { rerender } = render(
      <WorkThreadWorkspace
        initialThread={workThread()}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
        turnClient={{ transcript } as never}
      />,
    );
    await waitFor(() => expect(firstSignal).toBeDefined());

    rerender(
      <WorkThreadWorkspace
        initialThread={workThread({ id: nextThreadId })}
        threadClient={threadClient}
        threadId={nextThreadId}
        title="Next brief"
        turnClient={{ transcript } as never}
      />,
    );

    await waitFor(() => expect(firstSignal?.aborted).toBe(true));
  });

  it("paints live Work text from the stream without waiting for transcript polling", async () => {
    vi.useFakeTimers();
    try {
      const frame = deferred<{
        readonly kind: "response-delta";
        readonly sequence: 1;
        readonly threadId: typeof threadId;
        readonly requestId: ReturnType<typeof workTurn>["requestId"];
        readonly text: "Immediate text";
      }>();
      const running = workTurn({
        status: "running",
        response: undefined,
        transcript: [
          { role: "user", text: "Start" },
          { role: "assistant", text: "", status: "running" },
        ],
      });
      const transcript = vi.fn(async () => ({ threadId, turns: [running], liveCursor: 0 }));
      const list = vi.fn(async () => ({ requests: [] }));
      const subscribe = vi.fn(async function* () {
        yield await frame.promise;
      });

      render(
        <WorkThreadWorkspace
          changeRevision={0}
          initialThread={workThread()}
          requestClient={{ list } as never}
          threadClient={{ execute: vi.fn() } as never}
          threadId={threadId}
          title="Draft brief"
          turnClient={{ transcript, subscribe } as never}
        />,
      );

      await act(async () => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByText("Working…")).toBeInTheDocument();
      await act(async () => {
        frame.resolve({
          kind: "response-delta",
          sequence: 1,
          threadId,
          requestId: running.requestId,
          text: "Immediate text",
        });
        await Promise.resolve();
      });

      expect(screen.getByText("Immediate text")).toBeInTheDocument();
      await act(async () => vi.advanceTimersByTimeAsync(1_100));
      expect(transcript).toHaveBeenCalledOnce();
      expect(list).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries the initial Work snapshot before opening the live stream", async () => {
    const recovered = workTurn({
      prompt: "Recovered prompt",
      transcript: [{ role: "user", text: "Recovered prompt" }],
    });
    const transcript = vi
      .fn()
      .mockRejectedValueOnce(new Error("host is restarting"))
      .mockResolvedValue({ threadId, turns: [recovered], liveCursor: 4 });
    const subscribe = vi.fn(async function* (
      _threadId: typeof threadId,
      _cursor: number,
      signal: AbortSignal,
    ) {
      await new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      );
      yield* [];
    });

    render(
      <WorkThreadWorkspace
        changeRevision={0}
        initialThread={workThread()}
        threadClient={{ execute: vi.fn() } as unknown as WorkThreadClient}
        threadId={threadId}
        title="Draft brief"
        turnClient={{ transcript, subscribe } as never}
      />,
    );

    expect(await screen.findByText("Recovered prompt", {}, { timeout: 2_000 })).toBeVisible();
    expect(transcript).toHaveBeenCalledTimes(2);
    expect(subscribe).toHaveBeenCalledWith(threadId, 4, expect.any(AbortSignal));
  });

  it("pauses Work snapshot recovery while the document is hidden", async () => {
    vi.useFakeTimers();
    const originalVisibility = document.visibilityState;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    try {
      const recovered = workTurn({
        prompt: "Visible recovery",
        transcript: [{ role: "user", text: "Visible recovery" }],
      });
      const transcript = vi
        .fn()
        .mockRejectedValueOnce(new Error("host is restarting"))
        .mockResolvedValue({ threadId, turns: [recovered], liveCursor: 0 });
      render(
        <WorkThreadWorkspace
          changeRevision={0}
          initialThread={workThread()}
          threadClient={{ execute: vi.fn() } as unknown as WorkThreadClient}
          threadId={threadId}
          title="Draft brief"
          turnClient={{ transcript } as never}
        />,
      );

      await act(async () => vi.advanceTimersByTimeAsync(350));
      expect(transcript).toHaveBeenCalledOnce();

      await act(async () => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "visible",
        });
        document.dispatchEvent(new Event("visibilitychange"));
        await vi.advanceTimersByTimeAsync(250);
      });
      expect(screen.getByText("Visible recovery")).toBeVisible();
      expect(transcript).toHaveBeenCalledTimes(2);
    } finally {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: originalVisibility,
      });
      vi.useRealTimers();
    }
  });

  it("does not retry a Work snapshot the host permanently refuses", async () => {
    vi.useFakeTimers();
    try {
      const transcript = vi.fn(async () => {
        throw new WorkTurnClientFailure("Work transcript is unauthorized.", 401);
      });
      render(
        <WorkThreadWorkspace
          changeRevision={0}
          initialThread={workThread()}
          threadClient={{ execute: vi.fn() } as unknown as WorkThreadClient}
          threadId={threadId}
          title="Draft brief"
          turnClient={{ transcript } as never}
        />,
      );

      await act(async () => vi.advanceTimersByTimeAsync(0));
      expect(screen.getByRole("alert")).toHaveTextContent("This task could not be loaded.");
      await act(async () => vi.advanceTimersByTimeAsync(350));
      expect(transcript).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a slow initial transcript read from overwriting a newer polled result", async () => {
    // The initial bootstrap read and the interval poll are separate effects
    // that share one generation counter. A read the initial effect started
    // before the interval ever ticked must still lose to a poll that
    // completed after it, even though it settles later.
    const older = deferred<ReadonlyArray<ReturnType<typeof workTurn>>>();
    let reads = 0;
    const turnClient = {
      transcript: vi.fn(async () => {
        reads += 1;
        if (reads === 1) return { threadId, turns: await older.promise };
        return {
          threadId,
          turns: [
            workTurn({
              prompt: "Newest transcript",
              transcript: [{ role: "user", text: "Newest transcript" }],
            }),
          ],
        };
      }),
    };
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;

    render(
      <WorkThreadWorkspace
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
        turnClient={turnClient as never}
      />,
    );

    await waitFor(() => expect(turnClient.transcript).toHaveBeenCalledOnce());
    await waitFor(() => expect(turnClient.transcript).toHaveBeenCalledTimes(2), {
      timeout: 2_500,
    });
    expect(await screen.findByText("Newest transcript")).toBeInTheDocument();

    older.resolve([
      workTurn({
        prompt: "Stale transcript",
        transcript: [{ role: "user", text: "Stale transcript" }],
      }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(screen.queryByText("Stale transcript")).not.toBeInTheDocument();
  });

  it("waits for a slow polling cycle to settle before starting the next one", async () => {
    // Promise.allSettled from a polling tick used to run unawaited, so the
    // very next tick would bump the generation before a slow response came
    // back - discarding it. A host that consistently answers a little slower
    // than the 1s interval would then never see its transcript update again.
    const slow = deferred<ReadonlyArray<ReturnType<typeof workTurn>>>();
    let reads = 0;
    const transcript = vi.fn(async () => {
      reads += 1;
      if (reads === 1) return { threadId, turns: [] };
      return { threadId, turns: await slow.promise };
    });
    const turnClient = { transcript };
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;

    render(
      <WorkThreadWorkspace
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
        turnClient={turnClient as never}
      />,
    );

    await waitFor(() => expect(transcript).toHaveBeenCalledOnce());
    await waitFor(() => expect(transcript).toHaveBeenCalledTimes(2), { timeout: 2_500 });

    // The second read is still pending. Two more interval ticks pass without
    // a third call, proving the next cycle waited instead of piling on.
    await new Promise((resolve) => setTimeout(resolve, 2_200));
    expect(transcript).toHaveBeenCalledTimes(2);

    slow.resolve([
      workTurn({
        prompt: "Recovered after a slow poll",
        transcript: [{ role: "user", text: "Recovered after a slow poll" }],
      }),
    ]);

    expect(await screen.findByText("Recovered after a slow poll")).toBeInTheDocument();
    await waitFor(() => expect(transcript).toHaveBeenCalledTimes(3), { timeout: 2_500 });
  });

  it("keeps polling pending requests on a schedule without a turn client", async () => {
    // requestClient and turnClient are supplied independently by the host, so
    // request polling must not be gated on turnClient being present.
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    let pending: ReadonlyArray<Record<string, unknown>> = [];
    const list = vi.fn(async () => ({ requests: pending }));
    const requestClient = { list };

    render(
      <WorkThreadWorkspace
        requestClient={requestClient as never}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
      />,
    );

    await waitFor(() => expect(list).toHaveBeenCalledOnce());

    pending = [
      {
        requestId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        projectId: "20000000-0000-4000-8000-000000000101",
        threadId,
        status: "pending",
        detail: {
          kind: "approval",
          action: "write-file",
          description: "Save notes.md in the Project root.",
        },
        createdAt: "2026-08-01T20:01:30.000Z",
        updatedAt: "2026-08-01T20:01:30.000Z",
      },
    ];

    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(1), { timeout: 2_500 });
    expect(
      await screen.findByText("write-file: Save notes.md in the Project root."),
    ).toBeInTheDocument();
  });

  it("does not commit again when transcript polling returns the same data", async () => {
    vi.useFakeTimers();
    try {
      const turns = [workTurn()];
      const transcript = vi.fn(async () => ({ threadId, turns }));
      const turnClient = {
        transcript,
      };
      const threadClient = {
        bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
        execute: vi.fn(),
      } as unknown as WorkThreadClient;
      const commits: Array<string> = [];

      render(
        <Profiler id="work-thread-workspace" onRender={(_, phase) => commits.push(phase)}>
          <WorkThreadWorkspace
            threadClient={threadClient}
            threadId={threadId}
            title="Draft brief"
            turnClient={turnClient as never}
          />
        </Profiler>,
      );

      await act(async () => vi.advanceTimersByTimeAsync(3_100));
      expect(transcript.mock.calls.length).toBeGreaterThan(2);
      // Let the virtualized transcript finish its first timer-driven measure;
      // the assertion below isolates later identical polling responses.
      await act(async () => vi.advanceTimersByTimeAsync(1_100));
      const commitsAfterPolling = commits.length;
      await act(async () => vi.advanceTimersByTimeAsync(1_100));

      expect(commits.length).toBe(commitsAfterPolling);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not offer @Browser in a thread whose provider cannot carry the tool", async () => {
    const user = userEvent.setup();
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    const incapable = { ...providerGroup(), appManagedTools: "unsupported" } as never;

    render(
      <WorkThreadWorkspace
        hostId={"local" as never}
        browserAvailable
        providerGroups={[incapable]}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
      />,
    );

    // The bound provider is read once the thread has loaded; typing sooner
    // would race the bootstrap and offer the tool permissively.
    await screen.findByLabelText("Bound provider and model");
    await user.type(screen.getByLabelText("Work prompt"), "@b");
    expect(screen.queryByRole("option", { name: /Browser/ })).not.toBeInTheDocument();
  });

  it("offers a limited stop's recovery only while that stop is still waiting", async () => {
    const failure = {
      category: "rate-limited",
      message: "Rate limit reached.",
      usageLimit: {
        kind: "temporary",
        resetsAt: new Date(Date.now() + 10 * 60_000).toISOString(),
      },
    };
    const renderTurn = (status: "waiting" | "failed") => (
      <WorkThreadWorkspace
        hostId={"local" as never}
        threadClient={
          {
            bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
            execute: vi.fn(),
          } as unknown as WorkThreadClient
        }
        threadId={threadId}
        title="Draft brief"
        turnClient={
          {
            transcript: vi.fn(async () => ({
              threadId,
              turns: [
                workTurn({
                  status,
                  failure,
                  transcript: [
                    { role: "user", text: "Summarize the brief" },
                    { role: "assistant", text: "", status },
                  ],
                }),
              ],
            })),
          } as never
        }
      />
    );

    const failed = render(renderTurn("failed"));
    await screen.findByRole("alert");
    expect(
      screen.queryByRole("button", { name: "Resume when the limit resets" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Snooze until reset" })).not.toBeInTheDocument();
    failed.unmount();

    render(renderTurn("waiting"));
    await screen.findByRole("button", { name: "Resume when the limit resets" });
    expect(screen.getByRole("button", { name: "Snooze until reset" })).toBeVisible();
  });

  it("does not duplicate a turn that settles before the start response arrives", async () => {
    const user = userEvent.setup();
    const settledTurn = workTurn({
      requestId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      turnId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      status: "completed",
      prompt: "Quick turn",
      response: "Done",
      transcript: [
        { role: "user", text: "Quick turn" },
        { role: "assistant", text: "Done", status: "completed" },
      ],
    });
    const started = deferred<{
      readonly kind: "accepted";
      readonly turn: ReturnType<typeof workTurn>;
    }>();
    const settlement = deferred<{
      readonly kind: "turn-settled";
      readonly sequence: 1;
      readonly threadId: typeof threadId;
      readonly turn: ReturnType<typeof workTurn>;
    }>();
    const subscribe = vi.fn(async function* () {
      yield await settlement.promise;
    });
    const startFirstTurn = vi.fn(() => started.promise);
    render(
      <WorkThreadWorkspace
        changeRevision={0}
        hostId={"local" as never}
        initialThread={workThread()}
        threadClient={{ execute: vi.fn() } as unknown as WorkThreadClient}
        threadId={threadId}
        title="Draft brief"
        turnClient={
          {
            transcript: vi.fn(async () => ({ threadId, turns: [], liveCursor: 0 })),
            subscribe,
            startFirstTurn,
          } as never
        }
      />,
    );
    await waitFor(() => expect(subscribe).toHaveBeenCalledOnce());

    await user.type(screen.getByLabelText("Work prompt"), "Quick turn");
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));
    await waitFor(() => expect(startFirstTurn).toHaveBeenCalledOnce());
    settlement.resolve({ kind: "turn-settled", sequence: 1, threadId, turn: settledTurn });
    await waitFor(() => expect(screen.getByText("Done")).toBeVisible());
    started.resolve({ kind: "accepted", turn: { ...settledTurn, status: "accepted" } });
    await waitFor(() => expect(screen.getAllByText("Quick turn")).toHaveLength(1));
  });

  it("shows the host's reason when it refuses to start a Work turn", async () => {
    const user = userEvent.setup();
    const reason =
      "This thread has used all 2 of its turns. Raise or clear its spend ceiling in Usage to continue.";
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    const turnClient = {
      transcript: vi.fn(async () => ({ threadId, turns: [workTurn({ status: "completed" })] })),
      startFirstTurn: vi.fn(async () => {
        throw new WorkTurnClientFailure(reason, 409);
      }),
      putAttachment: vi.fn(),
      discardAttachment: vi.fn(async () => undefined),
    };

    render(
      <WorkThreadWorkspace
        hostId={"local" as never}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
        turnClient={turnClient as never}
      />,
    );

    const composer = await screen.findByLabelText("Work prompt");
    await user.type(composer, "one more pass");
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));

    expect(await screen.findByText(reason)).toBeInTheDocument();
    expect(screen.queryByText("The Work turn could not be started.")).not.toBeInTheDocument();
  });

  it("keeps a newer draft when an accepted send has identical text", async () => {
    const user = userEvent.setup();
    const store = createComposerThreadDraftStore(memoryDraftStorage());
    let finish: ((value: ReturnType<typeof workTurn>) => void) | undefined;
    const startFirstTurn = vi.fn(
      () =>
        new Promise<{ kind: "accepted"; turn: ReturnType<typeof workTurn> }>((resolve) => {
          finish = (turn) => resolve({ kind: "accepted", turn });
        }),
    );
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    const turnClient = {
      transcript: vi.fn(async () => ({ threadId, turns: [workTurn({ status: "completed" })] })),
      startFirstTurn,
    };

    render(
      <WorkThreadWorkspace
        draftStore={store}
        hostId={"local" as never}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
        turnClient={turnClient as never}
      />,
    );

    const composer = await screen.findByLabelText("Work prompt");
    await user.type(composer, "same draft");
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));
    store.clear("work", String(threadId));
    store.write("work", String(threadId), {
      text: "same draft",
      caretIndex: 10,
      stagedDropped: false,
    });
    finish?.(workTurn({ status: "accepted", prompt: "same draft" }));

    await waitFor(() => expect(startFirstTurn).toHaveBeenCalledOnce());
    expect(composer).toHaveValue("same draft");
  });

  it("refuses a follow-up when the thread has no binding authority instead of writing an artifact", async () => {
    const user = userEvent.setup();
    const { bindingRevisionId: _omitted, ...unbound } = workThread();
    const threadClient = {
      bootstrap: vi.fn(async () => ({
        threads: [unbound],
      })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    const mutate = vi.fn();
    const startFirstTurn = vi.fn();
    render(
      <WorkThreadWorkspace
        mutationClient={{ mutate } as never}
        providerGroups={[providerGroup()]}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
        turnClient={
          { startFirstTurn, transcript: vi.fn(async () => ({ threadId, turns: [] })) } as never
        }
      />,
    );

    await screen.findByLabelText("Bound provider and model");
    await user.type(screen.getByRole("textbox", { name: "Work prompt" }), "Revise that");
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));

    expect(mutate).not.toHaveBeenCalled();
    expect(startFirstTurn).not.toHaveBeenCalled();
    expect(
      await screen.findByText(/must be rebound before sending a follow-up/),
    ).toBeInTheDocument();
  });

  it("offers a file picker on an existing Work thread that can send images", async () => {
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    render(
      <WorkThreadWorkspace
        providerGroups={[
          {
            ...providerGroup(),
            sections: [
              {
                label: "Models",
                models: [
                  {
                    model: {
                      id: modelId,
                      displayName: "Model One",
                      inputModalities: ["text", "image"],
                    },
                  },
                ],
              },
            ],
          } as never,
        ]}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
        turnClient={{ transcript: vi.fn(async () => ({ threadId, turns: [] })) } as never}
      />,
    );

    await screen.findByLabelText("Bound provider and model");
    expect(screen.getByRole("button", { name: "Add attachment" })).toBeEnabled();
  });

  it("says a text-only model cannot take a pasted image instead of attaching it", async () => {
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    render(
      <WorkThreadWorkspace
        providerGroups={[
          {
            ...providerGroup(),
            sections: [
              {
                label: "Models",
                models: [
                  {
                    model: {
                      id: modelId,
                      displayName: "Model One",
                      inputModalities: ["text"],
                    },
                  },
                ],
              },
            ],
          } as never,
        ]}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
      />,
    );

    await screen.findByLabelText("Bound provider and model");
    const file = new File([new Uint8Array([137, 80, 78])], "pasted.png", { type: "image/png" });
    fireEvent.paste(screen.getByLabelText("Work prompt"), {
      clipboardData: { files: [file], items: [] },
    });
    const attached = await screen.findByLabelText("Attached images");
    expect(attached).toHaveTextContent(
      "The selected model does not accept images. Choose an image-capable model.",
    );
    expect(screen.queryByAltText("pasted.png")).not.toBeInTheDocument();
  });

  it("does not offer @file completion until the host can list the bound root", async () => {
    const user = userEvent.setup();
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    render(
      <WorkThreadWorkspace
        providerGroups={[providerGroup()]}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
      />,
    );
    await screen.findByLabelText("Bound provider and model");
    await user.type(screen.getByLabelText("Work prompt"), "look at @notes");
    expect(
      screen.queryByRole("listbox", { name: "Files you can mention" }),
    ).not.toBeInTheDocument();
  });

  it("restores a Work draft after leaving the thread and remounting", async () => {
    const store = createComposerThreadDraftStore(memoryDraftStorage());
    store.write("work", String(threadId), {
      text: "quarterly notes",
      caretIndex: 9,
      stagedDropped: false,
    });
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;

    const first = render(
      <WorkThreadWorkspace
        draftStore={store}
        providerGroups={[providerGroup()]}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
      />,
    );
    expect(await screen.findByRole("textbox", { name: "Work prompt" })).toHaveValue(
      "quarterly notes",
    );
    first.unmount();

    render(
      <WorkThreadWorkspace
        draftStore={store}
        providerGroups={[providerGroup()]}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
      />,
    );
    const prompt = await screen.findByRole("textbox", { name: "Work prompt" });
    expect(prompt).toHaveValue("quarterly notes");
    expect((prompt as HTMLTextAreaElement).selectionStart).toBe(9);
  });

  it("clears a Work draft so it does not reappear", async () => {
    const store = createComposerThreadDraftStore(memoryDraftStorage());
    store.write("work", String(threadId), {
      text: "artifact body",
      caretIndex: 0,
      stagedDropped: false,
    });
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    const { unmount } = render(
      <WorkThreadWorkspace
        draftStore={store}
        providerGroups={[providerGroup()]}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
      />,
    );
    expect(await screen.findByRole("textbox", { name: "Work prompt" })).toHaveValue(
      "artifact body",
    );
    store.clear("work", String(threadId));
    unmount();

    render(
      <WorkThreadWorkspace
        draftStore={store}
        providerGroups={[providerGroup()]}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
      />,
    );
    expect(await screen.findByRole("textbox", { name: "Work prompt" })).toHaveValue("");
  });

  it("purges a Work draft when the thread is no longer available", async () => {
    const store = createComposerThreadDraftStore(memoryDraftStorage());
    store.write("work", String(threadId), {
      text: "gone with thread",
      caretIndex: 0,
      stagedDropped: false,
    });
    const missing = {
      bootstrap: vi.fn(async () => ({ threads: [] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    const onDisplayReadyChange = vi.fn();
    render(
      <WorkThreadWorkspace
        draftStore={store}
        onDisplayReadyChange={onDisplayReadyChange}
        providerGroups={[providerGroup()]}
        threadClient={missing}
        threadId={threadId}
        title="Draft brief"
      />,
    );
    expect(await screen.findByText("This task is no longer available.")).toBeInTheDocument();
    expect(onDisplayReadyChange).toHaveBeenLastCalledWith(false);
    expect(store.read("work", String(threadId))).toBeUndefined();
  });

  it("shows why Save to Project failed instead of leaving an unhandled rejection", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => {
      throw new Error("disk full");
    });
    const threadClient = {
      bootstrap: vi.fn(async () => ({ threads: [workThread()] })),
      execute: vi.fn(),
    } as unknown as WorkThreadClient;
    render(
      <WorkThreadWorkspace
        imageGenerationClient={
          {
            list: async () => ({ jobs: [completedGeneratedJob()] }),
            artifact: async () => new Blob([Uint8Array.from([1])], { type: "image/png" }),
            save,
          } as never
        }
        imageGenerationProfiles={[imageProfile()]}
        providerGroups={[providerGroup()]}
        threadClient={threadClient}
        threadId={threadId}
        title="Draft brief"
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Save to Project" }));
    expect(await screen.findByText("The image could not be saved.")).toBeVisible();
  });
});

function workTurn(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    threadId,
    turnId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    projectId: "20000000-0000-4000-8000-000000000101",
    authority: {
      hostId: "local",
      projectId: "20000000-0000-4000-8000-000000000101",
      bindingRevisionId: "30000000-0000-4000-8000-000000000101",
      workingDirectory: "research/brief",
      confinementPosture: "project-root-confined",
      providerInstanceId: providerId,
      modelId,
    },
    status: "completed",
    prompt: "Summarize the brief",
    transcript: [
      { role: "user", text: "Summarize the brief" },
      { role: "assistant", text: "Here is the confined summary." },
    ],
    capabilities: {
      workspace: "project-backed",
      confinement: "project-root-confined",
      shell: "denied",
      git: "denied",
      worktree: "denied",
      pullRequest: "denied",
      code: "denied",
    },
    version: 2,
    acceptedAt: "2026-08-01T20:00:00.000Z",
    updatedAt: "2026-08-01T20:01:00.000Z",
    ...overrides,
  };
}

function workThread(overrides: Record<string, unknown> = {}) {
  return decodeWorkThread({
    id: threadId,
    projectId: "20000000-0000-4000-8000-000000000101",
    title: "Draft brief",
    lifecycle: "active",
    providerInstanceId: providerId,
    modelId,
    bindingRevisionId: "30000000-0000-4000-8000-000000000101",
    workingDirectory: "research/brief",
    version: 1,
    createdAt: "2026-08-01T20:00:00.000Z",
    updatedAt: "2026-08-01T20:00:00.000Z",
    ...overrides,
  });
}

function providerGroup(): PickerGroup {
  return {
    driverLabel: "OpenCode",
    endpointHost: "local",
    executionHost: "local",
    instance: { id: providerId, displayName: "Local OpenCode" },
    readiness: "ready",
    sections: [
      {
        label: "Models",
        models: [{ model: { id: modelId, displayName: "Model One" } }],
      },
    ],
  } as never;
}

function memoryDraftStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => {
      data.delete(key);
    },
    setItem: (key, value) => {
      data.set(key, value);
    },
  };
}

function alternateProviderGroup(): PickerGroup {
  return {
    driverLabel: "Remote",
    endpointHost: "remote.example",
    executionHost: "remote",
    instance: { id: alternateProviderId, displayName: "Remote Provider" },
    readiness: "ready",
    sections: [
      {
        label: "Models",
        models: [{ model: { id: alternateModelId, displayName: "Model Two" } }],
      },
    ],
  } as never;
}

function imageProfile() {
  return {
    instanceId: providerId,
    displayName: "OpenAI Image",
    driverKind: "openai-image" as const,
    modelAllowlist: ["gpt-image-2" as never],
    defaultModel: "gpt-image-2" as never,
  };
}

function completedGeneratedJob() {
  const jobId = "a3000000-0000-4000-8000-000000000003";
  return {
    id: jobId,
    status: "completed",
    threadKind: "work-thread",
    scopeId: String(threadId),
    profileInstanceId: providerId,
    modelId: "gpt-image-2",
    promptHash: "a".repeat(64),
    artifacts: [
      {
        attachmentId: "a3000000-0000-4000-8000-000000000010",
        hash: "b".repeat(64),
        size: 1,
        mime: "image/png",
        evidence: {
          profileInstanceId: providerId,
          modelId: "gpt-image-2",
          promptHash: "a".repeat(64),
          jobId,
        },
      },
    ],
    version: 3,
    createdAt: "2026-08-01T20:00:00.000Z",
    updatedAt: "2026-08-01T20:00:00.000Z",
  };
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}
