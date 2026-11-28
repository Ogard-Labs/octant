import { Schema } from "effect";
import { PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));

const CanvasId = brandedUuid("CanvasId");
const CanvasVersionId = brandedUuid("CanvasVersionId");
const CanvasDisplayName = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(256),
  Schema.makeFilter((value) => !/[\\/]/.test(value), {
    message: "Canvas display names must not contain path separators.",
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
  sequence: PositiveInt,
  displayName: CanvasDisplayName,
  scope: Schema.Literal("whole-canvas"),
});
export type CanvasContextSelection = typeof CanvasContextSelection.Type;

export const decodeCanvasContextSelectionId = Schema.decodeUnknownSync(
  CanvasContextSelectionId,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasContextSelection = Schema.decodeUnknownSync(
  CanvasContextSelection,
  STRICT_DECODE_OPTIONS,
);
