import { queueTestHost } from "../messageQueue/queueTestHost.test-fixture";
import { decodeThreadMentionCandidate, type ThreadMessageQueueResult } from "@octant/contracts";
import type { ThreadMentionClient } from "@octant/client-runtime";
import {
  decodeCodeAttachmentId,
  decodeCodeRelativePath,
  type CodeApprovalId,
} from "@octant/contracts/code";
import type { PlanClient } from "@octant/client-runtime/plan-client";
import type { CodeBoardCard, CodeBoardView, ThreadPlan } from "@octant/contracts";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { StrictMode, useState, type ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { AgentProfileNamesProvider } from "../agentProfile/AgentProfileNames";
import { ThreadPlanProvider } from "../plan/ThreadPlanContext";
import { CodeThreadWorkspace } from "./CodeThreadWorkspace";
import type { CodeAttachmentClient } from "./CodeThreadWorkspace";
import type { CodeController } from "./useCodeController";
import type { PickerGroup } from "@octant/domain";

const threadId = "10000000-0000-4000-8000-000000000001" as never;
const anotherThreadId = "10000000-0000-4000-8000-000000000002" as never;
const projectId = "30000000-0000-4000-8000-000000000001" as never;
const providerId = "80000000-0000-4000-8000-0000000000a1" as never;
const modelId = "model-one" as never;
const mentionedThreadId = "90000000-0000-4000-8000-000000000001" as never;
const alternateProviderId = "80000000-0000-4000-8000-0000000000a2" as never;
const alternateModelId = "model-two" as never;

describe("Code host queue", () => {
  it.each(["mention resolution", "queue acknowledgment"] as const)(
    "allows a new submission after switching threads during %s",
    async (pendingStep) => {
      const host = queueTestHost();
      const response = Promise.withResolvers<ThreadMessageQueueResult>();
      const resolution =
        Promise.withResolvers<Awaited<ReturnType<ThreadMentionClient["resolve"]>>>();
      const mentions: ThreadMentionClient = {
        search: vi.fn(async () => [
          decodeThreadMentionCandidate({
            threadId: mentionedThreadId,
            mode: "chat",
            title: "Release plan",
            placement: { kind: "recents" },
            updatedAt: "2026-08-15T09:00:00.000Z",
          }),
        ]),
        resolve: vi.fn(() => resolution.promise),
        openSideChat: vi.fn(),
        execute: vi.fn(),
      };
      const attachments: CodeAttachmentClient = {
        putAttachment: vi.fn(async (input) => ({
          attachmentId: input.attachmentId,
          displayName: input.displayName,
          mediaType: input.mediaType,
          byteLength: input.bytes.byteLength,
          digest: "a".repeat(64),
        })),
        discardAttachment: vi.fn(async () => undefined),
        attachment: vi.fn(),
      };
      if (pendingStep === "queue acknowledgment")
        host.execute.mockImplementationOnce(() => response.promise);
      const user = userEvent.setup();
      const { rerender } = render(
        <CodeThreadWorkspace
          messageQueueClient={host}
          threadMentionClient={mentions}
          attachmentClient={attachments}
          controller={controller({ turnStatus: "running" })}
          threadId={threadId}
        />,
      );
      const composer = screen.getByLabelText("Follow-up message");
      if (pendingStep === "mention resolution") {
        await user.type(composer, "#Rel");
        await user.click(await screen.findByRole("option", { name: /Release plan/ }));
      }
      await user.type(composer, "First");
      await user.click(screen.getByRole("button", { name: "Queue message" }));
      if (pendingStep === "mention resolution") expect(mentions.resolve).toHaveBeenCalledOnce();
      else await waitFor(() => expect(host.execute).toHaveBeenCalledOnce());

      const nextController = controller(
        { turnStatus: "running", pendingDraft: "Second" },
        anotherThreadId,
      );
      rerender(
        <CodeThreadWorkspace
          messageQueueClient={host}
          threadMentionClient={mentions}
          attachmentClient={attachments}
          controller={nextController}
          threadId={anotherThreadId}
        />,
      );
      expect(composer).toHaveValue("Second");
      pasteImage(composer, "second.png");
      await screen.findByAltText("second.png");
      await act(async () => {
        if (pendingStep === "mention resolution")
          resolution.resolve({ mentions: [], unavailable: [] });
        else {
          const command = host.execute.mock.calls[0]?.[0];
          if (command === undefined) throw new Error("Expected enqueue");
          response.resolve(host.apply(command));
        }
      });
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Queue message" })).toBeEnabled(),
      );
      expect(screen.getByRole("button", { name: "Remove second.png" })).toBeEnabled();
      expect(composer).toHaveValue("Second");
      expect(nextController.setPendingDraft).not.toHaveBeenCalledWith("");
      const earlierSubmissions = pendingStep === "mention resolution" ? 0 : 1;
      expect(host.execute).toHaveBeenCalledTimes(earlierSubmissions);

      const nextResponse = Promise.withResolvers<ThreadMessageQueueResult>();
      host.execute.mockImplementationOnce(() => nextResponse.promise);
      await user.click(screen.getByRole("button", { name: "Queue message" }));
      await waitFor(() => expect(host.execute).toHaveBeenCalledTimes(earlierSubmissions + 1));
      expect(screen.getByRole("button", { name: "Queue message" })).toBeDisabled();
      expect(screen.getByRole("button", { name: "Remove second.png" })).toBeDisabled();
      await user.click(composer);
      await user.keyboard("{Enter}");
      expect(host.execute).toHaveBeenCalledTimes(earlierSubmissions + 1);
      const command = host.execute.mock.calls[earlierSubmissions]?.[0];
      if (command?.kind !== "enqueue") throw new Error("Expected new thread enqueue");
      expect(command.scope.threadId).toBe(anotherThreadId);
      expect(command.payload.prompt).toBe("Second");
      expect(command.payload.attachmentIds).toHaveLength(1);
      await act(async () => {
        nextResponse.resolve(host.apply(command));
      });
      await waitFor(() => expect(composer).toHaveValue(""));
      expect(screen.queryByAltText("second.png")).not.toBeInTheDocument();
      await user.type(composer, "Third");
      expect(screen.getByRole("button", { name: "Queue message" })).toBeEnabled();
    },
  );

  it("queues multiple messages without sending after a turn finishes", async () => {
    const host = queueTestHost();
    const user = userEvent.setup();
    const sendFollowUp = vi.fn(async () => true);
    const { rerender, unmount } = render(
      <CodeThreadWorkspace
        messageQueueClient={host}
        controller={controller({ sendFollowUp, turnStatus: "running" })}
        threadId={threadId}
      />,
    );
    const composer = screen.getByLabelText("Follow-up message");
    await user.type(composer, "First");
    await user.click(screen.getByRole("button", { name: "Queue message" }));
    await waitFor(() => expect(composer).toHaveValue(""));
    await user.type(composer, "Second");
    expect(host.execute).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Queue message" }));
    expect(await screen.findByRole("button", { name: "2 queued" })).toBeVisible();
    rerender(
      <CodeThreadWorkspace
        messageQueueClient={host}
        controller={controller({ sendFollowUp, turnStatus: "idle" })}
        threadId={threadId}
      />,
    );
    unmount();
    expect(sendFollowUp).not.toHaveBeenCalled();
    expect(host.execute).toHaveBeenCalledTimes(2);
    expect(host.execute.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ mode: "code", prompt: "First" }),
      }),
    );
  });

  it("keeps newer draft attachments across a delayed queue acknowledgment", async () => {
    const host = queueTestHost();
    const response = Promise.withResolvers<ThreadMessageQueueResult>();
    host.execute.mockImplementationOnce(() => response.promise);
    const user = userEvent.setup();
    const attachments: CodeAttachmentClient = {
      putAttachment: vi.fn(async (input) => ({
        attachmentId: input.attachmentId,
        displayName: input.displayName,
        mediaType: input.mediaType,
        byteLength: input.bytes.byteLength,
        digest: "a".repeat(64),
      })),
      discardAttachment: vi.fn(async () => undefined),
      attachment: vi.fn(),
    };
    const { unmount } = render(
      <CodeThreadWorkspace
        messageQueueClient={host}
        attachmentClient={attachments}
        controller={controller({ turnStatus: "running" })}
        threadId={threadId}
      />,
    );
    const composer = screen.getByLabelText("Follow-up message");
    await user.type(composer, "First");
    pasteImage(composer, "first.png");
    await screen.findByAltText("first.png");
    await user.click(screen.getByRole("button", { name: "Queue message" }));
    await waitFor(() => expect(host.execute).toHaveBeenCalledOnce());
    expect(composer).toHaveValue("First");
    await user.clear(composer);
    await user.type(composer, "New draft");
    pasteImage(composer, "later.png");
    await screen.findByAltText("later.png");
    const command = host.execute.mock.calls[0]?.[0];
    if (command === undefined) throw new Error("Expected enqueue");
    await act(async () => {
      response.resolve(host.apply(command));
    });
    expect(composer).toHaveValue("New draft");
    expect(screen.queryByAltText("first.png")).not.toBeInTheDocument();
    expect(screen.getByAltText("later.png")).toBeVisible();
    unmount();
    expect(attachments.discardAttachment).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "releases only captured images after retry refusal with composer closed=%s",
    async (closed) => {
      const host = queueTestHost();
      host.execute.mockRejectedValueOnce(new Error("offline"));
      const response = Promise.withResolvers<ThreadMessageQueueResult>();
      host.execute.mockImplementationOnce(() => response.promise);
      const user = userEvent.setup();
      const attachments: CodeAttachmentClient = {
        putAttachment: vi.fn(async (input) => ({
          attachmentId: input.attachmentId,
          displayName: input.displayName,
          mediaType: input.mediaType,
          byteLength: input.bytes.byteLength,
          digest: "a".repeat(64),
        })),
        discardAttachment: vi.fn(async () => undefined),
        attachment: vi.fn(),
      };
      const { unmount } = render(
        <CodeThreadWorkspace
          messageQueueClient={host}
          attachmentClient={attachments}
          controller={controller({ turnStatus: "running" })}
          threadId={threadId}
        />,
      );
      const composer = screen.getByLabelText("Follow-up message");
      await user.type(composer, "First");
      pasteImage(composer, "first.png");
      await screen.findByAltText("first.png");
      await user.click(screen.getByRole("button", { name: "Queue message" }));
      await screen.findByText(/host has not confirmed/);
      pasteImage(composer, "later.png");
      await screen.findByAltText("later.png");
      await user.click(screen.getByRole("button", { name: "Check queue" }));
      const command = host.execute.mock.calls[0]?.[0];
      if (command?.kind !== "enqueue") throw new Error("Expected enqueue");
      if (closed) unmount();
      await act(async () => {
        response.resolve({ status: "refused", requestId: command.requestId, reason: "queue-full" });
      });
      if (!closed) {
        await user.click(screen.getByRole("button", { name: "Remove first.png" }));
        expect(screen.getByAltText("later.png")).toBeVisible();
      }
      await waitFor(() => expect(attachments.discardAttachment).toHaveBeenCalledOnce());
      expect(attachments.discardAttachment).toHaveBeenCalledWith(
        threadId,
        command.payload.attachmentIds?.[0],
      );
    },
  );

  it("refuses to persist a one-shot access selection in the queue", async () => {
    const host = queueTestHost();
    const user = userEvent.setup();
    render(
      <CodeThreadWorkspace
        messageQueueClient={host}
        controller={controller({ turnStatus: "running" })}
        threadId={threadId}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Next turn access" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Plan · read-only" }));
    await user.type(screen.getByLabelText("Follow-up message"), "Keep this");
    await user.click(screen.getByRole("button", { name: "Queue message" }));
    expect(host.execute).not.toHaveBeenCalled();
    expect(screen.getByText(/one-shot access change cannot be queued/)).toBeVisible();
    expect(screen.getByLabelText("Follow-up message")).toHaveValue("Keep this");
  });

  it("leaves a draft editable when the host queue is unavailable", async () => {
    const user = userEvent.setup();
    const sendFollowUp = vi.fn(async () => true);
    render(
      <CodeThreadWorkspace
        controller={controller({ turnStatus: "running", sendFollowUp })}
        threadId={threadId}
      />,
    );
    await user.type(screen.getByLabelText("Follow-up message"), "Keep this");
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Queue message" })).toBeDisabled();
    expect(sendFollowUp).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Follow-up message")).toHaveValue("Keep this");
  });
});

describe("CodeThreadWorkspace", () => {
  it("shows how long a completed Code turn worked and leaves unsettled turns without a duration", async () => {
    render(
      <CodeThreadWorkspace
        controller={controller({
          conversation: [
            {
              id: "completed",
              role: "assistant",
              text: "The fix is ready.",
              status: "completed",
              startedAt: "2026-09-30T08:00:00.000Z",
              at: "2026-09-30T08:01:12.000Z",
            },
            {
              id: "waiting",
              role: "assistant",
              text: "Waiting for approval.",
              status: "waiting",
              startedAt: "2026-09-30T08:02:00.000Z",
              at: "2026-09-30T08:03:00.000Z",
            },
          ],
        })}
        threadId={threadId}
      />,
    );

    expect(await screen.findByText("Worked for 1m 12s")).toBeVisible();
    expect(screen.getAllByText(/Worked for/)).toHaveLength(1);
  });

  it("re-reads the thread's Canvas cards once a running reply settles", async () => {
    const threadReferenceCards = vi.fn(async () => ({ cards: [] }));
    const reply = (status: "incomplete" | "completed") =>
      controller({
        conversation: [{ id: "reply", role: "assistant", text: "Drafting the plan.", status }],
      });
    const { rerender } = render(
      <CodeThreadWorkspace
        canvasClient={{ threadReferenceCards } as never}
        controller={reply("incomplete")}
        threadId={threadId}
      />,
    );
    await waitFor(() => expect(threadReferenceCards).toHaveBeenCalledTimes(1));
    expect(threadReferenceCards).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "code", threadId: String(threadId) }),
    );

    rerender(
      <CodeThreadWorkspace
        canvasClient={{ threadReferenceCards } as never}
        controller={reply("completed")}
        threadId={threadId}
      />,
    );
    await waitFor(() => expect(threadReferenceCards).toHaveBeenCalledTimes(2));
  });

  it("keeps the starting profile in the access menu, and stays quiet when it has none", async () => {
    const user = userEvent.setup();
    const profileId = "60000000-0000-4000-8000-000000000001";
    const withProfile = controller();
    const { rerender } = render(
      <AgentProfileNamesProvider profiles={[{ id: profileId, displayName: "Reviewer" } as never]}>
        <CodeThreadWorkspace
          controller={
            {
              ...withProfile,
              activeView: {
                ...withProfile.activeView,
                thread: { ...withProfile.activeView!.thread, profileId },
              },
            } as never
          }
          providerGroups={[providerGroup()]}
          threadId={threadId}
        />
      </AgentProfileNamesProvider>,
    );
    expect(screen.queryByText("Reviewer")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next turn access" }));
    expect(await screen.findByText("Started under Reviewer")).toBeVisible();
    await user.keyboard("{Escape}");

    rerender(
      <AgentProfileNamesProvider profiles={[{ id: profileId, displayName: "Reviewer" } as never]}>
        <CodeThreadWorkspace
          controller={controller()}
          providerGroups={[providerGroup()]}
          threadId={threadId}
        />
      </AgentProfileNamesProvider>,
    );
    expect(screen.queryByText("Reviewer")).toBeNull();
  });

  it("keeps the model beside send in a thread, apart from what the person attaches", () => {
    render(
      <CodeThreadWorkspace
        controller={controller()}
        providerGroups={[providerGroup()]}
        threadId={threadId}
      />,
    );
    // A new task's composer already reads attach, space, model, access, send.
    // The thread's composer put the model beside attach, so it changed sides
    // the moment a task became a thread.
    const gap = screen.getByLabelText("Thread context").querySelector(".composer-gap");
    const model = screen.getByRole("button", { name: "Provider and model" });
    const access = screen.getByRole("button", { name: "Next turn access" });
    expect(gap).not.toBeNull();
    const follows = (before: Node, after: Node) =>
      (before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    expect(follows(screen.getByRole("button", { name: "Add attachment" }), gap as Node)).toBe(true);
    expect(follows(gap as Node, model)).toBe(true);
    expect(follows(model, access)).toBe(true);
  });

  it("renders the conversation center and sends follow-ups through the controller", async () => {
    const user = userEvent.setup();
    const sendFollowUp = vi.fn(async () => true);
    const setPendingDraft = vi.fn();
    render(
      <CodeThreadWorkspace
        controller={controller({ sendFollowUp, setPendingDraft })}
        providerGroups={[providerGroup()]}
        threadId={threadId}
      />,
    );

    expect(screen.getByRole("log")).toHaveTextContent(
      "No messages yet. Send a prompt to start this thread.",
    );
    expect(screen.getByRole("button", { name: "Provider and model" })).toBeVisible();
    // Opening a surface is the tab launcher's job, so no row of openers is
    // rendered above the conversation.
    expect(screen.queryByRole("button", { name: "Changes" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Terminal" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Browser" })).not.toBeInTheDocument();

    await user.type(screen.getByLabelText("Follow-up message"), "check tests too");
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));
    expect(sendFollowUp).toHaveBeenCalledWith("check tests too", [], [], [], "approval-gated");
  });

  it("does not offer @Browser in a thread whose provider cannot carry the tool", async () => {
    const user = userEvent.setup();
    const incapable = { ...providerGroup(), appManagedTools: "unsupported" } as never;
    render(
      <CodeThreadWorkspace
        controller={controller()}
        providerGroups={[incapable]}
        threadId={threadId}
        browserAvailable
      />,
    );

    await user.type(screen.getByLabelText("Follow-up message"), "@b");
    expect(screen.queryByRole("option", { name: /Browser/ })).not.toBeInTheDocument();
  });

  it("offers @Browser when the thread's provider can carry app-managed tools", async () => {
    const user = userEvent.setup();
    const capable = { ...providerGroup(), appManagedTools: "supported" } as never;
    render(
      <CodeThreadWorkspace
        controller={controller()}
        providerGroups={[capable]}
        threadId={threadId}
        browserAvailable
      />,
    );

    await user.type(screen.getByLabelText("Follow-up message"), "@b");
    expect(await screen.findByRole("option", { name: /Browser/ })).toBeInTheDocument();
  });

  it("exposes Stop turn while the turn runs and hides it when idle", async () => {
    const user = userEvent.setup();
    const cancelTurn = vi.fn(async () => true);
    const { rerender } = render(
      <CodeThreadWorkspace
        controller={controller({ cancelTurn, turnStatus: "running" })}
        providerGroups={[providerGroup()]}
        threadId={threadId}
      />,
    );

    expect(screen.getByRole("button", { name: "Stop turn" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Stop turn" }));
    expect(cancelTurn).toHaveBeenCalledOnce();

    rerender(
      <CodeThreadWorkspace
        controller={controller({ cancelTurn, turnStatus: "sending" })}
        providerGroups={[providerGroup()]}
        threadId={threadId}
      />,
    );
    expect(screen.getByRole("button", { name: "Stop turn" })).toBeDisabled();

    rerender(
      <CodeThreadWorkspace
        controller={controller({ cancelTurn, turnStatus: "idle" })}
        providerGroups={[providerGroup()]}
        threadId={threadId}
      />,
    );
    expect(screen.queryByRole("button", { name: "Stop turn" })).not.toBeInTheDocument();
  });

  it("keeps the line under the row empty while nothing is running", () => {
    const { container } = render(
      <CodeThreadWorkspace
        controller={controller()}
        providerGroups={[providerGroup()]}
        threadId={threadId}
      />,
    );
    // Idle, the status line says nothing and takes no height; the live
    // region stays mounted so its first announcement is never dropped.
    expect(container.querySelector(".composer-status")).toBeEmptyDOMElement();
  });

  it("keeps new-thread setup hidden while an existing transcript is loading", () => {
    render(
      <CodeThreadWorkspace
        controller={controller({ conversation: [], conversationHistory: "loading" })}
        providerGroups={[providerGroup()]}
        threadId={threadId}
      />,
    );

    expect(screen.getByRole("heading", { name: "Loading conversation" })).toBeVisible();
    expect(screen.getByRole("log")).not.toHaveTextContent(
      "No messages yet. Send a prompt to start this thread.",
    );
    expect(screen.queryByRole("region", { name: "Start a project" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Set up this workspace" })).not.toBeInTheDocument();
  });

  it("shows the prompt a new thread is about to run instead of calling the thread empty", () => {
    const { rerender } = render(
      <CodeThreadWorkspace
        controller={controller({
          conversation: [],
          conversationHistory: "loaded",
          firstPromptInFlight: "Fix the failing test",
        })}
        providerGroups={[providerGroup()]}
        threadId={threadId}
      />,
    );

    expect(screen.getByRole("article", { name: "Your message" })).toHaveTextContent(
      "Fix the failing test",
    );
    expect(
      screen.queryByText("No messages yet. Send a prompt to start this thread."),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Start a project" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Set up this workspace" })).not.toBeInTheDocument();

    // Starting the turn re-reads the transcript. The prompt stays where it is
    // rather than giving way to a loading notice for a message already on screen.
    rerender(
      <CodeThreadWorkspace
        controller={controller({
          conversation: [],
          conversationHistory: "loading",
          firstPromptInFlight: "Fix the failing test",
        })}
        providerGroups={[providerGroup()]}
        threadId={threadId}
      />,
    );
    expect(screen.getByRole("article", { name: "Your message" })).toHaveTextContent(
      "Fix the failing test",
    );
    expect(screen.queryByRole("heading", { name: "Loading conversation" })).not.toBeInTheDocument();
  });

  /**
   * A thread whose history could not be fetched has an empty transcript for a
   * reason that has nothing to do with being new. Showing it the new-thread
   * copy and the project scaffolds invites a user to scaffold a project into a
   * checkout that already holds work, directly under a banner saying the
   * thread's own history is missing.
   */
  it("does not offer new-thread scaffolding to a thread whose history could not be loaded", () => {
    render(
      <CodeThreadWorkspace
        controller={controller({
          conversation: [],
          conversationHistory: "unavailable",
          turnError: "Conversation history could not be loaded.",
        })}
        providerGroups={[providerGroup()]}
        threadId={threadId}
      />,
    );

    expect(screen.getByRole("log")).not.toHaveTextContent(
      "No messages yet. Send a prompt to start this thread.",
    );
    expect(screen.queryByRole("region", { name: "Start a project" })).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Set up this workspace" })).not.toBeInTheDocument();
  });

  it("offers a retry beside the unloadable-history notice and keeps the composer usable", async () => {
    const user = userEvent.setup();
    const retry = vi.fn();
    render(
      <CodeThreadWorkspace
        controller={controller({
          conversation: [],
          conversationHistory: "unavailable",
          retry,
          turnError: "Conversation history could not be loaded.",
        })}
        providerGroups={[providerGroup()]}
        threadId={threadId}
      />,
    );

    // The notice and the way out sit together; an ordinary turn error carries
    // no retry, so the control appears only while history is unreachable.
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Conversation history could not be loaded.",
    );
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
    // The thread itself is live even without its history.
    expect(screen.getByLabelText("Follow-up message")).toBeEnabled();
  });

  it("keeps a failed turn's reason out of the callout once the transcript carries it", () => {
    render(
      <CodeThreadWorkspace
        controller={controller({
          turnStatus: "failed",
          turnError: "The provider turn failed.",
          turnErrorInTranscript: true,
        })}
        threadId={threadId}
      />,
    );

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps an interrupted turn's reason out of the callout once the transcript carries it", () => {
    render(
      <CodeThreadWorkspace
        controller={controller({
          turnStatus: "interrupted",
          turnError: "The provider turn was interrupted.",
          turnErrorInTranscript: true,
        })}
        threadId={threadId}
      />,
    );

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("keeps a refused send's reason visible when no failed turn reached the transcript", () => {
    // A send the host refuses before any turn exists adds no transcript row,
    // so this callout is the only place its reason is ever read.
    render(
      <CodeThreadWorkspace
        controller={controller({
          turnStatus: "failed",
          turnError: "The provider refused the turn.",
          turnErrorInTranscript: false,
        })}
        threadId={threadId}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("The provider refused the turn.");
  });

  it("carries a refused start's warning in a status mark and tint, not a coloured edge stripe", () => {
    const { container } = render(
      <CodeThreadWorkspace
        controller={controller({
          turnStatus: "failed",
          turnError:
            "This provider cannot carry Octant's Browser tool. Check the provider's connection in Settings, then retry without the Browser selection.",
          turnErrorInTranscript: false,
        })}
        threadId={threadId}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("This provider cannot carry Octant's Browser tool.");
    // The mark says warning without reading the colour: an icon sits with the
    // sentence, and the sentence keeps the secondary body role the recipe owns.
    expect(alert.querySelector("svg.lucide-circle-alert")).not.toBeNull();
    // A tinted ground plus hairline is the system's warning language; the
    // saturated stripe on the left edge made this read as a generic AI chat
    // warning box instead of one of the thread's own notices.
    expect(alert.className).not.toMatch(/callout-warn/);
    expect(container.querySelector(".code-thread-workspace__callout")).not.toBeNull();
  });

  it("records a failed limited stop without offering recovery that can only refuse", () => {
    render(
      <CodeThreadWorkspace
        controller={controller({
          turnStatus: "failed",
          turnUsageLimit: {
            kind: "temporary",
            resetsAt: new Date(Date.now() + 10 * 60_000).toISOString(),
          },
          latestProviderTurnOperationId: "op-1",
        } as never)}
        threadId={threadId}
      />,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("temporary rate limit");
    expect(
      screen.queryByRole("button", { name: "Resume when the limit resets" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Snooze until reset" })).not.toBeInTheDocument();
  });

  it("keeps the retry control off an ordinary turn error", () => {
    render(
      <CodeThreadWorkspace
        controller={controller({ turnError: "The provider refused the turn." })}
        threadId={threadId}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("The provider refused the turn.");
    expect(screen.queryByRole("button", { name: "Retry" })).not.toBeInTheDocument();
  });

  it("shows a waiting turn as compact status that says what it waits on", () => {
    render(
      <CodeThreadWorkspace
        controller={controller({
          turnStatus: "waiting",
          turnError: "Provider completed with unresolved checkout reconciliation.",
        })}
        threadId={threadId}
      />,
    );

    // No approval or question is open, so the host's own reason is the only
    // true thing to say; "waiting for approval" here sent people looking for
    // a button that did not exist.
    const status = screen
      .getByText("Waiting · Provider completed with unresolved checkout reconciliation.")
      .closest('[role="status"]');
    expect(status).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("folds inline reasoning in Code history while leaving the answer readable", async () => {
    render(
      <CodeThreadWorkspace
        controller={controller({
          conversation: [
            {
              id: "reply",
              role: "assistant",
              text: "<think>Check the two sources.</think>Here is the answer.",
              status: "completed",
            },
          ],
        })}
        threadId={threadId}
      />,
    );
    expect(screen.getByText("Here is the answer.")).toBeVisible();
    const thinking = screen.getByText("Thinking").closest("details");
    expect(thinking).not.toHaveAttribute("open");
    await userEvent.click(screen.getByText("Thinking"));
    expect(thinking).toHaveAttribute("open");
    expect(screen.getByText("Check the two sources.")).toBeVisible();
    await userEvent.click(screen.getByText("Thinking"));
    expect(thinking).not.toHaveAttribute("open");
  });

  it("ends a reply with the files that changed while its turn ran", () => {
    render(
      <CodeThreadWorkspace
        controller={controller({
          conversation: [
            {
              id: "reply",
              role: "assistant",
              text: "Added the helper.",
              status: "completed",
              changedFiles: {
                files: [
                  { path: decodeCodeRelativePath("src/helper.ts"), insertions: 12, deletions: 0 },
                ],
                total: 1,
                truncated: false,
              },
            },
            { id: "plain", role: "assistant", text: "Nothing to change.", status: "completed" },
          ],
        })}
        threadId={threadId}
      />,
    );

    // One card, on the turn that has a record; a turn without one shows none
    // rather than an empty card that would read as "nothing changed".
    const cards = screen.getAllByRole("region", { name: "Files changed while this ran" });
    expect(cards).toHaveLength(1);
    expect(cards[0]).toHaveTextContent("1 file changed while this ran");
    expect(cards[0]).toHaveTextContent("src/helper.ts");
    const reply = screen.getByText("Added the helper.");
    expect(
      reply.compareDocumentPosition(cards[0] as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it("reads a plan the assistant wrote as a plan, not as one long line", () => {
    render(
      <CodeThreadWorkspace
        controller={controller({
          conversation: [
            { id: "turn-1:user", role: "user" as const, text: "## Not a heading, I typed this" },
            {
              id: "turn-1:assistant",
              role: "assistant" as const,
              text: "## Plan\n\n1. Reproduce the gap\n2. Fix the projection\n",
              status: "completed" as const,
            },
          ],
        })}
        providerGroups={[providerGroup()]}
        threadId={threadId}
      />,
    );

    expect(screen.getByRole("heading", { name: "Plan" })).toBeVisible();
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toContain(
      "Reproduce the gap",
    );
    // What the user typed is what the user typed.
    expect(screen.getByText("## Not a heading, I typed this")).toBeVisible();
  });

  it("restores the checkout to a message's checkpoint only after a confirmation and an approval", async () => {
    const user = userEvent.setup();
    const executeOperation = vi.fn(async () => ({
      kind: "git-mutation-state" as const,
      state: "completed" as const,
    }));
    const requestApproval = vi.fn(async () => undefined);
    const conversation = [
      { id: "turn-1:user", role: "user" as const, text: "rewrite the parser", checkpoint },
      { id: "turn-1:assistant", role: "assistant" as const, text: "done" },
    ];
    const { rerender } = render(
      <CodeThreadWorkspace
        controller={controller({ conversation } as never)}
        nextUuid={() => "30000000-0000-4000-8000-000000000001"}
        operationClient={{ executeOperation } as never}
        requestApproval={requestApproval}
        threadId={threadId}
      />,
    );

    // The assistant reply carries no checkout snapshot, so only the message
    // that started the turn offers to put the files back.
    await chooseTurnAction(user, "Restore files to this point", "rewrite the parser");
    await user.click(screen.getByRole("button", { name: "Restore files" }));

    // This thread decides effects by approval, and the approval was declined:
    // nothing may reach the checkout.
    expect(requestApproval).toHaveBeenCalledOnce();
    expect(executeOperation).not.toHaveBeenCalled();
    expect(screen.getByText("The files were not restored. Nothing changed.")).toBeVisible();

    requestApproval.mockResolvedValue("40000000-0000-4000-8000-000000000001" as never);
    rerender(
      <CodeThreadWorkspace
        controller={controller({ conversation } as never)}
        nextUuid={() => "30000000-0000-4000-8000-000000000001"}
        operationClient={{ executeOperation } as never}
        requestApproval={requestApproval}
        threadId={threadId}
      />,
    );
    await chooseTurnAction(user, "Restore files to this point", "rewrite the parser");
    await user.click(screen.getByRole("button", { name: "Restore files" }));

    await waitFor(() =>
      expect(executeOperation).toHaveBeenCalledWith(
        expect.objectContaining({ kind: "restore-git-checkpoint", checkpoint }),
      ),
    );
    expect(screen.getByText("Files restored to this point.")).toBeVisible();
  });

  it("keeps the checkpoint a restore replaced reachable after a tab switch unmounts this surface", async () => {
    const user = userEvent.setup();
    const undo = { worktree: "e".repeat(40), index: "f".repeat(40) };
    const executeOperation = vi.fn(async () => ({
      kind: "git-mutation-state" as const,
      state: "completed" as const,
      undo,
    }));
    const conversation = [
      { id: "turn-1:user", role: "user" as const, text: "rewrite the parser", checkpoint },
    ];
    // The undo point belongs to the controller, which outlives this surface;
    // opening another tab unmounts the surface exactly like this.
    function Harness(props: { readonly open: boolean }) {
      const [restoreUndo, noteRestoreUndo] = useState<unknown>();
      if (!props.open) return <p>Another tab</p>;
      return (
        <CodeThreadWorkspace
          controller={controller({ conversation, restoreUndo, noteRestoreUndo } as never)}
          nextUuid={() => "30000000-0000-4000-8000-000000000001"}
          operationClient={{ executeOperation } as never}
          requestApproval={vi.fn(async () => "40000000-0000-4000-8000-000000000001" as never)}
          threadId={threadId}
        />
      );
    }
    const { rerender } = render(<Harness open />);

    await chooseTurnAction(user, "Restore files to this point", "rewrite the parser");
    await user.click(screen.getByRole("button", { name: "Restore files" }));
    await waitFor(() => expect(screen.getByText("Files restored to this point.")).toBeVisible());
    // The host returned what it replaced, so the destructive overwrite is
    // reachable rather than stranded.
    expect(await screen.findByRole("button", { name: "Undo restore" })).toBeVisible();

    rerender(<Harness open={false} />);
    expect(screen.queryByRole("button", { name: "Undo restore" })).toBeNull();
    rerender(<Harness open />);

    // The sentence the restore printed went with the surface that printed it.
    // The way back did not, so returning to the thread still finds it.
    await user.click(await screen.findByRole("button", { name: "Undo restore" }));
    await waitFor(() =>
      expect(executeOperation).toHaveBeenLastCalledWith(
        expect.objectContaining({ kind: "restore-git-checkpoint", checkpoint: undo }),
      ),
    );
    expect(screen.getByText("The restore was undone.")).toBeVisible();
  });

  it("dates each turn from the moment the journal recorded it", async () => {
    const at = new Date();
    at.setHours(9, 14, 0, 0);
    const conversation = [
      {
        id: "turn-1:user",
        role: "user" as const,
        text: "rewrite the parser",
        at: at.toISOString(),
      },
      {
        id: "turn-1:assistant",
        role: "assistant" as const,
        text: "done",
        operationId: "50000000-0000-4000-8000-000000000001",
        status: "completed" as const,
        at: new Date(at.getTime() + 60_000).toISOString(),
      },
    ];
    render(
      <CodeThreadWorkspace
        controller={controller({ conversation } as never)}
        threadId={threadId}
      />,
    );

    const expected = at.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    const stamps = await screen.findAllByText(expected);
    expect(stamps.length).toBeGreaterThan(0);
    expect(stamps[0]).toHaveAttribute("datetime", at.toISOString());
  });

  it("forks a new thread from a finished answer and opens it, leaving this one alone", async () => {
    const user = userEvent.setup();
    const forkThread = vi.fn(async () => ({
      id: "10000000-0000-4000-8000-0000000000aa",
      title: "find bugs in this repo (fork)",
      projectId: "10000000-0000-4000-8000-0000000000bb",
    }));
    const onOpenCodeThread = vi.fn();
    const conversation = [
      { id: "turn-1:user", role: "user" as const, text: "rewrite the parser" },
      {
        id: "turn-1:assistant",
        role: "assistant" as const,
        text: "done",
        operationId: "50000000-0000-4000-8000-000000000001",
        status: "completed" as const,
      },
      // A turn still running has no answer to branch from yet.
      {
        id: "turn-2:assistant",
        role: "assistant" as const,
        text: "working",
        operationId: "50000000-0000-4000-8000-000000000002",
        status: "incomplete" as const,
      },
    ];
    render(
      <CodeThreadWorkspace
        controller={controller({ conversation, forkThread } as never)}
        onOpenCodeThread={onOpenCodeThread}
        threadId={threadId}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Fork from here" }));

    await waitFor(() =>
      expect(forkThread).toHaveBeenCalledWith({
        threadId,
        throughOperationId: "50000000-0000-4000-8000-000000000001",
        title: "find bugs in this repo (fork)",
      }),
    );
    expect(onOpenCodeThread).toHaveBeenCalledWith(
      "10000000-0000-4000-8000-0000000000aa",
      "find bugs in this repo (fork)",
      "10000000-0000-4000-8000-0000000000bb",
    );
  });

  it("says why the host refused the fork instead of opening a thread that was never created", async () => {
    const user = userEvent.setup();
    const onOpenCodeThread = vi.fn();
    render(
      <CodeThreadWorkspace
        controller={controller({
          conversation: [
            {
              id: "turn-1:assistant",
              role: "assistant" as const,
              text: "done",
              operationId: "50000000-0000-4000-8000-000000000001",
              status: "completed" as const,
            },
          ],
          forkThread: vi.fn(async () => undefined),
          lastExecuteError: {
            current: { category: "conflict", message: "Fork from a reply that has finished." },
          },
        } as never)}
        onOpenCodeThread={onOpenCodeThread}
        threadId={threadId}
      />,
    );

    await chooseTurnAction(user, "Fork from here", "done");
    expect(
      await screen.findByText("Fork from a reply that has finished. This thread is unchanged."),
    ).toBeVisible();
    expect(onOpenCodeThread).not.toHaveBeenCalled();
  });

  it("shows the provider's own token, cost, and usage-window figures", () => {
    render(
      <CodeThreadWorkspace
        controller={controller({
          threadUsage: {
            inputTokens: 12_400,
            outputTokens: 3_100,
            costUsd: 0.42,
            limits: [
              { window: "five_hour", status: "warning", utilization: 0.87 },
              { window: "seven_day", status: "allowed", utilization: 0.12 },
            ],
          },
        } as never)}
        threadId={threadId}
      />,
    );

    // Spend lives in the context meter's panel, not on the strip. A limit is
    // shown once it is worth acting on; a healthy one stays in the panel so
    // the strip does not list every window a provider has.
    expect(screen.queryByText(/12\.4k in/)).not.toBeInTheDocument();
    // The limit no longer spells itself out under the composer; the context
    // meter's ring carries the alert and its panel carries the figures.
    expect(screen.queryByText(/5-hour limit/)).not.toBeInTheDocument();
    expect(screen.queryByText(/7-day limit/)).not.toBeInTheDocument();
  });

  it("shows no spend for a provider that has reported nothing, and never a free thread", () => {
    render(<CodeThreadWorkspace controller={controller()} threadId={threadId} />);

    // Zero tokens with no report is not the same as a thread that cost
    // nothing: the strip says nothing rather than "$0.00" or a sentence about it.
    expect(screen.queryByText(/\$0/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Enter to send/)).not.toBeInTheDocument();
  });

  it("keeps the restore control off a thread that cannot change the checkout", async () => {
    const conversation = [
      { id: "turn-1:user", role: "user" as const, text: "rewrite the parser", checkpoint },
    ];
    const plan = controller({ conversation } as never);
    render(
      <CodeThreadWorkspace
        controller={
          {
            ...plan,
            activeView: {
              ...plan.activeView,
              thread: { ...plan.activeView!.thread, executionPolicy: "plan" },
            },
          } as never
        }
        nextUuid={() => "30000000-0000-4000-8000-000000000001"}
        operationClient={{ executeOperation: vi.fn() } as never}
        requestApproval={vi.fn()}
        threadId={threadId}
      />,
    );

    await userEvent.click(
      within(turnArticle("rewrite the parser")).getByRole("button", { name: "More actions" }),
    );
    expect(
      screen.queryByRole("menuitemradio", { name: "Restore files to this point" }),
    ).not.toBeInTheDocument();
  });

  it("names putting files back separately from restoring a checkpoint", async () => {
    const user = userEvent.setup();
    render(
      <CodeThreadWorkspace
        controller={controller({
          conversation: [
            { id: "turn-1:user", role: "user" as const, text: "rewrite the parser", checkpoint },
          ],
        } as never)}
        nextUuid={() => "30000000-0000-4000-8000-000000000001"}
        operationClient={{ executeOperation: vi.fn() } as never}
        requestApproval={vi.fn()}
        threadId={threadId}
      />,
    );

    await user.click(
      within(turnArticle("rewrite the parser")).getByRole("button", { name: "More actions" }),
    );
    expect(
      await screen.findByRole("menuitemradio", { name: "Restore files to this point" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("menuitemradio", { name: "Restore from here" }),
    ).not.toBeInTheDocument();
  });

  it("opens the `#` picker in the Code composer and sends the chip as an id", async () => {
    const user = userEvent.setup();
    const sendFollowUp = vi.fn(async (_prompt: string) => true);
    const search = vi.fn(async () => [
      {
        threadId: mentionedThreadId,
        mode: "chat" as const,
        title: "Release notes",
        placement: { kind: "unfiled" as const },
        updatedAt: "2026-08-15T09:00:00.000Z" as never,
      },
    ]);
    const resolve = vi.fn(async () => ({
      mentions: [
        {
          threadId: mentionedThreadId,
          mode: "chat" as const,
          title: "Release notes",
          placement: { kind: "unfiled" as const },
          transcript: [
            {
              role: "user" as const,
              text: "ship on Friday",
              occurredAt: "2026-08-15T09:00:00.000Z" as never,
            },
          ],
          truncated: false,
        },
      ],
      unavailable: [],
    }));
    render(
      <CodeThreadWorkspace
        controller={controller({ sendFollowUp })}
        threadMentionClient={{ search, resolve, openSideChat: vi.fn(), execute: vi.fn() } as never}
        threadId={threadId}
      />,
    );

    const composer = screen.getByLabelText("Follow-up message");
    await user.type(composer, "#Rel");
    const hit = await screen.findByRole("option", { name: /Release notes/ });
    await user.click(hit);
    expect(screen.getByLabelText("Mentioned threads")).toHaveTextContent("Release notes");

    await user.type(composer, "does this still hold?");
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));

    expect(resolve).toHaveBeenCalledWith(expect.anything(), [mentionedThreadId]);
    // The chip travels as an id. The message the host journals — and the
    // conversation and every later turn read back — is the user's own words,
    // so nothing the mention contributed can be replayed.
    expect(sendFollowUp).toHaveBeenCalledWith(
      "#[Release notes] does this still hold?",
      [mentionedThreadId],
      [],
      [],
      "approval-gated",
    );
  });

  it("completes an `@` path from the checkout listing the host returned", async () => {
    const user = userEvent.setup();
    const sendFollowUp = vi.fn(async () => true);
    const list = vi.fn(async () => ({
      status: "listed" as const,
      listing: {
        kind: "code-file-listing" as const,
        threadId,
        checkoutId: "20000000-0000-4000-8000-000000000002" as never,
        entries: [
          { kind: "directory" as const, path: "src" as never },
          {
            kind: "file" as const,
            fileId: "file_" + "a".repeat(59),
            path: "src/index.ts" as never,
            byteLength: 12,
            availability: { status: "available" as const },
          },
        ],
        truncated: false,
        observedAt: "2026-08-16T09:00:00.000Z" as never,
      },
    }));
    render(
      <CodeThreadWorkspace
        controller={controller({ sendFollowUp })}
        fileListingClient={{ list } as never}
        threadId={threadId}
      />,
    );

    const composer = screen.getByLabelText("Follow-up message");
    // Nothing is listed until a mention is actually opened.
    expect(list).not.toHaveBeenCalled();
    await user.type(composer, "explain @ind");

    const hit = await screen.findByRole("option", { name: /src\/index\.ts/ });
    await user.click(hit);
    expect(composer).toHaveValue("explain @src/index.ts ");

    await user.type(composer, "please");
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));
    expect(sendFollowUp).toHaveBeenCalledWith(
      "explain @src/index.ts please",
      [],
      [],
      ["src/index.ts"],
      "approval-gated",
    );
  });

  it("uploads a pasted image before the turn and sends it by the host's own reference", async () => {
    const user = userEvent.setup();
    const sendFollowUp = vi.fn(async () => true);
    const reference = {
      attachmentId: "40000000-0000-4000-8000-000000000001",
      // The host decides the name it kept; the composer shows that one back.
      displayName: "pasted.png",
      mediaType: "image/png" as const,
      byteLength: 3,
      digest: "b".repeat(64),
    };
    const putAttachment = vi.fn(async () => reference);
    const discardAttachment = vi.fn(async () => undefined);
    render(
      <CodeThreadWorkspace
        attachmentClient={{ putAttachment, discardAttachment, attachment: vi.fn() } as never}
        controller={controller({ sendFollowUp })}
        threadId={threadId}
      />,
    );

    const composer = screen.getByLabelText("Follow-up message");
    await user.type(composer, "match this mockup");
    pasteImage(composer);

    expect(await screen.findByAltText("pasted.png")).toBeInTheDocument();
    expect(putAttachment).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Send follow-up" }));
    // The turn names what the host answered with, never bytes the composer held.
    expect(sendFollowUp).toHaveBeenCalledWith(
      "match this mockup",
      [],
      [reference],
      [],
      "approval-gated",
    );
    // Sending is not a discard: the image belongs to the turn that carried it.
    expect(discardAttachment).not.toHaveBeenCalled();
  });

  it("uploads an image chosen from the composer before the turn and sends it by the host's own reference", async () => {
    const user = userEvent.setup();
    const sendFollowUp = vi.fn(async () => true);
    const reference = {
      attachmentId: decodeCodeAttachmentId("40000000-0000-4000-8000-000000000001"),
      // The host decides the name it kept; the composer shows that one back.
      displayName: "pasted.png",
      mediaType: "image/png" as const,
      byteLength: 3,
      digest: "b".repeat(64),
    };
    const putAttachment = vi.fn(async () => reference);
    const discardAttachment = vi.fn(async () => undefined);
    render(
      <CodeThreadWorkspace
        attachmentClient={{ putAttachment, discardAttachment, attachment: vi.fn() }}
        controller={controller({ sendFollowUp })}
        threadId={threadId}
      />,
    );

    const composer = screen.getByLabelText("Follow-up message");
    await user.type(composer, "match this mockup");
    expect(screen.getByRole("button", { name: "Add attachment" })).toBeEnabled();
    await user.upload(
      screen.getByLabelText("Choose attachment file"),
      new File(["png"], "pasted.png", { type: "image/png" }),
    );

    expect(await screen.findByAltText("pasted.png")).toBeInTheDocument();
    expect(putAttachment).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: "Send follow-up" }));
    // The turn names what the host answered with, never bytes the composer held.
    expect(sendFollowUp).toHaveBeenCalledWith(
      "match this mockup",
      [],
      [reference],
      [],
      "approval-gated",
    );
    // Sending is not a discard: the image belongs to the turn that carried it.
    expect(discardAttachment).not.toHaveBeenCalled();
  });

  it("keeps the image chips when the host refuses the send so the turn can be retried", async () => {
    const user = userEvent.setup();
    const sendFollowUp = vi.fn(async () => false);
    const reference = {
      attachmentId: "40000000-0000-4000-8000-000000000003",
      displayName: "pasted.png",
      mediaType: "image/png" as const,
      byteLength: 3,
      digest: "c".repeat(64),
    };
    render(
      <CodeThreadWorkspace
        attachmentClient={
          {
            putAttachment: vi.fn(async () => reference),
            discardAttachment: vi.fn(),
            attachment: vi.fn(),
          } as never
        }
        controller={controller({ sendFollowUp })}
        threadId={threadId}
      />,
    );

    const composer = screen.getByLabelText("Follow-up message");
    await user.type(composer, "match this mockup");
    pasteImage(composer);
    expect(await screen.findByAltText("pasted.png")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send follow-up" }));
    expect(sendFollowUp).toHaveBeenCalledWith(
      "match this mockup",
      [],
      [reference],
      [],
      "approval-gated",
    );
    // The refused turn leaves both the text and its image in the composer.
    expect(screen.getByAltText("pasted.png")).toBeInTheDocument();
    expect(composer).toHaveValue("match this mockup");
  });

  it("says a text-only model cannot take the image instead of uploading it", async () => {
    const putAttachment = vi.fn();
    render(
      <CodeThreadWorkspace
        attachmentClient={
          { putAttachment, discardAttachment: vi.fn(), attachment: vi.fn() } as never
        }
        controller={controller({ sendFollowUp: vi.fn(async () => true) })}
        providerGroups={[textOnlyProviderGroup()]}
        threadId={threadId}
      />,
    );

    pasteImage(screen.getByLabelText("Follow-up message"));

    const attached = await screen.findByLabelText("Attached images");
    expect(within(attached).getByRole("status")).toHaveTextContent(
      "Local OpenCode — Model One does not support images. Choose a vision model to attach one.",
    );
    // Nothing is uploaded for a turn the host would refuse anyway.
    expect(putAttachment).not.toHaveBeenCalled();
  });

  it("takes back a removed image on the host as well as in the composer", async () => {
    const user = userEvent.setup();
    const sendFollowUp = vi.fn(async () => true);
    const reference = {
      attachmentId: "40000000-0000-4000-8000-000000000002",
      displayName: "pasted.png",
      mediaType: "image/png" as const,
      byteLength: 3,
      digest: "c".repeat(64),
    };
    const discardAttachment = vi.fn(async () => undefined);
    render(
      <CodeThreadWorkspace
        attachmentClient={
          {
            putAttachment: vi.fn(async () => reference),
            discardAttachment,
            attachment: vi.fn(),
          } as never
        }
        controller={controller({ sendFollowUp })}
        threadId={threadId}
      />,
    );

    const composer = screen.getByLabelText("Follow-up message");
    await user.type(composer, "never mind the picture");
    pasteImage(composer);
    await user.click(await screen.findByRole("button", { name: "Remove pasted.png" }));

    expect(screen.queryByAltText("pasted.png")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(discardAttachment).toHaveBeenCalledWith(threadId, reference.attachmentId),
    );
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));
    expect(sendFollowUp).toHaveBeenCalledWith(
      "never mind the picture",
      [],
      [],
      [],
      "approval-gated",
    );
  });

  it("leaves an `@` that matches no file in this checkout as ordinary text", async () => {
    const user = userEvent.setup();
    const list = vi.fn(async () => ({
      status: "listed" as const,
      listing: {
        kind: "code-file-listing" as const,
        threadId,
        checkoutId: "20000000-0000-4000-8000-000000000002" as never,
        entries: [],
        truncated: false,
        observedAt: "2026-08-16T09:00:00.000Z" as never,
      },
    }));
    render(
      <CodeThreadWorkspace
        controller={controller()}
        fileListingClient={{ list } as never}
        threadId={threadId}
      />,
    );

    await user.type(screen.getByLabelText("Follow-up message"), "mail henrik@ogard.no");
    expect(
      screen.queryByRole("listbox", { name: "Files you can mention" }),
    ).not.toBeInTheDocument();
    expect(list).not.toHaveBeenCalled();
  });

  it("keeps a failed follow-up in the composer so it can be retried", async () => {
    const user = userEvent.setup();
    const sendFollowUp = vi.fn(async () => false);
    render(<CodeThreadWorkspace controller={controller({ sendFollowUp })} threadId={threadId} />);

    const composer = screen.getByLabelText("Follow-up message");
    await user.type(composer, "keep this prompt");
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));

    expect(sendFollowUp).toHaveBeenCalledWith("keep this prompt", [], [], [], "approval-gated");
    expect(composer).toHaveValue("keep this prompt");
  });

  it("keeps post-preview Canvas tools out of the live thread toolbar", () => {
    render(
      <CodeThreadWorkspace
        canvasClient={{ threadReferenceCards: async () => ({ cards: [] }) } as never}
        controller={controller()}
        threadId={threadId}
      />,
    );

    expect(screen.queryByRole("button", { name: "Canvas" })).not.toBeInTheDocument();
  });

  it("leaves Agents and Export to the dock and the thread's own row menu", () => {
    render(
      <CodeThreadWorkspace
        controller={controller()}
        serverUrl="http://127.0.0.1:4317"
        threadId={threadId}
      />,
    );

    expect(screen.queryByRole("button", { name: "Agents" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Export thread" })).not.toBeInTheDocument();
  });

  it("keeps the transcript top-aligned like a conversation instead of bottom-anchoring it", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles/code.css"), "utf8");
    expect(styles).toMatch(/\.code-thread-workspace__transcript\s*\{[^}]*margin:\s*0 auto;/);
    expect(styles).not.toMatch(
      /\.code-thread-workspace__transcript\s*\{[^}]*margin:\s*auto auto 0;/,
    );
  });

  it("saves reasoning for an existing Code thread through the authoritative command", async () => {
    const user = userEvent.setup();
    const execute = vi.fn(async () => undefined);
    const group = providerGroup();
    const reasoningGroup = {
      ...group,
      sections: group.sections.map((section) => ({
        ...section,
        models: section.models.map((entry) => ({
          ...entry,
          model: {
            ...entry.model,
            options: [
              {
                id: "effort",
                displayName: "Effort",
                kind: "selection" as const,
                values: ["low", "high"] as const,
              },
            ],
          },
        })),
      })),
    };
    const { rerender } = render(
      <CodeThreadWorkspace
        controller={controller({ execute })}
        providerGroups={[reasoningGroup]}
        threadId={threadId}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    const levels = screen.getByRole("slider", { name: "Effort level" });
    fireEvent.change(levels, { target: { value: levels.getAttribute("max") } });
    expect(execute).toHaveBeenCalledWith({
      kind: "change-code-thread-provider",
      threadId,
      expectedVersion: 1,
      providerInstanceId: providerId,
      modelId,
      modelOptionValues: { effort: "high" },
    });
    const refreshed = controller({ execute });
    if (refreshed.activeView === undefined) throw new Error("Expected active thread");
    rerender(
      <CodeThreadWorkspace
        controller={{
          ...refreshed,
          activeView: {
            ...refreshed.activeView,
            thread: { ...refreshed.activeView.thread, modelOptionValues: { effort: "high" } },
          },
        }}
        providerGroups={[reasoningGroup]}
        threadId={threadId}
      />,
    );
    fireEvent.change(levels, { target: { value: "0" } });
    await waitFor(() =>
      expect(execute).toHaveBeenLastCalledWith(expect.objectContaining({ modelOptionValues: {} })),
    );
  });

  it("offers a started thread only the models its next turn will accept", async () => {
    const user = userEvent.setup();
    const execute = vi.fn(async () => undefined) as CodeController["execute"];
    const switching = providerGroup();
    const firstSection = switching.sections[0];
    if (firstSection === undefined) throw new Error("Expected a section.");
    const canSwitch = {
      ...switching,
      modelSwitch: "supported",
      sections: [
        {
          ...firstSection,
          models: [
            ...firstSection.models,
            { model: { id: "model-three", displayName: "Model Three" } },
          ],
        },
      ],
    } as never as PickerGroup;
    const answered = [
      { id: "reply", role: "assistant" as const, text: "Done.", status: "completed" as const },
    ];
    const { rerender } = render(
      <CodeThreadWorkspace
        controller={controller({ execute, conversation: answered })}
        providerGroups={[canSwitch, alternateProviderGroup()]}
        threadId={threadId}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    // The conversation lives in this provider's session, so another provider
    // is never offered; another of its models is, because it can carry over.
    expect(screen.queryByRole("option", { name: "Remote Provider" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Model Two" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Model Three" }));
    expect(execute).toHaveBeenCalledWith({
      kind: "change-code-thread-provider",
      threadId,
      expectedVersion: 1,
      providerInstanceId: providerId,
      modelId: "model-three",
    });

    await user.keyboard("{Escape}");
    rerender(
      <CodeThreadWorkspace
        controller={controller({ execute, conversation: answered })}
        providerGroups={[{ ...canSwitch, modelSwitch: "unsupported" }, alternateProviderGroup()]}
        threadId={threadId}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    expect(screen.queryByRole("option", { name: "Model Three" })).not.toBeInTheDocument();
  });

  it("keeps every provider for a thread whose first turn never reached its provider", async () => {
    const user = userEvent.setup();
    render(
      <CodeThreadWorkspace
        controller={controller()}
        providerGroups={[providerGroup(), alternateProviderGroup()]}
        threadId={threadId}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Provider and model" }));
    expect(screen.getByRole("option", { name: "Remote Provider" })).toBeInTheDocument();
  });

  it("shows the next turn's access and sends a narrower posture with the message", async () => {
    const user = userEvent.setup();
    const sendFollowUp = vi.fn(async () => true);
    const execute = vi.fn(async () => undefined) as CodeController["execute"];
    render(
      <CodeThreadWorkspace
        controller={controller({ execute, sendFollowUp })}
        threadId={threadId}
      />,
    );

    expect(screen.getByRole("button", { name: "Next turn access" })).toHaveTextContent("Ask");
    await user.click(screen.getByRole("button", { name: "Next turn access" }));
    expect(
      screen.queryByRole("menuitemradio", { name: "Auto-accept edits" }),
    ).not.toBeInTheDocument();
    expect(
      await screen.findByRole("menuitemradio", { name: "Raise thread · Auto-accept edits" }),
    ).toBeVisible();
    expect(
      await screen.findByRole("menuitemradio", { name: "Raise thread · Full access" }),
    ).toBeVisible();
    await user.click(await screen.findByRole("menuitemradio", { name: "Plan · read-only" }));
    expect(execute).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Follow-up message"), "just look");
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));
    expect(sendFollowUp).toHaveBeenCalledWith("just look", [], [], [], "plan");
  });

  it("keeps a selected Plan posture when the thread lowers to approval-gated access", async () => {
    const user = userEvent.setup();
    const initial = controller();
    const fullAccess = {
      ...initial,
      activeView: {
        ...initial.activeView!,
        thread: { ...initial.activeView!.thread, executionPolicy: "full-access" as const },
      },
    };
    const { rerender } = render(
      <CodeThreadWorkspace controller={fullAccess} threadId={threadId} />,
    );

    await user.click(screen.getByRole("button", { name: "Next turn access" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Plan · read-only" }));
    expect(screen.getByRole("button", { name: "Next turn access" })).toHaveTextContent("Plan");

    rerender(
      <CodeThreadWorkspace
        controller={{
          ...fullAccess,
          activeView: {
            ...fullAccess.activeView!,
            thread: {
              ...fullAccess.activeView!.thread,
              executionPolicy: "approval-gated" as const,
            },
          },
        }}
        threadId={threadId}
      />,
    );

    expect(screen.getByRole("button", { name: "Next turn access" })).toHaveTextContent("Plan");
  });

  it("clears a selected Plan posture when switching to another thread", async () => {
    const user = userEvent.setup();
    const initial = controller();
    const fullAccess = {
      ...initial,
      activeView: {
        ...initial.activeView!,
        thread: { ...initial.activeView!.thread, executionPolicy: "full-access" as const },
      },
    };
    const { rerender } = render(
      <CodeThreadWorkspace controller={fullAccess} threadId={threadId} />,
    );

    await user.click(screen.getByRole("button", { name: "Next turn access" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Plan · read-only" }));

    rerender(
      <CodeThreadWorkspace
        controller={controller({}, anotherThreadId)}
        threadId={anotherThreadId}
      />,
    );

    expect(screen.getByRole("button", { name: "Next turn access" })).toHaveTextContent("Ask");
  });

  it("offers auto-accept edits on a thread that already grants it, without changing the thread", async () => {
    const user = userEvent.setup();
    const sendFollowUp = vi.fn(async () => true);
    const execute = vi.fn(async () => undefined) as CodeController["execute"];
    render(
      <CodeThreadWorkspace
        controller={controller({
          execute,
          sendFollowUp,
          activeView: {
            ...controller().activeView!,
            thread: { ...controller().activeView!.thread, executionPolicy: "auto-accept-edits" },
          },
        })}
        threadId={threadId}
      />,
    );

    expect(screen.getByRole("button", { name: "Next turn access" })).toHaveTextContent(
      "Auto edits",
    );
    await user.click(screen.getByRole("button", { name: "Next turn access" }));
    expect(await screen.findByRole("menuitemradio", { name: "Plan · read-only" })).toBeVisible();
    expect(screen.getByRole("menuitemradio", { name: "Ask for approvals" })).toBeVisible();
    expect(screen.getByRole("menuitemradio", { name: "Raise thread · Full access" })).toBeVisible();
    expect(screen.queryByRole("menuitemradio", { name: "Full access" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("menuitemradio", { name: "Ask for approvals" }));
    expect(execute).not.toHaveBeenCalled();

    await user.type(screen.getByLabelText("Follow-up message"), "ask me first");
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));
    expect(sendFollowUp).toHaveBeenCalledWith("ask me first", [], [], [], "approval-gated");
  });

  it("cannot run a writing one-shot on a Plan thread, but can still raise the grant", async () => {
    const user = userEvent.setup();
    const execute = vi.fn(async () => undefined) as CodeController["execute"];
    render(
      <CodeThreadWorkspace
        controller={controller({
          execute,
          activeView: {
            ...controller().activeView!,
            thread: { ...controller().activeView!.thread, executionPolicy: "plan" },
          },
        })}
        requestFullAccessApproval={vi.fn(async () => "approval-1" as never)}
        threadId={threadId}
      />,
    );

    const picker = screen.getByRole("button", { name: "Next turn access" });
    expect(picker).toHaveTextContent("Plan");
    expect(picker).toBeEnabled();
    await user.click(picker);
    expect(
      screen.queryByRole("menuitemradio", { name: "Ask for approvals" }),
    ).not.toBeInTheDocument();
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Raise thread · Ask for approvals" }),
    );
    expect(execute).toHaveBeenCalledWith({
      kind: "change-code-thread-access",
      threadId,
      expectedVersion: 1,
      executionPolicy: "approval-gated",
      permissionPersistence: "current-session",
    });
  });

  it("raises an approval-gated thread to Full access through native confirmation", async () => {
    const user = userEvent.setup();
    const execute = vi.fn(async () => undefined) as CodeController["execute"];
    const requestFullAccessApproval = vi.fn(async () => "approval-1" as never);
    render(
      <CodeThreadWorkspace
        controller={controller({ execute })}
        requestFullAccessApproval={requestFullAccessApproval}
        threadId={threadId}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Next turn access" }));
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Raise thread · Full access" }),
    );
    expect(requestFullAccessApproval).toHaveBeenCalledWith({
      kind: "change-thread-full-access",
      threadId,
      expectedVersion: 1,
      permissionPersistence: "current-session",
    });
    expect(execute).toHaveBeenCalledWith({
      kind: "change-code-thread-access",
      threadId,
      expectedVersion: 1,
      executionPolicy: "full-access",
      permissionPersistence: "current-session",
      approvalId: "approval-1",
    });
  });

  it("raises a thread to remembered Project Full access without a native confirmation", async () => {
    const user = userEvent.setup();
    const execute = vi.fn(async () => undefined) as CodeController["execute"];
    render(
      <CodeThreadWorkspace
        controller={controller({ execute })}
        projectRemembersFullAccess
        threadId={threadId}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Next turn access" }));
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Raise thread · Full access" }),
    );
    expect(execute).toHaveBeenCalledWith({
      kind: "change-code-thread-access",
      threadId,
      expectedVersion: 1,
      executionPolicy: "full-access",
      permissionPersistence: "project-default",
    });
  });

  it("keeps Full access behind the native confirmation when the Project does not remember it", async () => {
    const user = userEvent.setup();
    const execute = vi.fn(async () => undefined) as CodeController["execute"];
    render(<CodeThreadWorkspace controller={controller({ execute })} threadId={threadId} />);

    await user.click(screen.getByRole("button", { name: "Next turn access" }));
    expect(
      await screen.findByRole("menuitemradio", { name: "Raise thread · Full access" }),
    ).toHaveAttribute("aria-disabled", "true");
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps the access picker disabled while the native Full access confirmation is open", async () => {
    const user = userEvent.setup();
    const approval = deferred<CodeApprovalId | undefined>();
    const requestFullAccessApproval = vi.fn(() => approval.promise);
    const execute = vi.fn(async () => undefined) as CodeController["execute"];
    const pickerController = controller({ execute });
    render(
      <CodeThreadWorkspace
        controller={pickerController}
        requestFullAccessApproval={requestFullAccessApproval}
        threadId={threadId}
      />,
    );

    const picker = screen.getByRole("button", { name: "Next turn access" });
    await user.click(picker);
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Raise thread · Full access" }),
    );
    expect(picker).toBeDisabled();

    approval.resolve("40000000-0000-4000-8000-000000000001" as CodeApprovalId);
    await waitFor(() => expect(picker).toBeEnabled());
  });

  it("attributes a confirmation cancelled by leaving the thread to the thread that asked", async () => {
    const user = userEvent.setup();
    const approval = deferred<CodeApprovalId | undefined>();
    const requestFullAccessApproval = vi.fn(() => approval.promise);
    const cancelApproval = vi.fn(async () => undefined);
    const setAccessNoticeA = vi.fn();
    const setAccessNoticeB = vi.fn();
    const holdAccessNoticeA = vi.fn();
    const holdAccessNoticeB = vi.fn();
    const leftThreadNotice =
      "Full access confirmation was cancelled when you left this thread. It keeps its current access.";
    const { unmount } = render(
      <CodeThreadWorkspace
        controller={controller({ setAccessNotice: setAccessNoticeA })}
        holdAccessNotice={holdAccessNoticeA}
        requestFullAccessApproval={requestFullAccessApproval}
        cancelApproval={cancelApproval}
        threadId={threadId}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Next turn access" }));
    await user.click(
      await screen.findByRole("menuitemradio", { name: "Raise thread · Full access" }),
    );

    unmount();
    const threadB = render(
      <CodeThreadWorkspace
        controller={controller({ setAccessNotice: setAccessNoticeB }, anotherThreadId)}
        holdAccessNotice={holdAccessNoticeB}
        requestFullAccessApproval={requestFullAccessApproval}
        cancelApproval={cancelApproval}
        threadId={anotherThreadId}
      />,
    );
    approval.resolve(undefined);
    await waitFor(() => expect(holdAccessNoticeA).toHaveBeenCalledWith(threadId, leftThreadNotice));
    expect(setAccessNoticeB).not.toHaveBeenCalled();
    expect(holdAccessNoticeB).not.toHaveBeenCalled();
    expect(screen.queryByText(leftThreadNotice)).not.toBeInTheDocument();

    threadB.rerender(
      <CodeThreadWorkspace
        controller={controller({ accessNotice: leftThreadNotice })}
        holdAccessNotice={holdAccessNoticeA}
        requestFullAccessApproval={requestFullAccessApproval}
        cancelApproval={cancelApproval}
        threadId={threadId}
      />,
    );
    expect(await screen.findByText(leftThreadNotice)).toBeVisible();
  });

  it("resets one-shot access as soon as the host accepts the start", async () => {
    const user = userEvent.setup();
    const sendFollowUp = vi.fn(() => new Promise<boolean>(() => undefined));
    render(<CodeThreadWorkspace controller={controller({ sendFollowUp })} threadId={threadId} />);

    await user.click(screen.getByRole("button", { name: "Next turn access" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Plan · read-only" }));
    expect(screen.getByRole("button", { name: "Next turn access" })).toHaveTextContent("Plan");
    await user.type(screen.getByLabelText("Follow-up message"), "just look");
    await user.click(screen.getByRole("button", { name: "Send follow-up" }));
    expect(sendFollowUp).toHaveBeenCalledWith("just look", [], [], [], "plan");
    expect(screen.getByRole("button", { name: "Next turn access" })).toHaveTextContent("Ask");
  });

  it("keeps sent messages free of access captions", () => {
    render(
      <CodeThreadWorkspace
        controller={controller({
          conversation: [
            {
              id: "turn-1:user",
              role: "user",
              text: "rewrite the loader",
              executionPolicy: "auto-accept-edits",
            },
            { id: "turn-1:assistant", role: "assistant", text: "Done." },
          ],
        })}
        threadId={threadId}
      />,
    );

    expect(screen.queryByText("Access · Auto-accept edits")).not.toBeInTheDocument();
  });

  it("keeps policy changes in the access control rather than repeating them in the transcript", () => {
    render(
      <CodeThreadWorkspace
        controller={controller({
          conversation: [
            {
              id: "turn-1:user",
              role: "user",
              text: "look around",
              executionPolicy: "approval-gated",
            },
            { id: "turn-1:assistant", role: "assistant", text: "Looked." },
            {
              id: "turn-2:user",
              role: "user",
              text: "keep looking",
              executionPolicy: "approval-gated",
            },
            { id: "turn-2:assistant", role: "assistant", text: "Still looking." },
            {
              id: "turn-3:user",
              role: "user",
              text: "now edit",
              executionPolicy: "auto-accept-edits",
            },
            { id: "turn-3:assistant", role: "assistant", text: "Edited." },
          ],
        })}
        threadId={threadId}
      />,
    );

    expect(screen.queryByText("Access · Ask for approvals")).not.toBeInTheDocument();
    expect(screen.queryByText("Access · Auto-accept edits")).not.toBeInTheDocument();
  });

  it("answers agent-initiated approvals and questions through the controller", async () => {
    const user = userEvent.setup();
    const answerProviderRequest = vi.fn(
      async () => true,
    ) as CodeController["answerProviderRequest"];
    render(
      <CodeThreadWorkspace
        controller={controller({
          answerProviderRequest,
          providerRequests: [
            {
              kind: "approval",
              approvalId: "30000000-0000-4000-8000-000000000003" as never,
              summary: "terminal: run bun test",
            },
            {
              kind: "input",
              requestId: "req-1",
              prompt: "Which package manager?",
              options: ["bun", "npm"],
            },
          ],
        })}
        threadId={threadId}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Approve" }));
    expect(answerProviderRequest).toHaveBeenCalledWith({
      kind: "approval",
      approvalId: "30000000-0000-4000-8000-000000000003",
      decision: "approved",
    });

    await user.click(screen.getByRole("radio", { name: /npm/ }));
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(answerProviderRequest).toHaveBeenCalledWith({
      kind: "input",
      requestId: "req-1",
      response: "npm",
    });

    await user.click(screen.getByRole("radio", { name: "Type your own answer" }));
    await user.type(screen.getByRole("textbox", { name: "Your answer" }), "pnpm");
    await user.click(screen.getByRole("button", { name: "Submit" }));
    expect(answerProviderRequest).toHaveBeenLastCalledWith({
      kind: "input",
      requestId: "req-1",
      response: "pnpm",
    });
  });

  it("keeps provider requests immediately above the composer", () => {
    render(
      <CodeThreadWorkspace
        controller={controller({
          providerRequests: [
            {
              kind: "approval",
              approvalId: "30000000-0000-4000-8000-000000000003" as never,
              summary: "skill: Approval is required for this action.",
            },
          ],
        })}
        threadId={threadId}
      />,
    );

    const approval = screen.getByRole("group", { name: "Provider approval" });
    const composer = screen
      .getByRole("textbox", { name: "Follow-up message" })
      .closest(".thread-composer");
    const requests = approval.closest(".code-thread-workspace__provider-requests");

    expect(approval).toHaveClass("approval-row--request");
    expect(requests).not.toBeNull();
    expect(requests?.nextElementSibling).toBe(composer);
  });

  it("marks a provider handoff between replayed assistant turns", () => {
    render(
      <CodeThreadWorkspace
        controller={controller({
          conversation: [
            {
              id: "turn:assistant-one",
              role: "assistant",
              text: "The first pass is complete.",
              providerInstanceId: providerId,
              modelId,
              status: "completed",
            },
            {
              id: "turn:assistant-two",
              role: "assistant",
              text: "The second pass is complete.",
              providerInstanceId: alternateProviderId,
              modelId: alternateModelId,
              status: "completed",
            },
          ],
        })}
        providerGroups={[providerGroup(), alternateProviderGroup()]}
        threadId={threadId}
      />,
    );

    expect(screen.getByRole("separator", { name: /provider handoff/i })).toHaveTextContent(
      "Provider handoff",
    );
  });

  it("labels a model-only switch as a model switch rather than a provider handoff", () => {
    render(
      <CodeThreadWorkspace
        controller={controller({
          conversation: [
            {
              id: "turn:assistant-one",
              role: "assistant",
              text: "The first pass is complete.",
              providerInstanceId: providerId,
              modelId,
              status: "completed",
            },
            {
              id: "turn:assistant-two",
              role: "assistant",
              text: "The second pass is complete.",
              providerInstanceId: providerId,
              modelId: alternateModelId,
              status: "completed",
            },
          ],
        })}
        providerGroups={[providerGroup()]}
        threadId={threadId}
      />,
    );

    expect(screen.getByRole("separator", { name: /model switch/i })).toHaveTextContent(
      `Switched to ${String(alternateModelId)}`,
    );
    expect(screen.queryByText(/provider handoff/i)).not.toBeInTheDocument();
  });

  it("does not invent a provider handoff for an app-authored assistant message", () => {
    render(
      <CodeThreadWorkspace
        controller={controller({
          conversation: [
            {
              id: "turn:assistant-provider",
              role: "assistant",
              text: "The provider pass is complete.",
              providerInstanceId: providerId,
              modelId,
              status: "completed",
            },
            {
              id: "turn:assistant-app",
              role: "assistant",
              text: "Local app status.",
              status: "completed",
            },
          ],
        })}
        providerGroups={[providerGroup()]}
        threadId={threadId}
      />,
    );

    expect(screen.queryByRole("separator", { name: /provider handoff/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/undefined/)).not.toBeInTheDocument();
  });

  it("keeps a pending draft editable without auto-sending it under Strict Mode", async () => {
    const sendFollowUp = vi.fn(async () => true);

    const { rerender } = render(
      <StrictMode>
        <CodeThreadWorkspace
          controller={controller({ pendingDraft: "Reply exactly: FOLLOWUP_OK.", sendFollowUp })}
          threadId={threadId}
        />
      </StrictMode>,
    );

    expect(screen.getByLabelText("Follow-up message")).toHaveValue("Reply exactly: FOLLOWUP_OK.");
    expect(sendFollowUp).not.toHaveBeenCalled();

    rerender(
      <StrictMode>
        <CodeThreadWorkspace
          controller={controller({ pendingDraft: "Do not auto-send this edit", sendFollowUp })}
          threadId={threadId}
        />
      </StrictMode>,
    );

    expect(screen.getByLabelText("Follow-up message")).toHaveValue("Do not auto-send this edit");
    expect(sendFollowUp).not.toHaveBeenCalled();
  });

  it("does not send pending drafts while navigating between threads", async () => {
    const sendFollowUp = vi.fn(async () => true);
    const { rerender } = render(
      <CodeThreadWorkspace
        controller={controller({ pendingDraft: "Opening A", sendFollowUp })}
        threadId={threadId}
      />,
    );
    expect(screen.getByLabelText("Follow-up message")).toHaveValue("Opening A");

    rerender(
      <CodeThreadWorkspace
        controller={controller({ pendingDraft: "Opening B", sendFollowUp }, anotherThreadId)}
        threadId={anotherThreadId}
      />,
    );
    expect(screen.getByLabelText("Follow-up message")).toHaveValue("Opening B");

    rerender(
      <CodeThreadWorkspace
        controller={controller({ pendingDraft: "Opening A", sendFollowUp })}
        threadId={threadId}
      />,
    );
    expect(screen.getByLabelText("Follow-up message")).toHaveValue("Opening A");
    expect(sendFollowUp).not.toHaveBeenCalled();
  });

  it("restores the caret once the Code composer mounts", () => {
    const { rerender } = render(
      <CodeThreadWorkspace
        controller={controller({
          activeView: undefined,
          pendingDraft: "half-written",
          pendingDraftCaret: 4,
          status: "loading",
        })}
        threadId={threadId}
      />,
    );
    expect(screen.queryByLabelText("Follow-up message")).not.toBeInTheDocument();

    rerender(
      <CodeThreadWorkspace
        controller={controller({ pendingDraft: "half-written", pendingDraftCaret: 4 })}
        threadId={threadId}
      />,
    );
    const message = screen.getByLabelText("Follow-up message") as HTMLTextAreaElement;
    expect(message).toHaveValue("half-written");
    expect(message.selectionStart).toBe(4);
    expect(message.selectionEnd).toBe(4);
  });

  it("says so when a replayed turn kept only its earliest steps", () => {
    const operationId = "70000000-0000-4000-8000-000000000052";
    render(
      <CodeThreadWorkspace
        controller={controller({
          conversation: [
            {
              id: `${operationId}:assistant`,
              role: "assistant",
              text: "Done.",
              operationId: operationId as never,
              status: "completed",
            },
          ],
          turnActivity: new Map([
            [
              operationId,
              {
                reasoning: "",
                truncated: true,
                rows: [{ kind: "tool", id: "call-1", toolName: "Read", state: "completed" }],
              },
            ],
          ]),
        })}
        threadId={threadId}
      />,
    );

    // The transcript never implies it is showing the whole turn when it is not.
    expect(screen.getByText("Earliest steps kept")).toBeVisible();
  });

  it("folds a settled turn's toolchain behind one summary until the user opens it", async () => {
    const user = userEvent.setup();
    const operationId = "70000000-0000-4000-8000-000000000051";
    render(
      <CodeThreadWorkspace
        controller={controller({
          conversation: [
            {
              id: `${operationId}:assistant`,
              role: "assistant",
              text: "Verified the change.",
              operationId: operationId as never,
              status: "completed",
            },
          ],
          turnActivity: new Map([
            [
              operationId,
              {
                reasoning: "Check the failing suite first.",
                rows: [
                  {
                    kind: "tool",
                    id: "call-1",
                    toolName: "Bash",
                    state: "completed",
                    summary: "bun run verify",
                  },
                  { kind: "task", id: "task-1", state: "completed", summary: "Rewrite the pane" },
                ],
              },
            ],
          ]),
        })}
        threadId={threadId}
      />,
    );

    // Settled turns fold the toolchain behind one quiet line.
    expect(screen.getByRole("button", { name: "1 tool call" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Bash, done" })).not.toBeVisible();
    expect(screen.queryByText("bun run verify")).not.toBeVisible();
    expect(screen.queryByText("Check the failing suite first.")).not.toBeVisible();

    await user.click(screen.getByRole("button", { name: "1 tool call" }));
    expect(screen.getByRole("button", { name: "Bash, done" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Bash, done" }));
    expect(screen.getByText("bun run verify")).toBeVisible();
    expect(screen.getByText("Bash")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Thinking" }));
    expect(screen.getByText("Check the failing suite first.")).toBeVisible();
  });

  it("keeps the live task list under the conversation while the turn works through it", () => {
    const operationId = "70000000-0000-4000-8000-000000000053";
    render(
      <CodeThreadWorkspace
        controller={controller({
          conversation: [
            {
              id: `${operationId}:assistant`,
              role: "assistant",
              text: "",
              operationId: operationId as never,
              status: "incomplete",
            },
          ],
          turnActivity: new Map([
            [
              operationId,
              {
                reasoning: "",
                rows: [
                  {
                    kind: "task",
                    id: "task-1",
                    state: "completed",
                    summary: "Watch CI on PR #1112 head c65201e8",
                  },
                  {
                    kind: "task",
                    id: "task-2",
                    state: "running",
                    summary: "Triage review-bot findings",
                  },
                ],
              },
            ],
          ]),
        })}
        threadId={threadId}
      />,
    );

    expect(screen.getByRole("region", { name: "Agent tasks" })).toBeVisible();
    expect(screen.getByText("1 of 2 tasks completed")).toBeVisible();
  });

  it("shows no task list for a settled turn whose tasks all finished", () => {
    const operationId = "70000000-0000-4000-8000-000000000054";
    render(
      <CodeThreadWorkspace
        controller={controller({
          conversation: [
            {
              id: `${operationId}:assistant`,
              role: "assistant",
              text: "Done.",
              operationId: operationId as never,
              status: "completed",
            },
          ],
          turnActivity: new Map([
            [
              operationId,
              {
                reasoning: "",
                rows: [
                  { kind: "task", id: "task-1", state: "completed", summary: "Rewrite the pane" },
                ],
              },
            ],
          ]),
        })}
        threadId={threadId}
      />,
    );

    expect(screen.queryByRole("region", { name: "Agent tasks" })).not.toBeInTheDocument();
  });

  it("renders no activity disclosure for a turn that reported none", () => {
    render(
      <CodeThreadWorkspace
        controller={controller({
          conversation: [
            {
              id: "assistant-plain",
              role: "assistant",
              text: "Done.",
              operationId: "70000000-0000-4000-8000-000000000052" as never,
              status: "completed",
            },
          ],
        })}
        threadId={threadId}
      />,
    );

    expect(screen.queryByText("Thinking")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /done$/ })).not.toBeInTheDocument();
  });

  it("windows a long transcript so only a bounded number of rows mount", () => {
    const conversation = Array.from({ length: 1000 }, (_, index) => ({
      id: `message-${String(index)}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `Code turn ${String(index)}`,
    }));
    render(<CodeThreadWorkspace controller={controller({ conversation })} threadId={threadId} />);

    expect(document.querySelectorAll("[data-transcript-row]").length).toBeLessThan(80);
    expect(screen.getByText("Code turn 0")).toBeVisible();
    expect(screen.queryByText("Code turn 999")).not.toBeInTheDocument();
  });

  it("keeps loading and disconnected states honest", () => {
    const { rerender } = render(
      <CodeThreadWorkspace
        controller={{
          ...controller(),
          activeView: undefined,
          status: "loading",
        }}
        threadId={threadId}
      />,
    );
    expect(screen.getByRole("heading", { name: "Loading Code thread" })).toBeVisible();

    rerender(
      <CodeThreadWorkspace
        controller={{
          ...controller(),
          activeView: undefined,
          errorMessage: "Code transport disconnected.",
          retry: vi.fn(),
          status: "disconnected",
        }}
        threadId={threadId}
      />,
    );
    expect(screen.getByRole("heading", { name: "Code is disconnected" })).toBeVisible();
  });

  it("shows the historical provider binding and terminal state for replayed turns", () => {
    render(
      <CodeThreadWorkspace
        controller={controller({
          conversation: [
            {
              id: "turn:assistant",
              role: "assistant",
              text: "The checks did not pass.",
              providerInstanceId: providerId,
              modelId,
              status: "failed",
            },
          ],
        })}
        providerGroups={[providerGroup()]}
        threadId={threadId}
      />,
    );

    // Provenance moved into the header's hover details; the row itself keeps
    // only the outcome.
    expect(screen.getByTitle(/Local OpenCode — Model One/)).toBeInTheDocument();
    expect(screen.queryByText("Local OpenCode — Model One")).not.toBeInTheDocument();
    expect(screen.getByText("Failed")).toBeVisible();
  });

  it("states the thread's identity nowhere, leaving the title to the pane and follow-up to the row", () => {
    render(
      <CodeThreadWorkspace
        controller={controller({
          followUps: new Map([
            [
              String(threadId),
              {
                threadId,
                followUpVersion: 3,
                followUp: {
                  threadId,
                  state: "open",
                  origin: "automatic",
                  reason: "Approval requested: run tests",
                  triggerSequence: 6,
                  acknowledgedThroughSequence: 0,
                  createdAt: "2026-07-27T09:00:00.000Z",
                },
              },
            ],
          ]) as never,
        })}
        threadId={threadId}
      />,
    );

    expect(
      screen.queryByRole("heading", { name: "find bugs in this repo" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Active")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mark for follow-up" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Complete follow-up" })).not.toBeInTheDocument();
  });

  it("shows the host's observed changed-file evidence on the thread plan", async () => {
    const user = userEvent.setup();
    const queryBoard = vi.fn(async () =>
      boardView([
        boardCard({
          changedFiles: {
            kind: "observed",
            freshness: "fresh",
            changedPathCount: 4,
            stagedCount: 1,
            committedAhead: 0,
            workingTreeClean: false,
            insertions: 173,
            deletions: 0,
          },
        }),
      ]),
    );

    render(
      withPlan(
        <CodeThreadWorkspace controller={controllerWithBoard(queryBoard)} threadId={threadId} />,
      ),
    );

    const trigger = await screen.findByRole("button", { name: /4 files changed \+173 −0/ });
    expect(trigger).not.toHaveTextContent("stale");
    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "Task progress" })).toHaveTextContent(
      "4 files changed +173 −0",
    );
    expect(queryBoard).toHaveBeenCalledWith({
      version: 1,
      projectIds: [projectId],
    });
  });

  it("shows why Save to Project failed instead of leaving an unhandled rejection", async () => {
    const user = userEvent.setup();
    const save = vi.fn(async () => {
      throw new Error("disk full");
    });
    render(
      <CodeThreadWorkspace
        controller={controller()}
        imageGenerationClient={
          {
            list: async () => ({ jobs: [completedGeneratedJob()] }),
            artifact: async () => new Blob([Uint8Array.from([1])], { type: "image/png" }),
            save,
          } as never
        }
        imageGenerationProfiles={[imageProfile()]}
        providerGroups={[providerGroup()]}
        threadId={threadId}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Save to Project" }));
    expect(await screen.findByText("The image could not be saved.")).toBeVisible();
  });

  it("marks a stale changed-file observation rather than treating it as current", async () => {
    const queryBoard = vi.fn(async () =>
      boardView([
        boardCard({
          changedFiles: {
            kind: "observed",
            freshness: "stale",
            changedPathCount: 1,
            stagedCount: 0,
            committedAhead: 0,
            workingTreeClean: false,
            insertions: 4,
            deletions: 2,
          },
        }),
      ]),
    );

    render(
      withPlan(
        <CodeThreadWorkspace controller={controllerWithBoard(queryBoard)} threadId={threadId} />,
      ),
    );

    expect(
      await screen.findByRole("button", { name: /1 file changed \+4 −2 · stale/ }),
    ).toBeVisible();
  });

  it("shows no changed-file count when the worktree could not be observed", async () => {
    const queryBoard = vi.fn(async () =>
      boardView([boardCard({ changedFiles: { kind: "unavailable" } })]),
    );

    render(
      withPlan(
        <CodeThreadWorkspace controller={controllerWithBoard(queryBoard)} threadId={threadId} />,
      ),
    );

    const trigger = await screen.findByRole("button", { name: /^Show task progress/ });
    await waitFor(() => expect(queryBoard).toHaveBeenCalled());
    expect(trigger).toHaveTextContent("Step 2 / 2");
    expect(trigger).not.toHaveTextContent("0");
    expect(trigger).not.toHaveTextContent("file");
    expect(trigger).not.toHaveTextContent("changed");
  });
});

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
    threadKind: "code-thread",
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
    createdAt: "2026-07-27T09:00:00.000Z",
    updatedAt: "2026-07-27T09:00:00.000Z",
  };
}

function providerGroup(): PickerGroup {
  return {
    driverLabel: "OpenCode",
    endpointHost: "local",
    executionHost: "local",
    instance: {
      id: providerId,
      displayName: "Local OpenCode",
    },
    readiness: "ready",
    sections: [
      {
        label: "Models",
        models: [
          {
            model: {
              id: modelId,
              displayName: "Model One",
            },
          },
        ],
      },
    ],
  } as never;
}

function alternateProviderGroup(): PickerGroup {
  return {
    driverLabel: "Remote",
    endpointHost: "remote.example",
    executionHost: "remote",
    instance: {
      id: alternateProviderId,
      displayName: "Remote Provider",
    },
    readiness: "ready",
    sections: [
      {
        label: "Models",
        models: [
          {
            model: {
              id: alternateModelId,
              displayName: "Model Two",
            },
          },
        ],
      },
    ],
  } as never;
}

const checkpoint = { worktree: "c".repeat(40), index: "d".repeat(40) } as never;

function controller(
  overrides: Partial<CodeController> = {},
  activeThreadId = threadId,
): CodeController {
  return {
    activeView: {
      checkout: {
        id: "20000000-0000-4000-8000-000000000002",
        repositoryId: "repo_" + "a".repeat(64),
        kind: "existing-worktree",
        availability: "available",
        head: { kind: "branch", name: "main", oid: "b".repeat(40) },
        observedAt: "2026-07-27T09:00:00.000Z",
      },
      lastSequence: 1,
      thread: {
        id: activeThreadId,
        title: "find bugs in this repo",
        lifecycle: "active",
        executionPolicy: "approval-gated",
        permissionPersistence: "current-session",
        checkoutId: "20000000-0000-4000-8000-000000000002",
        providerInstanceId: providerId,
        modelId,
        version: 1,
      },
    },
    accessNotice: undefined,
    setAccessNotice: vi.fn(),
    conversation: [],
    conversationHistory: "loaded",
    followUps: new Map(),
    markFollowUp: vi.fn(async () => true),
    completeFollowUp: vi.fn(async () => true),
    refreshFollowUp: vi.fn(async () => undefined),
    pendingDraft: "",
    providerRequests: [],
    answerProviderRequest: vi.fn(async () => true),
    cancelTurn: vi.fn(async () => true),

    threadUsage: { inputTokens: 0, outputTokens: 0, limits: [] },
    noteRestoreUndo: vi.fn(),
    turnActivity: new Map(),
    turnErrorInTranscript: false,
    sendFollowUp: vi.fn(async () => true),
    setPendingDraft: vi.fn(),
    status: "ready",
    turnStatus: "idle",
    retry: vi.fn(),
    ...overrides,
  } as never;
}

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolveValue: (value: T) => void = () => {};
  const promise = new Promise<T>((resolve) => {
    resolveValue = resolve;
  });
  return { promise, resolve: resolveValue };
}

function withPlan(ui: ReactElement): ReactElement {
  const client: PlanClient = {
    read: vi.fn(async () => ({ plan: approvedPlan(), history: [] })),
    execute: vi.fn(),
  };
  return (
    <ThreadPlanProvider client={client} threadId={String(threadId)}>
      {ui}
    </ThreadPlanProvider>
  );
}

function controllerWithBoard(queryBoard: CodeController["client"]["queryBoard"]): CodeController {
  const base = controller();
  return {
    ...base,
    activeView: {
      ...base.activeView!,
      thread: { ...base.activeView!.thread, projectId },
    },
    client: { queryBoard },
  } as never;
}

function approvedPlan(): ThreadPlan {
  return {
    id: "20000000-0000-4000-8000-000000000001",
    threadId,
    revisionId: "30000000-0000-4000-8000-000000000002",
    title: "Ship the context controls",
    status: "approved",
    approvedRevisionId: "30000000-0000-4000-8000-000000000002",
    steps: [
      {
        stepId: "40000000-0000-4000-8000-000000000001",
        position: 0,
        title: "Map the context",
        status: "done",
      },
      {
        stepId: "40000000-0000-4000-8000-000000000002",
        position: 1,
        title: "Build the viewer",
        status: "in-progress",
      },
    ],
    proposedAt: "2026-08-21T12:00:00.000Z",
    updatedAt: "2026-08-21T12:00:00.000Z",
    version: 5,
  } as never;
}

function boardView(cards: ReadonlyArray<CodeBoardCard>): CodeBoardView {
  return {
    version: 1,
    query: { version: 1 },
    cards,
    generatedAt: "2026-07-27T09:00:00.000Z",
  } as CodeBoardView;
}

function boardCard(overrides: Partial<CodeBoardCard> = {}): CodeBoardCard {
  return {
    threadId,
    projectId,
    checkoutId: "20000000-0000-4000-8000-000000000002",
    checkoutKind: "existing-worktree",
    title: "find bugs in this repo",
    status: "in-progress",
    statusReason: "executing",
    outcomeKind: "opened-pr",
    deliverySatisfaction: "pending",
    providerInstanceId: providerId,
    modelId,
    executing: true,
    worktree: { kind: "unavailable", checkoutId: "20000000-0000-4000-8000-000000000002" },
    changedFiles: { kind: "unavailable" },
    linkedPullRequest: { kind: "none", freshness: "fresh" },
    pullRequestSummaries: { items: [], hiddenCount: 0 },
    checks: { freshness: "fresh", state: "unknown" },
    reviewState: { freshness: "fresh", state: "unknown" },
    childAgents: { active: 0, completed: 0, failed: 0, unacknowledgedResults: 0 },
    recovery: { kind: "ok" },
    githubFreshness: "fresh",
    followUp: false,
    lastMeaningfulActivityAt: null,
    ...overrides,
  } as unknown as CodeBoardCard;
}

/**
 * Paste one PNG into the composer. jsdom has no real clipboard files, so the
 * event carries the same shape a browser hands React.
 */
function pasteImage(composer: HTMLElement, name = "pasted.png"): void {
  const file = new File([new Uint8Array([137, 80, 78])], name, { type: "image/png" });
  fireEvent.paste(composer, { clipboardData: { files: [file], items: [] } });
}

/** The bound provider group, with a model that reads text and nothing else. */
function textOnlyProviderGroup(): PickerGroup {
  const group = providerGroup();
  return {
    ...group,
    sections: [
      {
        ...group.sections[0]!,
        models: [
          {
            ...group.sections[0]!.models[0]!,
            model: { ...group.sections[0]!.models[0]!.model, inputModalities: ["text"] },
          },
        ],
      },
    ],
  } as never;
}

function turnArticle(text: string): HTMLElement {
  const turn = screen.getByText(text).closest("article");
  expect(turn).toBeInstanceOf(HTMLElement);
  if (!(turn instanceof HTMLElement)) {
    throw new Error("the turn is not in the document");
  }
  return turn;
}

async function chooseTurnAction(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  turnText: string,
) {
  await user.click(within(turnArticle(turnText)).getByRole("button", { name: "More actions" }));
  await user.click(await screen.findByRole("menuitemradio", { name }));
}
