import type { AppleBuildEvidence } from "@octant/contracts";
import { beforeAll, describe, expect, it } from "vitest";

let composeAppleValidationEvents: (input: Record<string, unknown>) => any;

beforeAll(async () => {
  const path = "./appleValidationEvidence";
  const loaded = await import(path).catch(() => undefined);
  expect(loaded).toBeDefined();
  expect(loaded?.composeAppleValidationEvents).toBeTypeOf("function");
  composeAppleValidationEvents = loaded!.composeAppleValidationEvents;
});

const evidence: AppleBuildEvidence = {
  actionId: "b1000000-0000-4000-8000-000000000001" as never,
  correlationId: "b1000000-0000-4000-8000-000000000002" as never,
  authority: {
    hostId: "4f70656e-4f72-4269-9474-4c6f63616c31" as never,
    mode: "code",
    projectId: "b1000000-0000-4000-8000-000000000003" as never,
    providerInstanceId: "b1000000-0000-4000-8000-000000000004" as never,
    extension: { kind: "core" },
  },
  kind: "test",
  outcome: "timed-out",
  diagnostics: [{ severity: "note", message: "Test exceeded its bounded action budget." }],
  artifacts: [{ kind: "xcresult", reference: "apple-xcresult-safe" }],
  cleanup: "complete",
  durationMs: 120000,
  completedAt: "2026-07-27T20:02:00.000Z" as never,
};

describe("composeAppleValidationEvents", () => {
  it("maps Apple evidence into one replayable plan, record, and report", () => {
    const composed = composeAppleValidationEvents({
      evidence,
      startedAt: "2026-07-27T20:00:00.000Z",
      newId: () => "b1000000-0000-4000-8000-000000000005",
    });
    expect(composed.plan).toMatchObject({
      planId: evidence.actionId,
      authority: evidence.authority,
      steps: [{ stepId: "apple-test", expectedOutcome: "passed" }],
    });
    expect(composed.record).toMatchObject({
      outcome: "inconclusive",
      source: {
        kind: "apple-test",
        reference: "apple-xcresult-safe",
        actionId: evidence.actionId,
        correlationId: evidence.correlationId,
      },
    });
    expect(composed.report).toMatchObject({
      overallOutcome: "inconclusive",
      stepResults: [{ stepId: "apple-test", outcome: "inconclusive", evidenceCount: 1 }],
    });
    expect(JSON.stringify(composed)).not.toContain("/private/");
  });

  it("marks typed Simulator input evidence as redacted", () => {
    const composed = composeAppleValidationEvents({
      evidence: {
        ...evidence,
        kind: "type-text",
        diagnostics: [{ severity: "note", message: "type-text completed (length=4; redacted)" }],
        artifacts: [{ kind: "log", reference: "apple-log-safe" }],
      },
      startedAt: "2026-07-27T20:00:00.000Z",
      newId: () => "b1000000-0000-4000-8000-000000000005",
    });
    expect(composed.record.redacted).toBe(true);
    expect(JSON.stringify(composed)).not.toContain("secret");
  });

  it("journals a physical device's signed build under a device step, with the identity that signed it", () => {
    const signedNote =
      "Signed sh.octant.SimulatorFixture for development with identity 0123456789ABCDEF0123456789ABCDEF01234567 of team A1B2C3D4E5.";
    const composed = composeAppleValidationEvents({
      evidence: {
        ...evidence,
        kind: "build",
        outcome: "succeeded",
        deviceId: "b1000000-0000-4000-8000-000000000006",
        requestedBy: { kind: "local-user", actorId: "b1000000-0000-4000-8000-000000000007" },
        bundleIdentifier: "sh.octant.SimulatorFixture",
        product: "apple-device-product-b1000000-0000-4000-8000-000000000001",
        signing: { teamId: "A1B2C3D4E5", identity: "0123456789ABCDEF0123456789ABCDEF01234567" },
        diagnostics: [{ severity: "note", message: signedNote }],
        artifacts: [{ kind: "log", reference: "apple-device-log-safe" }],
      },
      startedAt: "2026-07-27T20:00:00.000Z",
      newId: () => "b1000000-0000-4000-8000-000000000005",
    });
    expect(composed.plan.steps).toMatchObject([{ stepId: "apple-device-build" }]);
    expect(composed.record).toMatchObject({
      outcome: "passed",
      detail: `note: ${signedNote}`,
      redacted: false,
      source: { kind: "apple-build", reference: "apple-device-log-safe" },
    });
  });
});
