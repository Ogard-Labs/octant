export const MOBILE_CHAT_IDLE_REFRESH_INITIAL_DELAY_MS = 750;
export const MOBILE_CHAT_IDLE_REFRESH_MAX_DELAY_MS = 10_000;

export function nextMobileChatIdleRefreshDelay(input: {
  readonly currentDelayMs: number;
  readonly receivedFrame: boolean;
}): number {
  if (input.receivedFrame) return MOBILE_CHAT_IDLE_REFRESH_INITIAL_DELAY_MS;
  return Math.min(
    Math.max(MOBILE_CHAT_IDLE_REFRESH_INITIAL_DELAY_MS, input.currentDelayMs) * 2,
    MOBILE_CHAT_IDLE_REFRESH_MAX_DELAY_MS,
  );
}

export function enteredMobileForeground(previous: string | null, next: string): boolean {
  return previous !== "active" && next === "active";
}
