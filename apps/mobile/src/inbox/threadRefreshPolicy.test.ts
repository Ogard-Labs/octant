import { describe, expect, it } from "vitest";
import {
  MOBILE_CHAT_IDLE_REFRESH_INITIAL_DELAY_MS,
  MOBILE_CHAT_IDLE_REFRESH_MAX_DELAY_MS,
  enteredMobileForeground,
  nextMobileChatIdleRefreshDelay,
} from "./threadRefreshPolicy";

describe("mobile thread refresh policy", () => {
  it("backs off repeated empty event replays and caps the delay", () => {
    expect(
      nextMobileChatIdleRefreshDelay({
        currentDelayMs: MOBILE_CHAT_IDLE_REFRESH_INITIAL_DELAY_MS,
        receivedFrame: false,
      }),
    ).toBe(1_500);
    expect(
      nextMobileChatIdleRefreshDelay({
        currentDelayMs: 8_000,
        receivedFrame: false,
      }),
    ).toBe(MOBILE_CHAT_IDLE_REFRESH_MAX_DELAY_MS);
  });

  it("resets idle backoff after a replay delivers an event frame", () => {
    expect(nextMobileChatIdleRefreshDelay({ currentDelayMs: 8_000, receivedFrame: true })).toBe(
      MOBILE_CHAT_IDLE_REFRESH_INITIAL_DELAY_MS,
    );
  });

  it("refreshes when the app returns to the foreground, not on background transitions", () => {
    expect(enteredMobileForeground("background", "active")).toBe(true);
    expect(enteredMobileForeground("inactive", "active")).toBe(true);
    expect(enteredMobileForeground("active", "active")).toBe(false);
    expect(enteredMobileForeground("active", "background")).toBe(false);
  });
});
