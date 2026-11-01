import {
  CODE_PROJECT_PULL_REQUEST_ACTION_RECORDED,
  type CodeProjectPullRequestActionCommand,
  type CodeProjectPullRequestActionContext,
  type CodeProjectPullRequestActionContextQuery,
  type CodeProjectPullRequestActionOutcome,
  type CodeProjectPullRequestActionRecorded,
  type CodeProjectPullRequestDetailQuery,
  type CodeProjectPullRequestMergeCommand,
  type CodeProjectPullRequestMergeOutcome,
  type CodeProjectPullRequestStackMergeCommand,
  type CodeProjectPullRequestStackMergeOutcome,
  type WindowId,
} from "@octant/contracts";
import { decideStackMerge } from "@octant/domain/code-pull-request-action-policy";
import type { Journal } from "../persistence/journal";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";
import type {
  GhPullRequestActionContextResult,
  GhPullRequestActionResult,
  GhPullRequestIdentityRequest,
  GhPullRequestSummaryResult,
} from "./ghPullRequestActionPort";

/** Who is asking: the person at a desktop window, or on a paired phone or web client. */
export type CodeProjectPullRequestCaller = "local-window" | "remote-device";

export type CodeProjectPullRequestMergeAction = (
  windowId: WindowId,
  command: CodeProjectPullRequestMergeCommand,
  signal: AbortSignal,
  caller: CodeProjectPullRequestCaller,
) => Promise<CodeProjectPullRequestMergeOutcome>;

export interface CodeProjectPullRequestActionForge {
  editLabels(
    request: GhPullRequestIdentityRequest & {
      readonly add: ReadonlyArray<string>;
      readonly remove: ReadonlyArray<string>;
    },
    signal: AbortSignal,
  ): Promise<GhPullRequestActionResult>;
  comment(
    request: GhPullRequestIdentityRequest & { readonly body: string },
    signal: AbortSignal,
  ): Promise<GhPullRequestActionResult>;
  replyToReviewThread(
    request: GhPullRequestIdentityRequest & {
      readonly threadNodeId: string;
      readonly body: string;
    },
    signal: AbortSignal,
  ): Promise<GhPullRequestActionResult>;
  review(
    request: GhPullRequestIdentityRequest & {
      readonly event: "approve" | "request-changes";
      readonly headSha: string;
      readonly body?: string;
    },
    signal: AbortSignal,
  ): Promise<GhPullRequestActionResult>;
  retarget(
    request: GhPullRequestIdentityRequest & { readonly baseBranch: string },
    signal: AbortSignal,
  ): Promise<GhPullRequestActionResult>;
  setState(
    request: GhPullRequestIdentityRequest & { readonly state: "closed" | "open" },
    signal: AbortSignal,
  ): Promise<GhPullRequestActionResult>;
  summary(
    request: GhPullRequestIdentityRequest,
    signal: AbortSignal,
  ): Promise<GhPullRequestSummaryResult>;
  readContext(
    request: GhPullRequestIdentityRequest,
    signal: AbortSignal,
  ): Promise<GhPullRequestActionContextResult>;
}

export interface CodeProjectPullRequestActionAuthority {
  authorizePullRequest(
    windowId: WindowId,
    target: CodeProjectPullRequestDetailQuery,
  ): Promise<
    | { readonly status: "authorized"; readonly linkedThreadIds: ReadonlyArray<string> }
    | { readonly status: "not-authorized" }
    | { readonly status: "disconnected" }
  >;
}

/**
 * Appends one pull-request action as its own single-event aggregate. The local
 * user is the actor: only the person's own window reaches these actions.
 */
export function journalPullRequestAction(
  journal: Pick<Journal, "append">,
  record: CodeProjectPullRequestActionRecorded,
  options: { readonly uuid: () => string; readonly clock: () => string },
): void {
  journal.append({
    aggregate: { aggregateType: "code-project-pull-request-action", aggregateId: options.uuid() },
    expectedVersion: 0,
    events: [
      {
        eventId: options.uuid(),
        eventName: CODE_PROJECT_PULL_REQUEST_ACTION_RECORDED,
        eventVersion: 1,
        correlationId: options.uuid(),
        actor: { kind: "local-user", actorId: OCTANT_LOCAL_ACTOR_ID },
        occurredAt: options.clock(),
        payload: record,
      },
    ],
  });
}

/**
 * The person's own pull-request actions on a Project's repository: labels, a
 * comment, a reply in one review thread, close, and reopen, and merging a
 * whole stack in one step. The person's click is the approval. The server
 * checks the Project-to-repository connection before every effect, and
 * journals every attempt that reaches it before the answer returns.
 */
export class CodeProjectPullRequestActionService {
  readonly #authority: CodeProjectPullRequestActionAuthority;
  readonly #forge: CodeProjectPullRequestActionForge;
  readonly #merge: CodeProjectPullRequestMergeAction;
  readonly #record: (record: CodeProjectPullRequestActionRecorded) => void;

  constructor(options: {
    readonly authority: CodeProjectPullRequestActionAuthority;
    readonly forge: CodeProjectPullRequestActionForge;
    readonly merge: CodeProjectPullRequestMergeAction;
    readonly record: (record: CodeProjectPullRequestActionRecorded) => void;
  }) {
    this.#authority = options.authority;
    this.#forge = options.forge;
    this.#merge = options.merge;
    this.#record = options.record;
  }

  async act(
    windowId: WindowId,
    command: CodeProjectPullRequestActionCommand,
    signal: AbortSignal,
    caller: CodeProjectPullRequestCaller,
  ): Promise<CodeProjectPullRequestActionOutcome> {
    const record = (result: CodeProjectPullRequestActionRecorded["result"]) =>
      this.#record({
        projectId: command.projectId,
        repositoryOwner: command.repositoryOwner,
        repositoryName: command.repositoryName,
        number: command.number,
        action: command.kind,
        ...(command.kind === "labels"
          ? { labels: { add: command.add, remove: command.remove } }
          : {}),
        ...(command.kind === "comment" ||
        command.kind === "reply" ||
        command.kind === "request-changes" ||
        (command.kind === "approve" && command.body !== undefined)
          ? { bodyBytes: Buffer.byteLength(command.body ?? "") }
          : {}),
        result,
      });
    // These are the person's own controls on a desktop window; a paired device
    // is refused before the Project is even looked at, and the refusal is kept.
    if (caller !== "local-window") {
      const refused = { status: "refused", reason: "not-authorized" } as const;
      record(refused);
      return refused;
    }
    const authorized = await this.#authority.authorizePullRequest(windowId, command);
    let outcome: CodeProjectPullRequestActionOutcome;
    if (authorized.status === "not-authorized") {
      outcome = { status: "refused", reason: "not-authorized" };
    } else if (authorized.status === "disconnected") {
      outcome = { status: "unavailable", reason: "disconnected" };
    } else {
      try {
        outcome = await this.#send(command, signal);
      } catch (error) {
        // The call reached the forge, so the attempt is recorded as failed
        // with the effect unknown; the error text is never journaled.
        record({ status: "refused", reason: "failed" });
        throw error;
      }
    }
    record(outcome);
    return outcome;
  }

  /**
   * What the person's controls name on one pull request. Read-only, so it is
   * not journaled; like the actions it belongs to the desktop window.
   */
  async readContext(
    windowId: WindowId,
    query: CodeProjectPullRequestActionContextQuery,
    signal: AbortSignal,
    caller: CodeProjectPullRequestCaller,
  ): Promise<CodeProjectPullRequestActionContext> {
    if (caller !== "local-window") return { status: "refused", reason: "not-authorized" };
    const authorized = await this.#authority.authorizePullRequest(windowId, query);
    if (authorized.status === "not-authorized") {
      return { status: "refused", reason: "not-authorized" };
    }
    if (authorized.status === "disconnected") {
      return { status: "unavailable", reason: "disconnected" };
    }
    return this.#forge.readContext(
      { owner: query.repositoryOwner, name: query.repositoryName, number: query.number },
      signal,
    );
  }

  async mergeStack(
    windowId: WindowId,
    command: CodeProjectPullRequestStackMergeCommand,
    signal: AbortSignal,
    caller: CodeProjectPullRequestCaller,
  ): Promise<CodeProjectPullRequestStackMergeOutcome> {
    const target = (number: number): CodeProjectPullRequestDetailQuery => ({
      projectId: command.projectId,
      repositoryOwner: command.repositoryOwner,
      repositoryName: command.repositoryName,
      number,
    });
    const first = command.items[0];
    if (first === undefined) return { status: "refused", reason: "empty" };
    // Every pull request must belong to the connected repository before any
    // is read, let alone merged.
    for (const item of command.items) {
      const authorized = await this.#authority.authorizePullRequest(windowId, target(item.number));
      if (authorized.status !== "authorized")
        return { status: "refused", reason: "not-authorized" };
    }
    const summaries: Array<{
      readonly number: number;
      readonly headBranch: string;
      readonly baseBranch: string;
    }> = [];
    for (const item of command.items) {
      const summary = await this.#forge.summary(
        {
          owner: command.repositoryOwner,
          name: command.repositoryName,
          number: item.number,
        },
        signal,
      );
      if (summary.status !== "read" || summary.state !== "open") {
        return { status: "refused", reason: "unreadable" };
      }
      summaries.push({
        number: item.number,
        headBranch: summary.headBranch,
        baseBranch: summary.baseBranch,
      });
    }
    const decision = decideStackMerge(summaries);
    if (decision.decision === "refuse") return { status: "refused", reason: decision.reason };
    // Merging a parent into the branch below it would strand its child there
    // when the forge keeps the merged branch, so each child is pointed at the
    // branch the whole stack lands on before it merges.
    const destination = summaries[0]?.baseBranch ?? "";
    const merged: number[] = [];
    for (const [index, item] of command.items.entries()) {
      if (index > 0) {
        const retargeted = await this.#forge.retarget(
          {
            owner: command.repositoryOwner,
            name: command.repositoryName,
            number: item.number,
            baseBranch: destination,
          },
          signal,
        );
        if (retargeted.status !== "done") {
          return {
            status: "stopped",
            merged,
            stoppedAt: item.number,
            outcome: { status: "unavailable", reason: "unavailable" },
          };
        }
      }
      const outcome = await this.#merge(
        windowId,
        {
          projectId: command.projectId,
          repositoryOwner: command.repositoryOwner,
          repositoryName: command.repositoryName,
          number: item.number,
          method: command.method,
          headSha: item.headSha,
          confirmed: true,
        },
        signal,
        caller,
      );
      if (outcome.status === "merged") {
        merged.push(item.number);
        continue;
      }
      return { status: "stopped", merged, stoppedAt: item.number, outcome };
    }
    return { status: "merged", merged };
  }

  /**
   * A review is for the head the person read. The host reads the pull request
   * first and refuses a review for a head that moved or a pull request that is
   * no longer open, then reads it again after the post, because the forge accepts a
   * review for an older commit instead of refusing it.
   */
  async #review(
    identity: GhPullRequestIdentityRequest,
    command: Extract<
      CodeProjectPullRequestActionCommand,
      { readonly kind: "approve" | "request-changes" }
    >,
    signal: AbortSignal,
  ): Promise<GhPullRequestActionResult> {
    const summary = await this.#forge.summary(identity, signal);
    if (summary.status !== "read") return { status: "unavailable", reason: "unavailable" };
    if (summary.state === "merged") return { status: "refused", reason: "merged" };
    if (summary.state !== "open") return { status: "refused", reason: "not-open" };
    if (summary.headSha !== command.headSha) return { status: "refused", reason: "stale" };
    const posted = await this.#forge.review(
      {
        ...identity,
        event: command.kind === "approve" ? "approve" : "request-changes",
        headSha: command.headSha,
        ...(command.body === undefined ? {} : { body: command.body }),
      },
      signal,
    );
    if (posted.status !== "done") return posted;
    // GitHub files a review under the commit it names and does not refuse a
    // head that has since moved, so the host looks again. A review that landed
    // on an older commit is answered `stale` rather than `done`: the person
    // must not read it as approval of code they never saw.
    const after = await this.#forge.summary(identity, signal);
    return after.status === "read" && after.headSha !== command.headSha
      ? { status: "refused", reason: "stale" }
      : posted;
  }

  #send(
    command: CodeProjectPullRequestActionCommand,
    signal: AbortSignal,
  ): Promise<GhPullRequestActionResult> {
    const identity = {
      owner: command.repositoryOwner,
      name: command.repositoryName,
      number: command.number,
    };
    switch (command.kind) {
      case "labels":
        return this.#forge.editLabels(
          { ...identity, add: command.add, remove: command.remove },
          signal,
        );
      case "comment":
        return this.#forge.comment({ ...identity, body: command.body }, signal);
      case "reply":
        return this.#forge.replyToReviewThread(
          { ...identity, threadNodeId: command.reviewThreadId, body: command.body },
          signal,
        );
      case "approve":
      case "request-changes":
        return this.#review(identity, command, signal);
      case "close":
        return this.#forge.setState({ ...identity, state: "closed" }, signal);
      case "reopen":
        return this.#forge.setState({ ...identity, state: "open" }, signal);
    }
  }
}
