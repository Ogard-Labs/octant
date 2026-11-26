import type { CodeProjectPullRequestSwitchTarget, CodeThreadId, WindowId } from "@octant/contracts";
import type { GhCiLogEntry, GhCiRerunRefusal } from "./ghPullRequestSwitchPort";

/** Reruns of one check's run on one head before the host refuses another. */
export const MAX_PULL_REQUEST_CI_RERUNS = 3;

/**
 * What the Code runtime needs to let a thread's agent read and rerun the CI
 * of its own pull request. Like the watch port, it keeps the runtime and its
 * pull-request tool off the GitHub switch service that satisfies it today;
 * the agent never names a pull request, the host resolves the thread's own.
 */
export interface PullRequestCiPort {
  logs(input: {
    readonly windowId: WindowId;
    readonly threadId: CodeThreadId;
    readonly check?: string;
    readonly tailLines: number;
    readonly signal: AbortSignal;
  }): Promise<PullRequestCiLogsOutcome>;
  /**
   * Plans the rerun on the current head, asks `confirm` when it is given, and
   * starts it only if the head has not moved since the plan was read.
   */
  rerun(input: {
    readonly windowId: WindowId;
    readonly threadId: CodeThreadId;
    readonly check?: string;
    readonly headSha?: string;
    readonly confirm?: (plan: PullRequestCiRerunPlanSummary) => Promise<PullRequestCiConfirmation>;
    readonly signal: AbortSignal;
  }): Promise<PullRequestCiRerunOutcome>;
}

export interface PullRequestCiRerunPlanSummary {
  readonly number: number;
  readonly headSha: string;
  readonly checks: ReadonlyArray<string>;
}

export type PullRequestCiConfirmation =
  | "approved"
  | "denied"
  | "cancelled"
  | "expired"
  | "unavailable";

type ThreadPullRequestRefusal =
  | "no-pull-request"
  | "ambiguous-pull-request"
  | "not-authorized"
  | "not-open"
  | "thread-unavailable"
  | "pull-request-replaced";

export type PullRequestCiLogsOutcome =
  | {
      readonly status: "read";
      readonly target: CodeProjectPullRequestSwitchTarget;
      readonly headSha: string;
      readonly logs: ReadonlyArray<GhCiLogEntry>;
      readonly running: ReadonlyArray<string>;
    }
  | { readonly status: "refused"; readonly reason: ThreadPullRequestRefusal | "no-such-check" }
  | { readonly status: "unavailable"; readonly reason: "disconnected" | "unavailable" };

export type PullRequestCiRerunOutcome =
  | {
      readonly status: "rerun";
      readonly target: CodeProjectPullRequestSwitchTarget;
      readonly headSha: string;
      readonly checks: ReadonlyArray<string>;
    }
  | {
      readonly status: "refused";
      readonly reason: ThreadPullRequestRefusal | GhCiRerunRefusal;
    }
  | {
      readonly status: "not-confirmed";
      readonly answer: Exclude<PullRequestCiConfirmation, "approved">;
    }
  | { readonly status: "failed"; readonly rerun: ReadonlyArray<string> }
  | { readonly status: "unavailable"; readonly reason: "disconnected" | "unavailable" };
