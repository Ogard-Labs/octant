import { Schema } from "effect";
import { ProjectId } from "./projects";
import { AggregateVersion, EventActor, UtcTimestamp } from "./events";
import { PreviewSourceVersion } from "./previews";
import { WorkArtifactRef } from "./workArtifacts";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const PositiveInt = Schema.Int.pipe(Schema.positive());

/**
 * Branded identity for a bounded Work research brief. One brief owns one
 * Work Project, a bounded source set, captured evidence, generated claims,
 * and a target deliverable. Stable across revisions; the brief `version`
 * distinguishes content generations and backs optimistic concurrency.
 */
export const WorkResearchBriefId = brandedUuid("WorkResearchBriefId");
export type WorkResearchBriefId = typeof WorkResearchBriefId.Type;

/**
 * Branded identity for one explicitly authorized research source. Stable
 * across re-retrievals; the source's `PreviewSourceVersion` distinguishes
 * content generations so stale detection works uniformly with the preview
 * contracts.
 */
export const WorkSourceId = brandedUuid("WorkSourceId");
export type WorkSourceId = typeof WorkSourceId.Type;

/**
 * Branded identity for a finalized source-backed research report. The report
 * carries evidence, claims, and a produced artifact version ref that feeds the
 * existing preview surface without a parallel path.
 */
export const WorkResearchReportId = brandedUuid("WorkResearchReportId");
export type WorkResearchReportId = typeof WorkResearchReportId.Type;

/**
 * Correlation id for a single research command/result pair. The renderer mints
 * this id; the server echoes it on the result so reconnect/replay can
 * reconcile in-flight commands without ambiguity.
 */
export const WorkResearchRequestId = brandedUuid("WorkResearchRequestId");
export type WorkResearchRequestId = typeof WorkResearchRequestId.Type;

/**
 * Explicitly authorized research source kinds. `web` is a browser/web URL;
 * `file` is a file inside the bound Work root; `user-reference` is a
 * user-provided reference the host resolves read-only; `mail-export` is a
 * separately configured read-only mail export. No silent browsing, mailbox
 * access, or connector installation is implied by any kind.
 */
export const WorkSourceKind = Schema.Literal("web", "file", "user-reference", "mail-export");
export type WorkSourceKind = typeof WorkSourceKind.Type;

/**
 * Opaque, server-resolved reference to a research source. The renderer and
 * remote clients never receive a host filesystem path or raw URL authority;
 * the authoritative host maps this token to a Project-confined or explicitly
 * authorized external source during resolution. The token rejects path
 * separators and `file:` URLs so a server bug cannot deliver a
 * renderer-facing path through this field. Mirrors `WorkArtifactRef` so a
 * research source feeds the existing preview/citation surfaces without a
 * parallel path.
 */
export const WorkSourceRef = Schema.NonEmptyTrimmedString.pipe(
  Schema.filter((value) => !/[\\/]/.test(value) && !value.startsWith("file:")),
  Schema.brand("WorkSourceRef"),
);
export type WorkSourceRef = typeof WorkSourceRef.Type;

/**
 * Display name shown to the user for a source. Constrained to a basename (no
 * path separators) so a directory path can never reach the renderer through
 * it. Mirrors `WorkArtifactDisplayName`.
 */
const WorkSourceDisplayName = Schema.NonEmptyTrimmedString.pipe(
  Schema.filter((value) => !/[\\/]/.test(value)),
);

/**
 * Source accessibility state. `fresh` means the source's current observation
 * matches its known `PreviewSourceVersion`; `stale` means the source changed
 * since capture; `unavailable` means the source could not be re-observed;
 * `revoked` means the user or host revoked the source's authority. Stale,
 * unavailable, and revoked sources cannot back new claims; revoked sources
 * fail closed without metadata leakage beyond the opaque id.
 */
export const WorkSourceAvailability = Schema.Literal("fresh", "stale", "unavailable", "revoked");
export type WorkSourceAvailability = typeof WorkSourceAvailability.Type;

/**
 * Sanitized bounded excerpt of captured evidence. Rejects path separators and
 * common URL schemes so absolute paths, source snippets, credentials, or
 * authority tokens cannot leak through the excerpt. Mirrors
 * `WorkSafeDiagnostic` so the renderer reuses one sanitized-text
 * presentation across Work surfaces. Capped at `MAX_WORK_RESEARCH_EXCERPT`
 * bytes by the server before recording.
 */
const WorkResearchExcerpt = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(8_000),
  Schema.filter((value) => !/[\\/]/.test(value) && !/^(file|https?):/i.test(value)),
);

/**
 * Stable per-source citation anchor linking claims to evidence. The anchor is
 * opaque to the renderer and bound to a single source id; a claim cites
 * evidence by listing anchors. The anchor rejects path separators and
 * `file:` URLs so it cannot carry a host path.
 */
export const WorkCitationAnchor = Schema.NonEmptyTrimmedString.pipe(
  Schema.filter((value) => !/[\\/]/.test(value) && !value.startsWith("file:")),
  Schema.brand("WorkCitationAnchor"),
);
export type WorkCitationAnchor = typeof WorkCitationAnchor.Type;

/**
 * Normalized research source record. Carries the stable source id, the owning
 * brief and Project, the source kind, the opaque renderer-facing ref, a
 * basename display name, the retrieval time, a bounded excerpt, the citation
 * anchor, the `PreviewSourceVersion` binding the capture to exact bytes for
 * stale detection, and the current availability state. No host path, no
 * credential, no mailbox body, no authority token.
 */
export const WorkSourceRecord = Schema.Struct({
  sourceId: WorkSourceId,
  briefId: WorkResearchBriefId,
  projectId: ProjectId,
  kind: WorkSourceKind,
  sourceRef: WorkSourceRef,
  displayName: WorkSourceDisplayName,
  retrievedAt: UtcTimestamp,
  excerpt: WorkResearchExcerpt,
  citationAnchor: WorkCitationAnchor,
  sourceVersion: PreviewSourceVersion,
  availability: WorkSourceAvailability,
}).annotations(strict);
export type WorkSourceRecord = typeof WorkSourceRecord.Type;

/**
 * Bounded source policy for a research brief. `allowedKinds` restricts which
 * source kinds the brief accepts; `maxSources` caps the source set;
 * `excerptByteBudget` caps the total captured evidence bytes across all
 * sources. The server enforces these before recording any source.
 */
export const WorkResearchSourcePolicy = Schema.Struct({
  allowedKinds: Schema.Array(WorkSourceKind).pipe(Schema.minItems(1), Schema.maxItems(4)),
  maxSources: PositiveInt,
  excerptByteBudget: PositiveInt,
}).annotations(strict);
export type WorkResearchSourcePolicy = typeof WorkResearchSourcePolicy.Type;

/**
 * Sanitized free-text research question. Rejects path separators and
 * `file:`/`http(s):` schemes so an absolute host path or authority URL can
 * never leak through a question. Mirrors `WorkPromotionSummaryText`.
 */
const WorkResearchQuestion = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(2_000),
  Schema.filter((value) => !/[\\/]/.test(value) && !/(?:^|\s|[(\[{<])(file|https?):/i.test(value)),
);

/**
 * Sanitized free-text research note. Same constraints as a question.
 */
const WorkResearchNote = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(4_000),
  Schema.filter((value) => !/[\\/]/.test(value) && !/(?:^|\s|[(\[{<])(file|https?):/i.test(value)),
);

/**
 * Target deliverable kind for a research brief. The report is produced through
 * ordinary Work artifact/version workflows; the kind tells the renderer
 * which artifact format to offer.
 */
export const WorkResearchDeliverableKind = Schema.Literal(
  "report",
  "comparison-table",
  "spreadsheet",
  "presentation",
  "source-pack",
);
export type WorkResearchDeliverableKind = typeof WorkResearchDeliverableKind.Type;

export const WorkResearchBriefStatus = Schema.Literal(
  "draft",
  "gathering",
  "analyzing",
  "finalized",
  "cancelled",
);
export type WorkResearchBriefStatus = typeof WorkResearchBriefStatus.Type;

/**
 * Normalized bounded research brief. Carries the stable brief id, the owning
 * Work Project, the research questions, the source policy, notes, target
 * deliverables, the current status, and the monotonic `version` backing
 * optimistic concurrency. No host path, no credential, no authority token.
 */
export const WorkResearchBrief = Schema.Struct({
  briefId: WorkResearchBriefId,
  projectId: ProjectId,
  questions: Schema.Array(WorkResearchQuestion).pipe(Schema.minItems(1), Schema.maxItems(16)),
  sourcePolicy: WorkResearchSourcePolicy,
  notes: Schema.Array(WorkResearchNote).pipe(Schema.maxItems(64)),
  deliverables: Schema.Array(WorkResearchDeliverableKind).pipe(
    Schema.minItems(1),
    Schema.maxItems(8),
  ),
  status: WorkResearchBriefStatus,
  createdBy: EventActor,
  createdAt: UtcTimestamp,
  version: AggregateVersion,
}).annotations(strict);
export type WorkResearchBrief = typeof WorkResearchBrief.Type;

/**
 * Captured evidence distinct from generated claims. One evidence entry binds
 * a bounded excerpt to its source id and citation anchor at a specific
 * retrieval time. The renderer presents evidence separately from conclusions
 * so unsupported claims are visible.
 */
export const WorkResearchEvidence = Schema.Struct({
  evidenceId: brandedUuid("WorkResearchEvidenceId"),
  briefId: WorkResearchBriefId,
  sourceId: WorkSourceId,
  citationAnchor: WorkCitationAnchor,
  excerpt: WorkResearchExcerpt,
  retrievedAt: UtcTimestamp,
}).annotations(strict);
export type WorkResearchEvidence = typeof WorkResearchEvidence.Type;

/**
 * Generated conclusion. `citationAnchors` link the claim to recorded evidence;
 * a claim with no resolvable anchors is flagged `unsupported` by the pure
 * provenance policy and shown honestly to the user. The claim text is
 * sanitized free text mirroring `WorkPromotionSummaryText`.
 */
const WorkResearchClaimText = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(8_000),
  Schema.filter((value) => !/[\\/]/.test(value) && !/(?:^|\s|[(\[{<])(file|https?):/i.test(value)),
);

export const WorkResearchClaim = Schema.Struct({
  claimId: brandedUuid("WorkResearchClaimId"),
  briefId: WorkResearchBriefId,
  text: WorkResearchClaimText,
  citationAnchors: Schema.Array(WorkCitationAnchor).pipe(Schema.maxItems(64)),
  unsupported: Schema.Boolean,
}).annotations(strict);
export type WorkResearchClaim = typeof WorkResearchClaim.Type;

/**
 * Finalized source-backed research report. Carries the stable report id, the
 * owning brief and Project, the recorded evidence, the generated claims, and
 * an opaque artifact ref feeding the existing preview surface through the
 * ordinary Work artifact/version workflow. No host path, no credential, no
 * authority token.
 */
export const WorkResearchReport = Schema.Struct({
  reportId: WorkResearchReportId,
  briefId: WorkResearchBriefId,
  projectId: ProjectId,
  evidence: Schema.Array(WorkResearchEvidence).pipe(Schema.maxItems(256)),
  claims: Schema.Array(WorkResearchClaim).pipe(Schema.maxItems(128)),
  producedArtifactRef: WorkArtifactRef,
  finalizedAt: UtcTimestamp,
}).annotations(strict);
export type WorkResearchReport = typeof WorkResearchReport.Type;

const RequestCommon = {
  requestId: WorkResearchRequestId,
  projectId: ProjectId,
} as const;

const BriefTransitionCommon = {
  briefId: WorkResearchBriefId,
  expectedVersion: AggregateVersion,
} as const;

/**
 * Authoritative Work research command. The renderer emits one variant per
 * research action; the server validates against the pure provenance policy,
 * enforces source-policy budgets, retrieves sources read-only, journals a
 * versioned event, and replies with a typed result. `expectedVersion` backs
 * optimistic concurrency on brief transitions so a stale client cannot clobber
 * a newer brief silently. No command carries a host path, credential, mailbox
 * body, or authority token.
 */
export const WorkResearchCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("create-brief"),
    ...RequestCommon,
    briefId: WorkResearchBriefId,
    questions: Schema.Array(WorkResearchQuestion).pipe(Schema.minItems(1), Schema.maxItems(16)),
    sourcePolicy: WorkResearchSourcePolicy,
    deliverables: Schema.Array(WorkResearchDeliverableKind).pipe(
      Schema.minItems(1),
      Schema.maxItems(8),
    ),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("add-source"),
    ...RequestCommon,
    ...BriefTransitionCommon,
    sourceId: WorkSourceId,
    sourceKind: WorkSourceKind,
    sourceRef: WorkSourceRef,
    displayName: WorkSourceDisplayName,
    excerpt: WorkResearchExcerpt,
    citationAnchor: WorkCitationAnchor,
    sourceVersion: PreviewSourceVersion,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("revoke-source"),
    ...RequestCommon,
    ...BriefTransitionCommon,
    sourceId: WorkSourceId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("record-evidence"),
    ...RequestCommon,
    ...BriefTransitionCommon,
    evidenceId: brandedUuid("WorkResearchEvidenceId"),
    sourceId: WorkSourceId,
    citationAnchor: WorkCitationAnchor,
    excerpt: WorkResearchExcerpt,
    retrievedAt: UtcTimestamp,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("record-claim"),
    ...RequestCommon,
    ...BriefTransitionCommon,
    claimId: brandedUuid("WorkResearchClaimId"),
    text: WorkResearchClaimText,
    citationAnchors: Schema.Array(WorkCitationAnchor).pipe(Schema.maxItems(64)),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("finalize-report"),
    ...RequestCommon,
    ...BriefTransitionCommon,
    reportId: WorkResearchReportId,
    producedArtifactRef: WorkArtifactRef,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("cancel-retrieval"),
    ...RequestCommon,
    ...BriefTransitionCommon,
    sourceId: WorkSourceId,
  }).annotations(strict),
);
export type WorkResearchCommand = typeof WorkResearchCommand.Type;

export const WorkResearchFailureCode = Schema.Literal(
  "invalid",
  "unauthorized",
  "stale",
  "unsupported",
  "not-found",
  "conflict",
  "interrupted",
  "failed",
);
export type WorkResearchFailureCode = typeof WorkResearchFailureCode.Type;

/**
 * Sanitized renderer-facing diagnostic text for `failed` results. Rejects path
 * separators and common URL schemes so absolute paths, source snippets,
 * credentials, or authority tokens cannot leak. Mirrors
 * `WorkSafeDiagnostic`.
 */
const WorkResearchSafeDiagnostic = Schema.NonEmptyTrimmedString.pipe(
  Schema.filter((value) => !/[\\/]/.test(value) && !/^(file|https?):/i.test(value)),
);

/**
 * Typed Work research command result. Success variants carry the updated
 * brief and the typed transition payload; failure variants mirror existing
 * Work outcome shapes (`unauthorized`, `stale`, `unsupported`, `not-found`,
 * `conflict`, `interrupted`, `failed`) so the renderer reuses one typed-failure
 * presentation. `unauthorized` exposes only optional opaque ids; never
 * content-derived metadata, display name, or source kind.
 */
export const WorkResearchCommandResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("brief-created"),
    requestId: WorkResearchRequestId,
    brief: WorkResearchBrief,
  })
    .annotations(strict)
    .pipe(Schema.filter((r) => r.brief.status === "draft", { jsonSchema: {} })),
  Schema.Struct({
    kind: Schema.Literal("source-added"),
    requestId: WorkResearchRequestId,
    brief: WorkResearchBrief,
    source: WorkSourceRecord,
  })
    .annotations(strict)
    .pipe(
      Schema.filter(
        (r) => r.source.briefId === r.brief.briefId && r.source.projectId === r.brief.projectId,
        { jsonSchema: {} },
      ),
    ),
  Schema.Struct({
    kind: Schema.Literal("source-revoked"),
    requestId: WorkResearchRequestId,
    brief: WorkResearchBrief,
    sourceId: WorkSourceId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("evidence-recorded"),
    requestId: WorkResearchRequestId,
    brief: WorkResearchBrief,
    evidence: WorkResearchEvidence,
  })
    .annotations(strict)
    .pipe(Schema.filter((r) => r.evidence.briefId === r.brief.briefId, { jsonSchema: {} })),
  Schema.Struct({
    kind: Schema.Literal("claim-recorded"),
    requestId: WorkResearchRequestId,
    brief: WorkResearchBrief,
    claim: WorkResearchClaim,
  })
    .annotations(strict)
    .pipe(Schema.filter((r) => r.claim.briefId === r.brief.briefId, { jsonSchema: {} })),
  Schema.Struct({
    kind: Schema.Literal("report-finalized"),
    requestId: WorkResearchRequestId,
    brief: WorkResearchBrief,
    report: WorkResearchReport,
  })
    .annotations(strict)
    .pipe(
      Schema.filter(
        (r) => r.report.briefId === r.brief.briefId && r.report.projectId === r.brief.projectId,
        { jsonSchema: {} },
      ),
    ),
  Schema.Struct({
    kind: Schema.Literal("retrieval-cancelled"),
    requestId: WorkResearchRequestId,
    brief: WorkResearchBrief,
    sourceId: WorkSourceId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("unauthorized"),
    requestId: WorkResearchRequestId,
    briefId: Schema.optional(WorkResearchBriefId),
    sourceId: Schema.optional(WorkSourceId),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("stale"),
    requestId: WorkResearchRequestId,
    briefId: WorkResearchBriefId,
    sourceId: WorkSourceId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("unsupported"),
    requestId: WorkResearchRequestId,
    sourceKind: Schema.optional(WorkSourceKind),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("not-found"),
    requestId: WorkResearchRequestId,
    briefId: Schema.optional(WorkResearchBriefId),
    sourceId: Schema.optional(WorkSourceId),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("conflict"),
    requestId: WorkResearchRequestId,
    briefId: Schema.optional(WorkResearchBriefId),
    sourceId: Schema.optional(WorkSourceId),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("interrupted"),
    requestId: WorkResearchRequestId,
    briefId: Schema.optional(WorkResearchBriefId),
    sourceId: Schema.optional(WorkSourceId),
    canRetry: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    requestId: WorkResearchRequestId,
    reason: WorkResearchFailureCode,
    message: Schema.optional(WorkResearchSafeDiagnostic),
  }).annotations(strict),
);
export type WorkResearchCommandResult = typeof WorkResearchCommandResult.Type;

/**
 * Success-only research transition subset. The server journals only
 * successful transitions as versioned events; failure results never change
 * brief state and are not journaled. Projections rebuild brief state from this
 * success-only stream.
 */
export const WorkResearchSuccessTransition = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("brief-created"),
    brief: WorkResearchBrief,
  })
    .annotations(strict)
    .pipe(Schema.filter((t) => t.brief.status === "draft", { jsonSchema: {} })),
  Schema.Struct({
    kind: Schema.Literal("source-added"),
    brief: WorkResearchBrief,
    source: WorkSourceRecord,
  })
    .annotations(strict)
    .pipe(
      Schema.filter(
        (t) => t.source.briefId === t.brief.briefId && t.source.projectId === t.brief.projectId,
        { jsonSchema: {} },
      ),
    ),
  Schema.Struct({
    kind: Schema.Literal("source-revoked"),
    brief: WorkResearchBrief,
    sourceId: WorkSourceId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("evidence-recorded"),
    brief: WorkResearchBrief,
    evidence: WorkResearchEvidence,
  })
    .annotations(strict)
    .pipe(Schema.filter((t) => t.evidence.briefId === t.brief.briefId, { jsonSchema: {} })),
  Schema.Struct({
    kind: Schema.Literal("claim-recorded"),
    brief: WorkResearchBrief,
    claim: WorkResearchClaim,
  })
    .annotations(strict)
    .pipe(Schema.filter((t) => t.claim.briefId === t.brief.briefId, { jsonSchema: {} })),
  Schema.Struct({
    kind: Schema.Literal("report-finalized"),
    brief: WorkResearchBrief,
    report: WorkResearchReport,
  })
    .annotations(strict)
    .pipe(
      Schema.filter(
        (t) => t.report.briefId === t.brief.briefId && t.report.projectId === t.brief.projectId,
        { jsonSchema: {} },
      ),
    ),
  Schema.Struct({
    kind: Schema.Literal("retrieval-cancelled"),
    brief: WorkResearchBrief,
    sourceId: WorkSourceId,
  }).annotations(strict),
);
export type WorkResearchSuccessTransition = typeof WorkResearchSuccessTransition.Type;

/**
 * Journalable Work research frame. The server appends one frame per
 * successful transition as a versioned `work.research-recorded@1` event; the
 * aggregate is the brief and the aggregate version is the brief `version`,
 * backing optimistic concurrency on `expectedVersion`. Replay rebuilds the
 * frame stream for a brief idempotently so projections can reconstruct brief
 * state after reconnect or restart. The frame carries the request id
 * correlation, the owning Project, and the sanitized success transition (no
 * host path, no credential, no authority token). The frame's `projectId` must
 * match the transition's brief `projectId` so a cross-Project replay cannot
 * corrupt another Project's projection.
 */
export const WorkResearchFrame = Schema.Struct({
  requestId: WorkResearchRequestId,
  projectId: ProjectId,
  sequence: AggregateVersion,
  occurredAt: UtcTimestamp,
  transition: WorkResearchSuccessTransition,
})
  .annotations(strict)
  .pipe(
    Schema.filter((frame) => frame.transition.brief.projectId === frame.projectId, {
      jsonSchema: {},
    }),
  );
export type WorkResearchFrame = typeof WorkResearchFrame.Type;

export const WORK_RESEARCH_EVENT_NAMES = ["work.research-recorded@1"] as const;
export type WorkResearchEventName = (typeof WORK_RESEARCH_EVENT_NAMES)[number];

export const decodeWorkResearchBriefId = Schema.decodeUnknownSync(WorkResearchBriefId);
export const decodeWorkSourceId = Schema.decodeUnknownSync(WorkSourceId);
export const decodeWorkResearchReportId = Schema.decodeUnknownSync(WorkResearchReportId);
export const decodeWorkResearchRequestId = Schema.decodeUnknownSync(WorkResearchRequestId);
export const decodeWorkSourceRef = Schema.decodeUnknownSync(WorkSourceRef);
export const decodeWorkCitationAnchor = Schema.decodeUnknownSync(WorkCitationAnchor);
export const decodeWorkResearchBrief = Schema.decodeUnknownSync(WorkResearchBrief);
export const decodeWorkSourceRecord = Schema.decodeUnknownSync(WorkSourceRecord);
export const decodeWorkResearchEvidence = Schema.decodeUnknownSync(WorkResearchEvidence);
export const decodeWorkResearchClaim = Schema.decodeUnknownSync(WorkResearchClaim);
export const decodeWorkResearchReport = Schema.decodeUnknownSync(WorkResearchReport);
export const decodeWorkResearchCommand = Schema.decodeUnknownSync(WorkResearchCommand);
export const decodeWorkResearchCommandResult = Schema.decodeUnknownSync(WorkResearchCommandResult);
export const decodeWorkResearchFrame = Schema.decodeUnknownSync(WorkResearchFrame);

export function decodeWorkResearchEventPayload(
  eventName: WorkResearchEventName | string,
  payload: unknown,
): unknown {
  switch (eventName) {
    case "work.research-recorded@1":
      return decodeWorkResearchFrame(payload);
    default:
      throw new Error("Unknown Work research persistence event");
  }
}

/**
 * Maximum total excerpt bytes the server records across all sources for one
 * brief before rejecting new evidence with `conflict`. Enforced against the
 * brief's `excerptByteBudget`.
 */
export const MAX_WORK_RESEARCH_EXCERPT_BYTES = 64_000;

/**
 * Maximum bytes of a file the host will observe as a research source. A larger
 * file is unobservable, so `add-source` can only fail for it. The bound is
 * shared rather than restated so a renderer can refuse an oversized pick before
 * reading it, and cannot drift from the size the host actually enforces.
 */
export const MAX_WORK_RESEARCH_SOURCE_BYTES = 8 * 1024 * 1024;
