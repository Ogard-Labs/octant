import type { ProviderRuntimeEvent } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { ProviderAvailabilityMarks } from "./providerAvailabilityMarks";

const instance = "00000000-0000-4000-8000-000000000001";

function event(kind: string, sessionId: string, extra: Record<string, unknown> = {}) {
  return {
    instanceId: instance,
    sessionId,
    sequence: 1,
    correlationId: "c",
    occurredAt: "2026-11-15T12:00:00.000Z",
    kind,
    ...extra,
  } as unknown as ProviderRuntimeEvent;
}

describe("provider availability marks", () => {
  it("marks a provider down for 5 minutes after an availability failure, then tries it again", () => {
    let now = 1_000_000;
    const marks = new ProviderAvailabilityMarks({ now: () => now });
    marks.record(
      event("failed", "s1", { failure: { category: "unavailable", message: "refused" } }),
    );
    expect(marks.read(instance)?.downUntil).toBe(1_000_000 + 5 * 60_000);
    now += 5 * 60_000 - 1;
    expect(marks.read(instance)).toBeDefined();
    now += 1;
    expect(marks.read(instance)).toBeUndefined();
  });

  it("holds a usage limit until the reset the provider named", () => {
    let now = Date.parse("2026-11-15T12:00:00.000Z");
    const marks = new ProviderAvailabilityMarks({ now: () => now });
    marks.record(
      event("failed", "s1", {
        failure: {
          category: "rate-limited",
          message: "limit",
          usageLimit: { kind: "exhausted", resetsAt: "2026-11-15T14:00:00.000Z" },
        },
      }),
    );
    expect(marks.read(instance)).toEqual({ usageLimit: { until: "2026-11-15T14:00:00.000Z" } });
    now = Date.parse("2026-11-15T14:00:00.000Z");
    expect(marks.read(instance)).toBeUndefined();
  });

  it("ignores failures that say nothing about availability and clears on a completed request", () => {
    const marks = new ProviderAvailabilityMarks({ now: () => 0 });
    marks.record(event("failed", "s1", { failure: { category: "unauthenticated", message: "x" } }));
    expect(marks.read(instance)).toBeUndefined();
    marks.record(event("failed", "s2", { failure: { category: "unavailable", message: "x" } }));
    marks.record(event("completed", "s3"));
    expect(marks.read(instance)).toBeUndefined();
  });

  it("tells a session that failed before any output from one that had already answered", () => {
    const marks = new ProviderAvailabilityMarks({ now: () => 0 });
    marks.record(event("failed", "early", { failure: { category: "unavailable", message: "x" } }));
    marks.record(event("text-delta", "late", { text: "hi" }));
    marks.record(event("failed", "late", { failure: { category: "unavailable", message: "x" } }));
    expect(marks.failedBeforeOutput("early")).toBe(true);
    expect(marks.failedBeforeOutput("late")).toBe(false);
  });
});
