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
// (diagram v2 layout fields and journaled comments). Existing v1 documents
// remain decodable so a host does not lose its history at the bump.
export const CANVAS_SCHEMA_VERSION = 2 as const;
export const CanvasSchemaVersion = Schema.Literal(1, CANVAS_SCHEMA_VERSION);
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
