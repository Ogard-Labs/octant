import {
  LINEAR_MISSING_WRITE_SCOPE,
  MAX_TRACKER_COMMENT_BYTES,
  linkedIssueLabel,
  type CodeThread,
  type LinkedIssueRef,
} from "@octant/contracts";
import { clampTurnAccessPosture } from "@octant/domain";
import { redactSecretsAndPrivateKeys } from "@octant/domain/secret-shaped-text-policy";
import { decideAgentIssueUpdate } from "@octant/domain/tracker-issue-write-policy";
import { noticeFor, type TrackerIssueWrites } from "./trackerIssueWrites";

/**
 * What a turn gives the Linear and GitHub tools so their agent may change
 * the state of, or comment on, the issues linked to its thread. Absent, the
 * tools stay read-only.
 */
export interface AgentIssueUpdates {
  readonly linked: () => ReadonlyArray<LinkedIssueRef>;
  /** The Project's "Agents may update linked issues"; read again at every write. */
  readonly projectAllowsUpdates: () => boolean;
  /** Whether the thread has read outside content under Strict; absent reads as marked. */
  readonly readOutsideContent: () => boolean;
  /** Asks the person in the thread, showing the whole summary. */
  readonly ask: (
    summary: string,
    signal?: AbortSignal,
  ) => Promise<"approved" | "denied" | "cancelled" | "expired" | "unavailable">;
  readonly writes: Pick<TrackerIssueWrites, "agentSetState" | "agentComment">;
}

export type AgentIssueAction =
  | { readonly kind: "set-state"; readonly state: string }
  | { readonly kind: "comment"; readonly body: string };

type ToolResult = { readonly result: unknown; readonly isError: boolean };

/**
 * One agent write to a linked issue: reach, Plan and the ask are decided
 * before any tracker call, the comment is redacted and capped, and the
 * approval shows the whole text that will be posted.
 */
export async function runAgentIssueUpdate(input: {
  readonly turnThread: CodeThread;
  readonly current: CodeThread | undefined;
  readonly issue: LinkedIssueRef;
  readonly action: AgentIssueAction;
  readonly updates: AgentIssueUpdates;
  readonly signal?: AbortSignal;
}): Promise<ToolResult> {
  const posture = clampTurnAccessPosture({
    requested: input.turnThread.executionPolicy,
    thread: input.current?.executionPolicy ?? input.turnThread.executionPolicy,
  });
  const decision = decideAgentIssueUpdate({
    posture,
    issue: input.issue,
    linked: input.updates.linked(),
    projectAllowsUpdates: input.updates.projectAllowsUpdates(),
    readOutsideContent: input.updates.readOutsideContent(),
  });
  if (decision.decision === "refuse") {
    return failure(
      decision.reason === "plan" ? "plan-mode-read-only" : "issue-not-linked",
      decision.reason === "plan"
        ? "Plan does not change issues."
        : `${linkedIssueLabel(input.issue)} is not linked to this thread; the agent updates only its thread's linked issues.`,
    );
  }
  let action = input.action;
  if (action.kind === "comment") {
    const body = redactSecretsAndPrivateKeys(action.body).trim();
    if (body.length === 0 || Buffer.byteLength(body) > MAX_TRACKER_COMMENT_BYTES) {
      return failure("invalid-comment", "A comment is 1 byte to 4 KB of text.");
    }
    action = { kind: "comment", body };
  }
  if (decision.decision === "ask") {
    const label = linkedIssueLabel(input.issue);
    const summary =
      action.kind === "comment"
        ? `Comment on ${label} under your name?\n\n${action.body}`
        : input.issue.forge === "github"
          ? `Close ${label} as completed?`
          : `Move ${label} to ${action.state}?`;
    const answer = await input.updates.ask(summary, input.signal);
    if (answer !== "approved") {
      return failure(
        `issue-update-${answer}`,
        answer === "denied"
          ? "The person declined this issue update. Nothing reached the tracker."
          : "The issue update was not approved. Nothing reached the tracker.",
      );
    }
  }
  const threadId = String(input.turnThread.id);
  const result =
    action.kind === "comment"
      ? await input.updates.writes.agentComment(threadId, input.issue, action.body, input.signal)
      : await input.updates.writes.agentSetState(threadId, input.issue, action.state, input.signal);
  if (result.status === "applied") {
    return {
      result: {
        operation: action.kind,
        issue: linkedIssueLabel(input.issue),
        ...(action.kind === "set-state" ? { state: action.state } : {}),
        applied: true,
      },
      isError: false,
    };
  }
  if (result.status === "unknown-state") {
    return failure("unknown-state", `Name one of: ${result.states.join(", ")}.`);
  }
  return failure(
    result.reason,
    result.reason === "missing-scope" ? LINEAR_MISSING_WRITE_SCOPE : noticeFor(input.issue, result),
  );
}

function failure(error: string, message: string): ToolResult {
  return { result: { error, message }, isError: true };
}
