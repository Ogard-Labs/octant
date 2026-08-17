import {
  decodeChatAttempt,
  decodeChatThread,
  decodeChatThreadId,
  decodeChatTurnId,
  decodeChatAttemptId,
  decodeChatContentId,
  decodeChatAttachmentId,
  type ChatThread,
  type ChatAttempt,
  type ChatTurn,
  type ChatContentReference,
} from "@octant/contracts/chat";
import { decodeContextManifestId } from "@octant/contracts/context";
import type { AggregateVersion, UtcTimestamp } from "@octant/contracts/events";
import {
  decodeProviderInstanceId,
  decodeProviderModelId,
  decodeProviderResumeCursor,
  decodeProviderSessionId,
} from "@octant/contracts/providers";
import { describe, expect, it } from "vitest";
import {
  ChatPolicyRejected,
  activeChatTurns,
  chatAttemptAnswered,
  archiveChatThread,
  beginChatTurn,
  changeChatProvider,
  changeChatResearch,
  chatTurnsThrough,
  createChatThread,
  requestChatThreadDeletion,
  resumeChatTurn,
  retryChatTurn,
  transitionChatAttempt,
} from "./chatPolicy";

const ids = {
  thread: decodeChatThreadId("11111111-1111-4111-8111-111111111111"),
  turn: decodeChatTurnId("22222222-2222-4222-8222-222222222222"),
  attempt: decodeChatAttemptId("33333333-3333-4333-8333-333333333333"),
  newAttempt: decodeChatAttemptId("44444444-4444-4444-8444-444444444444"),
  content: decodeChatContentId("55555555-5555-4555-8555-555555555555"),
  attachment: decodeChatAttachmentId("66666666-6666-4666-8666-666666666666"),
  provider: decodeProviderInstanceId("77777777-7777-4777-8777-777777777777"),
  newProvider: decodeProviderInstanceId("88888888-8888-4888-8888-888888888888"),
  model: decodeProviderModelId("model-a"),
  newModel: decodeProviderModelId("model-b"),
  session: decodeProviderSessionId("99999999-9999-4999-8999-999999999999"),
  newSession: decodeProviderSessionId("00000000-0000-4000-8000-000000000000"),
  context: decodeContextManifestId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
  newContext: decodeContextManifestId("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
  resumeCursor: decodeProviderResumeCursor({
    driverKind: "openai-compatible",
    value: "opaque-session-reference",
  }),
} as const;

const now = "2026-07-19T10:00:00.000Z" as UtcTimestamp;
const later = "2026-07-19T11:00:00.000Z" as UtcTimestamp;

const userMessageRef: ChatContentReference = {
  contentId: ids.content,
  digest: "a".repeat(64),
  byteLength: 12,
};

function makeThread(overrides: Partial<ChatThread> = {}): ChatThread {
  return decodeChatThread({
    id: ids.thread,
    title: "Test thread",
    lifecycle: "active",
    providerInstanceId: ids.provider,
    modelId: ids.model,
    researchEnabled: false,
    researchRouting: "automatic",
    personalityInstructions: "Be calm.",
    version: 1 as AggregateVersion,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

function makeAttempt(
  outcome: ChatAttempt["outcome"],
  options: { readonly resumeCursor?: ChatAttempt["resumeCursor"] } = {},
): ChatAttempt {
  return decodeChatAttempt({
    id: ids.attempt,
    turnId: ids.turn,
    threadId: ids.thread,
    providerInstanceId: ids.provider,
    providerSessionId: ids.session,
    modelId: ids.model,
    contextManifestId: ids.context,
    outcome,
    responseRefs: [],
    citationIds: [],
    ...(options.resumeCursor === undefined ? {} : { resumeCursor: options.resumeCursor }),
    createdAt: now,
    updatedAt: now,
  });
}

describe("chat thread lifecycle", () => {
  it("creates an immutable active thread with version 1", () => {
    const thread = createChatThread({
      id: ids.thread,
      title: "  New Chat  ",
      providerInstanceId: ids.provider,
      modelId: ids.model,
      researchEnabled: true,
      researchRouting: "automatic",
      personalityInstructions: "  Be helpful.  ",
      createdAt: now,
    });

    expect(thread).toMatchObject({
      id: ids.thread,
      title: "New Chat",
      lifecycle: "active",
      providerInstanceId: ids.provider,
      modelId: ids.model,
      researchEnabled: true,
      researchRouting: "automatic",
      personalityInstructions: "Be helpful.",
      version: 1,
      createdAt: now,
      updatedAt: now,
    });
  });

  it("rejects empty titles and instructions when creating a thread", () => {
    expect(() =>
      createChatThread({
        id: ids.thread,
        title: "   ",
        providerInstanceId: ids.provider,
        modelId: ids.model,
        researchEnabled: false,
        researchRouting: "automatic",
        personalityInstructions: "Be calm.",
        createdAt: now,
      }),
    ).toThrow(ChatPolicyRejected);
  });

  it("rejects stale expected versions on mutating commands", () => {
    const thread = makeThread();
    const stale = { expectedVersion: 2 as AggregateVersion, updatedAt: later };
    expect(() =>
      changeChatProvider(thread, {
        ...stale,
        providerInstanceId: ids.newProvider,
        modelId: ids.newModel,
      }),
    ).toThrow(ChatPolicyRejected);
    expect(() =>
      changeChatResearch(thread, { ...stale, researchEnabled: true, researchRouting: "searxng" }),
    ).toThrow(ChatPolicyRejected);
    expect(() => archiveChatThread(thread, stale)).toThrow(ChatPolicyRejected);
    expect(() => requestChatThreadDeletion(thread, stale)).toThrow(ChatPolicyRejected);
  });

  it("changes provider and model with a fresh version", () => {
    const original = makeThread();
    const updated = changeChatProvider(original, {
      providerInstanceId: ids.newProvider,
      modelId: ids.newModel,
      expectedVersion: 1 as AggregateVersion,
      updatedAt: later,
    });

    expect(updated).toMatchObject({
      providerInstanceId: ids.newProvider,
      modelId: ids.newModel,
      version: 2,
      updatedAt: later,
    });
    expect(original).toMatchObject({
      providerInstanceId: ids.provider,
      modelId: ids.model,
      version: 1,
    });
  });

  it("keeps only model option values the selected model declares and rejects undeclared ones", () => {
    const original = makeThread();
    const effortOptions = [
      { id: "effort", displayName: "Effort", kind: "selection" as const, values: ["low", "high"] },
    ] as const;
    const withEffort = changeChatProvider(original, {
      providerInstanceId: ids.provider,
      modelId: ids.model,
      expectedVersion: 1 as AggregateVersion,
      updatedAt: later,
      modelOptions: effortOptions,
      modelOptionValues: { effort: "high" },
    });
    expect(withEffort.modelOptionValues).toEqual({ effort: "high" });

    // Switching models without an explicit payload carries over only values
    // the new model still declares.
    const switched = changeChatProvider(withEffort, {
      providerInstanceId: ids.newProvider,
      modelId: ids.newModel,
      expectedVersion: 2 as AggregateVersion,
      updatedAt: later,
      modelOptions: [
        { id: "reasoning", displayName: "Reasoning", kind: "selection", values: ["low"] },
      ],
    });
    expect(switched.modelOptionValues).toBeUndefined();
    const kept = changeChatProvider(withEffort, {
      providerInstanceId: ids.provider,
      modelId: ids.newModel,
      expectedVersion: 2 as AggregateVersion,
      updatedAt: later,
      modelOptions: effortOptions,
    });
    expect(kept.modelOptionValues).toEqual({ effort: "high" });

    // Explicit empty clears; explicit undeclared option or value is rejected.
    const cleared = changeChatProvider(withEffort, {
      providerInstanceId: ids.provider,
      modelId: ids.model,
      expectedVersion: 2 as AggregateVersion,
      updatedAt: later,
      modelOptions: effortOptions,
      modelOptionValues: {},
    });
    expect(cleared.modelOptionValues).toBeUndefined();
    for (const modelOptionValues of [{ effort: "max" }, { speed: "fast" }]) {
      expect(() =>
        changeChatProvider(original, {
          providerInstanceId: ids.provider,
          modelId: ids.model,
          expectedVersion: 1 as AggregateVersion,
          updatedAt: later,
          modelOptions: effortOptions,
          modelOptionValues,
        }),
      ).toThrow(ChatPolicyRejected);
    }
  });

  it("changes research settings with a fresh version", () => {
    const original = makeThread();
    const updated = changeChatResearch(original, {
      researchEnabled: true,
      researchRouting: "searxng",
      expectedVersion: 1 as AggregateVersion,
      updatedAt: later,
    });

    expect(updated).toMatchObject({
      researchEnabled: true,
      researchRouting: "searxng",
      version: 2,
      updatedAt: later,
    });
    expect(original.researchRouting).toBe("automatic");
  });

  it("archives an active thread and rejects re-archiving", () => {
    const active = makeThread();
    const archived = archiveChatThread(active, {
      expectedVersion: 1 as AggregateVersion,
      updatedAt: later,
    });
    expect(archived.lifecycle).toBe("archived");
    expect(archived.version).toBe(2);

    expect(() =>
      archiveChatThread(archived, {
        expectedVersion: 2 as AggregateVersion,
        updatedAt: later,
      }),
    ).toThrow(ChatPolicyRejected);
  });

  it("requests explicit deletion and rejects repeated deletion requests", () => {
    const active = makeThread();
    const deleting = requestChatThreadDeletion(active, {
      expectedVersion: 1 as AggregateVersion,
      updatedAt: later,
    });
    expect(deleting.lifecycle).toBe("deleting");
    expect(deleting.version).toBe(2);

    expect(() =>
      requestChatThreadDeletion(deleting, {
        expectedVersion: 2 as AggregateVersion,
        updatedAt: later,
      }),
    ).toThrow(ChatPolicyRejected);
  });
});

describe("chat turn and attempt policy", () => {
  it("begins a turn using the sticky thread provider and a queued attempt", () => {
    const thread = makeThread();
    const turn = beginChatTurn(thread, {
      turnId: ids.turn,
      attemptId: ids.attempt,
      providerSessionId: ids.session,
      contextManifestId: ids.context,
      userMessageRef,
      attachmentIds: [ids.attachment],
      sequence: 1 as ChatTurn["sequence"],
      expectedVersion: 1 as AggregateVersion,
      createdAt: now,
    });

    expect(turn).toMatchObject({
      id: ids.turn,
      threadId: ids.thread,
      sequence: 1,
      userMessageRef,
    });
    expect(turn.attachmentIds).toEqual([ids.attachment]);
    expect(turn.attempts).toHaveLength(1);
    expect(turn.attempts[0]).toMatchObject({
      id: ids.attempt,
      providerInstanceId: ids.provider,
      modelId: ids.model,
      providerSessionId: ids.session,
      contextManifestId: ids.context,
      outcome: "queued",
      responseRefs: [],
      citationIds: [],
    });
    expect(turn.attempts[0]!.usage).toBeUndefined();
  });

  it("rejects beginning a turn on a non-active or deleting thread", () => {
    const archived = makeThread({ lifecycle: "archived" });
    const deleting = makeThread({ lifecycle: "deleting" });
    const input = {
      turnId: ids.turn,
      attemptId: ids.attempt,
      providerSessionId: ids.session,
      contextManifestId: ids.context,
      userMessageRef,
      sequence: 1 as ChatTurn["sequence"],
      expectedVersion: 1 as AggregateVersion,
      createdAt: now,
    };
    expect(() => beginChatTurn(archived, input)).toThrow(ChatPolicyRejected);
    expect(() => beginChatTurn(deleting, input)).toThrow(ChatPolicyRejected);
  });

  it("rejects retry for completed, failed, cancelled, queued, streaming, and waiting attempts", () => {
    const thread = makeThread();
    const baseRetryInput = {
      turnId: ids.turn,
      attemptId: ids.attempt,
      newAttemptId: ids.newAttempt,
      newProviderSessionId: ids.newSession,
      newContextManifestId: ids.newContext,
      expectedVersion: 1 as AggregateVersion,
      createdAt: now,
    };

    for (const outcome of [
      "completed",
      "failed",
      "cancelled",
      "queued",
      "streaming",
      "waiting",
      "interrupted",
    ] as const) {
      const attempt = makeAttempt(outcome);
      if (outcome === "failed" || outcome === "interrupted") {
        // handled separately
        continue;
      }
      expect(() => retryChatTurn(thread, attempt, baseRetryInput)).toThrow(ChatPolicyRejected);
    }
  });

  it("allows retry only for failed and interrupted attempts", () => {
    const thread = makeThread();
    const retryInput = {
      turnId: ids.turn,
      attemptId: ids.attempt,
      newAttemptId: ids.newAttempt,
      newProviderSessionId: ids.newSession,
      newContextManifestId: ids.newContext,
      expectedVersion: 1 as AggregateVersion,
      createdAt: now,
    };

    for (const outcome of ["failed", "interrupted"] as const) {
      const attempt = makeAttempt(outcome);
      const retried = retryChatTurn(thread, attempt, retryInput);
      expect(retried.outcome).toBe("queued");
      expect(retried.id).toBe(ids.newAttempt);
      expect(retried.providerInstanceId).toBe(ids.provider);
      expect(retried.modelId).toBe(ids.model);
      expect(retried.providerSessionId).toBe(ids.newSession);
      expect(retried.contextManifestId).toBe(ids.newContext);
      expect(retried.responseRefs).toEqual([]);
      expect(retried.citationIds).toEqual([]);
      expect(retried.usage).toBeUndefined();
    }
  });

  it("rejects invalid attempt transitions", () => {
    const terminal = ["completed", "failed", "cancelled"] as const;
    const invalidTargets = ["queued", "streaming", "waiting", "completed"] as const;
    for (const from of terminal) {
      for (const to of invalidTargets) {
        expect(() =>
          transitionChatAttempt(makeAttempt(from), {
            outcome: to,
            updatedAt: later,
          }),
        ).toThrow(ChatPolicyRejected);
      }
    }

    expect(() =>
      transitionChatAttempt(makeAttempt("queued"), { outcome: "queued", updatedAt: later }),
    ).toThrow(ChatPolicyRejected);
    expect(() =>
      transitionChatAttempt(makeAttempt("streaming"), { outcome: "queued", updatedAt: later }),
    ).toThrow(ChatPolicyRejected);
    expect(() =>
      transitionChatAttempt(makeAttempt("interrupted"), { outcome: "completed", updatedAt: later }),
    ).toThrow(ChatPolicyRejected);
  });

  it("allows valid attempt transitions", () => {
    const queued = makeAttempt("queued");
    const streaming = transitionChatAttempt(queued, { outcome: "streaming", updatedAt: later });
    expect(streaming.outcome).toBe("streaming");
    expect(streaming.updatedAt).toBe(later);

    const completed = transitionChatAttempt(streaming, { outcome: "completed", updatedAt: later });
    expect(completed.outcome).toBe("completed");

    const streaming2 = transitionChatAttempt(makeAttempt("queued"), {
      outcome: "streaming",
      updatedAt: later,
    });
    const failed = transitionChatAttempt(streaming2, { outcome: "failed", updatedAt: later });
    expect(failed.outcome).toBe("failed");

    const waiting = transitionChatAttempt(makeAttempt("queued"), {
      outcome: "waiting",
      updatedAt: later,
    });
    const interrupted = transitionChatAttempt(waiting, {
      outcome: "interrupted",
      updatedAt: later,
    });
    expect(interrupted.outcome).toBe("interrupted");
  });

  it("rejects resume for non-resumable outcomes and preserves session identity for resumable ones", () => {
    const thread = makeThread();
    const baseResumeInput = {
      turnId: ids.turn,
      attemptId: ids.attempt,
      newAttemptId: ids.newAttempt,
      newContextManifestId: ids.newContext,
      expectedVersion: 1 as AggregateVersion,
      createdAt: now,
    };

    for (const outcome of ["completed", "failed", "cancelled", "queued", "streaming"] as const) {
      const attempt = makeAttempt(outcome, { resumeCursor: ids.resumeCursor });
      expect(() => resumeChatTurn(thread, attempt, baseResumeInput)).toThrow(ChatPolicyRejected);
    }
  });

  it("rejects resume when the attempt has no provider resume cursor", () => {
    const thread = makeThread();
    for (const outcome of ["waiting", "interrupted"] as const) {
      const attempt = makeAttempt(outcome);
      expect(() =>
        resumeChatTurn(thread, attempt, {
          turnId: ids.turn,
          attemptId: ids.attempt,
          newAttemptId: ids.newAttempt,
          newContextManifestId: ids.newContext,
          expectedVersion: 1 as AggregateVersion,
          createdAt: now,
        }),
      ).toThrow(ChatPolicyRejected);
    }
  });

  it("resumes waiting and interrupted attempts preserving the exact provider session id and resume cursor", () => {
    const thread = makeThread();
    const resumeInput = {
      turnId: ids.turn,
      attemptId: ids.attempt,
      newAttemptId: ids.newAttempt,
      newContextManifestId: ids.newContext,
      expectedVersion: 1 as AggregateVersion,
      createdAt: now,
    };

    for (const outcome of ["waiting", "interrupted"] as const) {
      const attempt = makeAttempt(outcome, { resumeCursor: ids.resumeCursor });
      const resumed = resumeChatTurn(thread, attempt, resumeInput);
      expect(resumed.outcome).toBe("queued");
      expect(resumed.id).toBe(ids.newAttempt);
      expect(resumed.providerInstanceId).toBe(ids.provider);
      expect(resumed.modelId).toBe(ids.model);
      expect(resumed.providerSessionId).toBe(ids.session);
      expect(resumed.resumeCursor).toEqual(ids.resumeCursor);
      expect(resumed.contextManifestId).toBe(ids.newContext);
      expect(resumed.responseRefs).toEqual([]);
      expect(resumed.citationIds).toEqual([]);
      expect(resumed.usage).toBeUndefined();
    }
  });

  it("rejects resume with stale thread version or mismatched attempt identity", () => {
    const thread = makeThread();
    const attempt = makeAttempt("interrupted", { resumeCursor: ids.resumeCursor });
    expect(() =>
      resumeChatTurn(thread, attempt, {
        turnId: ids.turn,
        attemptId: ids.attempt,
        newAttemptId: ids.newAttempt,
        newContextManifestId: ids.newContext,
        expectedVersion: 2 as AggregateVersion,
        createdAt: now,
      }),
    ).toThrow(ChatPolicyRejected);
    expect(() =>
      resumeChatTurn(thread, attempt, {
        turnId: ids.turn,
        attemptId: ids.newAttempt,
        newAttemptId: ids.newAttempt,
        newContextManifestId: ids.newContext,
        expectedVersion: 1 as AggregateVersion,
        createdAt: now,
      }),
    ).toThrow(ChatPolicyRejected);
  });
});

describe("activeChatTurns", () => {
  const turn = (id: string, supersedes?: string) => ({
    id,
    ...(supersedes === undefined ? {} : { supersedes }),
  });

  it("drops a superseded turn and everything that followed it", () => {
    const turns = [turn("a"), turn("b"), turn("c"), turn("d", "b")];
    expect(activeChatTurns(turns).map((entry) => entry.id)).toEqual(["a", "d"]);
    expect(chatTurnsThrough(turns, decodeChatTurnId(ids.turn))).toBeUndefined();
  });

  it("keeps chained revisions consistent and ignores a marker naming an inactive turn", () => {
    // Revising the same message twice, then revising the revision.
    const turns = [turn("a"), turn("b"), turn("c", "b"), turn("d", "c")];
    expect(activeChatTurns(turns).map((entry) => entry.id)).toEqual(["a", "d"]);
    // "b" is already inactive, so replaying its marker changes nothing.
    expect(activeChatTurns([...turns, turn("e", "b")]).map((entry) => entry.id)).toEqual([
      "a",
      "d",
      "e",
    ]);
  });

  it("returns the active conversation through a turn, or nothing for a superseded one", () => {
    const turns = [turn("a"), turn("b"), turn("c", "b")];
    expect(chatTurnsThrough(turns, "a" as never)?.map((entry) => entry.id)).toEqual(["a"]);
    expect(chatTurnsThrough(turns, "c" as never)?.map((entry) => entry.id)).toEqual(["a", "c"]);
    expect(chatTurnsThrough(turns, "b" as never)).toBeUndefined();
  });
});

describe("chatAttemptAnswered", () => {
  it("admits only the attempt that finished writing an answer", () => {
    expect(chatAttemptAnswered({ outcome: "completed" })).toBe(true);
    for (const outcome of [
      "queued",
      "streaming",
      "waiting",
      "interrupted",
      "failed",
      "cancelled",
    ]) {
      expect(chatAttemptAnswered({ outcome })).toBe(false);
    }
  });
});
