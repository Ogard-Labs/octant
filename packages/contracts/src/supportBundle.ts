import { Schema } from "effect";
import { GuidString, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { UtcTimestamp } from "./events";

/**
 * Wire version of the support bundle a person saves and sends themselves. It
 * is separate from the failure-anchored evidence packet in `./diagnostics`:
 * that packet describes one failed operation, this bundle describes the host.
 */
export const SUPPORT_BUNDLE_VERSION = 1 as const;

/** Journal event name recording that a bundle was handed over. */
export const SUPPORT_BUNDLE_EXPORTED_EVENT = "diagnostics.support-bundle-exported@1" as const;

/** The closed set of sections a bundle can hold, in the order a person reads them. */
export const SupportBundleSectionId = Schema.Literals([
  "versions",
  "system",
  "providers",
  "host-log",
  "crash-records",
  "journal-events",
  "confinement",
  "process",
]);
export type SupportBundleSectionId = typeof SupportBundleSectionId.Type;

/**
 * Where the person put the bundle, as a category and never a path. The host
 * journals the category so a record of the export carries no folder name.
 */
export const SupportBundleDestinationCategory = Schema.Literals([
  "downloads",
  "desktop",
  "documents",
  "home-folder",
  "temporary-folder",
  "other-folder",
  "browser-download",
  "chosen-by-person",
]);
export type SupportBundleDestinationCategory = typeof SupportBundleDestinationCategory.Type;

/** One row of the plain list shown before anything is saved. */
export const SupportBundleSectionPreview = Schema.Struct({
  id: SupportBundleSectionId,
  title: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
  /** What the section holds, in one plain sentence. */
  includes: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(240)),
  /** How many entries the section would hold right now; 0 when the host cannot read it. */
  entries: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 100_000 })),
  available: Schema.Boolean,
});
export type SupportBundleSectionPreview = typeof SupportBundleSectionPreview.Type;

export const SupportBundlePreview = Schema.Struct({
  bundleVersion: Schema.Literal(SUPPORT_BUNDLE_VERSION),
  generatedAt: UtcTimestamp,
  sections: Schema.Array(SupportBundleSectionPreview).check(Schema.isMaxLength(16)),
  /** Plain statements of what the bundle never holds. */
  neverIncluded: Schema.Array(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(160)),
  ).check(Schema.isMaxLength(16)),
});
export type SupportBundlePreview = typeof SupportBundlePreview.Type;

export const SupportBundleExportRequest = Schema.Struct({
  destinationCategory: SupportBundleDestinationCategory,
});
export type SupportBundleExportRequest = typeof SupportBundleExportRequest.Type;

/** A file inside the bundle: a relative path and its text. */
export const SupportBundleFile = Schema.Struct({
  path: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]*\.(?:json|txt)$/)),
  contents: Schema.String,
});
export type SupportBundleFile = typeof SupportBundleFile.Type;

/** What the journal keeps about one export: when, how many, and the path category. */
export const SupportBundleReceipt = Schema.Struct({
  bundleId: GuidString,
  exportedAt: UtcTimestamp,
  destinationCategory: SupportBundleDestinationCategory,
  sections: Schema.Array(SupportBundleSectionId).check(Schema.isMaxLength(16)),
  fileCount: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 0, maximum: 64 })),
  byteCount: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 0, maximum: 64 * 1024 * 1024 }),
  ),
});
export type SupportBundleReceipt = typeof SupportBundleReceipt.Type;

export const SupportBundleOutcome = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("exported"),
    files: Schema.Array(SupportBundleFile).check(Schema.isMaxLength(64)),
    receipt: SupportBundleReceipt,
  }),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(240)),
  }),
]);
export type SupportBundleOutcome = typeof SupportBundleOutcome.Type;

/**
 * What the host answers the desktop app after it wrote a bundle to the place
 * the person chose in the native save dialog. The file name is the last path
 * segment the person typed; the folder never leaves the host.
 */
export const SupportBundleSaveOutcome = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("saved"),
    fileName: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
    receipt: SupportBundleReceipt,
  }),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    message: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(240)),
  }),
]);
export type SupportBundleSaveOutcome = typeof SupportBundleSaveOutcome.Type;

/** Durable journal payload: the receipt and nothing from the bundle itself. */
export const SupportBundleExported = Schema.Struct({
  receipt: SupportBundleReceipt,
});
export type SupportBundleExported = typeof SupportBundleExported.Type;

export const decodeSupportBundlePreview = Schema.decodeUnknownSync(
  SupportBundlePreview,
  STRICT_DECODE_OPTIONS,
);
export const decodeSupportBundleExportRequest = Schema.decodeUnknownSync(
  SupportBundleExportRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeSupportBundleOutcome = Schema.decodeUnknownSync(
  SupportBundleOutcome,
  STRICT_DECODE_OPTIONS,
);
export const decodeSupportBundleSaveOutcome = Schema.decodeUnknownSync(
  SupportBundleSaveOutcome,
  STRICT_DECODE_OPTIONS,
);
export const decodeSupportBundleExported = Schema.decodeUnknownSync(
  SupportBundleExported,
  STRICT_DECODE_OPTIONS,
);
