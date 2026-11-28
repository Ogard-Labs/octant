import {
  type LinearIssueWorkflow,
  type LinkedIssueMoment,
  type LinkedIssueRef,
  type TrackerIssueWriteAction,
  type TrackerIssueWriteReason,
  type TrackerIssueWriteRecorded,
} from "@octant/contracts";
import {
  chooseLinearIssueState,
  decideGithubIssueMoment,
  linkedIssueLabel,
  sameLinkedIssue,
} from "@octant/domain/tracker-issue-write-policy";
import { commentDigest, type ThreadLinkedIssueStore } from "./threadLinkedIssueStore";

type GithubIssue = Extract<LinkedIssueRef, { readonly forge: "github" }>;

export type TrackerWriteResult =
  | { readonly status: "applied" }
  | {
      readonly status: "refused" | "failed";
      readonly reason: TrackerIssueWriteReason;
      /** The tracker's own remediation, when it gave one. */
      readonly message?: string;
    };

export type TrackerReadResult<T> =
  | { readonly status: "read"; readonly value: T }
  | Exclude<TrackerWriteResult, { readonly status: "applied" }>;

/**
 * The tracker calls the host may make for a linked issue. Linear is reached
 * only through its integration plugin's operations and GitHub only through
 * the host's `gh` issue port; neither ever sees a credential here.
 */
export interface TrackerIssuePort {
  readonly linearWorkflow: (
    issueId: string,
    signal?: AbortSignal,
    accountRef?: string,
  ) => Promise<TrackerReadResult<LinearIssueWorkflow>>;
  readonly linearSetState: (
    issueId: string,
    stateId: string,
    signal?: AbortSignal,
    accountRef?: string,
  ) => Promise<TrackerWriteResult>;
  readonly linearComment: (
    issueId: string,
    body: string,
    signal?: AbortSignal,
    accountRef?: string,
  ) => Promise<TrackerWriteResult>;
  readonly githubOpen: (
    issue: GithubIssue,
    signal?: AbortSignal,
  ) => Promise<TrackerReadResult<boolean>>;
  readonly githubComment: (
    issue: GithubIssue,
    body: string,
    signal?: AbortSignal,
  ) => Promise<TrackerWriteResult>;
  readonly githubClose: (issue: GithubIssue, signal?: AbortSignal) => Promise<TrackerWriteResult>;
}

/** What one write said, for the person when it did not apply. */
export interface TrackerWriteNotice {
  readonly issue: LinkedIssueRef;
  readonly message: string;
}

const REFUSAL_COPY: Readonly<Partial<Record<TrackerIssueWriteReason, string>>> = {
  "missing-scope":
    "Linear lets Octant read only. Reconnect Linear in Settings › Integrations to allow updates.",
  "missing-capability":
    "Your GitHub sign-in cannot change this repository's issues. Ask for triage access or update the issue yourself.",
  "not-connected": "Connect the tracker in Settings › Integrations to update this issue.",
};

/** How the caller reached a moment, which decides what it may try again. */
export interface TrackerAdvanceOptions {
  /**
   * A new trigger for the thread (a turn the person asked for, a pull request
   * the thread opened) retries a refused or failed moment. The periodic pass
   * is not a trigger: it makes only a moment's first attempt, so a refusal
   * is not repeated every pass.
   */
  readonly retry: boolean;
  /**
   * Done only for an issue whose In Review the host recorded: the switch was
   * on while the pull request was open. Turning the switch on must not close
   * issues of threads that merged before it, which a person may have
   * reopened since, and a follow-up turn's In Progress after that merge does
   * not count.
   */
  readonly requireEarlierWrite?: boolean;
}

/**
 * Writes to the issues linked to a thread, and journals every attempt as
 * `tracker.issue-write-recorded@1`. The host's moments move an issue forward
 * only, once per (thread, issue, moment): an applied or skipped moment is
 * not tried again, while a refused or failed one is retried at its next
 * trigger only. One thread's moments run one at a time, so two turns started
 * together write once. A comment's text is never journaled, only its digest.
 */
export class TrackerIssueWrites {
  readonly #store: Pick<ThreadLinkedIssueStore, "list" | "writes" | "recordWrite">;
  readonly #port: TrackerIssuePort;
  readonly #linearAccountForThread: ((threadId: string) => string | undefined) | undefined;
  readonly #threadQueues = new Map<string, Promise<unknown>>();

  constructor(options: {
    readonly store: Pick<ThreadLinkedIssueStore, "list" | "writes" | "recordWrite">;
    readonly port: TrackerIssuePort;
    readonly linearAccountForThread?: (threadId: string) => string | undefined;
  }) {
    this.#store = options.store;
    this.#port = options.port;
    this.#linearAccountForThread = options.linearAccountForThread;
  }

  /**
   * Moves every issue linked to the thread to `moment`, with the merge
   * comment on Done. Answers what the person should hear about: writes that
   * were refused, the first time each is.
   */
  advance(
    threadId: string,
    moment: LinkedIssueMoment,
    mergedPullRequestUrl: string | undefined,
    options: TrackerAdvanceOptions,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<TrackerWriteNotice>> {
    const previous = this.#threadQueues.get(threadId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() => this.#advance(threadId, moment, mergedPullRequestUrl, options, signal));
    const settledRun = run.catch(() => undefined);
    this.#threadQueues.set(threadId, settledRun);
    void settledRun.then(() => {
      if (this.#threadQueues.get(threadId) === settledRun) this.#threadQueues.delete(threadId);
    });
    return run;
  }

  async #advance(
    threadId: string,
    moment: LinkedIssueMoment,
    mergedPullRequestUrl: string | undefined,
    options: TrackerAdvanceOptions,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<TrackerWriteNotice>> {
    const notices: TrackerWriteNotice[] = [];
    for (const { issue } of this.#store.list(threadId)) {
      const issueRecords = this.#store
        .writes(threadId)
        .filter((record) => sameLinkedIssue(record.issue, issue) && record.actor === "host");
      if (
        options.requireEarlierWrite === true &&
        !issueRecords.some((record) => record.target === "in-review")
      )
        continue;
      const records = issueRecords.filter((record) => record.target === moment);
      if (!options.retry && records.length > 0) continue;
      const settled = (action: TrackerIssueWriteAction) =>
        records.some(
          (record) =>
            record.action === action &&
            (record.outcome === "applied" || record.outcome === "skipped"),
        );
      const stateAction = issue.forge === "github" ? "close" : "set-state";
      const record = (
        action: TrackerIssueWriteAction,
        result:
          | TrackerWriteResult
          | { readonly status: "skipped"; readonly reason: TrackerIssueWriteReason },
        extra: TrackerWriteExtra = {},
      ) => {
        const outcome = result.status;
        const reason = result.status === "applied" ? undefined : result.reason;
        const last = records.findLast((entry) => entry.action === action);
        // A retry that fails the same way adds nothing to the record or the notice.
        if (last?.outcome === outcome && last.reason === reason && outcome !== "applied") return;
        this.#store.recordWrite({
          threadId,
          issue,
          action,
          target: moment,
          outcome,
          ...(reason === undefined ? {} : { reason }),
          actor: "host",
          ...extra,
        });
        if (outcome === "refused" && reason !== undefined) {
          notices.push({ issue, message: noticeFor(issue, result) });
        }
      };
      const accountRef = this.#linearAccountForThread?.(threadId);
      if (!settled(stateAction)) {
        await this.#moveState(issue, moment, signal, accountRef, (result, stateId) =>
          record(stateAction, result, stateId === undefined ? {} : { stateId }),
        );
      }
      if (moment === "done" && mergedPullRequestUrl !== undefined && !settled("comment")) {
        const body = `Merged in \`${mergedPullRequestUrl}\`.`;
        const result =
          issue.forge === "linear"
            ? accountRef === undefined
              ? await this.#port.linearComment(issue.issueId, body, signal)
              : await this.#port.linearComment(issue.issueId, body, signal, accountRef)
            : await this.#port.githubComment(issue, body, signal);
        record("comment", result, { commentDigest: commentDigest(body) });
      }
    }
    return notices;
  }

  async #moveState(
    issue: LinkedIssueRef,
    moment: LinkedIssueMoment,
    signal: AbortSignal | undefined,
    accountRef: string | undefined,
    record: (
      result:
        | TrackerWriteResult
        | { readonly status: "skipped"; readonly reason: TrackerIssueWriteReason },
      stateId?: string,
    ) => void,
  ): Promise<void> {
    if (issue.forge === "github") {
      if (moment !== "done") {
        record({ status: "skipped", reason: "no-state-on-github" });
        return;
      }
      const open = await this.#port.githubOpen(issue, signal);
      if (open.status !== "read") return record(open);
      const decision = decideGithubIssueMoment({ moment, open: open.value });
      // An issue already closed is where Done would put it.
      if (decision.kind === "already-closed") return record({ status: "applied" });
      if (decision.kind === "skip") return record({ status: "skipped", reason: decision.reason });
      record(await this.#port.githubClose(issue, signal));
      return;
    }
    const workflow =
      accountRef === undefined
        ? await this.#port.linearWorkflow(issue.issueId, signal)
        : await this.#port.linearWorkflow(issue.issueId, signal, accountRef);
    if (workflow.status !== "read") return record(workflow);
    const choice = chooseLinearIssueState({
      moment,
      current: workflow.value.state,
      states: workflow.value.teamStates,
    });
    if (choice.kind === "skip") return record({ status: "skipped", reason: choice.reason });
    record(
      accountRef === undefined
        ? await this.#port.linearSetState(issue.issueId, choice.state.id, signal)
        : await this.#port.linearSetState(issue.issueId, choice.state.id, signal, accountRef),
      choice.state.id,
    );
  }

  /**
   * The agent's own state change, already decided and approved by the tool.
   * `state` names a Linear state of the issue's team by name or by type; on
   * GitHub only `closed` exists, as close as completed.
   */
  async agentSetState(
    threadId: string,
    issue: LinkedIssueRef,
    state: string,
    signal?: AbortSignal,
  ): Promise<
    | TrackerWriteResult
    | { readonly status: "unknown-state"; readonly states: ReadonlyArray<string> }
  > {
    if (issue.forge === "github") {
      if (state.trim().toLowerCase() !== "closed") {
        return { status: "unknown-state", states: ["closed"] };
      }
      const result = await this.#port.githubClose(issue, signal);
      this.#recordAgent(threadId, issue, "close", result);
      return result;
    }
    const accountRef = this.#linearAccountForThread?.(threadId);
    const workflow =
      accountRef === undefined
        ? await this.#port.linearWorkflow(issue.issueId, signal)
        : await this.#port.linearWorkflow(issue.issueId, signal, accountRef);
    if (workflow.status !== "read") return workflow;
    const wanted = state.trim().toLowerCase();
    const byPosition = [...workflow.value.teamStates].sort((a, b) => a.position - b.position);
    const target =
      byPosition.find((entry) => entry.name.toLowerCase() === wanted) ??
      byPosition.find((entry) => entry.type.toLowerCase() === wanted);
    if (target === undefined) {
      return { status: "unknown-state", states: byPosition.map((entry) => entry.name) };
    }
    const result =
      accountRef === undefined
        ? await this.#port.linearSetState(issue.issueId, target.id, signal)
        : await this.#port.linearSetState(issue.issueId, target.id, signal, accountRef);
    this.#recordAgent(threadId, issue, "set-state", result, { stateId: target.id });
    return result;
  }

  async agentComment(
    threadId: string,
    issue: LinkedIssueRef,
    body: string,
    signal?: AbortSignal,
  ): Promise<TrackerWriteResult> {
    const accountRef = this.#linearAccountForThread?.(threadId);
    const result =
      issue.forge === "linear"
        ? accountRef === undefined
          ? await this.#port.linearComment(issue.issueId, body, signal)
          : await this.#port.linearComment(issue.issueId, body, signal, accountRef)
        : await this.#port.githubComment(issue, body, signal);
    this.#recordAgent(threadId, issue, "comment", result, { commentDigest: commentDigest(body) });
    return result;
  }

  #recordAgent(
    threadId: string,
    issue: LinkedIssueRef,
    action: TrackerIssueWriteAction,
    result: TrackerWriteResult,
    extra: TrackerWriteExtra = {},
  ): void {
    this.#store.recordWrite({
      threadId,
      issue,
      action,
      outcome: result.status,
      ...(result.status === "applied" ? {} : { reason: result.reason }),
      actor: "agent",
      ...extra,
    });
  }
}

/** The line a person reads when a write was refused, naming the issue and the fix. */
export function noticeFor(
  issue: LinkedIssueRef,
  result: { readonly reason: TrackerIssueWriteReason; readonly message?: string },
): string {
  const copy =
    REFUSAL_COPY[result.reason] ?? result.message ?? "Octant could not update this issue.";
  return `${linkedIssueLabel(issue)} was not updated: ${copy}`;
}

type TrackerWriteExtra = Partial<Pick<TrackerIssueWriteRecorded, "stateId" | "commentDigest">>;
