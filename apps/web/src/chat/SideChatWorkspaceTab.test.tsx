import userEvent from "@testing-library/user-event";
import { decodeThreadMentionCommandResult } from "@octant/contracts";
import {
  composerThreadDrafts,
  COMPOSER_THREAD_DRAFTS_STORAGE_KEY,
} from "../composer/composerThreadDraftStore";
import { ChatClientFailure, type ChatClient } from "@octant/client-runtime/chat-client";
import type { ThreadMentionClient } from "@octant/client-runtime";
import { decodeChatBootstrap, decodeChatThreadView } from "@octant/contracts/chat";
import type { ChatThreadView } from "@octant/contracts/chat";
import type { SideChatSidecar } from "@octant/contracts";
import { decodeWorkspaceTab } from "@octant/contracts/shell";
import { act, render, screen, waitFor } from "@testing-library/react";
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

it("returns one selected finished answer to the source's editable saved draft without sending or queuing", async () => {
  const user = userEvent.setup();
  const { answered, reference, turnId, attemptId } = answeredSidecar();
  const chatClient = chatClientStub({ thread: vi.fn(async () => answered) });
  const mentionClient = mentionClientStub();
  const prepare = vi.fn(async () =>
    decodeThreadMentionCommandResult({
      kind: "side-chat-draft-prepared",
      requestId: tabId,
      reference,
      destination: {
        threadId: sourceThreadId,
        mode: "work",
        title: "Busy source",
        version: 7,
        busy: true,
      },
      text: "Chosen answer with visible original-source versions unrecorded; other replies omitted.",
      omissions: ["Other replies omitted."],
    }),
  );
  const returnClient = { ...mentionClient, execute: prepare };
  composerThreadDrafts.clear("work", sourceThreadId);
  composerThreadDrafts.write("work", sourceThreadId, {
    text: "My existing busy-task draft",
    caretIndex: 3,
    stagedDropped: false,
  });
  const rendered = render(
    <SideChatWorkspaceTab
      chatClient={chatClient}
      chatReadCursorStore={readCursorStore}
      tab={sideChatTab()}
      threadMentionClient={returnClient}
    />,
  );
  await screen.findByText("Chosen answer");
  await user.click(screen.getByRole("button", { name: "Reply actions" }));
  await user.click(await screen.findByRole("menuitem", { name: "Use in source draft" }));
  await screen.findByText(/Added to the source’s saved draft/);
  expect(prepare).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: "prepare-side-chat-return",
      sidecarThreadId,
      expectedSourceThreadId: sourceThreadId,
      turnId,
      attemptId,
    }),
    expect.any(AbortSignal),
  );
  expect(composerThreadDrafts.read("work", sourceThreadId)).toMatchObject({
    text: expect.stringContaining("My existing busy-task draft\n\nChosen answer"),
    caretIndex: 3,
    sideChatReturns: [reference],
  });
  const stored = globalThis.localStorage.getItem(COMPOSER_THREAD_DRAFTS_STORAGE_KEY)!;
  expect(JSON.parse(stored)[`work:${sourceThreadId}`].sideChatReturns).toEqual([reference]);
  expect(chatClient.execute).not.toHaveBeenCalled();
  rendered.unmount();
  composerThreadDrafts.reloadFromStorage();
  expect(composerThreadDrafts.read("work", sourceThreadId)?.sideChatReturns).toEqual([reference]);
  composerThreadDrafts.clear("work", sourceThreadId);
});

function answeredSidecar() {
  const turnId = "00000000-0000-4000-8000-000000000411";
  const attemptId = "00000000-0000-4000-8000-000000000412";
  const replyContent = "00000000-0000-4000-8000-000000000413";
  const userContent = "00000000-0000-4000-8000-000000000414";
  const reference = {
    sidecarThreadId,
    sourceThreadId,
    sourceMode: "work",
    turnId,
    attemptId,
    answerDigest: "b".repeat(64),
  };
  const view = sidecarView();
  const answered = decodeChatThreadView({
    ...view,
    turns: [
      {
        id: turnId,
        threadId: sidecarThreadId,
        sequence: 1,
        userMessageRef: { contentId: userContent, digest: "a".repeat(64), byteLength: 8 },
        attachmentIds: [],
        attempts: [
          {
            id: attemptId,
            turnId,
            threadId: sidecarThreadId,
            providerInstanceId: providerId,
            providerSessionId: tabId,
            modelId: "model-a",
            contextManifestId: tabId,
            outcome: "completed",
            responseRefs: [{ contentId: replyContent, digest: "b".repeat(64), byteLength: 6 }],
            citationIds: [],
            createdAt: now,
            updatedAt: now,
          },
        ],
        createdAt: now,
      },
    ],
    contents: [
      {
        contentId: userContent,
        role: "user",
        body: "Question",
        digest: "a".repeat(64),
        byteLength: 8,
      },
      {
        contentId: replyContent,
        role: "assistant",
        body: "Chosen answer",
        digest: "b".repeat(64),
        byteLength: 13,
      },
    ],
  });
  return { answered, reference, turnId, attemptId };
}

it("ignores a prepared return arriving after the Side Chat tab unmounts", async () => {
  const user = userEvent.setup();
  const { answered, reference } = answeredSidecar();
  const response = Promise.withResolvers<ReturnType<typeof decodeThreadMentionCommandResult>>();
  const prepare = vi.fn((_command: unknown, _signal?: AbortSignal) => response.promise);
  const rendered = render(
    <SideChatWorkspaceTab
      chatClient={chatClientStub({ thread: vi.fn(async () => answered) })}
      chatReadCursorStore={readCursorStore}
      tab={sideChatTab()}
      threadMentionClient={{ ...mentionClientStub(), execute: prepare }}
    />,
  );
  composerThreadDrafts.clear("work", sourceThreadId);
  await screen.findByText("Chosen answer");
  await user.click(screen.getByRole("button", { name: "Reply actions" }));
  await user.click(await screen.findByRole("menuitem", { name: "Use in source draft" }));
  expect(prepare).toHaveBeenCalledOnce();
  rendered.unmount();
  expect(prepare.mock.calls[0]![1]!.aborted).toBe(true);
  response.resolve(
    decodeThreadMentionCommandResult({
      kind: "side-chat-draft-prepared",
      requestId: tabId,
      reference,
      destination: { threadId: sourceThreadId, mode: "work", title: "Source", version: 1 },
      text: "Late answer",
      omissions: [],
    }),
  );
  await response.promise;
  await Promise.resolve();
  expect(composerThreadDrafts.read("work", sourceThreadId)).toBeUndefined();
});

it("bounds a held prepare read, permits explicit retry and suppresses its late answer", async () => {
  const user = userEvent.setup();
  const { answered, reference } = answeredSidecar();
  const held = Promise.withResolvers<ReturnType<typeof decodeThreadMentionCommandResult>>();
  const result = decodeThreadMentionCommandResult({
    kind: "side-chat-draft-prepared",
    requestId: tabId,
    reference,
    destination: { threadId: sourceThreadId, mode: "work", title: "Source", version: 1 },
    text: "Chosen returned answer",
    omissions: [],
  });
  const prepare = vi
    .fn()
    .mockImplementationOnce(() => held.promise)
    .mockResolvedValueOnce(result);
  const clock = vi.spyOn(globalThis, "setTimeout");
  composerThreadDrafts.clear("work", sourceThreadId);
  const rendered = render(
    <SideChatWorkspaceTab
      chatClient={chatClientStub({ thread: vi.fn(async () => answered) })}
      chatReadCursorStore={readCursorStore}
      tab={sideChatTab()}
      threadMentionClient={{ ...mentionClientStub(), execute: prepare }}
    />,
  );
  try {
    await screen.findByText("Chosen answer");
    await user.click(screen.getByRole("button", { name: "Reply actions" }));
    await user.click(await screen.findByRole("menuitem", { name: "Use in source draft" }));
    const deadline = clock.mock.calls.find((call) => call[1] === 20_000)?.[0];
    if (typeof deadline !== "function") throw new Error("missing bounded preparation wait");
    await act(async () => {
      deadline();
    });
    expect(prepare.mock.calls[0]![1].aborted).toBe(true);
    expect(await screen.findByText(/This reply could not be added/)).toBeVisible();
    expect(composerThreadDrafts.read("work", sourceThreadId)).toBeUndefined();
    await act(async () => {
      held.resolve(result);
      await held.promise;
    });
    expect(composerThreadDrafts.read("work", sourceThreadId)).toBeUndefined();
    await user.click(screen.getByRole("button", { name: "Reply actions" }));
    const retry = await screen.findByRole("menuitem", { name: "Use in source draft" });
    expect(retry).not.toHaveAttribute("aria-disabled", "true");
    await user.click(retry);
    await screen.findByText(/Added to the source’s saved draft/);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(composerThreadDrafts.read("work", sourceThreadId)?.text).toBe("Chosen returned answer");
  } finally {
    rendered.unmount();
    clock.mockRestore();
    composerThreadDrafts.clear("work", sourceThreadId);
  }
});
