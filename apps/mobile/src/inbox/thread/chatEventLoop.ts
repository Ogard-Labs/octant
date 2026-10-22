import { AppState } from "react-native";
import { loadMobileChatThread, subscribeMobileChatEvents } from "@octant/client-runtime";
import type { MobileRemoteTransport } from "@octant/client-runtime";
import type { ChatThreadView } from "@octant/contracts";
import {
  MOBILE_CHAT_IDLE_REFRESH_INITIAL_DELAY_MS,
  nextMobileChatIdleRefreshDelay,
} from "../threadRefreshPolicy";

/** Failures in a row before the screen says it is reconnecting. */
const RECONNECTING_AFTER_FAILURES = 2;

async function waitForForeground(signal: AbortSignal): Promise<boolean> {
  if (AppState.currentState === "active") return true;
  return new Promise((resolve) => {
    let settled = false;
    let subscription: { remove: () => void } | undefined;
    const abort = () => finish(false);
    const finish = (active: boolean) => {
      if (settled) return;
      settled = true;
      subscription?.remove();
      signal.removeEventListener("abort", abort);
      resolve(active);
    };
    subscription = AppState.addEventListener("change", (next) => {
      if (next === "active") finish(true);
    });
    signal.addEventListener("abort", abort, { once: true });
    if (AppState.currentState === "active") finish(true);
  });
}

async function waitForDelay(signal: AbortSignal, delayMs: number): Promise<boolean> {
  if (signal.aborted) return false;
  return new Promise((resolve) => {
    const finish = (completed: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      resolve(completed);
    };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(true), delayMs);
    signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Follows a chat thread's events and reloads the view after each burst. It
 * keeps reconnecting on error, and reports `reconnecting` once two attempts in
 * a row failed so the screen does not look frozen while the host is away.
 */
export async function runChatEventLoop(input: {
  readonly transport: MobileRemoteTransport;
  readonly threadId: string;
  readonly startSequence: number;
  readonly signal: AbortSignal;
  readonly onView: (view: ChatThreadView) => void;
  readonly onReconnecting: (reconnecting: boolean) => void;
}): Promise<void> {
  const { transport, threadId, signal } = input;
  let cursor = input.startSequence;
  let idleDelayMs = MOBILE_CHAT_IDLE_REFRESH_INITIAL_DELAY_MS;
  let consecutiveFailures = 0;

  while (!signal.aborted) {
    if (!(await waitForForeground(signal))) return;
    let receivedFrame = false;
    try {
      for await (const frame of subscribeMobileChatEvents({
        transport,
        threadId,
        afterSequence: cursor,
        signal,
      })) {
        if (signal.aborted) return;
        receivedFrame = true;
        cursor = frame.sequence;
      }
      if (signal.aborted) return;
      if (receivedFrame) {
        const next = await loadMobileChatThread(transport, threadId);
        if (signal.aborted) return;
        input.onView(next);
        cursor = next.lastSequence;
      }
      consecutiveFailures = 0;
      input.onReconnecting(false);
      const delayMs = receivedFrame ? MOBILE_CHAT_IDLE_REFRESH_INITIAL_DELAY_MS : idleDelayMs;
      if (!(await waitForDelay(signal, delayMs))) return;
    } catch {
      if (signal.aborted) return;
      receivedFrame = false;
      consecutiveFailures += 1;
      if (consecutiveFailures >= RECONNECTING_AFTER_FAILURES) input.onReconnecting(true);
      try {
        const next = await loadMobileChatThread(transport, threadId);
        if (!signal.aborted) {
          input.onView(next);
          cursor = next.lastSequence;
        }
      } catch {
        // Keep reconnecting while the thread is open.
      }
      if (!(await waitForDelay(signal, idleDelayMs))) return;
    }
    idleDelayMs = nextMobileChatIdleRefreshDelay({ currentDelayMs: idleDelayMs, receivedFrame });
  }
}
