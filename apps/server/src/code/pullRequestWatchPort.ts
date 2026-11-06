import type { CodeProjectPullRequestSwitchTarget, CodeThreadId, WindowId } from "@octant/contracts";

/**
 * The one capability the Code runtime needs to let a thread watch its own pull
 * request. GitHub sits with the separable integrations in the plugin-boundary
 * table, so the runtime and its pull-request tool depend on this port, never on
 * the switch service that satisfies it today; the composition root binds the
 * two, and an extracted GitHub package would satisfy the same port.
 */
export interface PullRequestWatchPort {
  /**
   * Resolves the thread's own linked pull request, checks the window may act
   * on it, and only then calls `ask`; the person's answer is the approval.
   */
  watch(input: {
    readonly windowId: WindowId;
    readonly threadId: CodeThreadId;
    readonly providerInstanceId: string;
    readonly ask: (target: CodeProjectPullRequestSwitchTarget) => Promise<PullRequestWatchAnswer>;
    readonly signal: AbortSignal;
  }): Promise<PullRequestWatchOutcome>;
  /** Stops the thread's own watch; it only takes reach away, so it never asks. */
  unwatch(input: {
    readonly threadId: CodeThreadId;
    readonly providerInstanceId: string;
  }): Promise<PullRequestWatchOutcome>;
}

/** The person's answer to one request to watch a pull request. */
export type PullRequestWatchAnswer =
  | "approved"
  | "denied"
  | "cancelled"
  | "expired"
  | "unavailable";

/** What a thread's agent hears back when it asks to watch or stop watching. */
export type PullRequestWatchOutcome =
  | {
      readonly status: "watching";
      readonly target: CodeProjectPullRequestSwitchTarget;
      readonly until: string;
      readonly alreadyWatching: boolean;
    }
  | { readonly status: "unwatched"; readonly target: CodeProjectPullRequestSwitchTarget }
  | { readonly status: "not-watching" }
  | { readonly status: "declined"; readonly answer: Exclude<PullRequestWatchAnswer, "approved"> }
  | {
      readonly status: "refused";
      readonly reason:
        | "no-pull-request"
        | "ambiguous-pull-request"
        | "not-authorized"
        | "not-open"
        | "thread-unavailable"
        | "watched-by-another-thread";
    }
  | { readonly status: "unavailable"; readonly reason: "disconnected" | "unavailable" };
