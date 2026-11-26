import type { CodeThreadId, WindowId } from "@octant/contracts";
import type {
  PullRequestGuideFailureReason,
  PullRequestGuideView,
} from "@octant/contracts/pull-request-guide";

/**
 * What the Code runtime needs to let a thread's agent read, and ask to write,
 * the review guide of its own pull request. Like the CI port it keeps the
 * runtime off the guide service; the host resolves which pull request.
 */
export interface PullRequestGuidePort {
  read(input: {
    readonly windowId: WindowId;
    readonly threadId: CodeThreadId;
    readonly signal: AbortSignal;
  }): Promise<PullRequestGuideReadOutcome>;
  /** Asks `confirm` after the cheap refusals, then waits for the run to settle. */
  write(input: {
    readonly windowId: WindowId;
    readonly threadId: CodeThreadId;
    readonly confirm?: (pullRequest: { readonly number: number }) => Promise<boolean>;
    readonly signal: AbortSignal;
  }): Promise<PullRequestGuideWriteOutcome>;
}

export type PullRequestGuideReadOutcome =
  | { readonly status: "read"; readonly number: number; readonly view: PullRequestGuideView }
  | { readonly status: "refused"; readonly reason: string };

export type PullRequestGuideWriteOutcome =
  | {
      readonly status: "written";
      readonly number: number;
      readonly headSha: string;
      readonly stops: number;
    }
  | { readonly status: "failed"; readonly reason: PullRequestGuideFailureReason }
  | { readonly status: "refused"; readonly reason: string }
  | { readonly status: "not-confirmed" };
