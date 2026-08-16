import type {
  ExtensionContentDigest,
  ExtensionEffectiveState,
  ExtensionSource,
  ExtensionSourceReference,
  StandaloneSkillRecord,
} from "@octant/contracts/extensions";
import {
  REVIEW_IN_PARALLEL_SKILL_CONTENT,
  REVIEW_IN_PARALLEL_SKILL_DIGEST,
} from "./bundledSkillData";
import { sourceQualifiedSkillId } from "./model";

export const REVIEW_IN_PARALLEL_SKILL_NAME = "review-in-parallel";
const BUNDLED_SOURCE_REF = "app:review-in-parallel";

const skillContent = REVIEW_IN_PARALLEL_SKILL_CONTENT;
const skillDigest = REVIEW_IN_PARALLEL_SKILL_DIGEST as ExtensionContentDigest;

const bundledSource: ExtensionSource = {
  kind: "bundled",
  sourceRef: BUNDLED_SOURCE_REF as ExtensionSourceReference,
};

const bundledEffectiveState: ExtensionEffectiveState = { kind: "effective" };

export function bundledSkillRecords(): ReadonlyArray<StandaloneSkillRecord> {
  return [reviewInParallelSkillRecord()];
}

export function reviewInParallelSkillRecord(): StandaloneSkillRecord {
  const skill = {
    qualifiedId: sourceQualifiedSkillId(bundledSource, REVIEW_IN_PARALLEL_SKILL_NAME, skillDigest),
    name: REVIEW_IN_PARALLEL_SKILL_NAME,
    sourceKind: bundledSource.kind,
    digest: skillDigest,
    available: true,
  };
  return {
    skill,
    source: bundledSource,
    displayName: "Review in parallel",
    description: "Fan out read-only parallel reviewers as independent linked threads.",
    provenance: { reviewed: true, reviewedAt: "2026-08-02T00:00:00.000Z" as never },
    contentBytes: new TextEncoder().encode(skillContent).byteLength,
    reviewed: true,
    desiredEnabled: true,
    effectiveState: bundledEffectiveState,
  };
}

export function reviewInParallelSkillContent(): string {
  return skillContent;
}
