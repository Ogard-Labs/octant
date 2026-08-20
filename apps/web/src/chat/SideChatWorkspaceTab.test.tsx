import { ChatClientFailure, type ChatClient } from "@octant/client-runtime/chat-client";
import type { ThreadMentionClient } from "@octant/client-runtime";
import { decodeChatBootstrap, decodeChatThreadView } from "@octant/contracts/chat";
import type { ChatThreadView } from "@octant/contracts/chat";
import type { SideChatSidecar } from "@octant/contracts";
import { decodeWorkspaceTab } from "@octant/contracts/shell";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { SideChatWorkspaceTab } from "./SideChatWorkspaceTab";
import { createChatReadCursorStore } from "./useChatController";

const now = "2026-08-14T10:00:00.000Z";
const providerId = "10000000-0000-4000-8000-000000000001";
const sourceThreadId = "00000000-0000-4000-8000-000000000101";
const sidecarThreadId = "00000000-0000-4000-8000-000000000201";
const otherSidecarThreadId = "00000000-0000-4000-8000-000000000202";
const tabId = "00000000-0000-4000-8000-000000000301";

function sideChatTab(overrides: Record<string, unknown> = {}) {
  const payload: Record<string, unknown> = {
    kind: "side-chat",
    id: tabId,
    mode: "work",
    title: "Side Chat about Release notes",
    sourceThreadId,
    sidecarThreadId,
    ...overrides,
  };
  if (payload.sidecarThreadId === undefined) delete payload.sidecarThreadId;
  const tab = decodeWorkspaceTab(payload);
  if (tab.kind !== "side-chat") throw new Error("expected a Side Chat tab");
  return tab;
}

function sidecarView(): ChatThreadView {
  return decodeChatThreadView({
    thread: {
      id: sidecarThreadId,
      title: "Side Chat about Release notes",
      lifecycle: "active",
      providerInstanceId: providerId,
      modelId: "model-a",
      researchEnabled: false,
      researchRouting: "automatic",
      personalityInstructions: "Be calm.",
      version: 1,
      createdAt: now,
      updatedAt: now,
    },
    turns: [],
    lastSequence: 0,
    contents: [],
    attachments: [],
    citations: [],
    workItems: [],
    workListVersion: 0,
    followUpVersion: 0,
  });
}

/**
 * The host hides sidecars from every Chat listing, so `bootstrap` never names
 * the sidecar thread; only a direct read returns it.
 */
function chatClientStub(overrides: Partial<ChatClient> = {}): ChatClient {
  return {
    bootstrap: vi.fn(async () =>
      decodeChatBootstrap({
        settings: {
          defaultProviderInstanceId: providerId,
          defaultModelId: "model-a",
          defaultResearchEnabled: false,
          defaultResearchRouting: "automatic",
          defaultPersonalityInstructions: "Be calm.",
          version: 1,
          updatedAt: now,
        },
        threads: [],
      }),
    ),
    thread: vi.fn(async () => sidecarView()),
    subscribe: vi.fn(async function* () {}),
    search: vi.fn(async () => []),
    execute: vi.fn(),
    upload: vi.fn(),
    discard: vi.fn(),
    ...overrides,
  } as unknown as ChatClient;
}

function mentionClientStub(resolvedSidecarThreadId = sidecarThreadId): ThreadMentionClient {
  const sidecar = {
    sourceThreadId,
    sourceMode: "work",
    sidecarThreadId: resolvedSidecarThreadId,
    title: "Side Chat about Release notes",
    createdAt: now,
  } as unknown as SideChatSidecar;
  return {
    search: vi.fn(),
    resolve: vi.fn(),
    openSideChat: vi.fn(async () => ({ sidecar, created: false })),
    execute: vi.fn(),
  } as unknown as ThreadMentionClient;
}

const readCursorStore = createChatReadCursorStore();

describe("SideChatWorkspaceTab", () => {
  it("reopens the sidecar the restored tab names and renders it as ordinary Chat", async () => {
    const threadMentionClient = mentionClientStub();
    const chatClient = chatClientStub();
    render(
      <SideChatWorkspaceTab
        chatClient={chatClient}
        chatReadCursorStore={readCursorStore}
        tab={sideChatTab()}
        threadMentionClient={threadMentionClient}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Chat workspace" })).toBeVisible(),
    );
    // The sidecar resolves after the surface mounts, so the calls are awaited
    // rather than asserted on the same tick: a loaded runner reaches the
    // visible region before the resolution settles.
    await waitFor(() => {
      expect(threadMentionClient.openSideChat).toHaveBeenCalledWith(
        expect.any(String),
        sourceThreadId,
      );
      expect(chatClient.thread).toHaveBeenCalledWith(sidecarThreadId);
    });
  });

  it("renders the sidecar without it appearing in any ordinary Chat listing", async () => {
    const chatClient = chatClientStub();
    render(
      <SideChatWorkspaceTab
        chatClient={chatClient}
        chatReadCursorStore={readCursorStore}
        tab={sideChatTab()}
        threadMentionClient={mentionClientStub()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Side Chat about Release notes" })).toBeVisible(),
    );
    // The surface came from a direct thread read; the host's listing stayed
    // empty, so opening the tab never unhid the sidecar.
    const bootstrapped = await (chatClient.bootstrap as ReturnType<typeof vi.fn>).mock.results[0]
      ?.value;
    expect(bootstrapped.threads).toEqual([]);
    await waitFor(() => expect(chatClient.thread).toHaveBeenCalledWith(sidecarThreadId));
  });

  it("fails closed when the host no longer knows the sidecar the tab was showing", async () => {
    render(
      <SideChatWorkspaceTab
        chatClient={chatClientStub()}
        chatReadCursorStore={readCursorStore}
        tab={sideChatTab()}
        threadMentionClient={mentionClientStub(otherSidecarThreadId)}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(
        "This tab’s Side Chat conversation no longer exists.",
      ),
    );
    expect(screen.queryByRole("region", { name: "Chat workspace" })).toBeNull();
  });

  it("fails closed with the host's words when the sidecar thread cannot be read", async () => {
    const chatClient = chatClientStub({
      thread: vi.fn(async () => {
        throw new ChatClientFailure({
          category: "invalid",
          message: "Chat thread was not found.",
        });
      }),
    });
    render(
      <SideChatWorkspaceTab
        chatClient={chatClient}
        chatReadCursorStore={readCursorStore}
        tab={sideChatTab()}
        threadMentionClient={mentionClientStub()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Chat thread was not found."),
    );
    expect(screen.queryByRole("region", { name: "Chat workspace" })).toBeNull();
  });

  it("tells the shell the sidecar identity when a launcher tab has not recorded one", async () => {
    const onSidecarOpened = vi.fn();
    render(
      <SideChatWorkspaceTab
        chatClient={chatClientStub()}
        chatReadCursorStore={readCursorStore}
        onSidecarOpened={onSidecarOpened}
        tab={sideChatTab({ sidecarThreadId: undefined })}
        threadMentionClient={mentionClientStub()}
      />,
    );

    await waitFor(() =>
      expect(onSidecarOpened).toHaveBeenCalledWith(expect.objectContaining({ sidecarThreadId })),
    );
  });

  it("does not ask the shell to replace a sidecar the restored tab already names", async () => {
    const onSidecarOpened = vi.fn();
    render(
      <SideChatWorkspaceTab
        chatClient={chatClientStub()}
        chatReadCursorStore={readCursorStore}
        onSidecarOpened={onSidecarOpened}
        tab={sideChatTab()}
        threadMentionClient={mentionClientStub()}
      />,
    );

    await waitFor(() =>
      expect(screen.getByRole("region", { name: "Chat workspace" })).toBeVisible(),
    );
    expect(onSidecarOpened).not.toHaveBeenCalled();
  });

  it("says Side Chat is unavailable when the host has no mention surface", () => {
    render(
      <SideChatWorkspaceTab
        chatClient={chatClientStub()}
        chatReadCursorStore={readCursorStore}
        tab={sideChatTab()}
      />,
    );

    expect(screen.getByText("Side Chat is not available on this host.")).toBeVisible();
  });
});
