import type { ExtensionSnapshot } from "@octant/contracts/extension-rpc";
import type { StandaloneSkillRecord } from "@octant/contracts/extensions";
import { admitApprovedProfileSkills } from "@octant/domain/agent-profile-policy";
import {
  REVIEW_IN_PARALLEL_SKILL_NAME,
  filterSkillCatalogForScope,
  reviewInParallelSkillContent,
  sourceQualifiedSkillId,
} from "@octant/plugin-host";
import type { CodeProfileSkillContribution } from "./codeTurnContext";

export interface CodeProfileSkillResolverInput {
  readonly approvedSkillIds: ReadonlyArray<string>;
  readonly threadId: string;
  readonly projectId: string;
}

export type CodeProfileSkillResolver = (
  input: CodeProfileSkillResolverInput,
) => Promise<ReadonlyArray<CodeProfileSkillContribution>>;

/**
 * Load only the snapshotted allowlist, and only skills the host already treats
 * as effective. Installation still implies no trust; a profile cannot activate
 * a skill the host would otherwise refuse.
 */
export function createCodeProfileSkillResolver(options: {
  readonly snapshot: () => Pick<ExtensionSnapshot, "packages" | "skills" | "collisions">;
  readonly loadSkillText: (record: StandaloneSkillRecord) => Promise<string | undefined>;
}): CodeProfileSkillResolver {
  return async (input) => {
    const snapshot = options.snapshot();
    const scoped = filterSkillCatalogForScope(
      { skills: snapshot.skills ?? [], collisions: snapshot.collisions ?? [] },
      { mode: "code", projectId: input.projectId, threadRef: input.threadId },
    );
    const admitted = admitApprovedProfileSkills({
      approvedSkillIds: input.approvedSkillIds,
      skills: scoped.skills.map((record) => ({
        qualifiedId: String(record.skill.qualifiedId),
        name: record.skill.name,
        displayName: record.displayName,
        effective: record.effectiveState.kind === "effective",
      })),
    });
    const byQualifiedId = new Map(
      scoped.skills.map((record) => [String(record.skill.qualifiedId), record] as const),
    );
    const contributions: CodeProfileSkillContribution[] = [];
    for (const skill of admitted) {
      const record = byQualifiedId.get(skill.qualifiedId);
      if (record === undefined) continue;
      const text = (await options.loadSkillText(record))?.trim();
      if (text === undefined || text.length === 0) continue;
      contributions.push({
        qualifiedId: skill.qualifiedId,
        displayName: skill.displayName,
        text,
      });
    }
    return contributions;
  };
}

export function createStoredCodeProfileSkillTextLoader(options: {
  readonly snapshot: () => Pick<ExtensionSnapshot, "packages">;
  readonly readVerifiedComponentText: (input: {
    readonly extensionId: string;
    readonly packageId: string;
    readonly version: string;
    readonly digest: string;
    readonly componentId: string;
  }) => Promise<string>;
}): (record: StandaloneSkillRecord) => Promise<string | undefined> {
  return async (record) => {
    if (record.source.kind === "bundled" && record.skill.name === REVIEW_IN_PARALLEL_SKILL_NAME) {
      return reviewInParallelSkillContent();
    }
    const snapshot = options.snapshot();
    for (const pkg of snapshot.packages) {
      for (const component of pkg.components) {
        if (component.component.kind !== "skill-instructions") continue;
        const qualified = sourceQualifiedSkillId(pkg.source, component.component.id, pkg.digest);
        if (String(qualified) !== String(record.skill.qualifiedId)) continue;
        try {
          return await options.readVerifiedComponentText({
            extensionId: String(pkg.extensionId),
            packageId: String(pkg.packageId),
            version: String(pkg.version),
            digest: String(pkg.digest),
            componentId: component.component.id,
          });
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  };
}
