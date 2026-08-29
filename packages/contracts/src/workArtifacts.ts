import { Schema } from "effect";
import { ProjectId } from "./projects";
import { EventActor, UtcTimestamp } from "./events";
import { PreviewSourceVersion, PreviewTarget } from "./previews";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const PositiveInt = Schema.Int.pipe(Schema.positive());

/**
 * Branded identity for a Work artifact. Stable across revisions; the
 * artifact-version identity below distinguishes content generations.
 */
export const WorkArtifactId = brandedUuid("WorkArtifactId");
export type WorkArtifactId = typeof WorkArtifactId.Type;

/**
 * Branded identity for one content generation of a Work artifact. Each
 * successful create/revise/transform/export produces a new version id and
 * a journaled event; projections are rebuildable from the event log.
 */
export const WorkArtifactVersionId = brandedUuid("WorkArtifactVersionId");
export type WorkArtifactVersionId = typeof WorkArtifactVersionId.Type;

/**
 * Correlation id for a single mutation request/reply pair. The renderer
 * mints this id; the server echoes it on the reply so reconnect/replay can
 * reconcile in-flight mutations without ambiguity.
 */
export const WorkMutationRequestId = brandedUuid("WorkMutationRequestId");
export type WorkMutationRequestId = typeof WorkMutationRequestId.Type;

/**
 * Representative Work artifact formats. Slice A defines the format
 * vocabulary only; format-specific production arrives in slices C-F.
 */
export const WorkArtifactFormat = Schema.Literal(
  "markdown",
  "docx",
  "csv",
  "xlsx",
  "pptx",
  "markdown-deck",
  "pdf",
  "image",
);
export type WorkArtifactFormat = typeof WorkArtifactFormat.Type;

/**
 * Opaque, server-resolved reference to a Work artifact. The renderer and
 * remote clients never receive a host filesystem path; the authoritative
 * host maps this token to a Project-confined source during resolution. The
 * token rejects path separators and `file:` URLs so a server bug cannot
 * deliver a renderer-facing path through this field. Mirrors `PreviewOpaqueRef`
 * so a mutation result feeds the existing preview target without a
 * parallel path.
 */
export const WorkArtifactRef = Schema.NonEmptyTrimmedString.pipe(
  Schema.filter((value) => !/[\\/]/.test(value) && !value.startsWith("file:")),
  Schema.brand("WorkArtifactRef"),
);
export type WorkArtifactRef = typeof WorkArtifactRef.Type;

/**
 * Display name shown to the user. Constrained to a basename (no path
 * separators) so a directory path can never reach the renderer through it.
 */
const WorkArtifactDisplayName = Schema.NonEmptyTrimmedString.pipe(
  Schema.filter((value) => !/[\\/]/.test(value)),
);

/**
 * Normalized Work artifact identity. Carries the stable artifact id, the
 * owning Work Project, the format, the opaque renderer-facing ref, and a
 * basename display name. No host path, no content, no authority token.
 */
export const WorkArtifactIdentity = Schema.Struct({
  artifactId: WorkArtifactId,
  projectId: ProjectId,
  format: WorkArtifactFormat,
  artifactRef: WorkArtifactRef,
  displayName: WorkArtifactDisplayName,
  createdAt: UtcTimestamp,
}).annotations(strict);
export type WorkArtifactIdentity = typeof WorkArtifactIdentity.Type;

/**
 * One content generation of a Work artifact. The `sourceVersion` binds the
 * version to exact bytes (sha-256 + size + observed-at) so stale detection
 * and source-versioned selections work uniformly with the preview
 * contracts. `sequence` is the monotonic per-artifact version number starting
 * at 1; it backs optimistic concurrency on mutation requests.
 */
export const WorkArtifactVersion = Schema.Struct({
  versionId: WorkArtifactVersionId,
  artifactId: WorkArtifactId,
  projectId: ProjectId,
  format: WorkArtifactFormat,
  sourceVersion: PreviewSourceVersion,
  createdBy: EventActor,
  createdAt: UtcTimestamp,
  sequence: PositiveInt,
}).annotations(strict);
export type WorkArtifactVersion = typeof WorkArtifactVersion.Type;

/**
 * Per-format capability flags. The base format-derived report is filtered by
 * the active posture and confinement authority in `packages/domain`; the
 * flags themselves never grant authority. `canRoundTrip` is honest: a format
 * that cannot safely round-trip reports `false` and offers an explicit
 * derived/export format instead.
 */
export const WorkCapabilityFlags = Schema.Struct({
  canRead: Schema.Boolean,
  canCreate: Schema.Boolean,
  canMutate: Schema.Boolean,
  canRoundTrip: Schema.Boolean,
  canExport: Schema.Boolean,
  canVersion: Schema.Boolean,
}).annotations(strict);
export type WorkCapabilityFlags = typeof WorkCapabilityFlags.Type;

export const WorkFidelityLevel = Schema.Literal("full", "limited");
export type WorkFidelityLevel = typeof WorkFidelityLevel.Type;

/**
 * Fidelity metadata for a Work format interaction. A `limited` level must
 * carry an actionable notice; `full` carries none. Mirrors `PreviewFidelity`
 * so the renderer reuses one fidelity presentation across preview and
 * mutation surfaces.
 */
export const WorkFidelity = Schema.Struct({
  level: WorkFidelityLevel,
  notice: Schema.optional(Schema.NonEmptyTrimmedString),
})
  .annotations(strict)
  .pipe(
    Schema.filter((fidelity) => fidelity.level === "full" || fidelity.notice !== undefined, {
      jsonSchema: {},
    }),
  );
export type WorkFidelity = typeof WorkFidelity.Type;

/**
 * Honest per-format capability report. `exportFormats` lists the derived
 * formats available when safe round-tripping is unavailable, so the renderer
 * can present an explicit export-only fallback instead of pretending lossy
 * round-trip is safe.
 */
export const WorkCapabilityReport = Schema.Struct({
  format: WorkArtifactFormat,
  capabilities: WorkCapabilityFlags,
  fidelity: WorkFidelity,
  exportFormats: Schema.Array(WorkArtifactFormat),
}).annotations(strict);
export type WorkCapabilityReport = typeof WorkCapabilityReport.Type;

const MutationRequestCommon = {
  requestId: WorkMutationRequestId,
  projectId: ProjectId,
  /**
   * Recorded user confirmation for a destructive or lossy mutation. Safe
   * mutations omit it; `false` is rejected so an unconfirmed request cannot
   * masquerade as approved.
   */
  confirmed: Schema.optional(Schema.Literal(true)),
} as const;

/**
 * Normalized Work mutation request. The renderer emits one variant per
 * mutation kind; the server resolves the opaque artifact ref, re-runs
 * confinement authority, and journals a versioned event before replying.
 * `expectedArtifactVersion` enables optimistic concurrency on revise,
 * transform, rename, and delete so a stale client cannot clobber a newer
 * version silently. `confirmed` is required for destructive and lossy
 * mutations; the server never infers approval from the transport.
 */
export const WorkMutationRequest = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("create-artifact"),
    ...MutationRequestCommon,
    format: WorkArtifactFormat,
    displayName: WorkArtifactDisplayName,
    content: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("revise-artifact"),
    ...MutationRequestCommon,
    artifactId: WorkArtifactId,
    content: Schema.NonEmptyTrimmedString,
    expectedArtifactVersion: PositiveInt,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("transform-artifact"),
    ...MutationRequestCommon,
    artifactId: WorkArtifactId,
    targetFormat: WorkArtifactFormat,
    expectedArtifactVersion: PositiveInt,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("rename-artifact"),
    ...MutationRequestCommon,
    artifactId: WorkArtifactId,
    displayName: WorkArtifactDisplayName,
    expectedArtifactVersion: PositiveInt,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("delete-artifact"),
    ...MutationRequestCommon,
    artifactId: WorkArtifactId,
    expectedArtifactVersion: PositiveInt,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("version-artifact"),
    ...MutationRequestCommon,
    artifactId: WorkArtifactId,
    expectedArtifactVersion: PositiveInt,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("export-artifact"),
    ...MutationRequestCommon,
    artifactId: WorkArtifactId,
    exportFormat: WorkArtifactFormat,
    expectedArtifactVersion: PositiveInt,
  }).annotations(strict),
);
export type WorkMutationRequest = typeof WorkMutationRequest.Type;

export const WorkExportHandoffKind = Schema.Literal("in-app-version", "external-handoff");
export type WorkExportHandoffKind = typeof WorkExportHandoffKind.Type;

const WorkExportRef = Schema.NonEmptyTrimmedString.pipe(
  Schema.filter((value) => !/[\\/]/.test(value) && !value.startsWith("file:")),
);

/**
 * Export or external-application handoff contract. An `in-app-version`
 * handoff produces a new confined artifact version and a preview target
 * so the renderer previews the export beside the thread without a parallel
 * path. An `external-handoff` carries an opaque export ref the host resolves
 * to a confined export path for Finder/Quick Look/external-application
 * handoff through authenticated server commands; no generic shell-open. The
 * two variants are a discriminated union so an external handoff can never
 * carry another Project's version metadata or preview target.
 */
export const WorkExportHandoff = Schema.Union(
  Schema.Struct({
    requestId: WorkMutationRequestId,
    artifactId: WorkArtifactId,
    exportFormat: WorkArtifactFormat,
    handoffKind: Schema.Literal("in-app-version"),
    producedVersion: WorkArtifactVersion,
    previewTarget: PreviewTarget,
    producedAt: UtcTimestamp,
  })
    .annotations(strict)
    .pipe(
      Schema.filter(
        (handoff) =>
          handoff.producedVersion.artifactId === handoff.artifactId &&
          handoff.producedVersion.format === handoff.exportFormat &&
          handoff.previewTarget.kind === "artifact-version" &&
          handoff.previewTarget.projectId === handoff.producedVersion.projectId,
        { jsonSchema: {} },
      ),
    ),
  Schema.Struct({
    requestId: WorkMutationRequestId,
    artifactId: WorkArtifactId,
    exportFormat: WorkArtifactFormat,
    handoffKind: Schema.Literal("external-handoff"),
    exportRef: WorkExportRef,
    producedAt: UtcTimestamp,
  }).annotations(strict),
);
export type WorkExportHandoff = typeof WorkExportHandoff.Type;

/**
 * Bounded failure code for `failed` mutation outcomes. Free-text exception
 * messages never cross the wire through `reason`; an optional sanitized
 * `message` may accompany the code when a human-readable hint is safe.
 */
export const WorkMutationFailureCode = Schema.Literal(
  "decode-failed",
  "read-failed",
  "write-failed",
  "parse-failed",
  "oversize",
  "cancelled",
  "unknown",
);
export type WorkMutationFailureCode = typeof WorkMutationFailureCode.Type;

/**
 * Sanitized renderer-facing diagnostic text. Rejects path separators and
 * common URL schemes so absolute paths, source snippets, credentials, or
 * authority tokens cannot leak through failure messages. Mirrors
 * `PreviewSafeDiagnostic`.
 */
const WorkSafeDiagnostic = Schema.NonEmptyTrimmedString.pipe(
  Schema.filter((value) => !/[\\/]/.test(value) && !/^(file|https?):/i.test(value)),
);

const createdOrRevisedOutcome = (literal: "created" | "revised") =>
  Schema.Struct({
    kind: Schema.Literal(literal),
    artifact: WorkArtifactIdentity,
    version: WorkArtifactVersion,
    previewTarget: PreviewTarget,
  })
    .annotations(strict)
    .pipe(
      Schema.filter(
        (outcome) =>
          outcome.version.artifactId === outcome.artifact.artifactId &&
          outcome.version.projectId === outcome.artifact.projectId &&
          outcome.version.format === outcome.artifact.format &&
          outcome.previewTarget.kind === "artifact-version" &&
          outcome.previewTarget.projectId === outcome.artifact.projectId &&
          outcome.previewTarget.displayName === outcome.artifact.displayName,
        { jsonSchema: {} },
      ),
    );

/**
 * Typed Work mutation outcome. Success variants (`created`, `revised`,
 * `exported`, `deleted`) feed the existing preview surface: `created` and
 * `revised` carry a `PreviewTarget` whose kind is `artifact-version` and whose
 * Project matches the artifact, so the renderer previews the new version beside
 * the thread without a parallel path. `deleted` carries the artifact id and
 * last version evidence so the renderer can reconcile the completed deletion
 * without a preview target. Failure variants mirror `PreviewOutcome` shapes
 * (unsupported, locked, stale, unauthorized, interrupted, failed) so the
 * renderer reuses one typed-failure presentation. `unauthorized` exposes only
 * optional opaque ids; never content-derived metadata, display name, or media
 * type.
 */
export const WorkMutationOutcome = Schema.Union(
  createdOrRevisedOutcome("created"),
  createdOrRevisedOutcome("revised"),
  Schema.Struct({
    kind: Schema.Literal("exported"),
    handoff: WorkExportHandoff,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("deleted"),
    artifactId: WorkArtifactId,
    projectId: ProjectId,
    lastVersion: WorkArtifactVersion,
  })
    .annotations(strict)
    .pipe(
      Schema.filter(
        (outcome) =>
          outcome.lastVersion.artifactId === outcome.artifactId &&
          outcome.lastVersion.projectId === outcome.projectId,
        { jsonSchema: {} },
      ),
    ),
  Schema.Struct({
    kind: Schema.Literal("unsupported"),
    artifactId: Schema.optional(WorkArtifactId),
    format: WorkArtifactFormat,
    canOpenExternally: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("locked"),
    artifactId: WorkArtifactId,
    canOpenExternally: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("stale"),
    artifactId: WorkArtifactId,
    knownVersion: PreviewSourceVersion,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("unauthorized"),
    artifactId: Schema.optional(WorkArtifactId),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("interrupted"),
    artifactId: Schema.optional(WorkArtifactId),
    canRetry: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    artifactId: Schema.optional(WorkArtifactId),
    reason: WorkMutationFailureCode,
    message: Schema.optional(WorkSafeDiagnostic),
  }).annotations(strict),
);
export type WorkMutationOutcome = typeof WorkMutationOutcome.Type;

/**
 * Success-only mutation outcome subset. The server journals only successful
 * mutations (created, revised, exported, deleted) as versioned events; failure
 * outcomes (unsupported, locked, stale, unauthorized, interrupted, failed)
 * never change artifact state and are not journaled. Projections rebuild
 * artifact state from this success-only stream.
 */
export const WorkMutationSuccessOutcome = Schema.Union(
  createdOrRevisedOutcome("created"),
  createdOrRevisedOutcome("revised"),
  Schema.Struct({
    kind: Schema.Literal("exported"),
    handoff: WorkExportHandoff,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("deleted"),
    artifactId: WorkArtifactId,
    projectId: ProjectId,
    lastVersion: WorkArtifactVersion,
  })
    .annotations(strict)
    .pipe(
      Schema.filter(
        (outcome) =>
          outcome.lastVersion.artifactId === outcome.artifactId &&
          outcome.lastVersion.projectId === outcome.projectId,
        { jsonSchema: {} },
      ),
    ),
);
export type WorkMutationSuccessOutcome = typeof WorkMutationSuccessOutcome.Type;

/**
 * Journalable Work mutation frame. The server appends one frame per
 * successful mutation as a versioned event; projections replay frames to
 * rebuild artifact state idempotently. The frame carries the sanitized
 * success outcome (no host path, no credential, no authority token) plus the
 * request id correlation, the owning Project, and the per-artifact mutation
 * `sequence` (1-based, monotonic) that backs optimistic concurrency and
 * replay gap detection. The frame's `projectId` must match the outcome's
 * Project (the artifact's Project for created/revised/deleted, the produced
 * version's Project for exported in-app handoffs) so a cross-Project replay
 * cannot corrupt another Project's projection. The `sequence` must match the
 * produced version's sequence when the outcome carries one (created/revised/
 * deleted/exported in-app), so a replayed frame cannot misreport the version
 * it produced.
 */
export const WorkArtifactMutationFrame = Schema.Struct({
  requestId: WorkMutationRequestId,
  projectId: ProjectId,
  sequence: PositiveInt,
  occurredAt: UtcTimestamp,
  outcome: WorkMutationSuccessOutcome,
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (frame) => {
        switch (frame.outcome.kind) {
          case "created":
          case "revised":
            if (frame.outcome.artifact.projectId !== frame.projectId) return false;
            if (frame.outcome.version.sequence !== frame.sequence) return false;
            return true;
          case "deleted":
            if (frame.outcome.projectId !== frame.projectId) return false;
            if (frame.outcome.lastVersion.sequence !== frame.sequence) return false;
            return true;
          case "exported":
            if (frame.outcome.handoff.handoffKind === "in-app-version") {
              if (frame.outcome.handoff.producedVersion.projectId !== frame.projectId) return false;
              if (frame.outcome.handoff.producedVersion.sequence !== frame.sequence) return false;
            }
            return true;
        }
      },
      { jsonSchema: {} },
    ),
  );
export type WorkArtifactMutationFrame = typeof WorkArtifactMutationFrame.Type;

/**
 * Mutation reply envelope. Correlates the renderer's request id with the
 * typed outcome and an optional refreshed capability report for the touched
 * format, so the renderer can update capability/fidelity UI after a mutation
 * that changed the format's effective support (e.g., an export produced a
 * derived format). When a refreshed capability is present, its `format` must
 * match the outcome's touched format (the artifact format for created/revised/
 * deleted, the export format for exported outcomes) so a server mixup or
 * replay cannot update the renderer's capability controls for the wrong
 * format.
 */
function outcomeTouchedFormat(outcome: WorkMutationOutcome): WorkArtifactFormat | undefined {
  switch (outcome.kind) {
    case "created":
    case "revised":
      return outcome.artifact.format;
    case "exported":
      return outcome.handoff.exportFormat;
    case "deleted":
      return outcome.lastVersion.format;
    case "unsupported":
    case "locked":
    case "stale":
    case "unauthorized":
    case "interrupted":
    case "failed":
      return undefined;
  }
}

export const WorkMutationReply = Schema.Struct({
  requestId: WorkMutationRequestId,
  outcome: WorkMutationOutcome,
  capability: Schema.optional(WorkCapabilityReport),
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (reply) => {
        if (
          reply.outcome.kind === "exported" &&
          reply.outcome.handoff.requestId !== reply.requestId
        ) {
          return false;
        }
        if (reply.capability !== undefined) {
          const touched = outcomeTouchedFormat(reply.outcome);
          if (touched === undefined || reply.capability.format !== touched) {
            return false;
          }
        }
        return true;
      },
      { jsonSchema: {} },
    ),
  );
export type WorkMutationReply = typeof WorkMutationReply.Type;

export const decodeWorkArtifactId = Schema.decodeUnknownSync(WorkArtifactId);
export const decodeWorkArtifactVersionId = Schema.decodeUnknownSync(WorkArtifactVersionId);
export const decodeWorkMutationRequestId = Schema.decodeUnknownSync(WorkMutationRequestId);
export const decodeWorkArtifactRef = Schema.decodeUnknownSync(WorkArtifactRef);
export const decodeWorkArtifactIdentity = Schema.decodeUnknownSync(WorkArtifactIdentity);
export const decodeWorkArtifactVersion = Schema.decodeUnknownSync(WorkArtifactVersion);
export const decodeWorkCapabilityFlags = Schema.decodeUnknownSync(WorkCapabilityFlags);
export const decodeWorkFidelity = Schema.decodeUnknownSync(WorkFidelity);
export const decodeWorkCapabilityReport = Schema.decodeUnknownSync(WorkCapabilityReport);
export const decodeWorkMutationRequest = Schema.decodeUnknownSync(WorkMutationRequest);
export const decodeWorkExportHandoff = Schema.decodeUnknownSync(WorkExportHandoff);
export const decodeWorkMutationOutcome = Schema.decodeUnknownSync(WorkMutationOutcome);
export const decodeWorkMutationSuccessOutcome = Schema.decodeUnknownSync(
  WorkMutationSuccessOutcome,
);
export const decodeWorkArtifactMutationFrame = Schema.decodeUnknownSync(WorkArtifactMutationFrame);
export const decodeWorkMutationReply = Schema.decodeUnknownSync(WorkMutationReply);
