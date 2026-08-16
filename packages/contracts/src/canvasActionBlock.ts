/**
 * Canvas typed-action *block* schema.
 *
 * Split from `canvasActions.ts` so `canvas.ts` can fold `CanvasActionBlock`
 * into the definition union without a module cycle: the execution request
 * carries `AgentRunAuthority`, and `agentRun` reaches `canvas` again through
 * `shell`. The block itself needs only canvas identity, so it lives here and
 * `canvasActions.ts` re-exports it for existing importers.
 */

import { Schema } from "effect";
import { CanvasBlockId, CanvasSchemaVersion, CanvasSourceId } from "./canvasIdentity";

// A Canvas action block is a *declarative reference* to a registered Octant
// command. It carries no executable code, inline handlers, scripts, URLs, or
// host paths: only a command identifier drawn from a closed allowlist plus
// bounded, typed, host-owned references. The server reauthorizes every action
// before any side effect, so a Canvas definition can never itself become an
// execution environment (design §7 Typed actions).
//
// This is delivered as a standalone versioned contract module, mirroring the
// Canvas refresh (C2) and skill (C3) contracts. Folding the action block into
// the first-party definition catalog union is a later Canvas D increment; D1
// establishes the schema and the command allowlist only.
const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const CANVAS_ACTION_LABEL_MAX_CHARS = 256;
export const CANVAS_ACTION_DESCRIPTION_MAX_CHARS = 1_024;
export const CANVAS_ACTION_PROMPT_MAX_CHARS = 4_096;
export const CANVAS_ACTION_MAX_FILTERS = 16;
export const CANVAS_ACTION_MAX_SELECTION_REFS = 64;
export const CANVAS_ACTION_TEXT_VALUE_MAX_CHARS = 512;

const boundedText = (maximum: number) => Schema.String.pipe(Schema.maxLength(maximum));
const boundedNonEmptyText = (maximum: number) =>
  Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(maximum));
const boundedToken = <B extends string>(brand: B) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(128),
    Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    Schema.brand(brand),
  );

const FiniteNumber = Schema.Number.pipe(
  Schema.filter(Number.isFinite, { message: () => "Canvas action numbers must be finite." }),
);

// External entities (threads, pull requests) are addressed only through
// host-owned opaque references. Free-form text, file URLs, credential-bearing
// URLs, and path traversal are rejected so a stored action can never leak a
// path or resolve to an arbitrary network location.
export const CanvasActionReference = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(512),
  Schema.pattern(/^(?:opaque|ref):[A-Za-z0-9._:-]+$/),
);
export type CanvasActionReference = typeof CanvasActionReference.Type;

// ── Command allowlist ───────────────────────────────────────────────────────

/**
 * The closed set of registered Octant commands a Canvas action may
 * reference. Any identifier outside this list fails closed at decode time and
 * again in the domain allowlist policy. This is the single source of truth for
 * the contract layer; the domain policy mirrors it as its enforcement set.
 */
export const CANVAS_COMMAND_IDS = [
  "canvas.open-source",
  "canvas.filter-data",
  "canvas.attach-selection",
  "canvas.open-thread",
  "canvas.open-pull-request",
  "canvas.request-refresh",
  "canvas.propose-thread",
] as const;

export const CanvasCommandId = Schema.Literal(...CANVAS_COMMAND_IDS);
export type CanvasCommandId = typeof CanvasCommandId.Type;

// ── Declarative command parameters ──────────────────────────────────────────

export const CanvasActionScalar = Schema.Union(
  boundedText(CANVAS_ACTION_TEXT_VALUE_MAX_CHARS),
  FiniteNumber,
  Schema.Boolean,
  Schema.Null,
);
export type CanvasActionScalar = typeof CanvasActionScalar.Type;

export const CanvasActionFilterOperator = Schema.Literal(
  "eq",
  "neq",
  "lt",
  "lte",
  "gt",
  "gte",
  "contains",
);
export type CanvasActionFilterOperator = typeof CanvasActionFilterOperator.Type;

export const CanvasActionFilter = Schema.Struct({
  column: boundedToken("CanvasActionFilterColumn"),
  operator: CanvasActionFilterOperator,
  value: CanvasActionScalar,
}).annotations(strict);
export type CanvasActionFilter = typeof CanvasActionFilter.Type;

export const CanvasActionSelectionRef = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("canvas") }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("block"), blockId: CanvasBlockId }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("source"), sourceId: CanvasSourceId }).annotations(strict),
);
export type CanvasActionSelectionRef = typeof CanvasActionSelectionRef.Type;

// ── Typed command references ─────────────────────────────────────────────────

export const CanvasOpenSourceCommand = Schema.Struct({
  command: Schema.Literal("canvas.open-source"),
  sourceId: CanvasSourceId,
}).annotations(strict);
export type CanvasOpenSourceCommand = typeof CanvasOpenSourceCommand.Type;

export const CanvasFilterDataCommand = Schema.Struct({
  command: Schema.Literal("canvas.filter-data"),
  target: CanvasBlockId,
  filters: Schema.Array(CanvasActionFilter).pipe(
    Schema.minItems(1),
    Schema.maxItems(CANVAS_ACTION_MAX_FILTERS),
  ),
}).annotations(strict);
export type CanvasFilterDataCommand = typeof CanvasFilterDataCommand.Type;

export const CanvasAttachSelectionCommand = Schema.Struct({
  command: Schema.Literal("canvas.attach-selection"),
  selection: Schema.Array(CanvasActionSelectionRef).pipe(
    Schema.minItems(1),
    Schema.maxItems(CANVAS_ACTION_MAX_SELECTION_REFS),
  ),
}).annotations(strict);
export type CanvasAttachSelectionCommand = typeof CanvasAttachSelectionCommand.Type;

export const CanvasOpenThreadCommand = Schema.Struct({
  command: Schema.Literal("canvas.open-thread"),
  threadRef: CanvasActionReference,
}).annotations(strict);
export type CanvasOpenThreadCommand = typeof CanvasOpenThreadCommand.Type;

export const CanvasOpenPullRequestCommand = Schema.Struct({
  command: Schema.Literal("canvas.open-pull-request"),
  pullRequestRef: CanvasActionReference,
}).annotations(strict);
export type CanvasOpenPullRequestCommand = typeof CanvasOpenPullRequestCommand.Type;

export const CanvasRequestRefreshCommand = Schema.Struct({
  command: Schema.Literal("canvas.request-refresh"),
}).annotations(strict);
export type CanvasRequestRefreshCommand = typeof CanvasRequestRefreshCommand.Type;

export const CanvasProposeThreadCommand = Schema.Struct({
  command: Schema.Literal("canvas.propose-thread"),
  prompt: Schema.optional(boundedNonEmptyText(CANVAS_ACTION_PROMPT_MAX_CHARS)),
}).annotations(strict);
export type CanvasProposeThreadCommand = typeof CanvasProposeThreadCommand.Type;

export const CanvasActionCommand = Schema.Union(
  CanvasOpenSourceCommand,
  CanvasFilterDataCommand,
  CanvasAttachSelectionCommand,
  CanvasOpenThreadCommand,
  CanvasOpenPullRequestCommand,
  CanvasRequestRefreshCommand,
  CanvasProposeThreadCommand,
);
export type CanvasActionCommand = typeof CanvasActionCommand.Type;

// ── Action block ────────────────────────────────────────────────────────────

export const CanvasActionBlock = Schema.Struct({
  blockId: CanvasBlockId,
  schemaVersion: CanvasSchemaVersion,
  kind: Schema.Literal("action"),
  label: boundedNonEmptyText(CANVAS_ACTION_LABEL_MAX_CHARS),
  description: Schema.optional(boundedText(CANVAS_ACTION_DESCRIPTION_MAX_CHARS)),
  command: CanvasActionCommand,
}).annotations(strict);
export type CanvasActionBlock = typeof CanvasActionBlock.Type;

// ── Decoders ────────────────────────────────────────────────────────────────

export const decodeCanvasCommandId = Schema.decodeUnknownSync(CanvasCommandId);
export const decodeCanvasActionFilter = Schema.decodeUnknownSync(CanvasActionFilter);
export const decodeCanvasActionSelectionRef = Schema.decodeUnknownSync(CanvasActionSelectionRef);
export const decodeCanvasActionCommand = Schema.decodeUnknownSync(CanvasActionCommand);
export const decodeCanvasActionBlock = Schema.decodeUnknownSync(CanvasActionBlock);
