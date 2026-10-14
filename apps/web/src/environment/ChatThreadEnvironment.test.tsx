import {
  decodeChatBootstrap,
  decodeChatThreadView,
  decodeProjectId,
  decodeWorkspaceTab,
  type ProjectSummary,
  type WorkspaceTab,
} from "@octant/contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ChatController } from "../chat/useChatController";
import { ChatThreadEnvironment } from "./ChatThreadEnvironment";

const now = "2026-07-28T16:00:00.000Z";
const projectId = decodeProjectId("00000000-0000-4000-8000-000000000901");
const threadId = "00000000-0000-4000-8000-000000000701";
const providerId = "00000000-0000-4000-8000-000000000902";
const tabA = chatTab("30000000-0000-4000-8000-00000000000a");
const tabB = chatTab("30000000-0000-4000-8000-00000000000b");

function chatTab(id: string): Extract<WorkspaceTab, { readonly kind: "chat-thread" }> {
  return decodeWorkspaceTab({
    kind: "chat-thread",
    id,
    threadId,
    mode: "chat",
    title: "Release plan",
  }) as Extract<WorkspaceTab, { readonly kind: "chat-thread" }>;
}

function chatProject(): ProjectSummary {
  return {
    id: projectId,
    type: "chat",
    name: "Planning",
    lifecycle: "active",
    pinned: true,
    rank: "0/1" as ProjectSummary["rank"],
    version: 1 as ProjectSummary["version"],
    createdAt: now as ProjectSummary["createdAt"],
    updatedAt: now as ProjectSummary["updatedAt"],
  } as ProjectSummary;
}

function controller(): ChatController {
  const thread = {
    id: threadId,
    projectId,
    title: "Release plan",
    lifecycle: "active" as const,
    providerInstanceId: providerId,
    modelId: "model-a",
    researchEnabled: false,
    researchRouting: "automatic" as const,
    personalityInstructions: "Be concise.",
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
  const activeView = decodeChatThreadView({
    thread,
    turns: [],
    lastSequence: 0,
    contents: [],
    attachments: [
      {
        id: "10000000-0000-4000-8000-000000000001",
        threadId,
        displayName: "brief.txt",
        mediaType: "text/plain",
        byteLength: 5,
        digest: "a".repeat(64),
        status: "finalized",
        createdAt: now,
      },
    ],
    citations: [],
    workItems: [],
    workListVersion: 0,
    followUpVersion: 0,
  });
  return {
    activeView,
    bootstrap: decodeChatBootstrap({
      settings: {
        defaultProviderInstanceId: providerId,
        defaultModelId: "model-a",
        defaultResearchEnabled: false,
        defaultResearchRouting: "automatic",
        defaultPersonalityInstructions: "Be concise.",
        version: 1,
        updatedAt: now,
      },
      threads: [thread],
    }),
    errorMessage: undefined,
    execute: vi.fn(),
    navigation: [],
    pendingDraft: "",
    retry: vi.fn(),
    sendTurn: vi.fn(),
    setPendingDraft: vi.fn(),
    status: "ready",
    upload: vi.fn(),
    discard: vi.fn(),
  } as unknown as ChatController;
}

describe("the Chat thread environment summary", () => {
  it("shows only the active tab view's Environment for two views of the same thread", async () => {
    const authoritative = controller();

    render(
      <>
        <ChatThreadEnvironment
          controller={authoritative}
          environmentOpen
          projects={[chatProject()]}
          tab={tabA}
        >
          <div>First view</div>
        </ChatThreadEnvironment>
        <ChatThreadEnvironment
          active={false}
          controller={authoritative}
          environmentOpen
          projects={[chatProject()]}
          tab={tabB}
        >
          <div>Second view</div>
        </ChatThreadEnvironment>
      </>,
    );

    expect(screen.queryByRole("button", { name: "Open Environment" })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getAllByRole("region", { name: "Environment details" })).toHaveLength(1),
    );
    expect(screen.getByText("1 attachment")).toBeVisible();
    expect(screen.getByText("First view")).toBeVisible();
    expect(screen.getByText("Second view")).toBeVisible();
  });

  it("fails closed when the authoritative thread references an unresolved Project", async () => {
    render(
      <ChatThreadEnvironment controller={controller()} environmentOpen projects={[]} tab={tabA}>
        <div />
      </ChatThreadEnvironment>,
    );

    const environment = await screen.findByRole("region", { name: "Environment details" });
    expect(environment).toHaveAttribute("data-environment-status", "unavailable");
    expect(screen.getByText("Chat · Project unavailable")).toBeVisible();
    expect(screen.getByText("Authoritative Chat context is unavailable.")).toBeVisible();
    expect(screen.queryByText("Unavailable for unfiled Chat")).not.toBeInTheDocument();
    expect(screen.queryByText("1 attachment")).not.toBeInTheDocument();
    expect(screen.queryByText("Git")).not.toBeInTheDocument();
    expect(screen.queryByText("Approvals")).not.toBeInTheDocument();
  });

  it("counts the whole thread's attachments when only its newest messages are loaded", async () => {
    const windowed = controller();
    const loaded = windowed.activeView!;
    const attachment = loaded.attachments[0]!;
    const whole = decodeChatThreadView({
      ...loaded,
      attachments: [
        attachment,
        { ...attachment, id: "10000000-0000-4000-8000-000000000002", displayName: "older.txt" },
      ],
    });
    const readWholeThread = vi.fn(async () => whole);
    render(
      <ChatThreadEnvironment
        controller={{
          ...windowed,
          readWholeThread,
          transcriptWindow: {
            threadKey: threadId,
            windowed: true,
            hasEarlier: true,
            offerEarlier: true,
            supersededTurnCount: 0,
            earlier: "idle",
            shownRun: 0,
          },
        }}
        environmentOpen
        projects={[chatProject()]}
        tab={tabA}
      >
        <div />
      </ChatThreadEnvironment>,
    );

    expect(await screen.findByText("2 attachments")).toBeVisible();
    expect(screen.queryByText("1 attachment")).not.toBeInTheDocument();
    expect(readWholeThread).toHaveBeenCalledWith(loaded.thread.id);
  });

  const windowState = {
    threadKey: threadId,
    windowed: true,
    hasEarlier: true,
    offerEarlier: true,
    supersededTurnCount: 0,
    earlier: "idle" as const,
    shownRun: 0,
  };
  const turn = (index: number) => ({
    id: `40000000-0000-4000-8000-00000000000${String(index)}`,
    threadId,
    sequence: index + 1,
    userMessageRef: {
      contentId: `50000000-0000-4000-8000-00000000000${String(index)}`,
      digest: "a".repeat(64),
      byteLength: 1,
    },
    attachmentIds: [],
    attempts: [],
    createdAt: now,
  });

  it("does not read the whole thread again when an earlier page loads", async () => {
    const base = controller();
    const loaded = base.activeView!;
    const newestOnly = decodeChatThreadView({ ...loaded, turns: [turn(2)] });
    const withEarlier = decodeChatThreadView({ ...loaded, turns: [turn(1), turn(2)] });
    const readWholeThread = vi.fn(async () => withEarlier);
    const environment = (activeView: typeof loaded) => (
      <ChatThreadEnvironment
        controller={{ ...base, activeView, readWholeThread, transcriptWindow: windowState }}
        environmentOpen
        projects={[chatProject()]}
        tab={tabA}
      >
        <div />
      </ChatThreadEnvironment>
    );
    const { rerender } = render(environment(newestOnly));
    expect(await screen.findByText("2 turns")).toBeVisible();

    rerender(environment(withEarlier));
    await waitFor(() => expect(screen.getByText("2 turns")).toBeVisible());

    expect(readWholeThread).toHaveBeenCalledOnce();
  });

  it("says when the totals could not be read and reads them again on request", async () => {
    const base = controller();
    const readWholeThread = vi
      .fn<() => Promise<NonNullable<ChatController["activeView"]>>>()
      .mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValue(base.activeView!);
    render(
      <ChatThreadEnvironment
        controller={{ ...base, readWholeThread, transcriptWindow: windowState }}
        environmentOpen
        projects={[chatProject()]}
        tab={tabA}
      >
        <div />
      </ChatThreadEnvironment>,
    );

    expect(await screen.findByText(/totals could not be read/)).toBeVisible();
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByText("1 attachment")).toBeVisible();
    expect(readWholeThread).toHaveBeenCalledTimes(2);
  });
});
