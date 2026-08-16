import type { CanvasDefinition } from "@octant/contracts/canvas";
import type { CanvasRefreshRequest, CanvasRefreshSkill } from "@octant/contracts/canvas-refresh";
import type {
  CanvasSkillContribution,
  CanvasSkillContributionResolution,
} from "@octant/contracts/canvas-skill";
import {
  admitCanvasSkillContribution,
  type CanvasSkillTrustFacts,
} from "@octant/extensions/canvas-skill-contributions";
import { resolveCanvasSkillPresentation } from "@octant/domain/canvas-skill-policy";

/** A registered contribution plus the effective trust/enablement facts. */
export interface CanvasSkillContributionSource {
  readonly contribution: CanvasSkillContribution;
  readonly facts: CanvasSkillTrustFacts;
}

export interface CanvasSkillContributionResolverDependencies {
  /**
   * Look up the trusted contribution registered for a refresh skill from
   * authoritative extension state. Returns undefined when no skill contributes
   * under that identity in the current scope.
   */
  readonly lookup: (
    skill: CanvasRefreshSkill,
    request: CanvasRefreshRequest,
  ) => CanvasSkillContributionSource | undefined;
}

/**
 * Server-side resolver that turns a refresh recipe skill reference into a
 * trusted Canvas skill contribution. It composes the pure extension
 * trust/enablement admission with the pure domain presentation binding and
 * fails closed: an unregistered, untrusted, disabled, mismatched, or
 * source-incompatible skill contributes nothing. It never grants authority;
 * the returned contribution only carries layouts and presentation rules.
 */
export function createCanvasSkillContributionResolver(
  deps: CanvasSkillContributionResolverDependencies,
): (
  skill: CanvasRefreshSkill,
  request: CanvasRefreshRequest,
  currentDefinition: CanvasDefinition,
) => CanvasSkillContributionResolution | undefined {
  return (skill, request, currentDefinition) => {
    const source = deps.lookup(skill, request);
    // A trusted refresh skill that declares no Canvas contribution simply
    // contributes no layouts; the refresh proceeds under the C2 skill gate.
    if (source === undefined) return undefined;
    const admitted = admitCanvasSkillContribution({
      contribution: source.contribution,
      facts: source.facts,
      expected: {
        qualifiedId: skill.qualifiedId,
        ...(skill.version === undefined ? {} : { version: skill.version }),
      },
    });
    if (admitted.kind !== "admitted") return admitted;
    const presentation = resolveCanvasSkillPresentation({
      contribution: admitted.contribution,
      definition: currentDefinition,
    });
    if (presentation.kind === "denied") {
      return {
        kind: "denied",
        denialCode: presentation.denialCode,
        message: presentation.message,
      };
    }
    return { kind: "admitted", contribution: admitted.contribution };
  };
}
