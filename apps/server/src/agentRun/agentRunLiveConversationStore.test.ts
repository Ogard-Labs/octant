import { describe, expect, it } from "vitest";
import { MAX_AGENT_RUN_CONVERSATION_BYTES, decodeAgentRunId } from "@octant/contracts";
import { AgentRunLiveConversationStore } from "./agentRunLiveConversationStore";

const runId = decodeAgentRunId("11111111-1111-4111-8111-111111111111");
const occurredAt = "2026-08-23T00:00:00.000Z" as never;

describe("AgentRunLiveConversationStore", () => {
  it("keeps a bounded replayable snapshot and reports truncation", () => {
    const store = new AgentRunLiveConversationStore();
    store.begin(runId);
    for (let index = 0; index < 140; index += 1) {
      store.appendText(runId, `chunk ${index}`, occurredAt);
    }

    const snapshot = store.read({ runId });
    expect(snapshot?.status).toBe("live");
    expect(snapshot?.entries.length).toBeLessThanOrEqual(128);
    expect(snapshot?.truncated).toBe(true);
    expect(snapshot?.entries.at(-1)?.text).toBe("chunk 139");
  });

  it("supports cursor reads and makes restart loss explicit", () => {
    const store = new AgentRunLiveConversationStore();
    store.begin(runId);
    store.appendText(runId, "first", occurredAt);
    store.appendText(runId, "second", occurredAt);
    expect(store.read({ runId, afterSequence: 1 })?.entries.map((entry) => entry.text)).toEqual([
      "second",
    ]);

    store.markStale(runId, "Host restarted before the child session could reconnect.");
    expect(store.read({ runId })?.status).toBe("stale");
    expect(store.read({ runId })?.staleReason).toContain("restarted");
  });

  it("bounds UTF-8 payload bytes even when a provider emits a huge delta", () => {
    const store = new AgentRunLiveConversationStore();
    store.begin(runId);
    store.appendText(runId, "å".repeat(80_000), occurredAt);
    const snapshot = store.read({ runId });
    const bytes = new TextEncoder().encode(JSON.stringify(snapshot?.entries)).byteLength;
    expect(bytes).toBeLessThanOrEqual(MAX_AGENT_RUN_CONVERSATION_BYTES);
    expect(snapshot?.truncated).toBe(true);
  });

  it("publishes an initial snapshot, cursor-safe deltas, and a terminal state", async () => {
    const store = new AgentRunLiveConversationStore();
    store.begin(runId);
    const controller = new AbortController();
    const stream = store.subscribe({ runId, signal: controller.signal });
    const initial = await stream.next();
    expect(initial.value).toMatchObject({ status: "live", entries: [] });

    store.appendText(runId, "first", occurredAt);
    await expect(stream.next()).resolves.toMatchObject({
      value: { status: "live", entries: [{ sequence: 1, text: "first" }] },
      done: false,
    });

    store.appendText(runId, "second", occurredAt);
    await expect(stream.next()).resolves.toMatchObject({
      value: { status: "live", entries: [{ sequence: 2, text: "second" }] },
      done: false,
    });

    store.complete(runId);
    await expect(stream.next()).resolves.toMatchObject({
      value: { status: "complete", entries: [] },
      done: false,
    });
    await expect(stream.next()).resolves.toMatchObject({ done: true });
  });

  it("removes an aborted subscriber and does not retain its listener", async () => {
    const store = new AgentRunLiveConversationStore();
    store.begin(runId);
    const controller = new AbortController();
    const stream = store.subscribe({ runId, signal: controller.signal });
    await stream.next();
    controller.abort();
    await expect(stream.next()).resolves.toMatchObject({ done: true });
    store.appendText(runId, "after abort", occurredAt);
    await expect(stream.next()).resolves.toMatchObject({ done: true });
  });

  it("marks a slow consumer stale instead of retaining an unbounded update queue", async () => {
    const store = new AgentRunLiveConversationStore();
    store.begin(runId);
    const controller = new AbortController();
    const stream = store.subscribe({ runId, signal: controller.signal });
    await stream.next();
    for (let index = 0; index < 40; index += 1) {
      store.appendText(runId, `chunk ${index}`, occurredAt);
    }
    await expect(stream.next()).resolves.toMatchObject({
      value: {
        status: "stale",
        staleReason: "Live child transcript consumer fell behind; reconnect to continue.",
      },
      done: false,
    });
    await expect(stream.next()).resolves.toMatchObject({ done: true });
  });
});
