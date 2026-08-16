import type { CanvasDefinition, CanvasSourceKind } from "@octant/contracts/canvas";
import type {
  CanvasSkillContribution,
  CanvasSkillContributionDenialCode,
  CanvasSkillLayout,
  CanvasSkillPresentationRule,
} from "@octant/contracts/canvas-skill";

/**
 * The advisory presentation a trusted skill contributes to a specific Canvas.
 *
 * It is deliberately limited to layouts, the presentation rules that actually
 * target blocks present in the Canvas, and the source *kinds* the skill covers.
 * It never contains concrete source references, opaque host references,
 * authority, or capabilities: a skill contribution can shape how existing,
 * already-authorized Canvas content is presented, but can never introduce new
 * sources or widen authority.
 */
export type CanvasSkillPresentation =
  | {
      readonly kind: "presentable";
      readonly layouts: ReadonlyArray<CanvasSkillLayout>;
      readonly appliedRules: ReadonlyArray<CanvasSkillPresentationRule>;
      readonly coveredSourceKinds: ReadonlyArray<CanvasSourceKind>;
    }
  | {
      readonly kind: "denied";
      readonly denialCode: Extract<CanvasSkillContributionDenialCode, "unsupported-source">;
      readonly message: string;
    };

export interface ResolveCanvasSkillPresentationInput {
  readonly contribution: CanvasSkillContribution;
  readonly definition: CanvasDefinition;
}

/**
 * Bind a trusted skill contribution to a concrete Canvas definition.
 *
 * Fails closed with `unsupported-source` when the Canvas relies on a source
 * kind the skill did not declare, or when a layout slot references a source
 * kind outside the contribution's own declared support. The returned
 * presentation carries no source references and cannot alter the definition or
 * its authority; the server still reauthorizes every canonical source
 * independently.
 */
export function resolveCanvasSkillPresentation(
  input: ResolveCanvasSkillPresentationInput,
): CanvasSkillPresentation {
  const { contribution, definition } = input;
  const supported = new Set<CanvasSourceKind>(contribution.supportedSources);

  const canvasSourceKinds = new Set<CanvasSourceKind>(
    definition.sourceManifest.map((source) => source.kind),
  );
  for (const kind of canvasSourceKinds) {
    if (!supported.has(kind)) {
      return {
        kind: "denied",
        denialCode: "unsupported-source",
        message: `Skill does not support the '${kind}' source kind used by this Canvas.`,
      };
    }
  }

  for (const layout of contribution.layouts) {
    for (const slot of layout.slots) {
      if (slot.sourceKind !== undefined && !supported.has(slot.sourceKind)) {
        return {
          kind: "denied",
          denialCode: "unsupported-source",
          message: `Skill layout '${String(layout.layoutId)}' references an unsupported source kind.`,
        };
      }
    }
  }

  const presentBlockKinds = new Set(definition.blocks.map((block) => block.kind));
  const appliedRules = contribution.presentationRules.filter((rule) =>
    presentBlockKinds.has(rule.target),
  );

  return {
    kind: "presentable",
    layouts: contribution.layouts,
    appliedRules,
    coveredSourceKinds: [...canvasSourceKinds],
  };
}
