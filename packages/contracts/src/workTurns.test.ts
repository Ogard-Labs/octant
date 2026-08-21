import { describe, expect, it } from "vitest";
import {
  WORK_TURN_CAPABILITIES,
  WORK_TURN_EVENT_NAMES,
  decodeCancelWorkTurnCommand,
  decodeWorkThreadTranscript,
  decodeWorkTurnAccepted,
  decodeWorkTurnAuthority,
  decodeWorkTurnLookupResult,
  decodeWorkTurnState,
  decodeWorkTurnUpdated,
  decodeStartWorkThreadTurnCommand,
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
});
