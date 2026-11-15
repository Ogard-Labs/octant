/**
 * Which cloud machine targets the host may offer.
 *
 * Installation, trust and enablement are separate steps and each is a
 * precondition: a target that is missing any of them is withheld and never
 * called. The decision is read again on every list, so disabling a plugin
 * withdraws its target from the next act even when a caller kept a reference.
 * Canonical: docs/design/server-projects.md § Machines in the person's cloud account.
 */
import {
  CLOUD_MACHINE_TARGET_CONTRIBUTION_KIND,
  type CloudMachineTarget,
} from "@octant/plugin-api/cloud-machine-target";

export interface CloudMachineTargetActivationFacts {
  readonly installed: boolean;
  readonly trusted: boolean;
  readonly enabled: boolean;
}

export type CloudMachineTargetOffer =
  | { readonly status: "offered" }
  | {
      readonly status: "withheld";
      readonly reason: "not-installed" | "not-trusted" | "disabled";
    };

export function offerCloudMachineTarget(
  facts: CloudMachineTargetActivationFacts,
): CloudMachineTargetOffer {
  if (!facts.installed) return { status: "withheld", reason: "not-installed" };
  if (!facts.trusted) return { status: "withheld", reason: "not-trusted" };
  if (!facts.enabled) return { status: "withheld", reason: "disabled" };
  return { status: "offered" };
}

export interface CloudMachineTargetContribution {
  readonly targetId: string;
  readonly displayName: string;
  readonly facts: CloudMachineTargetActivationFacts;
  readonly target: CloudMachineTarget;
}

export interface OfferedCloudMachineTarget {
  readonly targetId: string;
  readonly displayName: string;
  readonly target: CloudMachineTarget;
}

/**
 * The targets offered now, in id order. Two contributions that claim one id
 * are both withheld: a machine's journal names its target by id, and an act
 * must never reach a different plugin than the one that created it.
 */
export function offeredCloudMachineTargets(
  contributions: ReadonlyArray<CloudMachineTargetContribution>,
): ReadonlyArray<OfferedCloudMachineTarget> {
  const claims = new Map<string, number>();
  for (const contribution of contributions) {
    claims.set(contribution.targetId, (claims.get(contribution.targetId) ?? 0) + 1);
  }
  return contributions
    .filter(
      (contribution) =>
        claims.get(contribution.targetId) === 1 &&
        contribution.target.kind === CLOUD_MACHINE_TARGET_CONTRIBUTION_KIND &&
        offerCloudMachineTarget(contribution.facts).status === "offered",
    )
    .map(({ targetId, displayName, target }) => ({ targetId, displayName, target }))
    .sort((left, right) => left.targetId.localeCompare(right.targetId));
}
