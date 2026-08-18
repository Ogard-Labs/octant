import type { ChatClient } from "@octant/client-runtime/chat-client";
import {
  decodeChatBootstrap,
  decodeChatThreadId,
  decodeChatThreadView,
  type ChatThreadView,
} from "@octant/contracts/chat";
import type { ZenSourceContext, ZenThreadCatalogEntry } from "@octant/contracts/zen";
import type { ZenThreadCardActivity } from "@octant/domain";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createChatReadCursorStore } from "../chat/useChatController";
import { resolveZenLiveThreadCard } from "./ZenLiveThreadCards";

const now = "2026-07-28T12:00:00.000Z";
const providerInstanceId = "10000000-0000-4000-8000-000000000001";
const cardThreadId = decodeChatThreadId("00000000-0000-4000-8000-000000000941");
const otherThreadId = decodeChatThreadId("00000000-0000-4000-8000-000000000942");

function thread(id: string, title: string) {
  return {
    id,
    title,
    lifecycle: "active",
    providerInstanceId,
    modelId: "model-a",
    researchEnabled: false,
    researchRouting: "automatic",
    personalityInstructions: "Be calm.",
    version: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function view(id: string, title: string): ChatThreadView {
  return decodeChatThreadView({
    thread: thread(id, title),
    turns: [],
    lastSequence: 1,
    contents: [],
    attachments: [],
    citations: [],
    workItems: [],
    workListVersion: 0,
    followUpVersion: 0,
  });
}

function chatClient(requested: string[]): ChatClient {
  return {
    bootstrap: vi.fn(async () =>
      decodeChatBootstrap({
        settings: {
          defaultProviderInstanceId: providerInstanceId,
          defaultModelId: "model-a",
          defaultResearchEnabled: false,
          defaultResearchRouting: "automatic",
          defaultPersonalityInstructions: "Be calm.",
          version: 1,
          updatedAt: now,
        },
        threads: [
          thread(String(cardThreadId), "Card thread"),
          thread(String(otherThreadId), "Workspace thread"),
        ],
      }),
    ),
    thread: vi.fn(async (id: unknown) => {
      requested.push(String(id));
      return String(id) === String(cardThreadId)
        ? view(String(cardThreadId), "Card thread")
        : view(String(otherThreadId), "Workspace thread");
    }),
    subscribe: vi.fn(async function* () {}),
    search: vi.fn(async () => []),
    execute: vi.fn(),
    upload: vi.fn(),
    discard: vi.fn(),
  } as unknown as ChatClient;
}

function sourceContext(kind: "chat" | "code", threadId: string): ZenSourceContext {
  return {
    hostId: "local-host",
    mode: kind,
    projectId: null,
    threadKind: kind,
    threadId,
  } as unknown as ZenSourceContext;
}

function catalogEntry(context: ZenSourceContext): ZenThreadCatalogEntry {
  return {
    catalogRef: `${context.threadKind}:${context.threadId}`,
    hostId: context.hostId,
    hostLabel: "This Mac",
    mode: context.mode,
    projectId: null,
    projectLabel: "Unfiled",
    threadId: context.threadId,
    title: "Card thread",
    status: "active",
    recentActivityAt: now,
    providerInstanceId,
    modelId: "model-a",
    sourceContext: context,
  } as unknown as ZenThreadCatalogEntry;
}

const live: ZenThreadCardActivity = {
  elementId: "00000000-0000-4000-8000-000000000951" as never,
  activity: "live",
};

describe("resolveZenLiveThreadCard", () => {
  it("opens the conversation the card was attached to, not the one the shell has open", async () => {
    const requested: string[] = [];
    const context = sourceContext("chat", String(cardThreadId));
    const card = resolveZenLiveThreadCard({
      sourceContext: context,
      entry: catalogEntry(context),
      activity: live,
      clients: {
        chatClient: chatClient(requested),
        chatReadCursorStore: createChatReadCursorStore(),
      },
    });

    expect(card?.status).toBe("streaming");
    render(<>{card?.status === "streaming" ? card.surface : null}</>);

    await waitFor(() => expect(requested).toEqual([String(cardThreadId)]));
    expect(await screen.findByRole("textbox", { name: "Message" })).toBeInTheDocument();
  });

  it("reports a paused card without opening its stream", () => {
    const requested: string[] = [];
    const context = sourceContext("chat", String(cardThreadId));
    const card = resolveZenLiveThreadCard({
      sourceContext: context,
      entry: catalogEntry(context),
      activity: { elementId: live.elementId, activity: "frozen", reason: "off-screen" },
      clients: {
        chatClient: chatClient(requested),
        chatReadCursorStore: createChatReadCursorStore(),
      },
    });

    expect(card).toEqual({ status: "paused", reason: "off-screen" });
    expect(requested).toEqual([]);
  });

  it("offers no live card for a mode this window cannot host in the focus zone", () => {
    const context = sourceContext("code", String(cardThreadId));

    expect(
      resolveZenLiveThreadCard({
        sourceContext: context,
        entry: catalogEntry(context),
        activity: live,
        clients: {
          chatClient: chatClient([]),
          chatReadCursorStore: createChatReadCursorStore(),
        },
      }),
    ).toBeUndefined();
  });

  it("offers no live card when the window has no Chat surface to lend", () => {
    const context = sourceContext("chat", String(cardThreadId));

    expect(
      resolveZenLiveThreadCard({
        sourceContext: context,
        entry: catalogEntry(context),
        activity: live,
        clients: {},
      }),
    ).toBeUndefined();
  });
});
