import type { ProviderExecutionPolicy } from "@octant/contracts/providers";
import type { ThreadExternalContentTaint } from "@octant/contracts";
import {
  resolveTaintedApproval,
  type StandingApprovalGrant,
  type ToolApprovalClass,
} from "./untrustedContentPolicy";

export type CodeActor = "local-user" | "agent" | "remote-client";
export type CodeOperation =
  | "read"
  | "edit"
  | "terminal"
  | "test"
  | "stage"
  | "discard"
  | "commit"
  | "push"
  | "create-pr"
  | "merge-pr"
  | "managed-root"
  | "pr-mutation";
export type CodePolicyDecisionValue =
  | "allow"
  | "deny"
  | "prompt"
  | "request-local-confirmation"
  | "host-clamped"
  | "host-thread-clamped"
  | "host-thread-credential-clamped";

export interface CodeUntrustedContentContext {
  readonly taint: ThreadExternalContentTaint;
  readonly standingGrant: StandingApprovalGrant;
  readonly freshPerActionConfirmation: boolean;
}

export interface CodePolicyInput {
  readonly actor: CodeActor;
  readonly posture: ProviderExecutionPolicy;
  readonly operation: CodeOperation;
  /**
   * Who is asking. `agent` (default) is a provider acting on the user's
   * behalf and is what the approval-gated posture exists to gate. `user` is
   * the local person acting directly (e.g. saving in the editor): their own
   * action is the approval, so a plain edit needs no further prompt. Plan
   * mode stays read-only for both.
   */
  readonly initiator?: "agent" | "user";
  /** When present, irreversible classes on tainted threads require fresh confirmation. */
  readonly untrustedContent?: CodeUntrustedContentContext;
}

export interface CodePolicyDecision {
  readonly decision: CodePolicyDecisionValue;
  readonly taintedApprovalPrompt?: string;
}

/** Map Code operations onto design §8.4 approval classes for taint enforcement. */
export function approvalClassForCodeOperation(
  operation: CodeOperation,
): ToolApprovalClass | undefined {
  switch (operation) {
    case "edit":
    case "stage":
    case "commit":
      return "project-file-writes";
    case "terminal":
    case "test":
      return "shell-commands";
    // Discarding uncommitted work destroys content no commit can restore, so
    // it sits with push and merge rather than with the writes it undoes.
    case "discard":
    case "push":
    case "create-pr":
    case "merge-pr":
      return "destructive-or-irreversible";
    case "managed-root":
      return "privilege-expansion-or-sandbox-change";
    case "read":
    case "pr-mutation":
      return undefined;
  }
}

/**
 * Whether this posture decides gated Code effects by explicit approval.
 *
 * Auto-accept edits changes how one class is decided — project file writes —
 * and nothing else, so every surface that asks "does this effect need an
 * approval receipt?" must treat it exactly as it treats approval-gated. Asking
 * that question by equality against `"approval-gated"` is what would silently
 * let the new posture through an approval gate.
 */
export function decidesCodeEffectsByApproval(posture: ProviderExecutionPolicy): boolean {
  return posture === "approval-gated" || posture === "auto-accept-edits";
}

function standingGrantForPosture(posture: ProviderExecutionPolicy): StandingApprovalGrant {
  if (posture === "full-access") return "remembered-full-access";
  if (posture === "approval-gated" || posture === "auto-accept-edits") return "session";
  return "none";
}

export function authorizeCodeOperation(input: CodePolicyInput): CodePolicyDecision {
  const base = authorizeCodeOperationBase(input);
  if (input.untrustedContent === undefined) return base;

  const approvalClass = approvalClassForCodeOperation(input.operation);
  if (approvalClass === undefined) return base;

  const tainted = resolveTaintedApproval({
    taint: input.untrustedContent.taint,
    approvalClass,
    standingGrant:
      input.untrustedContent.standingGrant === "none"
        ? standingGrantForPosture(input.posture)
        : input.untrustedContent.standingGrant,
    freshPerActionConfirmation: input.untrustedContent.freshPerActionConfirmation,
  });

  if (tainted.kind !== "prompt") return base;

  // Standing Full access / session grants must not silently satisfy irreversible classes.
  if (base.decision === "allow" || base.decision === "prompt") {
    return {
      decision: "prompt",
      taintedApprovalPrompt: tainted.prompt,
    };
  }
  return base;
}

function authorizeCodeOperationBase(input: CodePolicyInput): CodePolicyDecision {
  if (input.operation === "pr-mutation") return { decision: "deny" };
  if (input.operation === "managed-root") {
    return {
      decision: input.posture === "plan" ? "deny" : "request-local-confirmation",
    };
  }

  if (input.actor === "remote-client") {
    if (input.operation === "read") return { decision: "host-clamped" };
    if (input.posture === "plan") return { decision: "deny" };
    if (
      input.operation === "push" ||
      input.operation === "create-pr" ||
      input.operation === "merge-pr"
    ) {
      return { decision: "host-thread-credential-clamped" };
    }
    return { decision: "host-thread-clamped" };
  }

  if (input.operation === "read") return { decision: "allow" };
  if (input.posture === "plan") return { decision: "deny" };
  if (input.initiator === "user" && input.operation === "edit") return { decision: "allow" };
  // Auto-accept edits covers project file writes and nothing else: shell,
  // tests, and every Git effect keep prompting exactly as approval-gated does.
  if (input.posture === "auto-accept-edits" && input.operation === "edit") {
    return { decision: "allow" };
  }
  return { decision: input.posture === "full-access" ? "allow" : "prompt" };
}

/**
 * The runtime-derived status of a Code thread on the Code Thread Board. It is
 * always projected from authoritative runtime, Git, GitHub, and delivery-target
 * evidence; it is never manually assigned and cards are never dragged between
 * columns (see the Code Thread Board grouping design).
 */
export type CodeBoardStatus = "ready" | "in-progress" | "waiting" | "done";

/**
 * Fixed column order for the `Status` grouping (design §4): configured/idle work
 * first, then active execution, then blocked/waiting work, then satisfied work.
 * `Done` is a first-class visible column and is never suppressed.
 */
export const CODE_BOARD_STATUS_COLUMN_ORDER = [
  "ready",
  "in-progress",
  "waiting",
  "done",
] as const satisfies ReadonlyArray<CodeBoardStatus>;

/**
 * Card sort priority within a `Project` column (design §5). Actionable work is
 * surfaced first — `Waiting`, then `In Progress`, then `Ready` — while every
 * `Done` card remains fully visible below it rather than being hidden.
 */
export const CODE_BOARD_PROJECT_STATUS_ORDER = [
  "waiting",
  "in-progress",
  "ready",
  "done",
] as const satisfies ReadonlyArray<CodeBoardStatus>;

/**
 * The authoritative runtime signals used to derive a board status. All four are
 * server-resolved projections; unread and follow-up state are deliberately
 * excluded because they are independent of runtime status.
 */
export interface CodeBoardStatusInput {
  /**
   * The server-authoritative delivery-target satisfaction. Ambiguous or stale
   * evidence has already been collapsed to `waiting` upstream, so this is only
   * `done` when the confirmed target is objectively satisfied.
   */
  readonly deliverySatisfaction: "pending" | "waiting" | "done";
  /** A provider turn, tool, or subagent is actively executing. */
  readonly executing: boolean;
  /**
   * A wait signal is present: pending approval or input, provider recovery, a
   * CI/review gate, or a required dependency.
   */
  readonly waiting: boolean;
  /**
   * The thread's metadata projection is recovering (e.g. a temporarily missing
   * Project projection or an operation-journal rebuild).
   */
  readonly recovering: boolean;
}

/**
 * Derive the board status from authoritative runtime evidence. Precedence is
 * `Done` → `In Progress` → `Waiting` → `Ready`:
 *
 * - `Done` requires an objectively satisfied delivery target. Ambiguous or stale
 *   evidence can never produce `Done` (it has already been resolved to `waiting`
 *   upstream), so this function only reports `Done` for `deliverySatisfaction`
 *   of `done`.
 * - `In Progress` reflects active execution.
 * - `Waiting` covers wait signals, recovery, or a waiting delivery target.
 * - `Ready` is everything else (configured, queued, or idle with unmet
 *   delivery criteria).
 *
 * Unread and follow-up state are intentionally ignored: they remain independent
 * of runtime status.
 */
export function deriveCodeBoardStatus(input: CodeBoardStatusInput): CodeBoardStatus {
  if (input.deliverySatisfaction === "done") return "done";
  if (input.executing) return "in-progress";
  if (input.waiting || input.recovering || input.deliverySatisfaction === "waiting") {
    return "waiting";
  }
  return "ready";
}

export function codeBoardProjectStatusRank(status: CodeBoardStatus): number {
  return CODE_BOARD_PROJECT_STATUS_ORDER.indexOf(status);
}

export interface CodeBoardProjectSortItem {
  readonly status: CodeBoardStatus;
  readonly lastMeaningfulActivityAtMs: number | null;
}

/**
 * Compare two cards for the `Project` grouping: by the approved status priority
 * (`Waiting → In Progress → Ready → Done`), then by most recent meaningful
 * activity within the same status. Cards with no recorded activity sort last.
 */
export function compareCodeBoardProjectOrder(
  a: CodeBoardProjectSortItem,
  b: CodeBoardProjectSortItem,
): number {
  const rank = codeBoardProjectStatusRank(a.status) - codeBoardProjectStatusRank(b.status);
  if (rank !== 0) return rank;
  return compareRecencyDescending(a.lastMeaningfulActivityAtMs, b.lastMeaningfulActivityAtMs);
}

/**
 * Compare two cards for a `Status` column: purely by most recent meaningful
 * activity (descending). Cards with no recorded activity sort last.
 */
export function compareCodeBoardActivityDescending(
  a: { readonly lastMeaningfulActivityAtMs: number | null },
  b: { readonly lastMeaningfulActivityAtMs: number | null },
): number {
  return compareRecencyDescending(a.lastMeaningfulActivityAtMs, b.lastMeaningfulActivityAtMs);
}

function compareRecencyDescending(a: number | null, b: number | null): number {
  const aValue = a ?? Number.NEGATIVE_INFINITY;
  const bValue = b ?? Number.NEGATIVE_INFINITY;
  if (aValue === bValue) return 0;
  return bValue - aValue;
}
