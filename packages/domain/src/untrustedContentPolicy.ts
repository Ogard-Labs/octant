import type {
  ContentOrigin,
  ContentProvenance,
  ThreadExternalContentTaint,
} from "@octant/contracts";

/**
 * Untrusted-content policy helpers for Security S2.
 * Consumed by the tool-call policy engine step 7 (S1) and approval paths.
 * Canonical: docs/security/security-architecture-threat-model.md § Untrusted-Content Policy
 * Approved Decision #3: taint scope is thread lifetime (does not clear on session/turn).
 */

/** Design §8.4 approval categories. */
export type ToolApprovalClass =
  | "project-file-writes"
  | "shell-commands"
  | "network-access"
  | "external-application-observation-or-control"
  | "destructive-or-irreversible"
  | "credential-or-secret-access"
  | "access-outside-selected-project"
  | "privilege-expansion-or-sandbox-change";

const IRREVERSIBLE_OR_AUTHORITY_BEARING = new Set<ToolApprovalClass>([
  "destructive-or-irreversible",
  "credential-or-secret-access",
  "access-outside-selected-project",
  "privilege-expansion-or-sandbox-change",
]);

export type StandingApprovalGrant = "none" | "session" | "remembered-full-access";

export type ThreadContentTaintEvent =
  | {
      readonly kind: "content-ingested";
      readonly provenance: ContentProvenance;
    }
  | { readonly kind: "session-boundary" }
  | { readonly kind: "turn-boundary" };

export type TaintedApprovalDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "allow-standing-grant" }
  | {
      readonly kind: "prompt";
      readonly reason: "tainted-thread-requires-fresh-confirmation";
      readonly prompt: string;
      readonly ignoredStandingGrant: StandingApprovalGrant;
    };

export type ContentAuthorityEffect =
  | "tool-invocation"
  | "approval"
  | "trust-change"
  | "authority-transition";

export function emptyThreadContentTaint(): ThreadExternalContentTaint {
  return { externalContentIngested: false, ingestedSources: [] };
}

/** Origins that mark the thread as having ingested external content. */
export function originTaintsThread(origin: ContentOrigin): boolean {
  return origin === "tool-result" || origin === "external-content";
}

/**
 * Fold provenance events into the thread-lifetime taint projection.
 * Session and turn boundaries never clear `externalContentIngested`.
 */
export function projectThreadContentTaint(
  state: ThreadExternalContentTaint,
  event: ThreadContentTaintEvent,
): ThreadExternalContentTaint {
  if (event.kind === "session-boundary" || event.kind === "turn-boundary") {
    return state;
  }
  if (!originTaintsThread(event.provenance.origin)) {
    return state;
  }
  const sourceLabel = event.provenance.sourceLabel;
  if (state.ingestedSources.includes(sourceLabel)) {
    return { externalContentIngested: true, ingestedSources: state.ingestedSources };
  }
  return {
    externalContentIngested: true,
    ingestedSources: [...state.ingestedSources, sourceLabel],
  };
}

export function isIrreversibleOrAuthorityBearingApprovalClass(
  approvalClass: ToolApprovalClass,
): boolean {
  return IRREVERSIBLE_OR_AUTHORITY_BEARING.has(approvalClass);
}

export function formatTaintedApprovalPrompt(ingestedSources: ReadonlyArray<string>): string {
  const named =
    ingestedSources.length === 0 ? "unknown external sources" : ingestedSources.join(", ");
  return `This thread ingested external content (${named}). Confirm this irreversible or authority-bearing action explicitly; standing Full access and session grants do not apply.`;
}

/**
 * Policy step-7 helper: on a tainted thread, irreversible/authority-bearing
 * approval classes require fresh per-action confirmation. Standing session
 * grants and remembered Full access do not silently satisfy them.
 */
export function resolveTaintedApproval(input: {
  readonly taint: ThreadExternalContentTaint;
  readonly approvalClass: ToolApprovalClass;
  readonly standingGrant: StandingApprovalGrant;
  readonly freshPerActionConfirmation: boolean;
}): TaintedApprovalDecision {
  if (
    !input.taint.externalContentIngested ||
    !isIrreversibleOrAuthorityBearingApprovalClass(input.approvalClass)
  ) {
    // Taint rule does not constrain this decision; standing grants may apply.
    return { kind: "allow-standing-grant" };
  }

  if (input.freshPerActionConfirmation) {
    return { kind: "allow" };
  }

  // Standing session grants and remembered Full access never silently satisfy
  // irreversible/authority-bearing classes on a tainted thread.
  return {
    kind: "prompt",
    reason: "tainted-thread-requires-fresh-confirmation",
    prompt: formatTaintedApprovalPrompt(input.taint.ingestedSources),
    ignoredStandingGrant: input.standingGrant,
  };
}

/**
 * Fail closed: tool/file content must never be parsed into invocations,
 * approvals, trust changes, or authority transitions.
 */
export function assertContentDoesNotAuthorize(input: {
  readonly attemptedEffect: ContentAuthorityEffect;
  readonly contentOrigin: ContentOrigin;
}): never {
  throw new Error(
    `Untrusted ${input.contentOrigin} content must never authorize a ${input.attemptedEffect}; only model-proposed tool calls resolved through the policy engine may act.`,
  );
}
