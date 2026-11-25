// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type MobileModelOption, type MobileProviderDirectoryEntry } from "@octant/client-runtime";
import { decodeChatThreadView, type ChatThreadView } from "@octant/contracts/chat";
import { ThemeProvider } from "../../design-system/theme";
import { ThreadTranscript, type ThreadTranscriptProps } from "../inbox/thread/ThreadTranscript";
import { TranscriptHandoffDivider } from "./TranscriptHandoffDivider";
import {
  resolveMobileTranscriptHandoff,
  type MobileTranscriptHandoffEntry,
} from "./transcriptHandoffPresentation";

vi.mock("react-native", () => vi.importActual("react-native-web"));
vi.mock("expo-blur", () => ({ BlurView: () => null }));
vi.mock("expo-clipboard", () => ({ setStringAsync: vi.fn(async () => true) }));
vi.mock("@expo/vector-icons", () => ({ Ionicons: () => null }));
vi.mock("../../design-system", async () => ({
  ...(await import("../../design-system/theme")),
  ...(await import("../../design-system/tokens")),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const roots: Root[] = [];
afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    act(() => root?.unmount());
  }
  document.body.replaceChildren();
});

const codexId = "10000000-0000-4000-8000-000000000001";
const claudeId = "10000000-0000-4000-8000-000000000002";
const claudeWorkId = "10000000-0000-4000-8000-000000000003";

const modelOptions: ReadonlyArray<MobileModelOption> = [
  {
    id: `${codexId}::gpt-5.3`,
    providerInstanceId: codexId,
    modelId: "gpt-5.3",
    label: "GPT-5.3",
    detail: "Codex",
    driverKind: "codex",
    attachmentModalities: ["text"],
  },
  {
    id: `${claudeId}::claude-sonnet-4`,
    providerInstanceId: claudeId,
    modelId: "claude-sonnet-4",
    label: "Sonnet 4",
    detail: "Claude Personal",
    driverKind: "claude",
    attachmentModalities: ["text"],
  },
  {
    id: `${claudeId}::claude-opus-4`,
    providerInstanceId: claudeId,
    modelId: "claude-opus-4",
    label: "Opus 4",
    detail: "Claude Personal",
    driverKind: "claude",
    attachmentModalities: ["text"],
  },
  {
    id: `${claudeWorkId}::claude-sonnet-4`,
    providerInstanceId: claudeWorkId,
    modelId: "claude-sonnet-4",
    label: "Sonnet 4",
    detail: "Claude Work",
    driverKind: "claude",
    attachmentModalities: ["text"],
  },
];

function renderDivider(entry: MobileTranscriptHandoffEntry): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  act(() =>
    root.render(
      createElement(ThemeProvider, null, createElement(TranscriptHandoffDivider, { entry })),
    ),
  );
  return host;
}

function renderChatTranscript(view: ChatThreadView): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const chat: ThreadTranscriptProps["chat"] = {
    view,
    activeAttempt: undefined,
    retryableAttempt: undefined,
    pendingPrompt: undefined,
    pendingFailure: undefined,
    pendingAttachments: [],
    modelOptionId: undefined,
    setModelOptionId: vi.fn(),
    reconnecting: false,
    refresh: vi.fn(async () => {}),
    attach: vi.fn(async () => {}),
    attachmentsSent: () => undefined,
    send: vi.fn(async () => undefined),
    stop: vi.fn(async () => {}),
    retry: vi.fn(async () => {}),
    completeWorkItem: vi.fn(),
    cancelWorkItem: vi.fn(),
    completeFollowUp: vi.fn(),
  };
  act(() =>
    root.render(
      createElement(
        ThemeProvider,
        null,
        createElement(ThreadTranscript, {
          workTurns: undefined,
          codeConversation: undefined,
          chat,
          allowProductMutations: false,
          turnActionsFor: () => [],
          replyDetail: "low",
          modelOptions,
        }),
      ),
    ),
  );
  return host;
}

const emptyOmissions = {
  earlierMessages: 0,
  unfinishedReplies: 0,
  missingBodies: 0,
  oversizedBodies: 0,
  emptyBodies: 0,
  attachments: 0,
  truncatedMessages: 0,
  truncatedCharacters: 0,
  sourceTruncatedMessages: 0,
};

describe("TranscriptHandoffDivider on the phone", () => {
  it("renders a context handoff with source and target models and its disclosure note", () => {
    const entry = resolveMobileTranscriptHandoff({
      previous: { providerInstanceId: codexId, modelId: "gpt-5.3" },
      current: { providerInstanceId: claudeId, modelId: "claude-sonnet-4" },
      handoff: {
        reason: "provider-switch",
        previousProviderInstanceId: codexId as never,
        previousModelId: "gpt-5.3" as never,
        messages: 5,
        omissions: { ...emptyOmissions, earlierMessages: 2 },
        externalContentIngested: false,
        nativeSessionTransferred: false,
        hiddenReasoningTransferred: false,
      },
      modelOptions,
    });

    expect(entry).toBeDefined();
    const host = renderDivider(entry!);
    expect(host.textContent).toContain("Context handoff");
    expect(host.textContent).toContain("GPT-5.3");
    expect(host.textContent).toContain("Sonnet 4");
    expect(host.textContent).toContain(
      "Handed over 5 recent messages from Codex — GPT-5.3 as text.",
    );
    expect(host.textContent).toContain("Left out: 2 earlier messages.");
    expect(host.textContent).toContain(
      "Hidden reasoning, tool activity and the previous session did not transfer.",
    );
  });

  it("names both accounts when moving to another account running the same model", () => {
    const entry = resolveMobileTranscriptHandoff({
      previous: { providerInstanceId: claudeId, modelId: "claude-sonnet-4" },
      current: { providerInstanceId: claudeWorkId, modelId: "claude-sonnet-4" },
      handoff: {
        reason: "account-move",
        previousProviderInstanceId: claudeId as never,
        previousModelId: "claude-sonnet-4" as never,
        nativeSessionTransferred: true,
      },
      modelOptions,
    });

    expect(entry?.route?.from.label).toBe("Claude Personal · Sonnet 4");
    expect(entry?.route?.to.label).toBe("Claude Work · Sonnet 4");
    expect(entry?.route?.showToMark).toBe(true);
    expect(entry?.disclosure).toContain("copied into this account and continued");
  });

  it("distinguishes an in-session model switch from a context handoff and draws one provider mark", () => {
    const entry = resolveMobileTranscriptHandoff({
      previous: { providerInstanceId: claudeId, modelId: "claude-sonnet-4" },
      current: { providerInstanceId: claudeId, modelId: "claude-opus-4" },
      modelOptions,
    });

    expect(entry?.kind).toBe("model-switch");
    expect(entry?.route?.showToMark).toBe(false);
    expect(entry?.disclosure).toBeUndefined();
    const host = renderDivider(entry!);
    expect(host.textContent).toContain("Model switch");
    expect(host.textContent).toContain("Sonnet 4");
    expect(host.textContent).toContain("Opus 4");
  });

  it("places turn-to-turn handoffs on the next user message and retry handoffs on the retry reply", () => {
    const now = "2026-11-24T12:00:00.000Z";
    const threadId = "00000000-0000-4000-8000-000000000801";
    const turn1Id = "00000000-0000-4000-8000-000000000802";
    const turn2Id = "00000000-0000-4000-8000-000000000803";
    const user1Id = "00000000-0000-4000-8000-000000000811";
    const reply1aId = "00000000-0000-4000-8000-000000000812";
    const reply1bId = "00000000-0000-4000-8000-000000000813";
    const user2Id = "00000000-0000-4000-8000-000000000814";
    const reply2Id = "00000000-0000-4000-8000-000000000815";
    const ref = (contentId: string) => ({ contentId, digest: "a".repeat(64), byteLength: 10 });
    const body = (contentId: string, role: "user" | "assistant", text: string) => ({
      contentId,
      role,
      body: text,
      byteLength: text.length,
      digest: "a".repeat(64),
    });
    const view = decodeChatThreadView({
      thread: {
        id: threadId,
        title: "Handoff",
        lifecycle: "active",
        providerInstanceId: claudeId,
        modelId: "claude-opus-4",
        researchEnabled: false,
        researchRouting: "automatic",
        personalityInstructions: "Be calm.",
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
      lastSequence: 2,
      turns: [
        {
          id: turn1Id,
          threadId,
          sequence: 1,
          userMessageRef: ref(user1Id),
          attachmentIds: [],
          attempts: [
            {
              id: "10000000-0000-4000-8000-000000000821",
              turnId: turn1Id,
              threadId,
              providerInstanceId: codexId,
              providerSessionId: "20000000-0000-4000-8000-000000000821",
              modelId: "gpt-5.3",
              contextManifestId: "30000000-0000-4000-8000-000000000821",
              outcome: "interrupted",
              responseRefs: [ref(reply1aId)],
              citationIds: [],
              createdAt: now,
              updatedAt: now,
            },
            {
              id: "10000000-0000-4000-8000-000000000822",
              turnId: turn1Id,
              threadId,
              providerInstanceId: claudeId,
              providerSessionId: "20000000-0000-4000-8000-000000000822",
              modelId: "claude-sonnet-4",
              contextManifestId: "30000000-0000-4000-8000-000000000822",
              outcome: "completed",
              responseRefs: [ref(reply1bId)],
              citationIds: [],
              createdAt: now,
              updatedAt: now,
            },
          ],
          createdAt: now,
        },
        {
          id: turn2Id,
          threadId,
          sequence: 2,
          userMessageRef: ref(user2Id),
          attachmentIds: [],
          attempts: [
            {
              id: "10000000-0000-4000-8000-000000000823",
              turnId: turn2Id,
              threadId,
              providerInstanceId: claudeId,
              providerSessionId: "20000000-0000-4000-8000-000000000822",
              modelId: "claude-opus-4",
              contextManifestId: "30000000-0000-4000-8000-000000000823",
              outcome: "completed",
              responseRefs: [ref(reply2Id)],
              citationIds: [],
              createdAt: now,
              updatedAt: now,
            },
          ],
          createdAt: now,
        },
      ],
      contents: [
        body(user1Id, "user", "First prompt"),
        body(reply1aId, "assistant", "Partial"),
        body(reply1bId, "assistant", "Recovered"),
        body(user2Id, "user", "Second prompt"),
        body(reply2Id, "assistant", "Done"),
      ],
      attachments: [],
      citations: [],
      workItems: [],
      workListVersion: 0,
      followUpVersion: 0,
    });

    const host = renderChatTranscript(view);
    const renderedIds = Array.from(host.querySelectorAll("[data-testid]"))
      .map((element) => element.getAttribute("data-testid") ?? "")
      .filter(
        (id) =>
          /^mobile-message-[0-9a-f-]{36}$/.test(id) ||
          /^mobile-chat-handoff-(?:after-)?[0-9a-f-]{36}(?:-\d+)?$/.test(id),
      );
    expect(renderedIds).toEqual([
      `mobile-message-${user1Id}`,
      `mobile-message-${reply1aId}`,
      `mobile-chat-handoff-${reply1bId}`,
      `mobile-message-${reply1bId}`,
      `mobile-chat-handoff-${user2Id}`,
      `mobile-message-${user2Id}`,
      `mobile-message-${reply2Id}`,
    ]);
    const retryDivider = host.querySelector(`[data-testid="mobile-chat-handoff-${reply1bId}"]`);
    expect(retryDivider?.textContent).toContain("Context handoff");
    expect(retryDivider?.textContent).toContain("GPT-5.3");
    expect(retryDivider?.textContent).toContain("Sonnet 4");
    const turnDivider = host.querySelector(`[data-testid="mobile-chat-handoff-${user2Id}"]`);
    expect(turnDivider?.textContent).toContain("Model switch");
    expect(turnDivider?.textContent).toContain("Sonnet 4");
    expect(turnDivider?.textContent).toContain("Opus 4");
  });

  it("prefers the recorded handoff source when a stopped handoff repeats on the destination provider", () => {
    const entry = resolveMobileTranscriptHandoff({
      previous: { providerInstanceId: claudeId, modelId: "claude-sonnet-4" },
      current: { providerInstanceId: claudeId, modelId: "claude-sonnet-4" },
      handoff: {
        reason: "provider-switch",
        previousProviderInstanceId: codexId as never,
        previousModelId: "gpt-5.3" as never,
        messages: 3,
        omissions: emptyOmissions,
        externalContentIngested: false,
        nativeSessionTransferred: false,
        hiddenReasoningTransferred: false,
      },
      modelOptions,
    });

    expect(entry?.kind).toBe("context-handoff");
    expect(entry?.route?.from.label).toBe("GPT-5.3");
    expect(entry?.route?.to.label).toBe("Sonnet 4");
  });

  it("keeps an explicit fork label when the fork opens on a different model of the same provider", () => {
    const entry = resolveMobileTranscriptHandoff({
      previous: { providerInstanceId: claudeId, modelId: "claude-sonnet-4" },
      current: { providerInstanceId: claudeId, modelId: "claude-opus-4" },
      handoff: {
        reason: "fork",
        messages: 2,
        omissions: emptyOmissions,
        externalContentIngested: false,
        nativeSessionTransferred: false,
        hiddenReasoningTransferred: false,
      },
      modelOptions,
    });

    expect(entry?.kind).toBe("fork");
    expect(entry?.heading).toBe("Forked context");
    expect(entry?.route?.from.label).toBe("Sonnet 4");
    expect(entry?.route?.to.label).toBe("Opus 4");
  });

  it("resolves disabled or unready historical accounts from the provider directory", () => {
    const disabledId = "10000000-0000-4000-8000-000000000099";
    const directory: ReadonlyArray<MobileProviderDirectoryEntry> = [
      {
        providerInstanceId: disabledId,
        displayName: "Retired Codex",
        driverKind: "codex",
        models: [{ modelId: "gpt-5.2", displayName: "GPT-5.2" }],
      },
      {
        providerInstanceId: claudeId,
        displayName: "Claude Personal",
        driverKind: "claude",
        models: [{ modelId: "claude-sonnet-4", displayName: "Sonnet 4" }],
      },
    ];
    const entry = resolveMobileTranscriptHandoff({
      previous: { providerInstanceId: disabledId, modelId: "gpt-5.2" },
      current: { providerInstanceId: claudeId, modelId: "claude-sonnet-4" },
      handoff: {
        reason: "provider-switch",
        previousProviderInstanceId: disabledId as never,
        previousModelId: "gpt-5.2" as never,
        messages: 2,
        omissions: emptyOmissions,
        externalContentIngested: false,
        nativeSessionTransferred: false,
        hiddenReasoningTransferred: false,
      },
      modelOptions: modelOptions.filter((option) => option.providerInstanceId === claudeId),
      providerDirectory: directory,
    });

    expect(entry?.route?.from.label).toBe("GPT-5.2");
    expect(entry?.route?.from.monogram).toBe("RC");
    expect(entry?.disclosure).toContain("Retired Codex — GPT-5.2");
  });

  it("keeps recorded handoffs for consecutive replyless Chat retries in attempt order", () => {
    const now = "2026-11-24T12:00:00.000Z";
    const threadId = "00000000-0000-4000-8000-000000000901";
    const turnId = "00000000-0000-4000-8000-000000000902";
    const userId = "00000000-0000-4000-8000-000000000911";
    const ref = (contentId: string) => ({ contentId, digest: "b".repeat(64), byteLength: 10 });
    const view = decodeChatThreadView({
      thread: {
        id: threadId,
        title: "Retry handoff",
        lifecycle: "active",
        providerInstanceId: claudeWorkId,
        modelId: "claude-sonnet-4",
        researchEnabled: false,
        researchRouting: "automatic",
        personalityInstructions: "Be calm.",
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
      lastSequence: 1,
      turns: [
        {
          id: turnId,
          threadId,
          sequence: 1,
          userMessageRef: ref(userId),
          attachmentIds: [],
          attempts: [
            {
              id: "10000000-0000-4000-8000-000000000921",
              turnId,
              threadId,
              providerInstanceId: codexId,
              providerSessionId: "20000000-0000-4000-8000-000000000921",
              modelId: "gpt-5.3",
              contextManifestId: "30000000-0000-4000-8000-000000000921",
              outcome: "interrupted",
              responseRefs: [],
              citationIds: [],
              createdAt: now,
              updatedAt: now,
            },
            {
              id: "10000000-0000-4000-8000-000000000922",
              turnId,
              threadId,
              providerInstanceId: claudeId,
              providerSessionId: "20000000-0000-4000-8000-000000000922",
              modelId: "claude-sonnet-4",
              contextManifestId: "30000000-0000-4000-8000-000000000922",
              outcome: "failed",
              responseRefs: [],
              citationIds: [],
              handoff: {
                reason: "provider-switch",
                previousProviderInstanceId: codexId,
                previousModelId: "gpt-5.3",
                messages: 4,
                omissions: emptyOmissions,
                externalContentIngested: false,
                nativeSessionTransferred: false,
                hiddenReasoningTransferred: false,
              },
              createdAt: now,
              updatedAt: now,
            },
            {
              id: "10000000-0000-4000-8000-000000000923",
              turnId,
              threadId,
              providerInstanceId: claudeWorkId,
              providerSessionId: "20000000-0000-4000-8000-000000000923",
              modelId: "claude-sonnet-4",
              contextManifestId: "30000000-0000-4000-8000-000000000923",
              outcome: "interrupted",
              responseRefs: [],
              citationIds: [],
              handoff: {
                reason: "provider-switch",
                previousProviderInstanceId: codexId,
                previousModelId: "gpt-5.3",
                messages: 4,
                omissions: emptyOmissions,
                externalContentIngested: false,
                nativeSessionTransferred: false,
                hiddenReasoningTransferred: false,
              },
              createdAt: now,
              updatedAt: now,
            },
          ],
          createdAt: now,
        },
      ],
      contents: [
        {
          contentId: userId,
          role: "user",
          body: "Retry me",
          byteLength: 8,
          digest: "b".repeat(64),
        },
      ],
      attachments: [],
      citations: [],
      workItems: [],
      workListVersion: 0,
      followUpVersion: 0,
    });

    const host = renderChatTranscript(view);
    const renderedIds = Array.from(host.querySelectorAll("[data-testid]"))
      .map((element) => element.getAttribute("data-testid") ?? "")
      .filter(
        (id) =>
          /^mobile-message-[0-9a-f-]{36}$/.test(id) ||
          /^mobile-chat-handoff-(?:after-)?[0-9a-f-]{36}(?:-\d+)?$/.test(id),
      );
    expect(renderedIds).toEqual([
      `mobile-message-${userId}`,
      `mobile-chat-handoff-after-${userId}-0`,
      `mobile-chat-handoff-after-${userId}-1`,
    ]);
    const firstDivider = host.querySelector(
      `[data-testid="mobile-chat-handoff-after-${userId}-0"]`,
    );
    const secondDivider = host.querySelector(
      `[data-testid="mobile-chat-handoff-after-${userId}-1"]`,
    );
    expect(firstDivider?.textContent).toContain("GPT-5.3");
    expect(firstDivider?.textContent).toContain("Sonnet 4");
    expect(firstDivider?.textContent).toContain("Handed over 4 recent messages");
    expect(secondDivider?.textContent).toContain("GPT-5.3");
    expect(secondDivider?.textContent).toContain("Sonnet 4");
  });

  it("keeps a replyless retry handoff ahead of a later retry reply even when reply ids sort before prompt ids", () => {
    const now = "2026-11-24T12:00:00.000Z";
    const threadId = "00000000-0000-4000-8000-000000000951";
    const turnId = "00000000-0000-4000-8000-000000000952";
    // Reply UUID sorts before user UUID, reproducing SQLite content_id ASC order.
    const replyId = "00000000-0000-4000-8000-000000000010";
    const userId = "00000000-0000-4000-8000-000000000999";
    const ref = (contentId: string) => ({ contentId, digest: "c".repeat(64), byteLength: 10 });
    const view = decodeChatThreadView({
      thread: {
        id: threadId,
        title: "Retry ordering",
        lifecycle: "active",
        providerInstanceId: claudeId,
        modelId: "claude-opus-4",
        researchEnabled: false,
        researchRouting: "automatic",
        personalityInstructions: "Be calm.",
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
      lastSequence: 1,
      turns: [
        {
          id: turnId,
          threadId,
          sequence: 1,
          userMessageRef: ref(userId),
          attachmentIds: [],
          attempts: [
            {
              id: "10000000-0000-4000-8000-000000000961",
              turnId,
              threadId,
              providerInstanceId: codexId,
              providerSessionId: "20000000-0000-4000-8000-000000000961",
              modelId: "gpt-5.3",
              contextManifestId: "30000000-0000-4000-8000-000000000961",
              outcome: "interrupted",
              responseRefs: [],
              citationIds: [],
              createdAt: now,
              updatedAt: now,
            },
            {
              id: "10000000-0000-4000-8000-000000000962",
              turnId,
              threadId,
              providerInstanceId: claudeId,
              providerSessionId: "20000000-0000-4000-8000-000000000962",
              modelId: "claude-sonnet-4",
              contextManifestId: "30000000-0000-4000-8000-000000000962",
              outcome: "failed",
              responseRefs: [],
              citationIds: [],
              handoff: {
                reason: "provider-switch",
                previousProviderInstanceId: codexId,
                previousModelId: "gpt-5.3",
                messages: 2,
                omissions: emptyOmissions,
                externalContentIngested: false,
                nativeSessionTransferred: false,
                hiddenReasoningTransferred: false,
              },
              createdAt: now,
              updatedAt: now,
            },
            {
              id: "10000000-0000-4000-8000-000000000963",
              turnId,
              threadId,
              providerInstanceId: claudeId,
              providerSessionId: "20000000-0000-4000-8000-000000000962",
              modelId: "claude-opus-4",
              contextManifestId: "30000000-0000-4000-8000-000000000963",
              outcome: "completed",
              responseRefs: [ref(replyId)],
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
          contentId: replyId,
          role: "assistant",
          body: "Recovered on Opus 4",
          byteLength: 19,
          digest: "c".repeat(64),
        },
        {
          contentId: userId,
          role: "user",
          body: "Try again",
          byteLength: 9,
          digest: "c".repeat(64),
        },
      ],
      attachments: [],
      citations: [],
      workItems: [],
      workListVersion: 0,
      followUpVersion: 0,
    });

    const host = renderChatTranscript(view);
    const renderedIds = Array.from(host.querySelectorAll("[data-testid]"))
      .map((element) => element.getAttribute("data-testid") ?? "")
      .filter(
        (id) =>
          /^mobile-message-[0-9a-f-]{36}$/.test(id) ||
          /^mobile-chat-handoff-(?:after-)?[0-9a-f-]{36}(?:-\d+)?$/.test(id),
      );

    expect(renderedIds).toEqual([
      `mobile-message-${userId}`,
      `mobile-chat-handoff-after-${userId}-0`,
      `mobile-chat-handoff-${replyId}`,
      `mobile-message-${replyId}`,
    ]);
    const text = host.textContent ?? "";
    expect(text.indexOf("Try again")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("Context handoff")).toBeGreaterThan(text.indexOf("Try again"));
    expect(text.indexOf("Model switch")).toBeGreaterThan(text.indexOf("Context handoff"));
    expect(text.indexOf("Recovered on Opus 4")).toBeGreaterThan(text.indexOf("Model switch"));
  });

  it("keeps Sees images attribution on its owning turn instead of rendering the description after later turns", () => {
    const now = "2026-11-24T12:00:00.000Z";
    const threadId = "00000000-0000-4000-8000-000000000971";
    const turn1Id = "00000000-0000-4000-8000-000000000972";
    const turn2Id = "00000000-0000-4000-8000-000000000973";
    const user1Id = "00000000-0000-4000-8000-000000000974";
    const reply1Id = "00000000-0000-4000-8000-000000000975";
    const descriptionId = "00000000-0000-4000-8000-000000000976";
    const user2Id = "00000000-0000-4000-8000-000000000977";
    const reply2Id = "00000000-0000-4000-8000-000000000978";
    const attachmentId = "00000000-0000-4000-8000-000000000979";
    const ref = (contentId: string) => ({ contentId, digest: "d".repeat(64), byteLength: 10 });
    const body = (contentId: string, role: "user" | "assistant", text: string) => ({
      contentId,
      role,
      body: text,
      byteLength: text.length,
      digest: "d".repeat(64),
    });
    const view = decodeChatThreadView({
      thread: {
        id: threadId,
        title: "Described image",
        lifecycle: "active",
        providerInstanceId: claudeId,
        modelId: "claude-sonnet-4",
        researchEnabled: false,
        researchRouting: "automatic",
        personalityInstructions: "Be calm.",
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
      lastSequence: 2,
      turns: [
        {
          id: turn1Id,
          threadId,
          sequence: 1,
          userMessageRef: ref(user1Id),
          attachmentIds: [attachmentId],
          attempts: [
            {
              id: "10000000-0000-4000-8000-000000000981",
              turnId: turn1Id,
              threadId,
              providerInstanceId: claudeId,
              providerSessionId: "20000000-0000-4000-8000-000000000981",
              modelId: "claude-sonnet-4",
              contextManifestId: "30000000-0000-4000-8000-000000000981",
              describedImages: [
                {
                  attachmentId,
                  name: "login.png",
                  describedBy: { provider: "Local Vision", model: "Vision" },
                  description: ref(descriptionId),
                },
              ],
              outcome: "completed",
              responseRefs: [ref(reply1Id)],
              citationIds: [],
              createdAt: now,
              updatedAt: now,
            },
          ],
          createdAt: now,
        },
        {
          id: turn2Id,
          threadId,
          sequence: 2,
          userMessageRef: ref(user2Id),
          attachmentIds: [],
          attempts: [
            {
              id: "10000000-0000-4000-8000-000000000982",
              turnId: turn2Id,
              threadId,
              providerInstanceId: claudeId,
              providerSessionId: "20000000-0000-4000-8000-000000000981",
              modelId: "claude-sonnet-4",
              contextManifestId: "30000000-0000-4000-8000-000000000982",
              outcome: "completed",
              responseRefs: [ref(reply2Id)],
              citationIds: [],
              createdAt: now,
              updatedAt: now,
            },
          ],
          createdAt: now,
        },
      ],
      contents: [
        body(user1Id, "user", "What is on login.png?"),
        body(reply1Id, "assistant", "A sign-in form with email and password."),
        body(descriptionId, "user", "INTERNAL SEES IMAGES TEXT"),
        body(user2Id, "user", "Unrelated follow-up"),
        body(reply2Id, "assistant", "Follow-up answer"),
      ],
      attachments: [],
      citations: [],
      workItems: [],
      workListVersion: 0,
      followUpVersion: 0,
    });

    const host = renderChatTranscript(view);
    const renderedIds = Array.from(host.querySelectorAll("[data-testid]"))
      .map((element) => element.getAttribute("data-testid") ?? "")
      .filter(
        (id) =>
          /^mobile-message-[0-9a-f-]{36}$/.test(id) ||
          id.startsWith("mobile-chat-described-images-"),
      );

    expect(renderedIds).toEqual([
      `mobile-message-${user1Id}`,
      `mobile-chat-described-images-${reply1Id}-0`,
      `mobile-message-${reply1Id}`,
      `mobile-message-${user2Id}`,
      `mobile-message-${reply2Id}`,
    ]);
    expect(host.textContent).toContain("login.png described by Vision (Local Vision)");
    expect(host.textContent).not.toContain("INTERNAL SEES IMAGES TEXT");
  });

  it("keeps an earlier replyless attempt's image attribution above a later retry's handoff divider", () => {
    const now = "2026-11-24T12:00:00.000Z";
    const threadId = "00000000-0000-4000-8000-000000000991";
    const turnId = "00000000-0000-4000-8000-000000000992";
    const userId = "00000000-0000-4000-8000-000000000993";
    const descriptionId = "00000000-0000-4000-8000-000000000994";
    const attachmentId = "00000000-0000-4000-8000-000000000995";
    const ref = (contentId: string) => ({ contentId, digest: "e".repeat(64), byteLength: 10 });
    const view = decodeChatThreadView({
      thread: {
        id: threadId,
        title: "Replyless image retry",
        lifecycle: "active",
        providerInstanceId: claudeId,
        modelId: "claude-sonnet-4",
        researchEnabled: false,
        researchRouting: "automatic",
        personalityInstructions: "Be calm.",
        version: 1,
        createdAt: now,
        updatedAt: now,
      },
      lastSequence: 1,
      turns: [
        {
          id: turnId,
          threadId,
          sequence: 1,
          userMessageRef: ref(userId),
          attachmentIds: [attachmentId],
          attempts: [
            {
              id: "10000000-0000-4000-8000-000000000996",
              turnId,
              threadId,
              providerInstanceId: codexId,
              providerSessionId: "20000000-0000-4000-8000-000000000996",
              modelId: "gpt-5.3",
              contextManifestId: "30000000-0000-4000-8000-000000000996",
              describedImages: [
                {
                  attachmentId,
                  name: "screen.png",
                  describedBy: { provider: "Local Vision", model: "Vision" },
                  description: ref(descriptionId),
                },
              ],
              outcome: "failed",
              responseRefs: [],
              citationIds: [],
              createdAt: now,
              updatedAt: now,
            },
            {
              id: "10000000-0000-4000-8000-000000000997",
              turnId,
              threadId,
              providerInstanceId: claudeId,
              providerSessionId: "20000000-0000-4000-8000-000000000997",
              modelId: "claude-sonnet-4",
              contextManifestId: "30000000-0000-4000-8000-000000000997",
              outcome: "interrupted",
              responseRefs: [],
              citationIds: [],
              handoff: {
                reason: "provider-switch",
                previousProviderInstanceId: codexId,
                previousModelId: "gpt-5.3",
                messages: 1,
                omissions: emptyOmissions,
                externalContentIngested: false,
                nativeSessionTransferred: false,
                hiddenReasoningTransferred: false,
              },
              createdAt: now,
              updatedAt: now,
            },
          ],
          createdAt: now,
        },
      ],
      contents: [
        {
          contentId: userId,
          role: "user",
          body: "Inspect screen.png",
          byteLength: 18,
          digest: "e".repeat(64),
        },
        {
          contentId: descriptionId,
          role: "user",
          body: "INTERNAL DESCRIPTION",
          byteLength: 20,
          digest: "e".repeat(64),
        },
      ],
      attachments: [],
      citations: [],
      workItems: [],
      workListVersion: 0,
      followUpVersion: 0,
    });

    const host = renderChatTranscript(view);
    const renderedIds = Array.from(host.querySelectorAll("[data-testid]"))
      .map((element) => element.getAttribute("data-testid") ?? "")
      .filter(
        (id) =>
          /^mobile-message-[0-9a-f-]{36}$/.test(id) ||
          /^mobile-chat-handoff-(?:after-)?[0-9a-f-]{36}(?:-\d+)?$/.test(id) ||
          id.startsWith("mobile-chat-described-images-"),
      );

    expect(renderedIds).toEqual([
      `mobile-message-${userId}`,
      `mobile-chat-described-images-after-${userId}-0`,
      `mobile-chat-handoff-after-${userId}-1`,
    ]);
  });
});
