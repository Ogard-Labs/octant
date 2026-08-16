import type { SourceQualifiedSkill } from "@octant/contracts/extensions";

const sourceOrder: Readonly<Record<SourceQualifiedSkill["sourceKind"], number>> = {
  "agents-skills-directory": 0,
  "plugin-package": 1,
  "provider-native": 2,
  bundled: 3,
  catalog: 4,
  "local-folder": 5,
};

export type SkillCollisionResolution =
  | { readonly kind: "resolved"; readonly skill: SourceQualifiedSkill }
  | {
      readonly kind: "ambiguous";
      readonly name: string;
      readonly candidates: ReadonlyArray<SourceQualifiedSkill>;
    }
  | { readonly kind: "not-found"; readonly query: string };

function compareSkills(left: SourceQualifiedSkill, right: SourceQualifiedSkill): number {
  return (
    sourceOrder[left.sourceKind] - sourceOrder[right.sourceKind] ||
    left.qualifiedId.localeCompare(right.qualifiedId)
  );
}

export function resolveSkillCollision(
  query: string,
  skills: ReadonlyArray<SourceQualifiedSkill>,
): SkillCollisionResolution {
  const exact = skills.find((skill) => skill.qualifiedId === query && skill.available);
  if (exact !== undefined) return { kind: "resolved", skill: exact };

  const candidates = skills
    .filter((skill) => skill.name === query && skill.available)
    .sort(compareSkills);
  if (candidates.length === 1) return { kind: "resolved", skill: candidates[0]! };
  if (candidates.length > 1) return { kind: "ambiguous", name: query, candidates };
  return { kind: "not-found", query };
}
