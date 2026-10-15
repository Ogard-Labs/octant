import type { ProviderExecutionPolicy } from "@octant/contracts/providers";

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
}

export interface CodePolicyDecision {
  readonly decision: CodePolicyDecisionValue;
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
 * Whether the harness's native reviewer answers approval prompts for this
 * thread, instead of the user.
 *
 * The flag is orthogonal to the posture: it changes who answers a prompt, not
 * what the sandbox permits. It is effective only when the posture produces
 * prompts (`approval-gated` or `auto-accept-edits`), the provider reports the
 * capability, and the thread has not ingested untrusted content. Taint still
 * wins: a tainted thread cannot delegate, so irreversible classes come back
 * to the user (0104).
 */
export function harnessAutoReviewEffective(input: {
  readonly autoApprove: boolean;
  readonly posture: ProviderExecutionPolicy;
  readonly externalContentIngested: boolean;
  readonly capabilitySupported: boolean;
}): boolean {
  return (
    input.autoApprove &&
    input.capabilitySupported &&
    decidesCodeEffectsByApproval(input.posture) &&
    !input.externalContentIngested
  );
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

export interface InPlaceRestoreTurn {
  readonly threadId: string;
  readonly checkoutRoot: string;
  readonly state: "running" | "waiting" | "completed" | "interrupted" | "failed";
  readonly posture: ProviderExecutionPolicy;
}

/**
 * Whether another thread's live turn would race an in-place restore of the
 * requester's checkout. A turn parked on an approval counts: it writes as soon
 * as it is answered. Roots are compared as paths, never by checkout id, which
 * differs between two Projects on one folder; a managed worktree has its own
 * path and so never matches.
 */
export function turnBlocksInPlaceRestore(
  turn: InPlaceRestoreTurn,
  requester: { readonly threadId: string; readonly checkoutRoot: string },
): boolean {
  return (
    turn.threadId !== requester.threadId &&
    turn.checkoutRoot === requester.checkoutRoot &&
    (turn.state === "running" || turn.state === "waiting") &&
    mayWriteToRepository(turn.posture)
  );
}

const RESTORE_REFUSAL_TITLE_LIMIT = 100;

/** `title` is given only when the writing thread is in the requester's Project. */
export function inPlaceRestoreRefusalText(title?: string): string {
  if (title === undefined) {
    return "A thread in another Project is writing in this checkout. Wait for its turn to finish or stop it, then restore.";
  }
  // Cut by code point: a UTF-16 slice can split an emoji into a lone surrogate.
  const shown = Array.from(title).slice(0, RESTORE_REFUSAL_TITLE_LIMIT).join("");
  return `Another thread is writing in this checkout: "${shown}". Wait for its turn to finish or stop it, then restore.`;
}

export function authorizeCodeOperation(input: CodePolicyInput): CodePolicyDecision {
  if (input.operation === "pr-mutation") return { decision: "deny" };
  if (input.operation === "managed-root") {
    return {
      decision: input.posture === "plan" ? "deny" : "request-local-confirmation",
    };
  }

  if (input.actor === "remote-client") {
    if (input.operation === "read") return { decision: "host-clamped" };
    if (input.posture === "plan") return { decision: "deny" };
    if (input.operation === "push" || input.operation === "create-pr") {
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
