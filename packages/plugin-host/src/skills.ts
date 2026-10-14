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

export interface SkillAudience {
  readonly mode: OctantMode;
  readonly projectId: string | null;
  /** `null` for a new-task draft, which has no thread yet. */
  readonly threadRef: string | null;
}

/**
 * May this thread, or this new-task draft, see the skill?
 *
 * A thread-scoped skill reaches only its exact thread, a Project-scoped skill
 * reaches every thread of that Project and mode, and an unscoped skill (the
 * user-global directory, bundled skills) reaches every thread. A Chat thread
 * matches no Project scope: Chat Projects have no filesystem, so a skill found
 * at a Work or Code Project root never reaches Chat.
 */
export function skillReachesAudience(
  record: Pick<StandaloneSkillRecord, "scope" | "projectScope">,
  audience: SkillAudience,
): boolean {
  if (record.scope !== undefined) {
    return (
      record.scope.mode === audience.mode &&
      sameReference(record.scope.projectId, audience.projectId) &&
      sameReference(record.scope.threadRef, audience.threadRef)
    );
  }
  if (record.projectScope !== undefined) {
    return (
      record.projectScope.mode === audience.mode &&
      sameReference(record.projectScope.projectId, audience.projectId)
    );
  }
  return true;
}

/** The catalog one thread or new-task draft sees: its own, its Project's, then shared skills. */
export function filterSkillCatalogForScope(
  catalog: SkillCatalog,
  scope: SkillAudience,
): SkillCatalog {
  const reached = catalog.skills.filter((record) => skillReachesAudience(record, scope));
  return buildSkillCatalog([
    ...reached.filter((record) => record.scope !== undefined),
    ...reached.filter((record) => record.scope === undefined && record.projectScope !== undefined),
    ...reached.filter((record) => record.scope === undefined && record.projectScope === undefined),
  ]);
}
