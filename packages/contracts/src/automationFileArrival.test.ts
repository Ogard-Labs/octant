import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  AutomationThreadRoutineRequest,
  RoutineProposal,
  decodeAutomationTrigger,
  decodeAutomationScheduledTrigger,
} from "./automation";

const trigger = {
  kind: "file-arrival",
  directory: "Inbox",
  includeExtensions: ["pdf", "txt"],
  excludeDirectories: ["processed"],
  settleSeconds: 5,
  automaticStartLimit: 8,
};
describe("bounded Work file-arrival trigger", () => {
  it("represents the explicit selected input and finite per-arm automatic limit", () => {
    expect(decodeAutomationTrigger(trigger)).toEqual(trigger);
  });
  it.each([
    "/outside",
    "../outside",
    "Inbox/../outside",
    "Inbox\\outside",
    "C:/outside",
    "//host/share",
    ".git",
    "Inbox/bad\u0000name",
    "Inbox/bad\nname",
  ])("refuses an unconfined or operational directory %s", (directory) => {
    expect(() => decodeAutomationTrigger({ ...trigger, directory })).toThrow();
  });
  it.each([0, 33, 1.5])("refuses automatic-start limit %s", (automaticStartLimit) => {
    expect(() => decodeAutomationTrigger({ ...trigger, automaticStartLimit })).toThrow();
  });
  it.each([1, 61])("refuses settling interval %s", (settleSeconds) => {
    expect(() => decodeAutomationTrigger({ ...trigger, settleSeconds })).toThrow();
  });
  it("does not accept hidden arbitrary patterns or source credentials", () => {
    expect(() => decodeAutomationTrigger({ ...trigger, includeExtensions: [".*"] })).toThrow();
    expect(() => decodeAutomationTrigger({ ...trigger, token: "must-not-pass" })).toThrow();
  });
  it("keeps file triggers out of thread-agent proposals and thread follow-ups", () => {
    expect(() => decodeAutomationScheduledTrigger(trigger)).toThrow();
    expect(
      decodeAutomationScheduledTrigger({ kind: "once", scheduledAt: "2026-11-03T12:00:00.000Z" })
        .kind,
    ).toBe("once");
    const request = {
      threadId: "11111111-1111-4111-8111-111111111111",
      mode: "work",
      projectId: "22222222-2222-4222-8222-222222222222",
      displayName: "Inbox",
      taskPrompt: "Process arrivals",
      trigger,
      missedRunPolicy: "skip",
    };
    expect(() =>
      Schema.decodeUnknownSync(AutomationThreadRoutineRequest)({
        ...request,
        kind: "create-thread-routine",
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(RoutineProposal)({
        ...request,
        proposalId: "33333333-3333-4333-8333-333333333333",
        firstRunAt: "2026-11-03T00:00:00.000Z",
        requestedAt: "2026-11-03T00:00:00.000Z",
      }),
    ).toThrow();
  });
});
