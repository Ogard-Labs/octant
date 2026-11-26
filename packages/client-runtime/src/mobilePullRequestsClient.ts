import {
  CodeProjectPullRequestSwitchesView,
  CodeProjectPullRequestSwitchOutcome,
  CodeProjectPullRequestView,
  type CodeProjectPullRequestAutoFixState,
  decodeHostAnswer,
  type CodeProjectPullRequestFreshness,
  type CodeProjectPullRequestRow,
} from "@octant/contracts";
import type { MobileRemoteTransport } from "./mobileInboxClient";

/**
 * One computer's open pull requests, across every Code Project it connects to
 * a repository. A paired phone reads the same Project overview the desktop
 * reads; the host decides which rows the session may see.
 */
export type MobilePullRequestList =
  | {
      readonly status: "ready";
      readonly hostId: string;
      readonly rows: ReadonlyArray<CodeProjectPullRequestRow>;
      readonly freshness: CodeProjectPullRequestFreshness;
      /** The host listed only part of what it knows of. */
      readonly truncated: boolean;
    }
  | { readonly status: "refused"; readonly hostId: string; readonly message: string }
  | { readonly status: "unavailable"; readonly hostId: string; readonly message: string };

/**
 * Reads the host's cached overview, or, with `refresh`, asks the host to read
 * GitHub again for every connected Project first. The host bounds and paces
 * that refresh itself; a GitHub failure comes back as stale freshness, not as
 * a failed list.
 */
export async function listMobilePullRequests(
  transport: MobileRemoteTransport,
  options: { readonly refresh?: boolean; readonly signal?: AbortSignal } = {},
): Promise<MobilePullRequestList> {
  const hostId = transport.hostId;
  let response: Response;
  try {
    response = await transport.authenticatedFetch({
      method: "POST",
      path:
        options.refresh === true
          ? "/api/code/project-pull-requests/refresh"
          : "/api/code/project-pull-requests",
      body: JSON.stringify(options.refresh === true ? { kind: "refresh-all" } : { version: 1 }),
      contentType: "application/json",
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch {
    return { status: "unavailable", hostId, message: "This computer could not be reached." };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      status: "refused",
      hostId,
      message: "This computer does not share its pull requests with this phone.",
    };
  }
  if (!response.ok) {
    return {
      status: "unavailable",
      hostId,
      message: "This computer cannot list pull requests right now.",
    };
  }
  try {
    const view = decodeHostAnswer(CodeProjectPullRequestView)(await response.json());
    return {
      status: "ready",
      hostId,
      rows: view.rows,
      freshness: view.freshness,
      truncated: view.repositoriesTruncated || view.pullRequestsTruncated,
    };
  } catch {
    return {
      status: "unavailable",
      hostId,
      message: "This computer sent a pull request list the phone cannot read.",
    };
  }
}

/** Which pull request a switch names, as the overview row gives it. */
export interface MobilePullRequestSwitchTarget {
  readonly projectId: string;
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  readonly number: number;
}

export type MobileBabysitChange =
  | { readonly status: "applied"; readonly autoFix: CodeProjectPullRequestAutoFixState }
  | { readonly status: "refused"; readonly message: string };

const BABYSIT_REFUSALS: Readonly<Record<string, string>> = {
  "not-authorized": "This phone may not change Babysit for this pull request.",
  "not-open": "The pull request is no longer open.",
  stale: "Babysit changed on the computer. Look again and try once more.",
  "thread-not-linked": "That thread is no longer linked to this pull request.",
  "already-active": "Another thread already babysits this pull request.",
  failed: "Babysit could not be changed. Nothing changed.",
};
const BABYSIT_FAILED = "Babysit could not be changed. Nothing changed.";

async function postSwitch(
  transport: MobileRemoteTransport,
  path: "switches" | "auto-fix",
  body: unknown,
): Promise<unknown> {
  const response = await transport.authenticatedFetch({
    method: "POST",
    path: `/api/code/project-pull-requests/${path}`,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
  if (response.status === 401 || response.status === 403) throw new Error("refused");
  if (!response.ok) throw new Error("failed");
  return response.json();
}

/**
 * Turns Babysit on for one thread linked to the pull request, or off. The
 * thread then fixes failing checks, answers review findings and keeps the
 * branch current, as when it is turned on at the computer. A Babysit that
 * stopped is restarted only from the stop the phone just read, so a newer
 * stop on the computer is not overridden unseen.
 */
export async function setMobilePullRequestBabysit(
  transport: MobileRemoteTransport,
  input: MobilePullRequestSwitchTarget &
    (
      | { readonly on: true; readonly threadId: string; readonly checks: "required" | "all" }
      | { readonly on: false; readonly threadId?: string }
    ),
): Promise<MobileBabysitChange> {
  const target = {
    projectId: input.projectId,
    repositoryOwner: input.repositoryOwner,
    repositoryName: input.repositoryName,
    number: input.number,
  };
  try {
    let command: unknown;
    if (input.on) {
      const view = decodeHostAnswer(CodeProjectPullRequestSwitchesView)(
        await postSwitch(transport, "switches", target),
      );
      const stopped =
        view.autoFix.status === "stopped" && String(view.autoFix.threadId) === input.threadId
          ? view.autoFix.stoppedAt
          : undefined;
      command = {
        kind: "enable",
        target,
        threadId: input.threadId,
        babysit: { checks: input.checks },
        ...(stopped === undefined ? {} : { expectedStoppedAt: stopped }),
      };
    } else {
      command = {
        kind: "disable",
        target,
        ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
      };
    }
    const outcome = decodeHostAnswer(CodeProjectPullRequestSwitchOutcome)(
      await postSwitch(transport, "auto-fix", command),
    );
    if (outcome.status === "applied") return { status: "applied", autoFix: outcome.view.autoFix };
    return {
      status: "refused",
      message: BABYSIT_REFUSALS[outcome.reason] ?? BABYSIT_FAILED,
    };
  } catch (error) {
    return {
      status: "refused",
      message:
        error instanceof Error && error.message === "refused"
          ? (BABYSIT_REFUSALS["not-authorized"] ?? BABYSIT_FAILED)
          : BABYSIT_FAILED,
    };
  }
}

/** Whether Babysit runs for the pull request now, and for which thread; undefined when unreadable. */
/**
 * Babysit and Merge when ready as the computer holds them now. The overview's
 * row may predate either, so a pull request's page reads them when it opens.
 */
export async function readMobilePullRequestSwitches(
  transport: MobileRemoteTransport,
  target: MobilePullRequestSwitchTarget,
): Promise<
  | {
      readonly autoFix: CodeProjectPullRequestAutoFixState;
      readonly mergeWhenReadyOn: boolean;
    }
  | undefined
> {
  try {
    const view = decodeHostAnswer(CodeProjectPullRequestSwitchesView)(
      await postSwitch(transport, "switches", {
        projectId: target.projectId,
        repositoryOwner: target.repositoryOwner,
        repositoryName: target.repositoryName,
        number: target.number,
      }),
    );
    return { autoFix: view.autoFix, mergeWhenReadyOn: view.mergeWhenReady.status === "on" };
  } catch {
    return undefined;
  }
}
