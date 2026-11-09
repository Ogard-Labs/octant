import { describe, expect, it, vi } from "vitest";
import type { AcpClientPort } from "./acpDriver";
import type { AcpServerNotification, AcpServerRequestMessage } from "./acpProtocol";
import { compactAcpConversation } from "./acpCompaction";

const start = {
  sessionUpdate: "tool_call",
  toolCallId: "compaction-receipt",
  kind: "other",
  status: "in_progress",
  title: "Compacting conversation history...",
};
const end = {
  sessionUpdate: "tool_call_update",
  toolCallId: "compaction-receipt",
  status: "completed",
  title: "Compacted conversation history",
};
function fixture(
  updates: ReadonlyArray<Readonly<Record<string, unknown>>>,
  source = "owned-native-session",
) {
  const listeners = new Set<(message: AcpServerNotification) => void>();
  const requests = new Set<(message: AcpServerRequestMessage) => void>();
  const calls: string[] = [];
  const client: Pick<AcpClientPort, "prompt" | "notify" | "onNotification" | "onRequest"> = {
    onNotification: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    onRequest: (listener) => {
      requests.add(listener);
      return () => {
        requests.delete(listener);
      };
    },
    prompt: async (session, prompt) => {
      calls.push(`${session}:${prompt}`);
      for (const update of updates)
        for (const listener of listeners)
          listener({
            kind: "notification",
            method: "session/update",
            params: { sessionId: source, update },
          });
      return { stopReason: "end_turn" };
    },
    notify: async () => {
      calls.push("cancel");
    },
  };
  return { client, calls, listeners, requests };
}

describe("requested ACP context compaction", () => {
  it("cancels only its owned pending command and discards a late answer", async () => {
    const f = fixture([]);
    let finish: (() => void) | undefined;
    const controller = new AbortController();
    const client = {
      ...f.client,
      prompt: async () =>
        new Promise<{ stopReason: "end_turn" }>((resolve) => {
          finish = () => resolve({ stopReason: "end_turn" });
        }),
    };
    const pending = compactAcpConversation(client, "owned-native-session", controller.signal);
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    expect(await pending).toMatchObject({ kind: "failed", sessionMayHaveChanged: true });
    expect(f.calls).toEqual(["cancel"]);
    expect(f.listeners.size).toBe(0);
    expect(f.requests.size).toBe(0);
    finish?.();
    await Promise.resolve();
    expect(f.listeners.size).toBe(0);
  });
  it("bounds a missing native reply without keeping its cancellation timer or listeners", async () => {
    vi.useFakeTimers();
    try {
      const f = fixture([]);
      const client = { ...f.client, prompt: async () => new Promise<never>(() => {}) };
      const pending = compactAcpConversation(
        client,
        "owned-native-session",
        new AbortController().signal,
      );
      await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
      expect(await pending).toMatchObject({ kind: "failed", sessionMayHaveChanged: true });
      expect(f.calls).toEqual(["cancel"]);
      expect(vi.getTimerCount()).toBe(0);
      expect(f.listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("requires the structured native receipt to start and finish on the same operation", async () => {
    const f = fixture([start, end]);
    expect(
      await compactAcpConversation(f.client, "owned-native-session", new AbortController().signal),
    ).toEqual({ kind: "compacted" });
    expect(f.calls).toEqual(["owned-native-session:/compact"]);
    expect(f.listeners.size).toBe(0);
    expect(f.requests.size).toBe(0);
  });
  it.each(
    [
      [],
      [
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "No conversation history to compact yet." },
        },
      ],
      [end],
      [start, { ...end, toolCallId: "another-operation" }],
      [start, end, end],
      [start, { ...end, status: "failed" }],
      [start, { ...end, status: "completed", title: "Ordinary tool completed" }],
    ].map((updates) => ({ updates })),
  )(
    "does not infer compaction or a no-change refusal from an incomplete or ambiguous receipt $updates",
    async ({ updates }) => {
      const f = fixture(updates);
      expect(
        await compactAcpConversation(
          f.client,
          "owned-native-session",
          new AbortController().signal,
        ),
      ).toMatchObject({ kind: "failed", sessionMayHaveChanged: true });
      expect(f.listeners.size).toBe(0);
    },
  );
  it("does not use another native session's receipt", async () => {
    const f = fixture([start, end], "other-native-session");
    expect(
      await compactAcpConversation(f.client, "owned-native-session", new AbortController().signal),
    ).toMatchObject({ kind: "failed", sessionMayHaveChanged: true });
  });
  it("does not send after cancellation and removes pending listeners", async () => {
    const f = fixture([start, end]);
    const controller = new AbortController();
    controller.abort();
    expect(
      await compactAcpConversation(f.client, "owned-native-session", controller.signal),
    ).toMatchObject({ kind: "failed", sessionMayHaveChanged: true });
    expect(f.calls).toEqual([]);
    expect(f.listeners.size).toBe(0);
  });
});
