import type {
  WorkResearchBrief,
  WorkResearchBriefId,
  WorkResearchClaim,
  WorkResearchEvidence,
  WorkResearchFrame,
  WorkResearchReport,
  WorkSourceId,
  WorkSourceRecord,
} from "@octant/contracts/work-research";
import { isClaimUnsupported } from "@octant/domain";

export interface WorkResearchBriefEntry {
  readonly briefId: WorkResearchBriefId;
  readonly brief: WorkResearchBrief;
  readonly sources: ReadonlyMap<WorkSourceId, WorkSourceRecord>;
  readonly revokedSourceIds: ReadonlySet<WorkSourceId>;
  readonly evidence: ReadonlyArray<WorkResearchEvidence>;
  readonly claims: ReadonlyArray<WorkResearchClaim>;
  readonly report?: WorkResearchReport;
}

interface EntryFields {
  readonly briefId: WorkResearchBriefId;
  readonly brief: WorkResearchBrief;
  readonly sources: ReadonlyMap<WorkSourceId, WorkSourceRecord>;
  readonly revokedSourceIds: ReadonlySet<WorkSourceId>;
  readonly evidence: ReadonlyArray<WorkResearchEvidence>;
  readonly claims: ReadonlyArray<WorkResearchClaim>;
  readonly report?: WorkResearchReport;
}

/**
 * Build an entry, including the optional `report` field only when defined so
 * the projection respects `exactOptionalPropertyTypes`. A `report: undefined`
 * value is dropped rather than assigned to the optional property.
 */
function buildEntry(
  fields: Omit<EntryFields, "report"> & { readonly report?: WorkResearchReport },
): WorkResearchBriefEntry {
  if (fields.report === undefined) {
    const { report: _report, ...rest } = fields;
    void _report;
    return rest;
  }
  return { ...fields };
}

/**
 * Re-derive every claim's `unsupported` flag against the brief's current
 * evidence and source availability. A claim's support is only true while its
 * citations still resolve to evidence from a source the brief can still cite,
 * so revoking a source must not leave an earlier claim presented as cited in
 * the panel or in a report finalized afterwards. The rule itself stays in
 * `isClaimUnsupported`, the same check the record-claim path applies, so the
 * two cannot drift.
 */
function recomputeClaimSupport(
  claims: ReadonlyArray<WorkResearchClaim>,
  evidence: ReadonlyArray<WorkResearchEvidence>,
  sources: ReadonlyMap<WorkSourceId, WorkSourceRecord>,
): ReadonlyArray<WorkResearchClaim> {
  const citations = evidence.map((entry) => ({
    citationAnchor: entry.citationAnchor,
    sourceId: entry.sourceId,
  }));
  const availability = [...sources.values()].map((source) => ({
    sourceId: source.sourceId,
    availability: source.availability,
  }));
  return claims.map((claim) => {
    const unsupported = isClaimUnsupported({
      evidence: citations,
      sources: availability,
      claim: { citationAnchors: claim.citationAnchors },
    });
    return unsupported === claim.unsupported ? claim : { ...claim, unsupported };
  });
}

/**
 * Rebuildable in-memory Work research projection. The research service
 * replays journaled `WorkResearchFrame` events into this projection to
 * reconstruct brief state, recorded sources, captured evidence, generated
 * claims, and the finalized report. The projection is idempotent: replaying
 * the same frame sequence produces identical state, so reconnect or restart
 * rebuilds research state from the authoritative event journal without a
 * separate store. Finalized and cancelled briefs are retained so transition
 * authority can fail closed on a replayed or stale command.
 */
export class WorkResearchProjection {
  readonly #entries = new Map<WorkResearchBriefId, WorkResearchBriefEntry>();

  apply(frame: WorkResearchFrame): void {
    const brief = frame.transition.brief;
    const existing = this.#entries.get(brief.briefId);
    if (existing !== undefined && brief.version <= existing.brief.version) {
      return;
    }
    switch (frame.transition.kind) {
      case "brief-created": {
        this.#entries.set(
          brief.briefId,
          buildEntry({
            briefId: brief.briefId,
            brief,
            sources: new Map(),
            revokedSourceIds: new Set(),
            evidence: [],
            claims: [],
          }),
        );
        return;
      }
      case "source-added": {
        const sources = new Map(existing?.sources ?? []);
        sources.set(frame.transition.source.sourceId, frame.transition.source);
        this.#entries.set(
          brief.briefId,
          buildEntry({
            briefId: brief.briefId,
            brief,
            sources,
            revokedSourceIds: new Set(existing?.revokedSourceIds ?? []),
            evidence: existing?.evidence ?? [],
            claims: existing?.claims ?? [],
            ...(existing?.report !== undefined ? { report: existing.report } : {}),
          }),
        );
        return;
      }
      case "source-revoked": {
        const sources = new Map(existing?.sources ?? []);
        const revoked = new Set(existing?.revokedSourceIds ?? []);
        const revokedSource = sources.get(frame.transition.sourceId);
        if (revokedSource !== undefined) {
          sources.set(frame.transition.sourceId, {
            ...revokedSource,
            availability: "revoked",
          });
        }
        revoked.add(frame.transition.sourceId);
        const evidence = existing?.evidence ?? [];
        this.#entries.set(
          brief.briefId,
          buildEntry({
            briefId: brief.briefId,
            brief,
            sources,
            revokedSourceIds: revoked,
            evidence,
            claims: recomputeClaimSupport(existing?.claims ?? [], evidence, sources),
            ...(existing?.report !== undefined ? { report: existing.report } : {}),
          }),
        );
        return;
      }
      case "evidence-recorded": {
        this.#entries.set(
          brief.briefId,
          buildEntry({
            briefId: brief.briefId,
            brief,
            sources: existing?.sources ?? new Map(),
            revokedSourceIds: existing?.revokedSourceIds ?? new Set(),
            evidence: [...(existing?.evidence ?? []), frame.transition.evidence],
            claims: existing?.claims ?? [],
            ...(existing?.report !== undefined ? { report: existing.report } : {}),
          }),
        );
        return;
      }
      case "claim-recorded": {
        this.#entries.set(
          brief.briefId,
          buildEntry({
            briefId: brief.briefId,
            brief,
            sources: existing?.sources ?? new Map(),
            revokedSourceIds: existing?.revokedSourceIds ?? new Set(),
            evidence: existing?.evidence ?? [],
            claims: [...(existing?.claims ?? []), frame.transition.claim],
            ...(existing?.report !== undefined ? { report: existing.report } : {}),
          }),
        );
        return;
      }
      case "report-finalized": {
        this.#entries.set(
          brief.briefId,
          buildEntry({
            briefId: brief.briefId,
            brief,
            sources: existing?.sources ?? new Map(),
            revokedSourceIds: existing?.revokedSourceIds ?? new Set(),
            evidence: existing?.evidence ?? [],
            claims: existing?.claims ?? [],
            report: frame.transition.report,
          }),
        );
        return;
      }
      case "retrieval-cancelled": {
        // Cancellation does not mutate brief state beyond the version bump;
        // the brief snapshot in the frame already reflects the current status.
        this.#entries.set(
          brief.briefId,
          buildEntry({
            briefId: brief.briefId,
            brief,
            sources: existing?.sources ?? new Map(),
            revokedSourceIds: existing?.revokedSourceIds ?? new Set(),
            evidence: existing?.evidence ?? [],
            claims: existing?.claims ?? [],
            ...(existing?.report !== undefined ? { report: existing.report } : {}),
          }),
        );
        return;
      }
    }
  }

  lookup(briefId: WorkResearchBriefId): WorkResearchBriefEntry | undefined {
    return this.#entries.get(briefId);
  }

  snapshot(): ReadonlyMap<WorkResearchBriefId, WorkResearchBriefEntry> {
    return new Map(this.#entries);
  }
}
