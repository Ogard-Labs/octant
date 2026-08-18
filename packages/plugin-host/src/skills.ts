import type { ExtensionSkillCollision, StandaloneSkillRecord } from "@octant/contracts/extensions";
import type { OctantMode } from "@octant/contracts/modes";
import { resolveSkillCollision } from "./collisions";

export interface SkillCatalog {
  readonly skills: ReadonlyArray<StandaloneSkillRecord>;
  readonly collisions: ReadonlyArray<ExtensionSkillCollision>;
}

export function buildSkillCatalog(records: ReadonlyArray<StandaloneSkillRecord>): SkillCatalog {
  const skills = [...records];
  const collisions: Array<ExtensionSkillCollision> = [];
  const names = [...new Set(skills.map((record) => record.skill.name))].sort((left, right) =>
    left.localeCompare(right),
  );
  for (const name of names) {
    const resolution = resolveSkillCollision(
      name,
      skills.map((record) => record.skill),
    );
    if (resolution.kind !== "ambiguous") continue;
    collisions.push({
      name,
      candidates: resolution.candidates.map((candidate) => candidate.qualifiedId),
    });
  }
  return { skills, collisions };
}

/**
 * Do two scope references name the same thing?
 *
 * Branded identifiers compare as strings on both sides, never one. A scope
 * reference can also be absent, and absence is only ever equal to absence: a
 * skill scoped to a Project must not fall into a thread that belongs to none
 * just because one side stringified into the word "null".
 */
function sameReference(left: string | null | undefined, right: string | null | undefined): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return (left ?? null) === (right ?? null);
  }
  return String(left) === String(right);
}

export function filterSkillCatalogForScope(
  catalog: SkillCatalog,
  scope: {
    readonly mode: OctantMode;
    readonly projectId: string | null;
    readonly threadRef: string;
  },
): SkillCatalog {
  const exact: StandaloneSkillRecord[] = [];
  const shared: StandaloneSkillRecord[] = [];
  for (const record of catalog.skills) {
    if (record.scope === undefined) {
      shared.push(record);
    } else if (
      record.scope.mode === scope.mode &&
      sameReference(record.scope.projectId, scope.projectId) &&
      sameReference(record.scope.threadRef, scope.threadRef)
    ) {
      exact.push(record);
    }
  }
  return buildSkillCatalog([...exact, ...shared]);
}
