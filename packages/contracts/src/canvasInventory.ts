import { Schema } from "effect";
import { CanvasId, CanvasVersion, CanvasVersionId } from "./canvas";
import { CanvasWorkspaceScope } from "./canvasCards";
import { CanvasRefreshSkillOptions } from "./canvasRefresh";
import { UtcTimestamp } from "./events";
import { OctantMode } from "./modes";
import { ProjectId } from "./projects";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * Opaque Canvas inventory row for Project-scoped listings. Carries identity and
 * version metadata only — never definition bodies, source manifests, or secrets.
 */
export const CanvasInventoryEntry = Schema.Struct({
  canvasId: CanvasId,
  projectId: ProjectId,
  mode: OctantMode,
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256)),
  versionCount: Schema.Int.pipe(Schema.positive()),
  currentVersionId: CanvasVersionId,
  currentSequence: Schema.Int.pipe(Schema.positive()),
  updatedAt: UtcTimestamp,
}).annotations(strict);
export type CanvasInventoryEntry = typeof CanvasInventoryEntry.Type;

export const CanvasInventoryList = Schema.Struct({
  projectId: ProjectId,
  entries: Schema.Array(CanvasInventoryEntry),
}).annotations(strict);
export type CanvasInventoryList = typeof CanvasInventoryList.Type;

export const CanvasInventoryListRequest = Schema.Struct({
  projectId: ProjectId,
  query: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(256))),
}).annotations(strict);
export type CanvasInventoryListRequest = typeof CanvasInventoryListRequest.Type;

export const CanvasGetRequest = Schema.Struct({
  canvasId: CanvasId,
  versionId: Schema.optional(CanvasVersionId),
}).annotations(strict);
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
export const CanvasGetOutcome = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("ready"),
    version: CanvasVersion,
    workspace: Schema.optional(CanvasWorkspaceScope),
    refreshSkills: Schema.optional(CanvasRefreshSkillOptions),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("unavailable"),
    canvasId: CanvasId,
    reason: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("unauthorized"), canvasId: CanvasId }).annotations(strict),
);
export type CanvasGetOutcome = typeof CanvasGetOutcome.Type;

export const decodeCanvasInventoryEntry = Schema.decodeUnknownSync(CanvasInventoryEntry);
export const decodeCanvasInventoryList = Schema.decodeUnknownSync(CanvasInventoryList);
export const decodeCanvasInventoryListRequest = Schema.decodeUnknownSync(
  CanvasInventoryListRequest,
);
export const decodeCanvasGetRequest = Schema.decodeUnknownSync(CanvasGetRequest);
export const decodeCanvasGetOutcome = Schema.decodeUnknownSync(CanvasGetOutcome);
