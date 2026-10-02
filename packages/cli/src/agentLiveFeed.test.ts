import { describe, expect, it } from "vitest";
import { AgentWake, followAgentThread } from "./agentLiveFeed";
import type {
  LocalControlRequest,
  LocalControlStream,
  OpenedLocalControlSession,
} from "./localControl";

/** A long fallback: a wake that arrives in time came from the stream, not the timer. */
const FALLBACK_MS = 30_000;

function lines(...frames: ReadonlyArray<unknown>): LocalControlStream {
  return {
    kind: "open",
    lines: (async function* () {
      for (const frame of frames) yield JSON.stringify(frame);
    })(),
  };
}

function feedSession(
  answer: (request: LocalControlRequest) => { status: number; body: unknown },
  stream: (path: string) => LocalControlStream,
  opened: string[],
): OpenedLocalControlSession {
  return {
    kind: "opened",
    windowId: "window",
    send: async (request) => answer(request),
    stream: async (path) => {
      opened.push(path);
      return stream(path);
    },
    close: async () => undefined,
  };
}

async function within<T>(promise: Promise<T>, ms = 2_000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("no wake from the stream")), ms),
    ),
  ]);
}

describe("following a thread live", () => {
  it("wakes the terminal on a Work frame and resumes the stream after it", async () => {
    const wake = new AgentWake();
    const feed = new AbortController();
    const opened: string[] = [];
    let served = 0;
    followAgentThread(
      feedSession(
        () => ({ status: 200, body: { threadId: "t", turns: [], liveCursor: 4 } }),
        () => {
          served += 1;
          return served === 1
            ? lines({
                kind: "response-delta",
                sequence: 5,
                threadId: "t",
                requestId: "r",
                text: "Hi",
              })
            : lines();
        },
        opened,
      ),
      "work",
      "t",
      wake,
      feed.signal,
    );
    try {
      await within(wake.next(FALLBACK_MS));
      await within(
        (async () => {
          while (opened.length < 2) await new Promise((resolve) => setTimeout(resolve, 10));
        })(),
      );
      expect(opened[0]).toBe("/api/work/turns/stream/t?afterSequence=4");
      expect(opened[1]).toBe("/api/work/turns/stream/t?afterSequence=5");
    } finally {
      feed.abort();
    }
  });

  it("follows the newest Code turn's events from where the last replay stopped", async () => {
    const wake = new AgentWake();
    const feed = new AbortController();
    const opened: string[] = [];
    followAgentThread(
      feedSession(
        (request) =>
          request.path.includes("afterCursor=0&")
            ? {
                status: 200,
                body: {
                  turns: [{ operationId: "old" }, { operationId: "op" }],
                  nextCursor: 9,
                  hasMore: false,
                },
              }
            : { status: 200, body: { turns: [], nextCursor: 9, hasMore: false } },
        (path) => (path.endsWith("afterCursor=0") ? lines({ cursor: 1 }, { cursor: 2 }) : lines()),
        opened,
      ),
      "code",
      "t",
      wake,
      feed.signal,
    );
    try {
      await within(wake.next(FALLBACK_MS));
      await within(wake.next(FALLBACK_MS));
      await within(
        (async () => {
          while (opened.length < 2) await new Promise((resolve) => setTimeout(resolve, 10));
        })(),
      );
      expect(opened[0]).toBe("/api/code/threads/t/operations/op/events?afterCursor=0");
      expect(opened[1]).toBe("/api/code/threads/t/operations/op/events?afterCursor=2");
    } finally {
      feed.abort();
    }
  });

  it("falls back to the timer when the session cannot stream", async () => {
    const wake = new AgentWake();
    followAgentThread(
      {
        kind: "opened",
        windowId: "window",
        send: async () => ({ status: 200, body: {} }),
        close: async () => undefined,
      },
      "chat",
      "t",
      wake,
      new AbortController().signal,
    );
    const started = Date.now();
    await wake.next(30);
    expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  });
});
