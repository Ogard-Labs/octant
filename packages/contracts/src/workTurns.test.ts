import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { decodeHostAnswer } from "./hostAnswer";
import {
  WORK_TURN_CAPABILITIES,
  WORK_TURN_EVENT_NAMES,
  decodeCancelWorkTurnCommand,
  MAX_WORK_TRANSCRIPT_TURNS,
  decodeWorkThreadTranscript,
  decodeWorkThreadTranscriptWindow,
  decodeWorkThreadTranscriptWindowRequest,
  decodeWorkTurnAccepted,
  decodeWorkTurnAuthority,
  decodeWorkTurnLookupResult,
  decodeWorkTurnState,
  decodeWorkTurnUpdated,
  decodeStartWorkThreadTurnCommand,
  WorkTurnStreamFrame,
} from "./workTurns";

const ids = {
  request: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  turn: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  thread: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  project: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  binding: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  provider: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  session: "11111111-1111-4111-8111-111111111111",
} as const;

const now = "2026-08-11T12:00:00.000Z";

const authority = {
  hostId: "local",
  projectId: ids.project,
  bindingRevisionId: ids.binding,
  workingDirectory: ".",
  confinementPosture: "project-root-confined",
  providerInstanceId: ids.provider,
  modelId: "gpt-5",
} as const;

describe("work turn handoff", () => {
  const handoff = {
    reason: "provider-switch",
    previousProviderInstanceId: ids.provider,
    previousModelId: "gpt-5",
    messages: 3,
    omissions: {
      earlierMessages: 2,
      unfinishedReplies: 0,
      missingBodies: 0,
      oversizedBodies: 0,
      emptyBodies: 0,
      attachments: 1,
      truncatedMessages: 0,
      truncatedCharacters: 0,
      sourceTruncatedMessages: 0,
    },
    externalContentIngested: false,
    nativeSessionTransferred: false,
    hiddenReasoningTransferred: false,
  } as const;
  const accepted = {
    kind: "turn-accepted",
    requestId: ids.request,
    threadId: ids.thread,
    turnId: ids.turn,
    projectId: ids.project,
    authority,
    providerSessionId: ids.session,
    prompt: "Continue",
    capabilities: WORK_TURN_CAPABILITIES,
    acceptedAt: now,
  } as const;

  it("journals the handoff with the acceptance of the turn that carried it", () => {
    expect(decodeWorkTurnAccepted({ ...accepted, handoff }).handoff).toEqual(handoff);
    expect(decodeWorkTurnAccepted(accepted).handoff).toBeUndefined();
  });

  it("keeps the handoff on the turn state and refuses a record claiming a native session moved", () => {
    const { kind: _kind, ...acceptedFields } = accepted;
    const withoutKind = {
      ...acceptedFields,
      status: "accepted",
      transcript: [{ role: "user", text: "Continue" }],
      version: 1,
      updatedAt: now,
    };
    expect(decodeWorkTurnState({ ...withoutKind, handoff }).handoff).toEqual(handoff);
    expect(() =>
      decodeWorkTurnState({
        ...withoutKind,
        handoff: { ...handoff, nativeSessionTransferred: true },
      }),
    ).toThrow();
    expect(() =>
      decodeWorkTurnAccepted({ ...accepted, handoff: { ...handoff, reason: "branch" } }),
    ).toThrow();
  });
});

describe("work turn contracts", () => {
  it("decodes an exact Project-backed start-turn command", () => {
    const command = decodeStartWorkThreadTurnCommand({
      kind: "start-work-thread-turn",
      requestId: ids.request,
      threadId: ids.thread,
      turnId: ids.turn,
      prompt: "Summarize the brief",
      authority,
    });
    expect(command.authority.confinementPosture).toBe("project-root-confined");
    expect(command.authority.workingDirectory).toBe(".");
  });

  it("decodes a start-turn command that names staged image ids", () => {
    const command = decodeStartWorkThreadTurnCommand({
      kind: "start-work-thread-turn",
      requestId: ids.request,
      threadId: ids.thread,
      turnId: ids.turn,
      prompt: "Match this mockup",
      authority,
      attachmentIds: ["22222222-2222-4222-8222-222222222222"],
    });
    expect(command.attachmentIds).toEqual(["22222222-2222-4222-8222-222222222222"]);
  });

  it("carries a Work turn's `#thread` mentions as ids the host resolves itself", () => {
    const command = decodeStartWorkThreadTurnCommand({
      kind: "start-work-thread-turn",
      requestId: ids.request,
      threadId: ids.thread,
      turnId: ids.turn,
      prompt: "Does this still hold?",
      authority,
      threadMentionIds: [ids.thread],
    });
    expect(command.threadMentionIds).toEqual([ids.thread]);
  });

  it("carries a Work turn's `@file` mentions as paths the host re-checks itself", () => {
    const command = decodeStartWorkThreadTurnCommand({
      kind: "start-work-thread-turn",
      requestId: ids.request,
      threadId: ids.thread,
      turnId: ids.turn,
      prompt: "Summarize @notes.md",
      authority,
      fileMentionPaths: ["notes.md", "../secret"],
    });
    // The contract accepts the raw string so the host can refuse out-of-root
    // itself rather than failing decode and looking like a malformed command.
    expect(command.fileMentionPaths).toEqual(["notes.md", "../secret"]);
  });

  it("rejects a start-turn command that names more images than a turn may carry", () => {
    expect(() =>
      decodeStartWorkThreadTurnCommand({
        kind: "start-work-thread-turn",
        requestId: ids.request,
        threadId: ids.thread,
        turnId: ids.turn,
        prompt: "Match this mockup",
        authority,
        attachmentIds: Array.from(
          { length: 9 },
          (_, index) => `22222222-2222-4222-8222-${String(index).padStart(12, "0")}`,
        ),
      }),
    ).toThrow();
  });

  it("rejects Code, shell, Git, worktree, or PR authority on the turn snapshot", () => {
    for (const excess of [
      { shell: true },
      { git: true },
      { worktree: true },
      { pullRequest: true },
      { code: true },
      { checkoutId: ids.binding },
      { executionPolicy: "full-access" },
    ]) {
      expect(() =>
        decodeWorkTurnAuthority({
          ...authority,
          ...excess,
        }),
      ).toThrow();
    }
  });

  it("rejects an unbound confinement posture", () => {
    expect(() =>
      decodeWorkTurnAuthority({
        ...authority,
        confinementPosture: "unconfined",
      }),
    ).toThrow();
  });

  it("decodes accepted turn state with a durable user/assistant transcript", () => {
    const turn = decodeWorkTurnState({
      requestId: ids.request,
      threadId: ids.thread,
      turnId: ids.turn,
      projectId: ids.project,
      authority,
      providerSessionId: ids.session,
      status: "running",
      prompt: "Summarize the brief",
      response: "Working…",
      transcript: [
        { role: "user", text: "Summarize the brief" },
        { role: "assistant", text: "Working…", status: "running" },
      ],
      capabilities: WORK_TURN_CAPABILITIES,
      version: 1,
      acceptedAt: now,
      updatedAt: now,
    });
    expect(turn.transcript).toHaveLength(2);
    expect(turn.capabilities.code).toBe("denied");
  });

  it("decodes cancel, lookup, transcript bootstrap, and journal frames", () => {
    expect(
      decodeCancelWorkTurnCommand({
        kind: "cancel-work-turn",
        requestId: ids.request,
        threadId: ids.thread,
        turnId: ids.turn,
      }).kind,
    ).toBe("cancel-work-turn");

    expect(
      decodeWorkTurnLookupResult({
        kind: "accepted",
        turn: {
          requestId: ids.request,
          threadId: ids.thread,
          turnId: ids.turn,
          projectId: ids.project,
          authority,
          status: "accepted",
          prompt: "Summarize the brief",
          transcript: [{ role: "user", text: "Summarize the brief" }],
          capabilities: WORK_TURN_CAPABILITIES,
          version: 1,
          acceptedAt: now,
          updatedAt: now,
        },
      }).kind,
    ).toBe("accepted");

    expect(
      decodeWorkThreadTranscript({
        threadId: ids.thread,
        turns: [],
      }).threadId,
    ).toBe(ids.thread);

    expect(
      decodeWorkTurnAccepted({
        kind: "turn-accepted",
        requestId: ids.request,
        threadId: ids.thread,
        turnId: ids.turn,
        projectId: ids.project,
        authority,
        providerSessionId: ids.session,
        prompt: "Summarize the brief",
        capabilities: WORK_TURN_CAPABILITIES,
        acceptedAt: now,
      }).kind,
    ).toBe("turn-accepted");

    const acceptedWithImage = decodeWorkTurnAccepted({
      kind: "turn-accepted",
      requestId: ids.request,
      threadId: ids.thread,
      turnId: ids.turn,
      projectId: ids.project,
      authority,
      providerSessionId: ids.session,
      prompt: "Match this mockup",
      attachments: [
        {
          attachmentId: "22222222-2222-4222-8222-222222222222",
          displayName: "mockup.png",
          mediaType: "image/png",
          byteLength: 3,
          digest: "a".repeat(64),
        },
      ],
      capabilities: WORK_TURN_CAPABILITIES,
      acceptedAt: now,
    });
    expect(acceptedWithImage.attachments?.[0]?.displayName).toBe("mockup.png");

    expect(
      decodeWorkTurnUpdated({
        kind: "turn-updated",
        requestId: ids.request,
        threadId: ids.thread,
        turnId: ids.turn,
        status: "completed",
        response: "Done",
        transcript: [
          { role: "user", text: "Summarize the brief" },
          { role: "assistant", text: "Done", status: "completed" },
        ],
        updatedAt: now,
      }).status,
    ).toBe("completed");

    expect(WORK_TURN_EVENT_NAMES).toEqual(["work.turn-accepted@1", "work.turn-updated@1"]);
  });

  it("decodes a transcript window with its bounds and refuses a field it does not name", () => {
    const window = decodeWorkThreadTranscriptWindow({
      version: 1,
      threadId: ids.thread,
      turns: [],
      liveCursor: 3,
      hasEarlier: true,
      hasLater: false,
    });
    expect(window.hasEarlier).toBe(true);
    expect(window.hasLater).toBe(false);
    for (const excess of [{ cursor: "next" }, { supersededTurnCount: 0 }]) {
      expect(() =>
        decodeWorkThreadTranscriptWindow({
          version: 1,
          threadId: ids.thread,
          turns: [],
          liveCursor: 0,
          hasEarlier: false,
          hasLater: false,
          ...excess,
        }),
      ).toThrow();
    }
  });

  it("bounds a transcript window request to one page and at most one anchor", () => {
    expect(decodeWorkThreadTranscriptWindowRequest({ limit: 30 }).limit).toBe(30);
    expect(
      decodeWorkThreadTranscriptWindowRequest({
        limit: MAX_WORK_TRANSCRIPT_TURNS,
        before: ids.request,
      }).before,
    ).toBe(ids.request);
    for (const invalid of [
      { limit: 0 },
      { limit: MAX_WORK_TRANSCRIPT_TURNS + 1 },
      { limit: 1.5 },
      { limit: 30, before: "not-a-turn" },
      { limit: 30, after: ids.request },
    ]) {
      expect(() => decodeWorkThreadTranscriptWindowRequest(invalid)).toThrow();
    }
  });
});

describe("a Work turn's Shield rows on an older client", () => {
  const strict = { parseOptions: { onExcessProperty: "error" as const } };
  // A client built before tool steps carried Shield's decision or the
  // Watcher's mark: its step has only these fields, and refuses any other.
  const OlderToolStep = Schema.Struct({
    toolCallId: Schema.String,
    toolName: Schema.String,
    state: Schema.Literal("started", "running", "completed", "failed"),
    summary: Schema.optional(Schema.String),
  }).annotations(strict);
  const OlderTurnToolsFrame = Schema.Struct({
    kind: Schema.Literal("turn-tools"),
    sequence: Schema.Int,
    threadId: Schema.String,
    requestId: Schema.String,
    toolSteps: Schema.Array(OlderToolStep),
    toolStepsTruncated: Schema.Boolean,
  }).annotations(strict);

  it("keeps the row and drops the decision it cannot show instead of refusing the turn", () => {
    const frame = Schema.encodeSync(WorkTurnStreamFrame)(
      decodeHostAnswer(WorkTurnStreamFrame)({
        kind: "turn-tools",
        sequence: 3,
        threadId: ids.thread,
        requestId: ids.request,
        toolSteps: [
          {
            toolCallId: "shield:call-1",
            toolName: "bash",
            state: "completed",
            summary: "git status",
            shield: {
              reviewer: "octant-shield",
              verdict: "allow",
              stage: "fast-allow",
              rule: "read-only-git",
              reason: "A read-only Git command.",
              latencyMs: 1,
              decidedAt: now,
            },
            outsideContent: { labels: ["secret-path-read"], recordedOnly: true },
          },
        ],
        toolStepsTruncated: false,
      }),
    );

    expect(() => Schema.decodeUnknownSync(OlderTurnToolsFrame)(frame)).toThrow();
    expect(decodeHostAnswer(OlderTurnToolsFrame)(frame).toolSteps).toEqual([
      { toolCallId: "shield:call-1", toolName: "bash", state: "completed", summary: "git status" },
    ]);
  });
});
