import { Schema } from "effect";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));

const CanvasId = brandedUuid("CanvasId");
const CanvasVersionId = brandedUuid("CanvasVersionId");
const CanvasDisplayName = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(256),
  Schema.filter((value) => !/[\\/]/.test(value), {
    message: () => "Canvas display names must not contain path separators.",
  }),
);

export const MAX_CHAT_TURN_CANVAS_SELECTIONS = 16;

export const CanvasContextSelectionId = brandedUuid("CanvasContextSelectionId");
export type CanvasContextSelectionId = typeof CanvasContextSelectionId.Type;

/**
 * A bounded, versioned whole-canvas selection attached to the composer as
 * explicit agent context. The selection carries only opaque canvas/version
 * identity; the host reauthorizes the canvas and rechecks the source version at
 * send time. The renderer never synthesizes block bodies or paths.
 */
export const CanvasContextSelection = Schema.Struct({
  id: CanvasContextSelectionId,
  canvasId: CanvasId,
  versionId: CanvasVersionId,
  sequence: Schema.Int.pipe(Schema.positive()),
  displayName: CanvasDisplayName,
  scope: Schema.Literal("whole-canvas"),
}).annotations(strict);
export type CanvasContextSelection = typeof CanvasContextSelection.Type;

export const decodeCanvasContextSelectionId = Schema.decodeUnknownSync(CanvasContextSelectionId);
export const decodeCanvasContextSelection = Schema.decodeUnknownSync(CanvasContextSelection);
