import { Schema } from "effect";
import { UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

/**
 * Wire version of the support bundle a person saves and sends themselves. It
 * is separate from the failure-anchored evidence packet in `./diagnostics`:
 * that packet describes one failed operation, this bundle describes the host.
 */
export const SUPPORT_BUNDLE_VERSION = 1 as const;

/** Journal event name recording that a bundle was handed over. */
export const SUPPORT_BUNDLE_EXPORTED_EVENT = "diagnostics.support-bundle-exported@1" as const;

/** The closed set of sections a bundle can hold, in the order a person reads them. */
export const SupportBundleSectionId = Schema.Literal(
  "versions",
  "system",
  "providers",
  "host-log",
  "journal-events",
  "confinement",
  "process",
);
export type SupportBundleSectionId = typeof SupportBundleSectionId.Type;

/**
 * Where the person put the bundle, as a category and never a path. The host
 * journals the category so a record of the export carries no folder name.
 */
export const SupportBundleDestinationCategory = Schema.Literal(
  "downloads",
  "desktop",
  "documents",
  "home-folder",
  "temporary-folder",
  "other-folder",
  "browser-download",
);
export type SupportBundleDestinationCategory = typeof SupportBundleDestinationCategory.Type;

/** One row of the plain list shown before anything is saved. */
export const SupportBundleSectionPreview = Schema.Struct({
  id: SupportBundleSectionId,
  title: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64)),
  /** What the section holds, in one plain sentence. */
  includes: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(240)),
  /** How many entries the section would hold right now; 0 when the host cannot read it. */
  entries: Schema.Number.pipe(Schema.int(), Schema.between(0, 100_000)),
  available: Schema.Boolean,
}).annotations(strict);
export type SupportBundleSectionPreview = typeof SupportBundleSectionPreview.Type;

export const SupportBundlePreview = Schema.Struct({
  bundleVersion: Schema.Literal(SUPPORT_BUNDLE_VERSION),
  generatedAt: UtcTimestamp,
  sections: Schema.Array(SupportBundleSectionPreview).pipe(Schema.maxItems(16)),
  /** Plain statements of what the bundle never holds. */
  neverIncluded: Schema.Array(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(160))).pipe(
    Schema.maxItems(16),
  ),
}).annotations(strict);
export type SupportBundlePreview = typeof SupportBundlePreview.Type;

export const SupportBundleExportRequest = Schema.Struct({
  destinationCategory: SupportBundleDestinationCategory,
}).annotations(strict);
export type SupportBundleExportRequest = typeof SupportBundleExportRequest.Type;

/** A file inside the bundle: a relative path and its text. */
export const SupportBundleFile = Schema.Struct({
  path: Schema.String.pipe(Schema.pattern(/^[a-z0-9][a-z0-9-]*\.(?:json|txt)$/)),
  contents: Schema.String,
}).annotations(strict);
export type SupportBundleFile = typeof SupportBundleFile.Type;

/** What the journal keeps about one export: when, how many, and the path category. */
export const SupportBundleReceipt = Schema.Struct({
  bundleId: Schema.UUID,
  exportedAt: UtcTimestamp,
  destinationCategory: SupportBundleDestinationCategory,
  sections: Schema.Array(SupportBundleSectionId).pipe(Schema.maxItems(16)),
  fileCount: Schema.Number.pipe(Schema.int(), Schema.between(0, 64)),
  byteCount: Schema.Number.pipe(Schema.int(), Schema.between(0, 64 * 1024 * 1024)),
}).annotations(strict);
export type SupportBundleReceipt = typeof SupportBundleReceipt.Type;

export const SupportBundleOutcome = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("exported"),
    files: Schema.Array(SupportBundleFile).pipe(Schema.maxItems(64)),
    receipt: SupportBundleReceipt,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    message: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(240)),
  }).annotations(strict),
);
export type SupportBundleOutcome = typeof SupportBundleOutcome.Type;

/** Durable journal payload: the receipt and nothing from the bundle itself. */
export const SupportBundleExported = Schema.Struct({
  receipt: SupportBundleReceipt,
}).annotations(strict);
export type SupportBundleExported = typeof SupportBundleExported.Type;

export const decodeSupportBundlePreview = Schema.decodeUnknownSync(SupportBundlePreview);
export const decodeSupportBundleExportRequest = Schema.decodeUnknownSync(
  SupportBundleExportRequest,
);
export const decodeSupportBundleOutcome = Schema.decodeUnknownSync(SupportBundleOutcome);
export const decodeSupportBundleExported = Schema.decodeUnknownSync(SupportBundleExported);
