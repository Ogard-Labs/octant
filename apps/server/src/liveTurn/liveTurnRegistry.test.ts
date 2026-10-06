import type { ProviderRuntimeEvent } from "@octant/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveTurnRegistry } from "./liveTurnRegistry";

function event(kind: ProviderRuntimeEvent["kind"], fields: object = {}): ProviderRuntimeEvent {
  return {
    kind,
    instanceId: "provider-a",
    sessionId: "session-a",
    sequence: 1,
    correlationId: "correlation-a",
    occurredAt: "2026-10-06T12:00:00.000Z",
    ...fields,
  } as unknown as ProviderRuntimeEvent;
}

const START = "2026-10-06T12:00:00.000Z";

describe("a thread's live turn", () => {
  it("has no facts before a turn starts", () => {
    expect(new LiveTurnRegistry().read("t1")).toBeUndefined();
  });

  it("carries the start time from the moment the turn begins", () => {
    const registry = new LiveTurnRegistry();
    registry.tracker("t1", "code-navigation").begin(START);
    expect(registry.read("t1")).toEqual({ turnStartedAt: START });
  });

  it("updates its step on tool activity and on an approval wait", () => {
    const registry = new LiveTurnRegistry();
    const tracker = registry.tracker("t1", "code-navigation");
    tracker.begin(START);
    tracker.observe(
      event("tool-start", { toolCallId: "c1", toolName: "Command", argument: "bun run test" }),
    );
    expect(registry.read("t1")?.liveStep).toEqual({
      kind: "tool",
      tool: "Command",
      argument: "bun run test",
    });
    tracker.observe(event("approval-request", { requestId: "r1", action: "Command" }));
    expect(registry.read("t1")?.liveStep).toEqual({ kind: "waiting", reason: "approval" });
    tracker.observe(event("tool-success", { toolCallId: "c1", summary: "ok" }));
    expect(registry.read("t1")?.liveStep).toMatchObject({ kind: "tool", tool: "Command" });
  });

  it("clears everything when the turn ends", () => {
    const registry = new LiveTurnRegistry();
    const tracker = registry.tracker("t1", "code-navigation");
    tracker.begin(START);
    tracker.observe(event("tool-start", { toolCallId: "c1", toolName: "Command" }));
    tracker.end();
    expect(registry.read("t1")).toBeUndefined();
  });

  it("keeps a newer turn when an older turn ends late", () => {
    const registry = new LiveTurnRegistry();
    const older = registry.tracker("t1", "code-navigation");
    older.begin(START);
    const newer = registry.tracker("t1", "code-navigation");
    newer.begin("2026-10-06T12:05:00.000Z");
    older.observe(event("tool-start", { toolCallId: "c1", toolName: "Stale" }));
    older.end();
    expect(registry.read("t1")).toEqual({ turnStartedAt: "2026-10-06T12:05:00.000Z" });
  });

  it("keeps threads apart", () => {
    const registry = new LiveTurnRegistry();
    registry.tracker("t1", "code-navigation").begin(START);
    expect(registry.read("t2")).toBeUndefined();
  });
});

describe("telling the navigation read that a live step moved", () => {
  afterEach(() => vi.useRealTimers());

  it("sends one merged notice for a burst of tool changes, and says which topic", () => {
    vi.useFakeTimers();
    const notices: string[] = [];
    const registry = new LiveTurnRegistry({ onChanged: (topic) => notices.push(topic) });
    const tracker = registry.tracker("t1", "work-navigation");
    tracker.begin(START);
    for (const name of ["a", "b", "c"]) {
      tracker.observe(event("tool-start", { toolCallId: name, toolName: name }));
    }
    expect(notices).toEqual([]);
    vi.advanceTimersByTime(300);
    expect(notices).toEqual(["work-navigation"]);
  });

  it("stays quiet when an event does not change what the row would say", () => {
    vi.useFakeTimers();
    const notices: string[] = [];
    const registry = new LiveTurnRegistry({ onChanged: (topic) => notices.push(topic) });
    const tracker = registry.tracker("t1", "code-navigation");
    tracker.begin(START);
    tracker.observe(event("tool-start", { toolCallId: "c1", toolName: "Command" }));
    vi.advanceTimersByTime(300);
    notices.length = 0;
    tracker.observe(event("text-delta", { text: "hello" }));
    tracker.observe(event("tool-success", { toolCallId: "c1", summary: "ok" }));
    vi.advanceTimersByTime(300);
    expect(notices).toEqual([]);
  });

  it("sends a notice when the turn ends so the row stops showing a step", () => {
    vi.useFakeTimers();
    const notices: string[] = [];
    const registry = new LiveTurnRegistry({ onChanged: (topic) => notices.push(topic) });
    const tracker = registry.tracker("t1", "chat-navigation");
    tracker.begin(START);
    vi.advanceTimersByTime(300);
    notices.length = 0;
    tracker.end();
    vi.advanceTimersByTime(300);
    expect(notices).toEqual(["chat-navigation"]);
  });
});
