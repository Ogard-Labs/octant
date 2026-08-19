import type { ProviderExecutionPolicy } from "@octant/contracts";

/**
 * Publishing something to a target the person owns.
 *
 * Shipping is not a variation on pushing a branch. It is outward-facing and
 * usually irreversible: it makes something visible to people who are not in the
 * room, and no local checkpoint undoes that. So it is decided per act, against
 * the exact target, revision, and bytes about to leave the machine, and a
 * standing grant given for anything else never covers it.
 *
 * Nothing here reaches a network or holds a secret. It answers one question —
 * may this exact publication happen — and the host does the rest.
 */

export type ShipRefusalReason =
  | "target-not-enabled"
  | "credential-unbound"
  | "plan-mode"
  | "checkout-dirty"
  | "revision-not-reviewed"
  | "artifact-unobserved"
  | "artifact-digest-mismatch"
  | "approval-required"
  | "approval-not-per-act";

/**
 * The approval standing behind a ship.
 *
 * `standing` is modelled explicitly rather than folded into `none` because the
 * two are different mistakes: nobody approved anything, versus someone approved
 * repository writes and a caller is trying to spend it on publication.
 */
export type ShipApproval =
  | { readonly kind: "none" }
  | { readonly kind: "standing" }
  | {
      readonly kind: "per-act";
      readonly targetId: string;
      readonly revision: string;
      readonly artifactDigest: string;
    };

export interface ShipArtifactFacts {
  /** What the caller says it is publishing. */
  readonly digest: string;
  /** What the host measured when the run produced it, if it did. */
  readonly observedDigest: string | undefined;
  /** The run this host watched produce it. Absent means nobody watched. */
  readonly producedByRunId: string | undefined;
}

export interface ShipFacts {
  readonly targetId: string;
  /** Installed, trusted, and enabled: the whole ladder, not just installed. */
  readonly targetEnabled: boolean;
  /** Whether a credential is bound to this target. The value never appears here. */
  readonly credentialBound: boolean;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly checkoutClean: boolean;
  readonly headRevision: string;
  /** The revision that was actually reviewed, when one was. */
  readonly reviewedRevision: string | undefined;
  readonly artifact: ShipArtifactFacts;
  readonly approval: ShipApproval;
}

export type ShipDecision =
  | { readonly decision: "ship" }
  | { readonly decision: "refuse"; readonly reason: ShipRefusalReason };

/**
 * Whether this publication may happen.
 *
 * The order is deliberate: the cheapest and most fixable refusals come first,
 * so a person who has not bound a credential is told that rather than being
 * asked to approve an act that would fail anyway.
 */
export function decideShip(facts: ShipFacts): ShipDecision {
  if (!facts.targetEnabled) return refuse("target-not-enabled");
  if (!facts.credentialBound) return refuse("credential-unbound");
  // Read-only is a promise about the outside world as well as the disk. A Plan
  // mode that could publish would be the least reversible thing in the product.
  if (facts.executionPolicy === "plan") return refuse("plan-mode");

  if (!facts.checkoutClean) return refuse("checkout-dirty");
  if (facts.reviewedRevision === undefined || facts.reviewedRevision !== facts.headRevision) {
    return refuse("revision-not-reviewed");
  }

  // The same evidence rule that ends a goal: a ship claims a build happened
  // only when this host watched it happen.
  if (facts.artifact.producedByRunId === undefined) return refuse("artifact-unobserved");
  if (facts.artifact.observedDigest !== facts.artifact.digest) {
    return refuse("artifact-digest-mismatch");
  }

  if (facts.approval.kind === "none") return refuse("approval-required");
  // A standing grant is refused rather than downgraded to "ask again": someone
  // holding one believes they already approved this, and silently continuing
  // would publish on the strength of a decision made about something else.
  if (facts.approval.kind === "standing") return refuse("approval-not-per-act");
  if (
    facts.approval.targetId !== facts.targetId ||
    facts.approval.revision !== facts.headRevision ||
    facts.approval.artifactDigest !== facts.artifact.digest
  ) {
    return refuse("approval-not-per-act");
  }

  return { decision: "ship" };
}

export function shipRefusalText(reason: ShipRefusalReason): string {
  switch (reason) {
    case "target-not-enabled":
      return "That target is installed but not enabled yet. Trust and enable it first.";
    case "credential-unbound":
      return "No credential is bound to that target. Bind one before publishing to it.";
    case "plan-mode":
      return "This thread is read-only, so it cannot publish anything.";
    case "checkout-dirty":
      return "The checkout has uncommitted changes. Publishing would ship something nobody reviewed.";
    case "revision-not-reviewed":
      return "This is not the revision that was reviewed. Review this one, or publish the reviewed one.";
    case "artifact-unobserved":
      return "No run on this host produced that build, so there is nothing to vouch for it.";
    case "artifact-digest-mismatch":
      return "The build has changed since this host measured it. Rebuild and try again.";
    case "approval-required":
      return "Publishing needs your approval for this exact target and build.";
    case "approval-not-per-act":
      return "That approval was for something else. Publishing is approved one act at a time.";
  }
}

function refuse(reason: ShipRefusalReason): ShipDecision {
  return { decision: "refuse", reason };
}
