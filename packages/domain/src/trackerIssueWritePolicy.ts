/**
 * Which writes reach a tracker issue linked to a Code thread, decided without
 * touching GitHub or Linear. The host asks these before any call and journals
 * the answer; the renderer never decides.
 */
import type { LinearWorkflowState } from "@octant/contracts/linear-issues";
import type { LinkedIssueMoment, LinkedIssueRef } from "@octant/contracts/thread-linked-issues";
import type { ProviderExecutionPolicy } from "@octant/contracts/providers";
import { decidePullRequestComment } from "./codePullRequestActionPolicy";

export type LinearStateChoice =
  | { readonly kind: "set"; readonly state: LinearWorkflowState }
  | { readonly kind: "skip"; readonly reason: "already-there" | "no-matching-state" };

/**
 * How far along a state is: 0 not started, 1 in progress, 2 in review, 3
 * finished. Canceled counts as finished, so the host never reopens an issue
 * someone closed by hand.
 */
function linearStateRank(state: Pick<LinearWorkflowState, "name" | "type">): number {
  if (state.type === "completed" || state.type === "canceled") return 3;
  if (state.type === "started") return /review/i.test(state.name) ? 2 : 1;
  return 0;
}

const MOMENT_RANK: Readonly<Record<LinkedIssueMoment, number>> = {
  "in-progress": 1,
  "in-review": 2,
  done: 3,
};

/**
 * The Linear state a linked issue moves to at one moment, by the team's own
 * states: In Progress is the `started` state named so, else the first started
 * state by position; In Review a started state whose name says review, with
 * no fallback; Done the `completed` state named so, else the first completed
 * one. An issue already at or past the moment stays where it is.
 */
export function chooseLinearIssueState(input: {
  readonly moment: LinkedIssueMoment;
  readonly current: LinearWorkflowState;
  readonly states: ReadonlyArray<LinearWorkflowState>;
}): LinearStateChoice {
  if (linearStateRank(input.current) >= MOMENT_RANK[input.moment]) {
    return { kind: "skip", reason: "already-there" };
  }
  const byPosition = [...input.states].sort((left, right) => left.position - right.position);
  const ofType = (type: string) => byPosition.filter((state) => state.type === type);
  const named = (states: ReadonlyArray<LinearWorkflowState>, name: string) =>
    states.find((state) => state.name.trim().toLowerCase() === name);
  let target: LinearWorkflowState | undefined;
  if (input.moment === "in-progress") {
    const started = ofType("started").filter((state) => linearStateRank(state) === 1);
    target = named(started, "in progress") ?? started[0];
  } else if (input.moment === "in-review") {
    target = ofType("started").find((state) => linearStateRank(state) === 2);
  } else {
    const completed = ofType("completed");
    target = named(completed, "done") ?? completed[0];
  }
  return target === undefined
    ? { kind: "skip", reason: "no-matching-state" }
    : { kind: "set", state: target };
}

/**
 * GitHub issues are open or closed, nothing between: In Progress and In
 * Review have no state there, and Done closes the issue as completed. An issue
 * already closed counts as done.
 */
export function decideGithubIssueMoment(input: {
  readonly moment: LinkedIssueMoment;
  readonly open: boolean;
}):
  | { readonly kind: "close" }
  | { readonly kind: "already-closed" }
  | { readonly kind: "skip"; readonly reason: "no-state-on-github" } {
  if (input.moment !== "done") return { kind: "skip", reason: "no-state-on-github" };
  return input.open ? { kind: "close" } : { kind: "already-closed" };
}

export type AgentIssueUpdateDecision =
  | { readonly decision: "write" | "write-on-project-choice" | "ask" }
  | { readonly decision: "refuse"; readonly reason: "plan" | "not-linked" };

/**
 * Whether an agent's state change or comment on an issue goes ahead. It
 * reaches only the issues linked to its own thread, Plan refuses it, and
 * otherwise it is gated as a pull-request comment is: Full access writes,
 * and below it the Project's `agentsMayUpdateIssues` choice stands in for the
 * ask only on a thread that has read no outside content.
 */
export function decideAgentIssueUpdate(input: {
  readonly posture: ProviderExecutionPolicy;
  readonly issue: LinkedIssueRef;
  readonly linked: ReadonlyArray<LinkedIssueRef>;
  readonly projectAllowsUpdates: boolean;
  readonly readOutsideContent: boolean;
}): AgentIssueUpdateDecision {
  if (input.posture === "plan") return { decision: "refuse", reason: "plan" };
  if (!input.linked.some((linked) => sameIssue(linked, input.issue))) {
    return { decision: "refuse", reason: "not-linked" };
  }
  const comment = decidePullRequestComment({
    fullAccess: input.posture === "full-access",
    projectAllowsComments: input.projectAllowsUpdates,
    readOutsideContent: input.readOutsideContent,
  });
  if (comment === "post") return { decision: "write" };
  return comment === "post-on-project-choice"
    ? { decision: "write-on-project-choice" }
    : { decision: "ask" };
}

function sameIssue(left: LinkedIssueRef, right: LinkedIssueRef): boolean {
  if (left.forge === "github" && right.forge === "github") {
    return (
      left.number === right.number &&
      left.owner.toLowerCase() === right.owner.toLowerCase() &&
      left.repository.toLowerCase() === right.repository.toLowerCase()
    );
  }
  return left.forge === "linear" && right.forge === "linear" && left.issueId === right.issueId;
}

/**
 * A pull request's body with a closing reference for each linked issue it
 * does not already name: `Fixes #12` in the base repository, `Fixes
 * owner/repo#12` in another, and `Fixes ENG-12` for Linear, which its GitHub
 * integration reads. The text the person approves is the text sent.
 */
export function withLinkedIssueReferences(input: {
  readonly body: string;
  readonly issues: ReadonlyArray<LinkedIssueRef>;
  readonly baseRepository: string;
}): string {
  const lines: string[] = [];
  for (const issue of input.issues) {
    const sameRepository =
      issue.forge === "github" &&
      `${issue.owner}/${issue.repository}`.toLowerCase() === input.baseRepository.toLowerCase();
    const reference =
      issue.forge === "linear"
        ? issue.identifier
        : sameRepository
          ? `#${String(issue.number)}`
          : `${issue.owner}/${issue.repository}#${String(issue.number)}`;
    if (mentions(input.body, reference)) continue;
    lines.push(`Fixes ${reference}`);
  }
  if (lines.length === 0) return input.body;
  const trimmed = input.body.trimEnd();
  return trimmed.length === 0 ? lines.join("\n") : `${trimmed}\n\n${lines.join("\n")}`;
}

function mentions(body: string, reference: string): boolean {
  const escaped = reference.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9_/#-])${escaped}(?![0-9])`, "i").test(body);
}

const GITHUB_FULL = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})#(\d{1,9})$/;
const GITHUB_SHORT = /^#(\d{1,9})$/;
const LINEAR_IDENTIFIER = /^([A-Za-z][A-Za-z0-9]{0,9})-(\d{1,9})$/;

/**
 * Reads the reference a person typed to link an issue: `#12` in the thread's
 * delivery repository, `owner/repo#12`, or a Linear identifier. A Linear
 * identifier still needs its node id, which only Linear can answer.
 */
export function parseLinkedIssueReference(
  text: string,
  deliveryRepository: string | undefined,
):
  | Extract<LinkedIssueRef, { readonly forge: "github" }>
  | { readonly forge: "linear"; readonly identifier: string }
  | undefined {
  const value = text.trim();
  const full = GITHUB_FULL.exec(value);
  if (full?.[1] !== undefined && full[2] !== undefined && full[3] !== undefined) {
    const number = Number(full[3]);
    return number < 1
      ? undefined
      : { forge: "github", owner: full[1], repository: full[2], number };
  }
  const short = GITHUB_SHORT.exec(value);
  if (short?.[1] !== undefined) {
    const [owner, repository, ...rest] = (deliveryRepository ?? "").split("/");
    const number = Number(short[1]);
    if (owner === undefined || repository === undefined || rest.length > 0 || owner === "") {
      return undefined;
    }
    if (owner === "local" || number < 1) return undefined;
    return { forge: "github", owner, repository, number };
  }
  const linear = LINEAR_IDENTIFIER.exec(value);
  if (linear !== null) return { forge: "linear", identifier: value.toUpperCase() };
  return undefined;
}
