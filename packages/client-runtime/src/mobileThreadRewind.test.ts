import { describe, expect, it, vi } from "vitest";
import {
  MOBILE_REWIND_FILES_NEED_COMPUTER,
  composerAfterRewind,
  forkMobileChatThread,
  forkMobileCodeThread,
  mobileChatMessages,
  mobileCodeRewindFilesOffer,
  mobileCodeTurnTargets,
  mobileForkTitle,
  mobileRewindScopes,
  mobileWorkTurnTargets,
  previewMobileCodeRewind,
  rewindMobileChatThread,
  rewindMobileCodeThread,
  rewindMobileWorkThread,
} from "./mobileThreadRewind";
import type { MobileRemoteTransport } from "./mobileInboxClient";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const digest = `sha256:${"a".repeat(64)}`;

function ref(n: number) {
  return { contentId: uuid(n), digest, byteLength: 1 };
}
function content(n: number, role: "user" | "assistant", body: string) {
  return { contentId: uuid(n), role, body, digest, byteLength: body.length };
}
function turn(n: number, user: number, reply: number | undefined, extra: object = {}) {
  return {
    id: uuid(n),
    sequence: n,
    userMessageRef: ref(user),
    attempts:
      reply === undefined
        ? []
        : [{ id: uuid(n + 500), outcome: "completed", responseRefs: [ref(reply)] }],
    ...extra,
  };
}

/** Three turns, the last one removed by an earlier rewind. */
const chatView = {
  thread: {
    id: uuid(900),
    version: 7,
    title: "Plan the trip",
    updatedAt: "2026-11-01T10:00:00.000Z",
  },
  turns: [
    turn(1, 11, 12),
    turn(2, 21, 22),
    turn(3, 31, 32, { rewound: { rewindId: uuid(99), rewoundAt: "2026-11-01T10:00:00.000Z" } }),
  ],
  contents: [
    content(11, "user", "one"),
    content(12, "assistant", "reply one"),
    content(21, "user", "two"),
    content(22, "assistant", "reply two"),
    content(31, "user", "three"),
    content(32, "assistant", "reply three"),
  ],
};

function transportReturning(body: unknown, status = 200) {
  const authenticatedFetch = vi.fn(
    async (_input: Parameters<MobileRemoteTransport["authenticatedFetch"]>[0]) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
  return {
    transport: { hostId: "host-1", authenticatedFetch } satisfies MobileRemoteTransport,
    authenticatedFetch,
  };
}

describe("mobile fork and rewind", () => {
  it("leaves out the messages a rewind removed and names each message's targets", () => {
    const messages = mobileChatMessages(chatView as never);
    expect(messages.map((message) => message.content.body)).toEqual([
      "one",
      "reply one",
      "two",
      "reply two",
    ]);
    const [one, replyOne, two, replyTwo] = messages;
    // The first message has nothing before it to fork through.
    expect(one?.targets).toMatchObject({
      rewindFromId: uuid(1),
      rewindPrompt: "one",
      removedTurns: 2,
    });
    expect(one?.targets?.forkThroughId).toBeUndefined();
    expect(replyOne?.targets).toMatchObject({
      forkThroughId: uuid(1),
      rewindFromId: uuid(2),
      rewindPrompt: "two",
      removedTurns: 1,
    });
    // A person's message forks through the reply before it.
    expect(two?.targets).toMatchObject({ forkThroughId: uuid(1), rewindFromId: uuid(2) });
    // The last reply has no later turn to rewind to.
    expect(replyTwo?.targets?.rewindFromId).toBeUndefined();
    expect(replyTwo?.targets?.forkThroughId).toBe(uuid(2));
  });

  it("returns the removed message above a draft already in the composer", () => {
    expect(composerAfterRewind("old message", "")).toBe("old message");
    expect(composerAfterRewind("old message", "half typed")).toBe("old message\n\nhalf typed");
  });

  it("names a fork once instead of stacking suffixes", () => {
    expect(mobileForkTitle("Plan (fork)", "fork")).toBe("Plan (fork)");
    expect(mobileForkTitle("Plan (branch 2)", "branch")).toBe("Plan (branch)");
    expect(mobileForkTitle("  ", "fork")).toBe("Task (fork)");
  });

  it("offers files from a phone only where the host asks no approval", () => {
    expect(mobileCodeRewindFilesOffer("full-access")).toEqual({ kind: "offered" });
    for (const posture of ["approval-gated", "auto-accept-edits"] as const) {
      expect(mobileCodeRewindFilesOffer(posture)).toEqual({
        kind: "conversation-only",
        reason: MOBILE_REWIND_FILES_NEED_COMPUTER,
      });
    }
    expect(mobileCodeRewindFilesOffer("plan").kind).toBe("conversation-only");
  });

  it("offers the files choice only when the preview says files can come back", () => {
    expect(mobileRewindScopes({ kind: "changes", paths: ["a.ts"], total: 1 })).toEqual([
      "both",
      "conversation",
      "files",
    ]);
    expect(mobileRewindScopes({ kind: "unchanged" })).toEqual(["conversation"]);
    expect(mobileRewindScopes({ kind: "unavailable", reason: "no" })).toEqual(["conversation"]);
  });

  it("sends the Chat rewind on the thread's version and the first turn it removes", async () => {
    const { transport, authenticatedFetch } = transportReturning({
      kind: "thread-rewound",
      thread: { ...chatView.thread },
      rewindId: uuid(70),
      fromTurnId: uuid(2),
      removedTurnIds: [uuid(2)],
      rewoundAt: "2026-11-01T10:00:00.000Z",
    });
    await expect(
      rewindMobileChatThread({ transport, thread: chatView.thread as never, fromTurnId: uuid(2) }),
    ).rejects.toThrow(); // the fixture thread is not a full thread, so the host answer is refused
    const request = authenticatedFetch.mock.calls[0]?.[0];
    expect(request?.path).toBe("/api/chat/commands");
    expect(JSON.parse(String(request?.body))).toEqual({
      kind: "rewind-chat-thread",
      threadId: uuid(900),
      expectedVersion: 7,
      turnId: uuid(2),
    });
  });

  it("tells the person nothing changed when the host reports a newer version", async () => {
    const { transport } = transportReturning({}, 409);
    await expect(
      forkMobileChatThread({ transport, thread: chatView.thread as never, throughTurnId: uuid(1) }),
    ).rejects.toMatchObject({
      category: "stale",
      message: "The thread changed on the host. Nothing changed.",
    });
  });

  it("asks the Work route to rewind and hands back the removed prompt", async () => {
    const { transport, authenticatedFetch } = transportReturning({
      kind: "thread-rewound",
      threadId: uuid(800),
      fromRequestId: uuid(2),
      removedTurns: 2,
      prompt: "second ask",
    });
    const result = await rewindMobileWorkThread({
      transport,
      threadId: uuid(800),
      fromRequestId: uuid(2),
    });
    expect(result.prompt).toBe("second ask");
    const request = authenticatedFetch.mock.calls[0]?.[0];
    expect(request?.path).toBe("/api/work/turns/rewind");
    expect(JSON.parse(String(request?.body))).toMatchObject({
      kind: "rewind-work-thread",
      threadId: uuid(800),
      fromRequestId: uuid(2),
    });
  });

  it("asks the host to fork a Code thread through the turn the person chose", async () => {
    const { transport, authenticatedFetch } = transportReturning({ kind: "nope" });
    await expect(
      forkMobileCodeThread({
        transport,
        sourceThreadId: uuid(700),
        sourceTitle: "Fix login",
        throughOperationId: uuid(5),
      }),
    ).rejects.toThrow();
    const body = JSON.parse(String(authenticatedFetch.mock.calls[0]?.[0].body));
    expect(body).toMatchObject({
      kind: "fork-code-thread",
      sourceThreadId: uuid(700),
      throughOperationId: uuid(5),
      title: "Fix login (fork)",
    });
  });

  it("shows the files a Code rewind would put back before anything changes", async () => {
    const { transport, authenticatedFetch } = transportReturning({});
    authenticatedFetch.mockImplementationOnce(async (input) => {
      const command = JSON.parse(String(input.body));
      return new Response(
        JSON.stringify({
          kind: "rewind-preview",
          operationId: command.operationId,
          fromOperationId: uuid(5),
          removedTurns: 3,
          rollback: "handoff",
          files: {
            kind: "changes",
            changes: {
              files: [{ path: "src/a.ts", insertions: 1, deletions: 0 }],
              total: 1,
              truncated: false,
            },
          },
        }),
        { status: 200 },
      );
    });
    const preview = await previewMobileCodeRewind(transport, {
      threadId: uuid(700) as never,
      checkoutId: uuid(701) as never,
      fromOperationId: uuid(5),
    });
    expect(preview.removedTurns).toBe(3);
    expect(preview.files).toEqual({ kind: "changes", paths: ["src/a.ts"], total: 1 });
    expect(JSON.parse(String(authenticatedFetch.mock.calls[0]?.[0].body)).kind).toBe(
      "preview-code-rewind",
    );
  });

  it("shows the host's own sentence when a Code rewind is refused", async () => {
    const { transport, authenticatedFetch } = transportReturning({});
    authenticatedFetch.mockImplementationOnce(async (input) => {
      const command = JSON.parse(String(input.body));
      return new Response(
        JSON.stringify({
          kind: "operation-failed",
          operationId: command.operationId,
          failure: {
            category: "waiting",
            message:
              "A turn is running in this thread. Wait for it to finish or stop it, then rewind.",
          },
        }),
        { status: 200 },
      );
    });
    await expect(
      rewindMobileCodeThread(transport, {
        threadId: uuid(700) as never,
        checkoutId: uuid(701) as never,
        fromOperationId: uuid(5),
        scope: "conversation",
      }),
    ).rejects.toThrow("A turn is running in this thread.");
  });

  it("targets a Work message the way the desktop does", () => {
    const turns = [
      { requestId: uuid(1), prompt: "first" },
      { requestId: uuid(2), prompt: "second" },
    ] as never;
    expect(mobileWorkTurnTargets(turns, 0, "user")).toEqual({
      rewindFromId: uuid(1),
      rewindPrompt: "first",
      removedTurns: 2,
    });
    expect(mobileWorkTurnTargets(turns, 0, "assistant")).toEqual({
      forkThroughId: uuid(1),
      rewindFromId: uuid(2),
      rewindPrompt: "second",
      removedTurns: 1,
    });
    expect(mobileWorkTurnTargets(turns, 1, "assistant").rewindFromId).toBeUndefined();
  });

  it("offers a Code fork only after a finished turn and returns no empty prompt", () => {
    const turns = [
      { operationId: uuid(1), status: "failed", prompt: "first" },
      { operationId: uuid(2), status: "completed", prompt: "" },
      { operationId: uuid(3), status: "completed", prompt: "third" },
    ];
    expect(mobileCodeTurnTargets(turns, 1, "user").forkThroughId).toBeUndefined();
    expect(mobileCodeTurnTargets(turns, 1, "user").rewindPrompt).toBeUndefined();
    expect(mobileCodeTurnTargets(turns, 2, "user").forkThroughId).toBe(uuid(2));
    expect(mobileCodeTurnTargets(turns, 0, "assistant").rewindPrompt).toBeUndefined();
  });
});
