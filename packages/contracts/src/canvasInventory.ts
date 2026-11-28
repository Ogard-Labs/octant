import { Schema } from "effect";
import { NonEmptyTrimmedString, PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { CanvasId, CanvasVersion, CanvasVersionId } from "./canvas";
import { CanvasWorkspaceScope } from "./canvasCards";
import { CanvasRefreshSkillOptions } from "./canvasRefresh";
import { UtcTimestamp } from "./events";
import { OctantMode } from "./modes";
import { ProjectId } from "./projects";

/**
 * Opaque Canvas inventory row for Project-scoped listings. Carries identity and
 * version metadata only — never definition bodies, source manifests, or secrets.
 */
export const CanvasInventoryEntry = Schema.Struct({
  canvasId: CanvasId,
  projectId: ProjectId,
  mode: OctantMode,
  title: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  versionCount: PositiveInt,
  currentVersionId: CanvasVersionId,
  currentSequence: PositiveInt,
  updatedAt: UtcTimestamp,
});
export type CanvasInventoryEntry = typeof CanvasInventoryEntry.Type;

export const CanvasInventoryList = Schema.Struct({
  projectId: ProjectId,
  entries: Schema.Array(CanvasInventoryEntry),
});
export type CanvasInventoryList = typeof CanvasInventoryList.Type;

export const CanvasInventoryListRequest = Schema.Struct({
  projectId: ProjectId,
  query: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256))),
});
export type CanvasInventoryListRequest = typeof CanvasInventoryListRequest.Type;

export const CanvasGetRequest = Schema.Struct({
  canvasId: CanvasId,
  versionId: Schema.optional(CanvasVersionId),
});
export type CanvasGetRequest = typeof CanvasGetRequest.Type;

/**
 * A ready read publishes the host's authoritative workspace scope for the
 * Canvas so a client can echo it on revise, refresh, and action requests
 * instead of inferring one. It is omitted when the host cannot resolve the
 * scope from durable state — a client that needs it must then fail closed
 * rather than fabricate a scope the server would reject.
 *
 * `refreshSkills` publishes the skills the host considers eligible to present
 * this Canvas. It is the Canvas's only source of authorized skill identity: a
 * derived refresh recipe carries no skill of its own, and a renderer cannot
 * mint a digest-pinned `qualifiedId`. An absent or empty list simply means a
 * refresh proceeds without a skill contribution.
 */
export const CanvasGetOutcome = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("ready"),
    version: CanvasVersion,
    workspace: Schema.optional(CanvasWorkspaceScope),
    refreshSkills: Schema.optional(CanvasRefreshSkillOptions),
  }),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    canvasId: CanvasId,
    reason: NonEmptyTrimmedString,
  }),
  Schema.Struct({ kind: Schema.Literal("unauthorized"), canvasId: CanvasId }),
]);
export type CanvasGetOutcome = typeof CanvasGetOutcome.Type;

export const decodeCanvasInventoryEntry = Schema.decodeUnknownSync(
  CanvasInventoryEntry,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasInventoryList = Schema.decodeUnknownSync(
  CanvasInventoryList,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasInventoryListRequest = Schema.decodeUnknownSync(
  CanvasInventoryListRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasGetRequest = Schema.decodeUnknownSync(
  CanvasGetRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasGetOutcome = Schema.decodeUnknownSync(
  CanvasGetOutcome,
  STRICT_DECODE_OPTIONS,
);
