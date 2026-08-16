import type {
  CanvasSkillContribution,
  CanvasSkillContributionDenialCode,
  CanvasSkillContributionResolution,
} from "@octant/contracts/canvas-skill";
import type {
  ExtensionContentDigest,
  ExtensionEffectiveState,
  ExtensionPackageVersion,
  SourceQualifiedSkillId,
} from "@octant/contracts/extensions";

/**
 * Trust and enablement facts for a candidate Canvas skill contribution. These
 * are the *effective* facts already resolved by the extension activation
 * pipeline (see `resolveExtensionActivation`); this policy only decides whether
 * the contribution may reach the Canvas renderer.
 */
export interface CanvasSkillTrustFacts {
  readonly installed: boolean;
  readonly trusted: boolean;
  readonly desiredEnabled: boolean;
  readonly effectiveState: ExtensionEffectiveState;
}

export interface AdmitCanvasSkillContributionInput {
  readonly contribution: CanvasSkillContribution;
  readonly facts: CanvasSkillTrustFacts;
  /**
   * Optional pinned identity the caller expects. Identity is checked before
   * trust so a mismatch never leaks whether a skill is trusted or enabled.
   */
  readonly expected?: {
    readonly qualifiedId?: SourceQualifiedSkillId;
    readonly version?: ExtensionPackageVersion;
    readonly digest?: ExtensionContentDigest;
  };
}

function deny(
  denialCode: CanvasSkillContributionDenialCode,
  message: string,
): CanvasSkillContributionResolution {
  return { kind: "denied", denialCode, message };
}

/**
 * Decide whether a trusted, enabled skill may contribute layouts and
 * presentation rules to the Canvas renderer. Only a skill that is installed,
 * trusted, enabled, and effective contributes. Installing, selecting, or
 * mentioning a skill never satisfies these gates on its own, so contribution
 * can never grant authority. Checks run in a fixed order and fail closed.
 */
export function admitCanvasSkillContribution(
  input: AdmitCanvasSkillContributionInput,
): CanvasSkillContributionResolution {
  const { contribution, facts, expected } = input;

  if (
    expected?.qualifiedId !== undefined &&
    String(expected.qualifiedId) !== String(contribution.qualifiedId)
  ) {
    return deny("identity-mismatch", "Skill identity does not match the expected contribution.");
  }
  if (expected?.digest !== undefined && String(expected.digest) !== String(contribution.digest)) {
    return deny("identity-mismatch", "Skill content digest does not match the expected identity.");
  }
  // A pinned version must match exactly. An unversioned contribution cannot
  // satisfy a version pin, so an absent contribution version is a mismatch
  // (never an implicit match) to keep package-version provenance honest.
  if (
    expected?.version !== undefined &&
    (contribution.version === undefined ||
      String(expected.version) !== String(contribution.version))
  ) {
    return deny("version-mismatch", "Skill package version does not match the expected version.");
  }

  // Installation and trust are preconditions: a skill that is merely installed
  // or selected but not trusted contributes nothing.
  if (!facts.installed || !facts.trusted) {
    return deny(
      "untrusted",
      "Skill is not trusted; installation or selection does not grant a contribution.",
    );
  }
  if (!facts.desiredEnabled) {
    return deny("not-enabled", "Skill is not enabled and contributes no layouts or rules.");
  }
  if (facts.effectiveState.kind !== "effective") {
    return deny(
      "not-effective",
      `Skill is not effective in this scope (${facts.effectiveState.reason}).`,
    );
  }

  return { kind: "admitted", contribution };
}

/**
 * Reduce a set of candidate contributions to only those that are admitted.
 * Denied candidates are dropped; callers that need denial reasons should call
 * `admitCanvasSkillContribution` directly.
 */
export function filterCanvasSkillContributions(
  candidates: ReadonlyArray<AdmitCanvasSkillContributionInput>,
): ReadonlyArray<CanvasSkillContribution> {
  const admitted: CanvasSkillContribution[] = [];
  for (const candidate of candidates) {
    const resolution = admitCanvasSkillContribution(candidate);
    if (resolution.kind === "admitted") admitted.push(resolution.contribution);
  }
  return admitted;
}
