// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mobileChatMessages,
  type MobileModelOption,
  type MobileProviderDirectoryEntry,
} from "@octant/client-runtime";
import { decodeChatThreadView } from "@octant/contracts/chat";
import { ThemeProvider } from "../../design-system/theme";
import { TranscriptHandoffDivider } from "./TranscriptHandoffDivider";
import {
  mobileChatHandoffPlacements,
  resolveMobileTranscriptHandoff,
  type MobileTranscriptHandoffEntry,
} from "./transcriptHandoffPresentation";

vi.mock("react-native", () => vi.importActual("react-native-web"));
vi.mock("expo-blur", () => ({ BlurView: () => null }));
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

    const placements = mobileChatHandoffPlacements(view, modelOptions);
    expect(placements.beforeContentId.get(user1Id)).toBeUndefined();
    expect(placements.beforeContentId.get(reply1bId)?.[0]?.kind).toBe("context-handoff");
    expect(placements.beforeContentId.get(reply1bId)?.[0]?.route?.from.label).toBe("GPT-5.3");
    expect(placements.beforeContentId.get(reply1bId)?.[0]?.route?.to.label).toBe("Sonnet 4");
    expect(placements.beforeContentId.get(user2Id)?.[0]?.kind).toBe("model-switch");
    expect(placements.beforeContentId.get(user2Id)?.[0]?.route?.from.label).toBe("Sonnet 4");
    expect(placements.beforeContentId.get(user2Id)?.[0]?.route?.to.label).toBe("Opus 4");
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

    const placements = mobileChatHandoffPlacements(view, modelOptions);
    const afterUser = placements.afterContentId.get(userId);
    expect(afterUser).toHaveLength(2);
    expect(afterUser?.[0]?.route?.from.label).toBe("GPT-5.3");
    expect(afterUser?.[0]?.route?.to.label).toBe("Sonnet 4");
    expect(afterUser?.[0]?.disclosure).toContain("Handed over 4 recent messages");
    expect(afterUser?.[1]?.route?.from.label).toBe("GPT-5.3");
    expect(afterUser?.[1]?.route?.to.label).toBe("Sonnet 4");
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

    const messages = mobileChatMessages(view);
    const placements = mobileChatHandoffPlacements(view, modelOptions);
    const renderedSequence: string[] = [];
    for (const { content } of messages) {
      const id = String(content.contentId);
      for (const entry of placements.beforeContentId.get(id) ?? []) {
        renderedSequence.push(`divider:${entry.heading}:${entry.route?.to.label ?? ""}`);
      }
      renderedSequence.push(`message:${content.body}`);
      for (const entry of placements.afterContentId.get(id) ?? []) {
        renderedSequence.push(`divider:${entry.heading}:${entry.route?.to.label ?? ""}`);
      }
    }
    for (const entry of placements.trailing) {
      renderedSequence.push(`divider:${entry.heading}:${entry.route?.to.label ?? ""}`);
    }

    expect(renderedSequence).toEqual([
      "message:Try again",
      "divider:Context handoff:Sonnet 4",
      "divider:Model switch:Opus 4",
      "message:Recovered on Opus 4",
    ]);
  });
});
