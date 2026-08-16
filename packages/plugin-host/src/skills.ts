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
      String(record.scope.projectId) === scope.projectId &&
      String(record.scope.threadRef) === scope.threadRef
    ) {
      exact.push(record);
    }
  }
  return buildSkillCatalog([...exact, ...shared]);
}
