import { Schema } from "effect";
import { isCanvasShareSafeText } from "./canvasExportText";
const strict = { parseOptions: { onExcessProperty: "error" as const } };
const boundedText = (maximum: number) =>
  Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(maximum));
const boundedToken = <B extends string>(brand: B) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(96),
    Schema.pattern(/^[a-z][a-z0-9-]*$/),
    Schema.brand(brand),
  );
export const CANVAS_EXPORT_SCHEMA_VERSION = 1 as const;
export const CanvasExportSchemaVersion = Schema.Literal(CANVAS_EXPORT_SCHEMA_VERSION);
export type CanvasExportSchemaVersion = typeof CanvasExportSchemaVersion.Type;

export const CANVAS_EXPORT_LABEL_MAX_CHARS = 128;
export const CANVAS_EXPORT_MESSAGE_MAX_CHARS = 1_024;

export const CanvasExportFormat = Schema.Literal(
  "markdown",
  "html",
  "share-document",
  "pdf",
  "png",
);
export type CanvasExportFormat = typeof CanvasExportFormat.Type;

export const CanvasExportTargetId = boundedToken("CanvasExportTargetId");
export type CanvasExportTargetId = typeof CanvasExportTargetId.Type;

export const canvasExportSafeBounded = (maximum: number) =>
  boundedText(maximum).pipe(
    Schema.filter((value) => isCanvasShareSafeText(value), {
      message: () => "Canvas export text must not contain a secret or a file path.",
    }),
  );

export const canvasExportUniqueFormats = <T extends string>(formats: ReadonlyArray<T>): boolean =>
  new Set(formats).size === formats.length;

export const CanvasExportContribution = Schema.Struct({
  schemaVersion: CanvasExportSchemaVersion,
  kind: Schema.Literal("canvas-export-contribution"),
  targetId: CanvasExportTargetId,
  label: canvasExportSafeBounded(CANVAS_EXPORT_LABEL_MAX_CHARS),
  formats: Schema.NonEmptyArray(CanvasExportFormat).pipe(
    Schema.maxItems(5),
    Schema.filter(canvasExportUniqueFormats, {
      message: () => "Canvas export formats must be unique.",
    }),
  ),
}).annotations(strict);
export type CanvasExportContribution = typeof CanvasExportContribution.Type;
