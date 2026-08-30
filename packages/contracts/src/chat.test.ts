import { describe, expect, expectTypeOf, it } from "vitest";
import type { ProviderSessionId } from "./providers";
import {
  CHAT_EVENT_NAMES,
  CHAT_ATTACHMENT_MEDIA_TYPES,
  MAX_CHAT_TURN_ATTACHMENTS,
  decodeChatAttachmentMediaType,
  decodeChatAttempt,
  decodeChatAttemptOutcome,
  decodeChatCommand,
  decodeChatCommandResult,
  decodeChatContentBody,
  decodeChatContentReference,
  decodeChatEventFrame,
  decodeChatFailure,
  decodeChatPublicEvent,
  decodeChatResearchRouting,
  decodeChatBootstrap,
  decodeChatNavigation,
  decodeChatSettings,
  decodeChatThread,
  decodeChatThreadView,
  decodeChatTurn,
  decodeChatTurnRouteDecision,
} from "./chat";
import { MAX_THREAD_MENTIONS_PER_TURN } from "./threadMention";

const now = "2026-07-19T12:00:00.000Z";

const ids = {
  thread: "00000000-0000-4000-8000-000000000001",
  turn: "00000000-0000-4000-8000-000000000002",
  attempt: "00000000-0000-4000-8000-000000000003",
  content: "00000000-0000-4000-8000-000000000004",
  attachment: "00000000-0000-4000-8000-000000000005",
  citation: "00000000-0000-4000-8000-000000000006",
  workItem: "00000000-0000-4000-8000-000000000007",
  provider: "10000000-0000-4000-8000-000000000001",
  project: "20000000-0000-4000-8000-000000000001",
  manifest: "80000000-0000-4000-8000-000000000001",
} as const;

const contentRef = {
  contentId: ids.content,
  digest: "a".repeat(64),
  byteLength: 12,
} as const;

const extensionSelection = {
  kind: "plugin",
  extensionId: "30000000-0000-4000-8000-000000000001",
  packageId: "31000000-0000-4000-8000-000000000001",
  componentId: "instructions",
  packageVersion: "1.2.3",
  packageDigest: `sha256:${"a".repeat(64)}`,
  catalogEpoch: `sha256:${"c".repeat(64)}`,
  origin: { kind: "turn", reference: ids.turn },
} as const;

const threadFixture = {
  id: ids.thread,
  title: "Provider-neutral Chat",
  lifecycle: "active",
  providerInstanceId: ids.provider,
  modelId: "model-a",
  researchEnabled: false,
  researchRouting: "automatic",
  personalityInstructions: "Be calm, direct, and useful.",
  version: 1,
  createdAt: now,
  updatedAt: now,
} as const;

const attemptFixture = {
  id: ids.attempt,
  turnId: ids.turn,
  threadId: ids.thread,
  providerInstanceId: ids.provider,
  providerSessionId: ids.provider,
  modelId: "model-a",
  contextManifestId: ids.manifest,
  outcome: "completed",
  responseRefs: [contentRef],
  citationIds: [ids.citation],
  createdAt: now,
  updatedAt: now,
} as const;

const turnFixture = {
  id: ids.turn,
  threadId: ids.thread,
  sequence: 1,
  userMessageRef: contentRef,
  attachmentIds: [ids.attachment],
  extensionSelections: [extensionSelection],
  attempts: [attemptFixture],
  createdAt: now,
} as const;

const settingsFixture = {
  defaultProviderInstanceId: ids.provider,
  defaultModelId: "model-a",
  defaultResearchEnabled: false,
  defaultResearchRouting: "automatic",
  defaultPersonalityInstructions: "Be calm, direct, and useful.",
  version: 1,
  updatedAt: now,
} as const;

describe("chat contracts", () => {
  it("decodes the exact ChatResearchRouting values and rejects unknown routing", () => {
    expect(decodeChatResearchRouting("automatic")).toBe("automatic");
    expect(decodeChatResearchRouting("searxng")).toBe("searxng");
    expect(decodeChatResearchRouting("provider-native")).toBe("provider-native");
    expect(() => decodeChatResearchRouting("default")).toThrow();
  });

  it("decodes the exact ChatAttemptOutcome values and rejects unknown outcomes", () => {
    const outcomes = [
      "queued",
      "streaming",
      "waiting",
      "interrupted",
      "failed",
      "cancelled",
      "completed",
    ] as const;
    for (const outcome of outcomes) {
      expect(decodeChatAttemptOutcome(outcome)).toBe(outcome);
    }
    expect(() => decodeChatAttemptOutcome("success")).toThrow();
  });

  it("decodes one immutable thread and rejects unknown fields", () => {
    const thread = decodeChatThread(threadFixture);
    expect(thread.researchRouting).toBe("automatic");
    expect(() => decodeChatThread({ ...thread, extra: true })).toThrow();
    expect(() => decodeChatThread({ ...thread, lifecycle: "unknown" })).toThrow();
  });

  it("decodes a normalized historical attachment handoff warning without provider payloads", () => {
    const thread = decodeChatThread({
      ...threadFixture,
      handoffWarning: {
        targetProviderInstanceId: ids.provider,
        targetModelId: "model-a",
        omittedAttachments: [
          {
            attachmentId: ids.attachment,
            displayName: "diagram.png",
            mediaType: "image/png",
            reason: "native-attachments-unsupported",
          },
        ],
        createdAt: now,
      },
    });

    expect(thread.handoffWarning?.omittedAttachments).toEqual([
      expect.objectContaining({ attachmentId: ids.attachment, displayName: "diagram.png" }),
    ]);
    expect(() =>
      decodeChatThread({
        ...thread,
        handoffWarning: { ...thread.handoffWarning, providerPayload: { legacy: true } },
      }),
    ).toThrow();
  });

  it("decodes ChatSettings and rejects unbounded or excess values", () => {
    expect(decodeChatSettings(settingsFixture)).toEqual(settingsFixture);
    expect(
      decodeChatSettings({
        defaultResearchEnabled: false,
        defaultResearchRouting: "automatic",
        defaultPersonalityInstructions: "Be calm, direct, and useful.",
        version: 0,
        updatedAt: now,
      }),
    ).toMatchObject({ version: 0 });
    expect(() => decodeChatSettings({ ...settingsFixture, defaultModelId: undefined })).toThrow();
    expect(() =>
      decodeChatSettings({ ...settingsFixture, defaultProviderInstanceId: undefined }),
    ).toThrow();
    expect(() =>
      decodeChatSettings({ ...settingsFixture, defaultResearchRouting: "auto" }),
    ).toThrow();
    expect(() => decodeChatSettings({ ...settingsFixture, secretToken: "token" })).toThrow();
  });

  it("exports the exact attachment media-type allow-list", () => {
    expect(CHAT_ATTACHMENT_MEDIA_TYPES).toEqual([
      "text/plain",
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "application/pdf",
    ]);
    for (const mediaType of CHAT_ATTACHMENT_MEDIA_TYPES) {
      expect(decodeChatAttachmentMediaType(mediaType)).toBe(mediaType);
    }
    expect(() =>
      decodeChatAttachmentMediaType(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ),
    ).toThrow();
  });

  it("decodes bounded ChatContentReference values and rejects raw or unbounded bodies", () => {
    expect(decodeChatContentReference(contentRef)).toEqual(contentRef);
    expect(() =>
      decodeChatContentReference({
        contentId: ids.content,
        digest: "not-a-sha256-digest",
        byteLength: 12,
      }),
    ).toThrow();
    expect(() =>
      decodeChatContentReference({
        contentId: ids.content,
        digest: "a".repeat(257),
        byteLength: 0,
      }),
    ).toThrow();
    expect(() =>
      decodeChatContentReference({
        contentId: ids.content,
        digest: "a".repeat(64),
        byteLength: -1,
      }),
    ).toThrow();
    expect(() =>
      decodeChatContentReference({
        contentId: ids.content,
        digest: "a".repeat(64),
        byteLength: 12,
        rawBody: "secret text",
      }),
    ).toThrow();
  });

  it("decodes ChatTurn and ChatAttempt without accepting raw response bodies", () => {
    expect(decodeChatTurn(turnFixture)).toEqual(turnFixture);
    expect(() =>
      decodeChatTurn({
        ...turnFixture,
        userMessage: "raw prompt",
      }),
    ).toThrow();

    const attempt = decodeChatAttempt(attemptFixture);
    expect(attempt).toEqual(attemptFixture);
    expectTypeOf(attempt.providerSessionId).toEqualTypeOf<ProviderSessionId>();
    expect(() =>
      decodeChatAttempt({
        ...attemptFixture,
        rawResponse: "raw assistant text",
      }),
    ).toThrow();
  });

  it("decodes ChatContentBody with bounded transcript text and rejects managed paths", () => {
    expect(
      decodeChatContentBody({
        contentId: ids.content,
        role: "user",
        body: "Hello",
        digest: "a".repeat(64),
        byteLength: 5,
      }),
    ).toEqual({
      contentId: ids.content,
      role: "user",
      body: "Hello",
      digest: "a".repeat(64),
      byteLength: 5,
    });
    expect(
      decodeChatContentBody({
        contentId: ids.content,
        role: "assistant",
        body: "Hello",
        digest: "a".repeat(64),
        byteLength: 5,
        parts: [
          { kind: "reasoning", text: "think" },
          { kind: "tool", name: "web_search", status: "done", summary: "ok" },
          { kind: "markdown", text: "Hello" },
        ],
      }).parts,
    ).toEqual([
      { kind: "reasoning", text: "think" },
      { kind: "tool", name: "web_search", status: "done", summary: "ok" },
      { kind: "markdown", text: "Hello" },
    ]);
    expect(() =>
      decodeChatContentBody({
        contentId: ids.content,
        role: "user",
        body: "Hello",
        digest: "a".repeat(64),
        byteLength: 5,
        managedPath: "/tmp/secret",
      }),
    ).toThrow();
  });

  it("decodes ChatBootstrap with settings and thread summaries", () => {
    expect(
      decodeChatBootstrap({
        settings: settingsFixture,
        threads: [threadFixture],
      }),
    ).toEqual({
      settings: settingsFixture,
      threads: [threadFixture],
    });
  });

  it("decodes navigation rows without admitting transcript-shaped fields", () => {
    expect(
      decodeChatNavigation({
        threads: [
          {
            id: ids.thread,
            title: "Planning",
            providerInstanceId: ids.provider,
            updatedAt: now,
            lastSequence: 7,
            followUpOpen: true,
            executing: true,
          },
        ],
      }),
    ).toMatchObject({
      threads: [{ id: ids.thread, lastSequence: 7, followUpOpen: true, executing: true }],
    });
    // An older host that omits executing still decodes; the row is not working.
    expect(
      decodeChatNavigation({
        threads: [
          {
            id: ids.thread,
            title: "Planning",
            providerInstanceId: ids.provider,
            updatedAt: now,
            lastSequence: 7,
            followUpOpen: false,
          },
        ],
      }).threads[0]?.executing,
    ).toBe(false);
    expect(() =>
      decodeChatNavigation({
        threads: [
          {
            id: ids.thread,
            title: "Planning",
            providerInstanceId: ids.provider,
            updatedAt: now,
            lastSequence: 7,
            followUpOpen: true,
            turns: [],
          },
        ],
      }),
    ).toThrow();
  });

  it("decodes ChatThreadView with decoded transcript content, attachments, citations, work, and follow-up", () => {
    const view = {
      thread: threadFixture,
      turns: [turnFixture],
      lastSequence: 7,
      contents: [
        {
          contentId: ids.content,
          role: "user",
          body: "Hello",
          digest: "a".repeat(64),
          byteLength: 5,
        },
      ],
      attachments: [
        {
          id: ids.attachment,
          threadId: ids.thread,
          displayName: "diagram.png",
          mediaType: "image/png",
          byteLength: 128,
          digest: "b".repeat(64),
          status: "finalized",
          createdAt: now,
        },
      ],
      citations: [
        {
          citationId: ids.citation,
          threadId: ids.thread,
          turnId: ids.turn,
          attemptId: ids.attempt,
          sourceTitle: "Source",
          sourceUrl: "https://example.test/source",
          backend: "searxng",
          retrievedAt: now,
        },
      ],
      workItems: [
        {
          id: ids.workItem,
          threadId: ids.thread,
          title: "Follow up",
          status: "pending",
          position: 0,
          origin: "user",
          version: 1,
          createdAt: now,
          updatedAt: now,
        },
      ],
      workListVersion: 3,
      followUpVersion: 2,
      followUp: {
        threadId: ids.thread,
        state: "open",
        origin: "manual",
        reason: "Needs review",
        triggerSequence: 5,
        acknowledgedThroughSequence: 0,
        createdAt: now,
      },
    } as const;
    expect(decodeChatThreadView(view)).toEqual(view);
    expect(() =>
      decodeChatThreadView({
        ...view,
        turns: [{ ...turnFixture, attempts: [{ ...attemptFixture, outcome: "unknown" }] }],
      }),
    ).toThrow();
  });

  it("decodes a structurally valid retry for domain policy evaluation", () => {
    expect(() =>
      decodeChatCommand({
        kind: "retry-chat-turn",
        threadId: ids.thread,
        turnId: ids.turn,
        attemptId: ids.attempt,
        expectedVersion: 4,
      }),
    ).not.toThrow();
  });

  it("decodes a structurally valid resume-chat-turn command", () => {
    const decoded = decodeChatCommand({
      kind: "resume-chat-turn",
      threadId: ids.thread,
      turnId: ids.turn,
      attemptId: ids.attempt,
      expectedVersion: 4,
    });
    expect(decoded.kind).toBe("resume-chat-turn");
    expect(() =>
      decodeChatCommand({
        kind: "resume-chat-turn",
        threadId: ids.thread,
        turnId: ids.turn,
        attemptId: ids.attempt,
        expectedVersion: 4,
        prompt: "extra",
      }),
    ).toThrow();
  });

  it("decodes ChatAttempt with an optional provider resume cursor and rejects invalid cursors", () => {
    const withCursor = decodeChatAttempt({
      ...attemptFixture,
      resumeCursor: { driverKind: "openai-compatible", value: "opaque-session-ref" },
    });
    expect(withCursor.resumeCursor).toEqual({
      driverKind: "openai-compatible",
      value: "opaque-session-ref",
    });
    expect(decodeChatAttempt(attemptFixture).resumeCursor).toBeUndefined();
    expect(() =>
      decodeChatAttempt({
        ...attemptFixture,
        resumeCursor: { driverKind: "openai-compatible", value: "" },
      }),
    ).toThrow();
  });

  it("decodes create-chat-thread with title and optional project only", () => {
    expect(
      decodeChatCommand({
        kind: "create-chat-thread",
        title: "New thread",
      }).kind,
    ).toBe("create-chat-thread");
    expect(
      decodeChatCommand({
        kind: "create-chat-thread",
        title: "Host-compatible internal thread",
        hostId: "local",
      }).kind,
    ).toBe("create-chat-thread");
    expect(() =>
      decodeChatCommand({
        kind: "create-chat-thread",
        title: "New thread",
        hostId: "local",
        providerInstanceId: ids.provider,
      }),
    ).toThrow();
    expect(
      decodeChatCommand({
        kind: "create-chat-thread",
        title: "From an issue",
        issueContext: { owner: "octant", name: "octant", number: 7 },
      }),
    ).toMatchObject({
      kind: "create-chat-thread",
      issueContext: { owner: "octant", name: "octant", number: 7 },
    });
    expect(
      decodeChatCommand({
        kind: "create-chat-thread",
        title: "From a Linear issue",
        linearIssueContext: { id: "11111111-1111-4111-8111-111111111111" },
      }),
    ).toMatchObject({
      kind: "create-chat-thread",
      linearIssueContext: { id: "11111111-1111-4111-8111-111111111111" },
    });
    expect(() =>
      decodeChatCommand({
        kind: "create-chat-thread",
        title: "From an issue",
        issueContext: { owner: "octant", name: "octant", number: 7, body: "assembled" },
      }),
    ).toThrow();
    expect(() =>
      decodeChatCommand({
        kind: "create-chat-thread",
        title: "From a Linear issue",
        linearIssueContext: {
          id: "11111111-1111-4111-8111-111111111111",
          title: "assembled",
        },
      }),
    ).toThrow();
  });

  it("reserves deleting and deleted lifecycle states for the purge workflow", () => {
    for (const lifecycle of ["active", "archived"] as const) {
      expect(
        decodeChatCommand({
          kind: "change-chat-thread-lifecycle",
          threadId: ids.thread,
          expectedVersion: 1,
          lifecycle,
        }).kind,
      ).toBe("change-chat-thread-lifecycle");
    }
    for (const lifecycle of ["deleting", "deleted"] as const) {
      expect(() =>
        decodeChatCommand({
          kind: "change-chat-thread-lifecycle",
          threadId: ids.thread,
          expectedVersion: 1,
          lifecycle,
        }),
      ).toThrow();
    }
  });

  it("decodes ChatCommand variants and rejects unknown kinds or fields", () => {
    expect(
      decodeChatCommand({
        kind: "send-chat-turn",
        threadId: ids.thread,
        expectedVersion: 3,
        prompt: "Hello",
        attachmentIds: [ids.attachment],
        extensionSelections: [extensionSelection],
      }).kind,
    ).toBe("send-chat-turn");

    expect(() =>
      decodeChatCommand({
        kind: "send-chat-turn",
        threadId: ids.thread,
        expectedVersion: 3,
        prompt: "Too many attachments",
        attachmentIds: Array.from({ length: MAX_CHAT_TURN_ATTACHMENTS + 1 }, () => ids.attachment),
      }),
    ).toThrow();

    // A `#thread` mention travels as the id of a thread the server re-checks
    // at turn time, never as transcript text the browser resolved.
    expect(
      decodeChatCommand({
        kind: "send-chat-turn",
        threadId: ids.thread,
        expectedVersion: 3,
        prompt: "Compare this with that thread",
        threadMentionIds: [ids.thread],
      }).kind,
    ).toBe("send-chat-turn");

    expect(() =>
      decodeChatCommand({
        kind: "send-chat-turn",
        threadId: ids.thread,
        expectedVersion: 3,
        prompt: "Too many mentions",
        threadMentionIds: Array.from(
          { length: MAX_THREAD_MENTIONS_PER_TURN + 1 },
          () => ids.thread,
        ),
      }),
    ).toThrow();

    expect(
      decodeChatCommand({
        kind: "update-chat-settings",
        expectedVersion: 2,
        defaultProviderInstanceId: ids.provider,
        defaultModelId: "model-a",
        defaultResearchEnabled: true,
        defaultResearchRouting: "searxng",
        defaultPersonalityInstructions: "Be helpful.",
      }).kind,
    ).toBe("update-chat-settings");

    expect(
      decodeChatCommand({
        kind: "add-chat-work-item",
        threadId: ids.thread,
        expectedVersion: 1,
        itemId: ids.workItem,
        title: "Follow up",
        status: "pending",
        position: 0,
        origin: "user",
      }).kind,
    ).toBe("add-chat-work-item");

    expect(
      decodeChatCommand({
        kind: "open-chat-follow-up",
        threadId: ids.thread,
        expectedVersion: 1,
        reason: "Needs review",
        origin: "manual",
        triggerSequence: 5,
      }).kind,
    ).toBe("open-chat-follow-up");

    expect(() =>
      decodeChatCommand({
        kind: "unknown-command",
        threadId: ids.thread,
        expectedVersion: 1,
      }),
    ).toThrow();
  });

  it("carries bounded model option values on the thread and the provider command", () => {
    const thread = decodeChatThread({
      ...threadFixture,
      modelOptionValues: { effort: "high", "service-tier": "fast" },
    });
    expect(thread.modelOptionValues).toEqual({ effort: "high", "service-tier": "fast" });
    expect(decodeChatThread(threadFixture).modelOptionValues).toBeUndefined();
    expect(() =>
      decodeChatThread({ ...threadFixture, modelOptionValues: { effort: " " } }),
    ).toThrow();

    const command = decodeChatCommand({
      kind: "change-chat-provider",
      threadId: ids.thread,
      expectedVersion: 1,
      providerInstanceId: ids.provider,
      modelId: "model-a",
      modelOptionValues: { effort: "low" },
    });
    expect(command.kind === "change-chat-provider" && command.modelOptionValues).toEqual({
      effort: "low",
    });
    expect(() =>
      decodeChatCommand({
        kind: "change-chat-provider",
        threadId: ids.thread,
        expectedVersion: 1,
        providerInstanceId: ids.provider,
        modelId: "model-a",
        modelOptionValues: { effort: "x".repeat(65) },
      }),
    ).toThrow();
  });

  it("keeps raw message bodies out of public events and uses bounded ChatContentReference", () => {
    const turnCreated = {
      kind: "turn-created",
      turn: turnFixture,
    } as const;
    expect(decodeChatPublicEvent(turnCreated).kind).toBe("turn-created");
    expect(() =>
      decodeChatPublicEvent({
        kind: "turn-created",
        turn: { ...turnFixture, userMessage: "raw" },
      }),
    ).toThrow();

    const attemptUpdated = {
      kind: "attempt-updated",
      attempt: attemptFixture,
    } as const;
    expect(decodeChatPublicEvent(attemptUpdated).kind).toBe("attempt-updated");
    expect(() =>
      decodeChatPublicEvent({
        kind: "attempt-updated",
        attempt: { ...attemptFixture, rawResearchQuery: "q" },
      }),
    ).toThrow();
  });

  it("decodes ChatEventFrame with a public event and rejects unknown fields", () => {
    const frame = {
      threadId: ids.thread,
      sequence: 1,
      event: {
        kind: "thread-created",
        thread: threadFixture,
      },
    } as const;
    expect(decodeChatEventFrame(frame)).toEqual(frame);
    expect(() =>
      decodeChatEventFrame({
        ...frame,
        rawEventPayload: "secret",
      }),
    ).toThrow();
  });

  it("decodes ChatCommandResult and ChatFailure with strict categories", () => {
    const result = {
      kind: "thread-created",
      thread: threadFixture,
    } as const;
    expect(decodeChatCommandResult(result).kind).toBe("thread-created");

    expect(decodeChatFailure({ category: "unavailable", message: "Service down" })).toEqual({
      category: "unavailable",
      message: "Service down",
    });
    expect(() =>
      decodeChatFailure({
        category: "unknown-category",
        message: "Something",
      }),
    ).toThrow();
    expect(() =>
      decodeChatFailure({
        category: "unavailable",
        message: "Service down",
        raw: "diagnostic",
      }),
    ).toThrow();
  });

  it("publishes the versioned chat event vocabulary", () => {
    expect(CHAT_EVENT_NAMES).toEqual([
      "chat.settings-updated@1",
      "chat.thread-created@1",
      "chat.thread-updated@1",
      "chat.turn-created@1",
      "chat.attempt-updated@1",
      "chat.turn-route-decided@1",
      "chat.attachment-updated@1",
      "chat.citation-recorded@1",
      "thread.work-updated@1",
      "thread.follow-up-updated@1",
      "chat.deletion-requested@1",
      "chat.deleted@1",
    ]);
  });

  describe("multi-model pool routing", () => {
    const poolFixture = {
      candidates: [
        { hostId: "local", providerInstanceId: ids.provider, modelId: "model-a" },
        { hostId: "local", providerInstanceId: ids.provider, modelId: "model-b" },
      ],
      mixedVendorEnabled: false,
      fallbackAllowed: true,
      higherCostFallbackAllowed: false,
    } as const;

    const eligibilityFixture = [
      {
        candidate: poolFixture.candidates[0],
        eligible: true,
        reasons: [],
      },
      {
        candidate: poolFixture.candidates[1],
        eligible: false,
        reasons: ["provider-not-ready"],
      },
    ] as const;

    const selectionRequestFixture = {
      pool: poolFixture,
      requiredCapabilities: [],
    } as const;

    const selectedDecisionFixture = {
      kind: "selected",
      request: selectionRequestFixture,
      mode: "chat",
      activeHostId: "local",
      parentCandidate: poolFixture.candidates[0],
      eligibility: eligibilityFixture,
      selectedCandidate: poolFixture.candidates[0],
      selectionKind: "requested",
      reason: "The requested model is selected and eligible for this execution unit.",
    } as const;

    it("decodes a thread carrying an optional multi-model pool and rejects an invalid one", () => {
      const thread = decodeChatThread({ ...threadFixture, multiModelPool: poolFixture });
      expect(thread.multiModelPool).toEqual(poolFixture);
      expect(decodeChatThread(threadFixture).multiModelPool).toBeUndefined();
      expect(() =>
        decodeChatThread({
          ...threadFixture,
          multiModelPool: { ...poolFixture, candidates: [poolFixture.candidates[0]] },
        }),
      ).toThrow();
    });

    it("decodes select-chat-multi-model-pool to set or clear the thread's pool", () => {
      const select = decodeChatCommand({
        kind: "select-chat-multi-model-pool",
        threadId: ids.thread,
        expectedVersion: 4,
        pool: poolFixture,
      });
      expect(select.kind).toBe("select-chat-multi-model-pool");
      const clear = decodeChatCommand({
        kind: "select-chat-multi-model-pool",
        threadId: ids.thread,
        expectedVersion: 4,
      });
      expect(clear.kind).toBe("select-chat-multi-model-pool");
      expect(() =>
        decodeChatCommand({
          kind: "select-chat-multi-model-pool",
          threadId: ids.thread,
          expectedVersion: 4,
          pool: poolFixture,
          extra: true,
        }),
      ).toThrow();
    });

    it("decodes a durable ChatTurnRouteDecision and rejects unknown fields", () => {
      const decision = {
        threadId: ids.thread,
        turnId: ids.turn,
        decision: selectedDecisionFixture,
        decidedAt: now,
      } as const;
      expect(decodeChatTurnRouteDecision(decision)).toEqual(decision);
      expect(() => decodeChatTurnRouteDecision({ ...decision, extra: true })).toThrow();
    });

    it("decodes a turn-route-decided public event scoped to its thread", () => {
      const event = decodeChatPublicEvent({
        kind: "turn-route-decided",
        decision: {
          threadId: ids.thread,
          turnId: ids.turn,
          decision: selectedDecisionFixture,
          decidedAt: now,
        },
      });
      expect(event.kind).toBe("turn-route-decided");
    });

    it("decodes ChatThreadView with an optional array of route decisions", () => {
      const withDecisions = {
        thread: threadFixture,
        turns: [turnFixture],
        lastSequence: 7,
        contents: [],
        attachments: [],
        citations: [],
        workItems: [],
        workListVersion: 0,
        followUpVersion: 0,
        routeDecisions: [
          {
            threadId: ids.thread,
            turnId: ids.turn,
            decision: selectedDecisionFixture,
            decidedAt: now,
          },
        ],
      } as const;
      expect(decodeChatThreadView(withDecisions)).toEqual(withDecisions);
      const withoutDecisions = { ...withDecisions, routeDecisions: undefined };
      delete (withoutDecisions as { routeDecisions?: unknown }).routeDecisions;
      expect(decodeChatThreadView(withoutDecisions).routeDecisions).toBeUndefined();
    });
  });

  describe("revising and branching a conversation", () => {
    const revisedTurnId = "00000000-0000-4000-8000-0000000000a1";
    const branchThreadId = "00000000-0000-4000-8000-0000000000a2";

    it("carries a revision marker on a turn without letting it name itself", () => {
      const revised = { ...turnFixture, id: revisedTurnId, supersedes: ids.turn };
      expect(decodeChatTurn(revised).supersedes).toBe(ids.turn);
      expect(decodeChatTurn(turnFixture).supersedes).toBeUndefined();
      expect(() => decodeChatTurn({ ...turnFixture, supersedes: ids.turn })).toThrow();
    });

    it("records branch provenance on the branch, never on the source", () => {
      const branchedFrom = {
        threadId: ids.thread,
        turnId: ids.turn,
        sourceVersion: 4,
        carriedTurnCount: 2,
        omittedAttachmentCount: 1,
        branchedAt: now,
      } as const;
      expect(
        decodeChatThread({ ...threadFixture, id: branchThreadId, branchedFrom }).branchedFrom,
      ).toEqual(branchedFrom);
      expect(decodeChatThread(threadFixture).branchedFrom).toBeUndefined();
      // A thread cannot claim to be branched from itself.
      expect(() => decodeChatThread({ ...threadFixture, branchedFrom })).toThrow();
    });

    it("requires an expected version on both new commands and refuses extra authority fields", () => {
      const edit = {
        kind: "edit-chat-turn",
        threadId: ids.thread,
        expectedVersion: 3,
        turnId: ids.turn,
        prompt: "Revised",
      } as const;
      expect(decodeChatCommand(edit)).toEqual(edit);
      expect(() => decodeChatCommand({ ...edit, expectedVersion: undefined })).toThrow();

      const branch = {
        kind: "branch-chat-thread",
        threadId: ids.thread,
        expectedVersion: 3,
        turnId: ids.turn,
        title: "Second direction",
        branchThreadId,
      } as const;
      expect(decodeChatCommand(branch)).toEqual(branch);
      expect(() => decodeChatCommand({ ...branch, expectedVersion: undefined })).toThrow();
      // Neither command may carry a provider, model, or Project of its own:
      // those stay server-owned so a branch cannot widen or re-route scope.
      expect(() => decodeChatCommand({ ...branch, projectId: ids.project })).toThrow();
      expect(() => decodeChatCommand({ ...branch, modelId: "model-b" })).toThrow();
    });
  });
});
