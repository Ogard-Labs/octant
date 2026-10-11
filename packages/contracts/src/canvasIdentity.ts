import { Schema } from "effect";
import { ActorId } from "./events";

/**
 * Canvas identity and versioning primitives.
 *
 * These live apart from `canvas.ts` so the typed-action contract can reuse them
 * without a module cycle: `canvas.ts` folds `CanvasActionBlock` into the block
 * union, and `canvasActions.ts` needs the same identifiers. Effect schemas are
 * initialized at module load, so a cycle between those two would leave one side
 * reading an uninitialized binding. `canvas.ts` re-exports everything here, so
 * existing importers are unaffected.
 */

const strict = { parseOptions: { onExcessProperty: "error" as const } };

// Canvas wire contracts are deliberately versioned independently from event
// envelopes. A decoder must reject a future version until its renderer and
// policy have been reviewed together. Version 2 adds the board surface
// (diagram v2 layout fields and journaled comments). Version 3 adds the
// mockup block, version 4 the thread presentation, version 5 the treemap
// block, version 6 the heatmap block, version 7 the ranked bar list block,
// version 8 the entity-relationship, swimlane, and mind map diagram kinds,
// version 9 the design block, version 10 the comparison matrix, version 11
// the math block, version 12 the mockup catalog, version 13 the stable
// table row id a comment anchors to, and version 14 the funnel, radar, and
// sankey chart types. A version-gated kind or
// hint is only valid inside a document declaring the version that introduced
// it, so a rolled-back older runtime refuses it as a declared future version
// instead of reading it as corrupt. Each gated block kind is admitted from the
// version that introduced it: every earlier document (including
// mockup-carrying v3, presentation v4, treemap-carrying v5, heatmap-carrying
// v6, bar-list-carrying v7, diagram-kind-carrying v8, design-carrying v9,
// matrix-carrying v10, math-carrying v11, catalog-carrying v12, and
// row-id-carrying v13 documents) remains decodable so a
// host does not lose its history at the bump. The literal set names each
// earlier version explicitly and ends at the current one, so a future bump
// cannot silently drop an intermediate version from the set that decodes.
export const CANVAS_SCHEMA_VERSION = 14 as const;
export const CanvasSchemaVersion = Schema.Literal(
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  11,
  12,
  13,
  CANVAS_SCHEMA_VERSION,
);
export type CanvasSchemaVersion = typeof CanvasSchemaVersion.Type;
export const CanvasBlockSchemaVersion = CanvasSchemaVersion;
export type CanvasBlockSchemaVersion = CanvasSchemaVersion;

const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const boundedToken = <B extends string>(brand: B) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(128),
    Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
    Schema.brand(brand),
  );

export const CanvasId = brandedUuid("CanvasId");
export type CanvasId = typeof CanvasId.Type;
export const CanvasVersionId = brandedUuid("CanvasVersionId");
export type CanvasVersionId = typeof CanvasVersionId.Type;
export const CanvasSourceId = brandedUuid("CanvasSourceId");
export type CanvasSourceId = typeof CanvasSourceId.Type;
export const CanvasBlockId = boundedToken("CanvasBlockId");
export type CanvasBlockId = typeof CanvasBlockId.Type;
export const CanvasNodeId = boundedToken("CanvasNodeId");
export type CanvasNodeId = typeof CanvasNodeId.Type;
export const CanvasEdgeId = boundedToken("CanvasEdgeId");
export type CanvasEdgeId = typeof CanvasEdgeId.Type;
// A table row's identity, written by the author so it survives a re-sort, a
// filter, and a revision that inserts or removes rows; an index would not.
export const CanvasTableRowId = boundedToken("CanvasTableRowId");
export type CanvasTableRowId = typeof CanvasTableRowId.Type;

// A Canvas actor is either the system, a local user, or an agent operating on
// the user's behalf. The agent kind is admitted for board actions such as
// layout revisions and comment threading that may originate from a provider
// turn or an explicit user gesture.
export const CanvasActor = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("system"), actorId: ActorId }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("local-user"), actorId: ActorId }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("agent"), actorId: ActorId }).annotations(strict),
);
export type CanvasActor = typeof CanvasActor.Type;
