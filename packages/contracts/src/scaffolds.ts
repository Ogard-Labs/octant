/**
 * Curated project scaffolds.
 *
 * A scaffold is a starting point the host offers for an empty checkout: pick
 * one, name a directory, and the host runs the generator it pinned. The host
 * owns the catalog and composes the command line from the pinned record, so a
 * renderer selects a scaffold and never authors one — the same rule the
 * repository-test listing already follows, for the same reason.
 */

import { Schema } from "effect";
import { CodeCheckoutId, CodeThreadId } from "./code";
import { UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const encoder = new TextEncoder();

export const MAX_SCAFFOLD_OUTPUT_BYTES = 256 * 1024;
export const MAX_SCAFFOLD_DIRECTORY_NAME_LENGTH = 64;

export const ScaffoldId = Schema.String.pipe(
  Schema.pattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  Schema.maxLength(64),
  Schema.brand("ScaffoldId"),
);
export type ScaffoldId = typeof ScaffoldId.Type;

export const ScaffoldRunId = Schema.UUID.pipe(Schema.brand("ScaffoldRunId"));
export type ScaffoldRunId = typeof ScaffoldRunId.Type;

/**
 * The directory a scaffold creates, as the user typed it.
 *
 * One path segment, no separators, no traversal, no leading dot. A scaffold
 * always creates its own directory, so a name that could escape the checkout
 * or hide itself is refused before any planning happens.
 */
export const ScaffoldDirectoryName = Schema.String.pipe(
  Schema.maxLength(MAX_SCAFFOLD_DIRECTORY_NAME_LENGTH),
  Schema.filter(
    (value) =>
      value.length > 0 &&
      value === value.normalize("NFC") &&
      !value.startsWith(".") &&
      !value.startsWith("-") &&
      /^[A-Za-z0-9._-]+$/.test(value) &&
      value !== "." &&
      value !== "..",
  ),
);

/**
 * A command-line token a scaffold contributes.
 *
 * Shells and `-c` are refused for the same reason repository-test definitions
 * refuse them: a token that opens a shell turns a pinned generator back into
 * arbitrary text.
 */
const ScaffoldArgvToken = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(256),
  Schema.filter(
    (value) =>
      !value.includes("\0") &&
      !["/bin/sh", "sh", "bash", "zsh", "fish", "cmd", "powershell", "-c"].includes(value),
  ),
);

const ScaffoldPresetArguments = Schema.Array(ScaffoldArgvToken).pipe(
  Schema.filter((values) => values.length <= 16),
);

/**
 * What actually produces the project.
 *
 * `pinned-package` names an exact generator package and version, so the same
 * scaffold produces the same generator today and next year. `toolchain` runs a
 * tool the machine already has; there is nothing to pin because nothing is
 * fetched.
 */
export const ScaffoldGenerator = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("pinned-package"),
    runner: Schema.Literal("bun", "npm"),
    packageName: Schema.NonEmptyTrimmedString.pipe(
      Schema.maxLength(128),
      Schema.pattern(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/),
    ),
    version: Schema.NonEmptyTrimmedString.pipe(
      Schema.maxLength(32),
      Schema.pattern(/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/),
    ),
    presetArguments: ScaffoldPresetArguments,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("toolchain"),
    tool: Schema.Literal("swift"),
    presetArguments: ScaffoldPresetArguments,
  }).annotations(strict),
);
export type ScaffoldGenerator = typeof ScaffoldGenerator.Type;

/**
 * One entry in the curated catalog.
 *
 * `requiresTool` is the executable the entry cannot run without. The host
 * reports what it found rather than guessing, so an entry the machine cannot
 * run says so instead of failing halfway through.
 */
export const ScaffoldEntry = Schema.Struct({
  id: ScaffoldId,
  displayName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(80)),
  summary: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(240)),
  target: Schema.Literal("web-app", "cross-platform-app", "native-apple-app"),
  generator: ScaffoldGenerator,
  requiresTool: Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(32),
    Schema.pattern(/^[a-z][a-z0-9-]*$/),
  ),
  /** Notable paths the scaffold writes, shown before anything runs. */
  produces: Schema.Array(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(120))).pipe(
    Schema.filter((paths) => paths.length <= 12),
  ),
}).annotations(strict);
export type ScaffoldEntry = typeof ScaffoldEntry.Type;

/**
 * The scaffolds this host offers, and which of them it can actually run.
 *
 * The listing is authoritative and may be empty. A renderer submits an entry's
 * id back; it never submits an entry.
 */
export const ScaffoldCatalogListing = Schema.Struct({
  kind: Schema.Literal("scaffold-catalog-listing"),
  entries: Schema.Array(ScaffoldEntry).pipe(
    Schema.filter((entries) => new Set(entries.map((entry) => entry.id)).size === entries.length),
  ),
  /** Tools the host found on this machine, out of the ones the entries need. */
  availableTools: Schema.Array(Schema.String).pipe(
    Schema.filter((tools) => new Set(tools).size === tools.length),
  ),
  observedAt: UtcTimestamp,
}).annotations(strict);
export type ScaffoldCatalogListing = typeof ScaffoldCatalogListing.Type;

const ScaffoldOutput = Schema.String.pipe(
  Schema.filter((value) => encoder.encode(value).byteLength <= MAX_SCAFFOLD_OUTPUT_BYTES),
);

/** What one scaffold run did, as the host observed it. */
export const ScaffoldRun = Schema.Struct({
  id: ScaffoldRunId,
  scaffoldId: ScaffoldId,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  directoryName: ScaffoldDirectoryName,
  /** The command the host composed, recorded so the run can be read back. */
  argv: Schema.NonEmptyArray(ScaffoldArgvToken).pipe(Schema.filter((argv) => argv.length <= 32)),
  startedAt: UtcTimestamp,
  completedAt: UtcTimestamp,
  exitCode: Schema.NullOr(Schema.Int),
  termination: Schema.Literal("exited", "cancelled", "timed-out", "unavailable"),
  output: ScaffoldOutput,
  outputTruncated: Schema.Boolean,
  outcome: Schema.Literal("created", "failed", "cancelled", "unavailable"),
})
  .annotations(strict)
  .pipe(
    // A scaffold that never exited cleanly cannot have created anything, and
    // saying it did is how a half-written directory gets treated as a project.
    Schema.filter((run) => run.outcome !== "created" || run.exitCode === 0),
  );
export type ScaffoldRun = typeof ScaffoldRun.Type;

export const decodeScaffoldId = Schema.decodeUnknownSync(ScaffoldId);
export const decodeScaffoldRunId = Schema.decodeUnknownSync(ScaffoldRunId);
export const decodeScaffoldEntry = Schema.decodeUnknownSync(ScaffoldEntry);
export const decodeScaffoldCatalogListing = Schema.decodeUnknownSync(ScaffoldCatalogListing);
export const decodeScaffoldRun = Schema.decodeUnknownSync(ScaffoldRun);
