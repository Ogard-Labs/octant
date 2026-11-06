import { describe, expect, it } from "vitest";
import type {
  AutomationIntegrationEvent,
  AutomationIntegrationEventTrigger,
  UtcTimestamp,
} from "@octant/contracts";
import {
  initialAutomationEventCheckpoint,
  reconcileAutomationEventObservation,
} from "./automationEventSourceState";
const at = "2026-11-06T12:00:00.000Z" as UtcTimestamp;
const trigger: AutomationIntegrationEventTrigger = {
  kind: "integration-event",
  integrationId: "example",
  sourceId: "completed",
  filters: {},
  pollMinutes: 1,
  automaticStartLimit: 8,
};
const event = (id: string): AutomationIntegrationEvent => ({
  id,
  label: id,
  occurredAt: at,
  data: "{}",
  routineOutput: false,
});
const initial = initialAutomationEventCheckpoint("a".repeat(64), at);
function observe(
  previous = initial,
  events: ReadonlyArray<AutomationIntegrationEvent> = [],
  overrides: Partial<Parameters<typeof reconcileAutomationEventObservation>[0]> = {},
) {
  return reconcileAutomationEventObservation({
    previous,
    trigger,
    events,
    semantics: "append",
    observedAt: at,
    coverageGap: false,
    missedRunPolicy: "run-once",
    busy: false,
    ...overrides,
  });
}
function state(result: ReturnType<typeof observe>) {
  return result.kind === "claim" ? result.receipt.checkpoint : result.checkpoint;
}
describe("routine integration observations", () => {
  it("baselines existing history and distinguishes later run attempts without duplicates", () => {
    const baseline = state(observe(initial, [event("run:1:attempt:1")]));
    expect(observe(baseline, [event("run:1:attempt:1")]).kind).toBe("checkpoint");
    const next = observe(baseline, [event("run:1:attempt:1"), event("run:1:attempt:2")]);
    expect(next).toMatchObject({
      kind: "claim",
      receipt: { event: { id: "run:1:attempt:2" }, checkpoint: { automaticStarts: 1 } },
    });
    expect(observe(state(next), [event("run:1:attempt:2")]).kind).toBe("checkpoint");
  });
  it("observes assignment transitions rather than ordinary updates of an assigned issue", () => {
    const baseline = state(observe(initial, [event("issue:1")], { semantics: "assignment-set" }));
    expect(observe(baseline, [event("issue:1")], { semantics: "assignment-set" }).kind).toBe(
      "checkpoint",
    );
    const absent = state(observe(baseline, [], { semantics: "assignment-set" }));
    expect(observe(absent, [event("issue:1")], { semantics: "assignment-set" }).kind).toBe("claim");
  });
  it("catches up once or skips surviving offline events without an offline burst", () => {
    const baseline = state(observe());
    expect(observe(baseline, [event("1"), event("2")], { coverageGap: true })).toMatchObject({
      kind: "claim",
      receipt: { event: { id: "2" }, checkpoint: { pending: [], coverageGap: true } },
    });
    expect(
      observe(baseline, [event("1")], { coverageGap: true, missedRunPolicy: "skip" }),
    ).toMatchObject({ kind: "checkpoint", checkpoint: { pending: [], automaticStarts: 0 } });
  });
  it("retains a busy or routine-produced event for explicit review and preserves the finite limit", () => {
    const baseline = state(observe());
    const held = state(observe(baseline, [event("1")], { busy: true }));
    expect(held).toMatchObject({ phase: "held", reason: "busy-input", pending: [{ id: "1" }] });
    expect(observe(held, []).kind).toBe("checkpoint");
    expect(state(observe(baseline, [{ ...event("2"), routineOutput: true }]))).toMatchObject({
      phase: "held",
      reason: "routine-output",
    });
    expect(state(observe({ ...baseline, automaticStarts: 8 }, [event("3")]))).toMatchObject({
      phase: "needs-rearm",
      reason: "automatic-start-limit",
      automaticStarts: 8,
    });
  });
});
