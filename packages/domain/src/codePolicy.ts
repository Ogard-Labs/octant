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
  | "unstage"
  | "discard"
  | "restore-checkpoint"
  | "commit"
  | "push"
  | "create-pr"
  | "merge-pr"
  | "merge-run"
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
   * the local person acting directly (e.g. saving in the editor, opening a
   * repository terminal): their own action is the approval, so a plain edit
   * or their own confined shell needs no further prompt. Plan mode stays
   * read-only for both.
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
    // Unstaging only moves paths out of the index; the files keep every
    // change they had, so it sits with the ordinary writes.
    case "unstage":
    case "commit":
      return "project-file-writes";
    case "terminal":
    case "test":
      return "shell-commands";
    // Discarding uncommitted work destroys content no commit can restore, so
    // it sits with push and merge rather than with the writes it undoes.
    case "discard":
    // Restoring a checkpoint overwrites current files with older ones. The
    // host records what it replaced, but the replacement itself is a wholesale
    // overwrite of the checkout and is gated as one.
    case "restore-checkpoint":
    case "push":
    case "create-pr":
    case "merge-pr":
    // Bringing a run home rewrites the checkout the person works in. The host
    // records what it replaced first, but the merge itself is a wholesale
    // change to their tree and is gated like one.
    case "merge-run":
      return "destructive-or-irreversible";
    case "managed-root":
      return "privilege-expansion-or-sandbox-change";
    case "read":
    case "pr-mutation":
      return undefined;
  }
}

/**
 * Rank of a Code access posture from least authority to most. Used everywhere
 * a per-message intent is compared with a thread grant: a turn may only ever
 * sit at or below the thread.
 */
export const ACCESS_POSTURE_RANK = {
  plan: 0,
  "approval-gated": 1,
  "auto-accept-edits": 2,
  "full-access": 3,
} as const satisfies Record<ProviderExecutionPolicy, number>;

/** Postures from least authority to most, for composer option lists. */
export const ACCESS_POSTURES_NARROWEST_FIRST = [
  "plan",
  "approval-gated",
  "auto-accept-edits",
  "full-access",
] as const satisfies ReadonlyArray<ProviderExecutionPolicy>;

/**
 * The posture a turn actually runs under.
 *
 * The composer sends an intent; the host clamps it to the thread's grant so a
 * per-message choice can only narrow. Asking for more than the thread allows
 * is not a refusal of the turn — the turn still runs, under the thread. Plan
 * is the floor: a Plan thread stays read-only even when the intent names a
 * writing posture.
 */
export function clampTurnAccessPosture(input: {
  readonly requested?: ProviderExecutionPolicy;
  readonly thread: ProviderExecutionPolicy;
}): ProviderExecutionPolicy {
  if (input.requested === undefined) return input.thread;
  return ACCESS_POSTURE_RANK[input.requested] <= ACCESS_POSTURE_RANK[input.thread]
    ? input.requested
    : input.thread;
}

/** Postures the composer may offer for the next turn given the thread's grant. */
export function accessPosturesAtOrBelow(
  ceiling: ProviderExecutionPolicy,
): ReadonlyArray<ProviderExecutionPolicy> {
  const rank = ACCESS_POSTURE_RANK[ceiling];
  return ACCESS_POSTURES_NARROWEST_FIRST.filter((posture) => ACCESS_POSTURE_RANK[posture] <= rank);
}

/**
 * Postures that would widen the thread. The composer offers these as a grant
 * raise, never as a one-shot: a turn may only sit at or below the thread.
 */
export function accessPosturesAbove(
  floor: ProviderExecutionPolicy,
): ReadonlyArray<ProviderExecutionPolicy> {
  const rank = ACCESS_POSTURE_RANK[floor];
  return ACCESS_POSTURES_NARROWEST_FIRST.filter((posture) => ACCESS_POSTURE_RANK[posture] > rank);
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

/**
 * Whether a turn under this posture may leave the repository different than it
 * found it.
 *
 * Plan is read-only, and read-only is a promise about the repository, not only
 * about the working tree: a host that records a restore point by writing trees
 * into the object database has still written to a repository the user was told
 * nothing would be written to. Ask this before any preparatory write, not only
 * before the effects a provider requests.
 */
export function mayWriteToRepository(posture: ProviderExecutionPolicy): boolean {
  return posture !== "plan";
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
    // A remote client may ask for a merge into the person's own checkout, but
    // it is clamped to the host's thread authority like every other mutation:
    // the decision is still made where the checkout is.
    if (input.operation === "merge-run") return { decision: "host-thread-clamped" };
    return { decision: "host-thread-clamped" };
  }

  if (input.operation === "read") return { decision: "allow" };
  if (input.posture === "plan") return { decision: "deny" };
  if (
    input.initiator === "user" &&
    (input.operation === "edit" || input.operation === "terminal")
  ) {
    return { decision: "allow" };
  }
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
