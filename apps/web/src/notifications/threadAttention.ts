/**
 * Which threads are waiting on the user, and what changed since the last look.
 *
 * The renderer already knows every attention signal it renders in the sidebar;
 * this model turns that into the two native surfaces the desktop shell owns —
 * a one-shot banner per newly raised signal, and a standing dock badge count.
 */

export type ThreadAttentionReason =
  | "turn-finished"
  | "approval-required"
  | "question-asked"
  | "follow-up-due";

export interface ThreadAttentionSignal {
  readonly threadId: string;
  readonly reason: ThreadAttentionReason;
  readonly title: string;
  readonly detail?: string;
  /** Which surface can open the thread; a thread id alone names no mode. */
  readonly source: "chat" | "code" | "work";
  readonly projectId?: string;
}

export interface ThreadAttentionInput {
  /** Every signal currently outstanding, across modes. */
  readonly signals: ReadonlyArray<ThreadAttentionSignal>;
  /** The thread the user is looking at, when the window has focus. */
  readonly watchedThreadId?: string;
  readonly windowFocused: boolean;
}

export interface ThreadAttentionOutcome {
  readonly badgeCount: number;
  /** Signals raised since the previous evaluation and still unwatched. */
  readonly announce: ReadonlyArray<ThreadAttentionSignal>;
  /** Opaque carry-over for the next evaluation. */
  readonly raised: ReadonlySet<string>;
}

export const EMPTY_THREAD_ATTENTION: ReadonlySet<string> = new Set<string>();

function signalKey(signal: ThreadAttentionSignal): string {
  return `${signal.threadId}:${signal.reason}`;
}

/**
 * A signal on the thread the user is actively watching is answered by the UI
 * itself, so it neither banners nor badges.
 */
function isWatched(signal: ThreadAttentionSignal, input: ThreadAttentionInput): boolean {
  return input.windowFocused && signal.threadId === input.watchedThreadId;
}

export function evaluateThreadAttention(
  input: ThreadAttentionInput,
  raised: ReadonlySet<string> = EMPTY_THREAD_ATTENTION,
): ThreadAttentionOutcome {
  const announce: ThreadAttentionSignal[] = [];
  const nextRaised = new Set<string>();
  const badgedThreads = new Set<string>();
  for (const signal of input.signals) {
    const key = signalKey(signal);
    if (nextRaised.has(key)) continue;
    nextRaised.add(key);
    if (isWatched(signal, input)) continue;
    badgedThreads.add(signal.threadId);
    if (!raised.has(key)) announce.push(signal);
  }
  return { announce, badgeCount: badgedThreads.size, raised: nextRaised };
}
