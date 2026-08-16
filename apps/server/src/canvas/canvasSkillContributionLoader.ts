import type { CanvasRefreshRequest, CanvasRefreshSkill } from "@octant/contracts/canvas-refresh";
import { decodeCanvasSkillContribution } from "@octant/contracts/canvas-skill";
import type { StandaloneSkillRecord } from "@octant/contracts/extensions";
import type { CanvasSkillTrustFacts } from "@octant/extensions/canvas-skill-contributions";
import type { CanvasSkillContributionSource } from "./canvasSkillContributionResolver";

/**
 * Read the raw, provider-published Canvas contribution document for a resolved
 * skill record, or undefined when the skill publishes none. This is the
 * production seam a skill package populates once it ships parsed Canvas
 * contribution content (carried on the reconciled skill record). It is
 * intentionally injectable so the wiring can evolve (skill metadata, manifest,
 * on-disk content) without changing the admission policy.
 */
export type CanvasSkillContributionDocumentReader = (
  record: StandaloneSkillRecord,
  skill: CanvasRefreshSkill,
  request: CanvasRefreshRequest,
) => unknown | undefined;

export interface CanvasSkillContributionLookupDependencies {
  /**
   * Resolve the authoritative reconciled skill record for a refresh skill in
   * the request scope, or undefined when no such skill is installed/in scope.
   */
  readonly findSkillRecord: (
    skill: CanvasRefreshSkill,
    request: CanvasRefreshRequest,
  ) => StandaloneSkillRecord | undefined;
  /** Read the skill's published Canvas contribution document, if any. */
  readonly readContributionDocument: CanvasSkillContributionDocumentReader;
}

/**
 * Derive effective trust/enablement facts from an authoritative skill record.
 * A record present in the reconciled snapshot is installed; trust follows the
 * review decision, enablement the desired flag, and effectiveness the resolved
 * activation state. Facts are always taken from the record, never from the
 * contribution document, so a document can never assert its own trust.
 */
export function canvasSkillTrustFactsFromRecord(
  record: StandaloneSkillRecord,
): CanvasSkillTrustFacts {
  return {
    installed: true,
    trusted: record.reviewed,
    desiredEnabled: record.desiredEnabled,
    effectiveState: record.effectiveState,
  };
}

/**
 * Compose an authoritative skill record and its published contribution document
 * into the resolver's lookup. Returns undefined when the skill is not
 * reconciled/in scope or publishes no contribution; a malformed document is
 * treated as no contribution (fail closed) so a broken skill never contributes
 * layouts. When a document is present it is decoded and paired with the
 * record's trust facts, so the pure admission policy admits trusted enabled
 * skills and denies untrusted or disabled ones on the real production path.
 */
export function createCanvasSkillContributionLookup(
  deps: CanvasSkillContributionLookupDependencies,
): (
  skill: CanvasRefreshSkill,
  request: CanvasRefreshRequest,
) => CanvasSkillContributionSource | undefined {
  return (skill, request) => {
    const record = deps.findSkillRecord(skill, request);
    if (record === undefined) return undefined;
    const document = deps.readContributionDocument(record, skill, request);
    if (document === undefined) return undefined;
    let contribution;
    try {
      contribution = decodeCanvasSkillContribution(document);
    } catch {
      // A published-but-malformed contribution contributes nothing rather than
      // failing the refresh; the C2 skill gate still governs the skill.
      return undefined;
    }
    return { contribution, facts: canvasSkillTrustFactsFromRecord(record) };
  };
}
