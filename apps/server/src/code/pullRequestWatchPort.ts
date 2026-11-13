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
   * on it, and turns the watch on. Nobody is asked: a watch changes nothing on
   * the forge and ends by its own wake and lifetime limits.
   */
  watch(input: {
    readonly windowId: WindowId;
    readonly threadId: CodeThreadId;
    readonly providerInstanceId: string;
    readonly signal: AbortSignal;
  }): Promise<PullRequestWatchOutcome>;
  /** Stops the thread's own watch; it only takes reach away, so it never asks. */
  unwatch(input: {
    readonly threadId: CodeThreadId;
    readonly providerInstanceId: string;
  }): Promise<PullRequestWatchOutcome>;
}

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
