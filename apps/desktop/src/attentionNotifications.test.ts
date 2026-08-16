import { describe, expect, it } from "vitest";
import {
  ATTENTION_BADGE_LIMIT,
  ATTENTION_NOTIFICATION_BODY_LIMIT,
  attentionBadgeLabel,
  attentionNotificationPresentation,
  decodeAttentionBadgeCount,
  decodeAttentionNotificationRequest,
} from "./attentionNotifications";

describe("attention notifications", () => {
  it("names the reason in the title and the thread in the body", () => {
    expect(
      attentionNotificationPresentation({
        reason: "approval-required",
        threadTitle: "Fix the diff pane",
        detail: "Run bun run verify",
      }),
    ).toEqual({
      title: "Approval needed",
      body: "Fix the diff pane — Run bun run verify",
      silent: false,
    });
  });

  it("stays silent for a finished turn and audible for a blocked one", () => {
    const finished = attentionNotificationPresentation({
      reason: "turn-finished",
      threadTitle: "Fix the diff pane",
    });
    const asked = attentionNotificationPresentation({
      reason: "question-asked",
      threadTitle: "Fix the diff pane",
    });
    expect(finished).toEqual({
      title: "Turn finished",
      body: "Fix the diff pane",
      silent: true,
    });
    expect(asked.silent).toBe(false);
  });

  it("clamps an oversized body so the native banner stays readable", () => {
    const body = attentionNotificationPresentation({
      reason: "turn-finished",
      threadTitle: "x".repeat(1_000),
    }).body;
    expect(body.length).toBe(ATTENTION_NOTIFICATION_BODY_LIMIT);
    expect(body.endsWith("…")).toBe(true);
  });

  it("rejects a request the renderer did not shape correctly", () => {
    expect(() => decodeAttentionNotificationRequest(undefined)).toThrow();
    expect(() => decodeAttentionNotificationRequest({ reason: "nope", threadTitle: "a" })).toThrow();
    expect(() =>
      decodeAttentionNotificationRequest({ reason: "turn-finished", threadTitle: "   " }),
    ).toThrow();
    expect(
      decodeAttentionNotificationRequest({
        reason: "turn-finished",
        threadTitle: " Fix\nthe pane ",
        detail: 7,
      }),
    ).toEqual({ reason: "turn-finished", threadTitle: "Fix the pane" });
  });

  it("renders the dock badge, clearing at zero and capping the high end", () => {
    expect(attentionBadgeLabel(0)).toBe("");
    expect(attentionBadgeLabel(3)).toBe("3");
    expect(attentionBadgeLabel(ATTENTION_BADGE_LIMIT + 1)).toBe(`${ATTENTION_BADGE_LIMIT}+`);
  });

  it("normalises a badge count and rejects a non-numeric one", () => {
    expect(decodeAttentionBadgeCount(-4)).toBe(0);
    expect(decodeAttentionBadgeCount(2.7)).toBe(2);
    expect(() => decodeAttentionBadgeCount("2")).toThrow();
    expect(() => decodeAttentionBadgeCount(Number.NaN)).toThrow();
  });
});
