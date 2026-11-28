import { Schema } from "effect";
import { NonEmptyTrimmedString, NonNegativeInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { UtcTimestamp } from "./events";
import { HostId } from "./host";
import { ProviderDriverKind, ProviderInstanceId } from "./providers";

// ── Discovery readiness ─────────────────────────────────────────────────────

export const DiscoveryReadiness = Schema.Literals([
  "ready",
  "unauthenticated",
  "incompatible",
  "unavailable",
  "unknown",
]);
export type DiscoveryReadiness = typeof DiscoveryReadiness.Type;

// ── Discovery candidate ─────────────────────────────────────────────────────

const SafePathSummary = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(512));
const AbsolutePath = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.makeFilter((path) => path.startsWith("/")),
);
const CanonicalBinaryPath = AbsolutePath;
const DetectedVersion = Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(128));
const PickerReceiptId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/));

export const DiscoveryCandidate = Schema.Struct({
  driverKind: ProviderDriverKind,
  displayName: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
  binaryPath: CanonicalBinaryPath,
  /**
   * The path the scan actually examined when it differs from the canonical
   * `binaryPath`. A Homebrew `bin/codex` symlink is the path a user configures
   * on an instance, while `binaryPath` is the realpath the symlink resolves to;
   * detection compares both so an installed provider is not reported missing.
   */
  discoveredPath: Schema.optional(CanonicalBinaryPath),
  version: Schema.optional(DetectedVersion),
  readiness: DiscoveryReadiness,
  pathSummary: SafePathSummary,
  onboardingGuidance: Schema.optional(
    Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1024)),
  ),
  detectedAt: UtcTimestamp,
});
export type DiscoveryCandidate = typeof DiscoveryCandidate.Type;

// ── Discovery scan status ───────────────────────────────────────────────────

export const DiscoveryScanStatus = Schema.Literals(["completed", "partial", "cancelled", "failed"]);
export type DiscoveryScanStatus = typeof DiscoveryScanStatus.Type;

// ── Discovery snapshot ──────────────────────────────────────────────────────

export const DiscoveryDriverDirectoryCoverage = Schema.Struct({
  driverKind: ProviderDriverKind,
  directories: Schema.Array(AbsolutePath),
});
export type DiscoveryDriverDirectoryCoverage = typeof DiscoveryDriverDirectoryCoverage.Type;

export const DiscoverySnapshot = Schema.Struct({
  hostId: HostId,
  candidates: Schema.Array(DiscoveryCandidate).check(
    Schema.makeFilter((candidates) => candidates.length <= 64),
  ),
  scannedAt: UtcTimestamp,
  scanDurationMs: NonNegativeInt,
  status: DiscoveryScanStatus,
  message: Schema.optional(Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(1024))),
  /**
   * Directories each driver scan actually examined. A configured binary is
   * absent only when its driverKind was scanned and its parent directory
   * appears in that driver's coverage. Old snapshots omit the field.
   */
  searchedDirectories: Schema.optional(Schema.Array(DiscoveryDriverDirectoryCoverage)),
  /**
   * Instances auto-registered by this scan. This records what the scan created,
   * not current presence — `candidates` is the evidence a runtime is installed.
   */
  autoRegisteredInstanceIds: Schema.optional(Schema.Array(ProviderInstanceId)),
  /**
   * The Claude gateway this host's own environment names in
   * `ANTHROPIC_BASE_URL`, offered to prefill a new gateway account's address.
   * Only the address crosses, and only one the host would accept for a
   * gateway account; a token never does. `tokenVariable` says whether
   * `ANTHROPIC_AUTH_TOKEN` is set, so Settings can say a token is still to
   * be entered. Absent when the variable is unset or not an address Octant
   * accepts.
   */
  claudeHostGateway: Schema.optional(
    Schema.Struct({
      baseUrl: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2048)),
      tokenVariable: Schema.Boolean,
    }),
  ),
});
export type DiscoverySnapshot = typeof DiscoverySnapshot.Type;

// ── Discovery commands ──────────────────────────────────────────────────────

export const DiscoveryCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("scan"),
  }),
  Schema.Struct({
    kind: Schema.Literal("connect"),
    driverKind: ProviderDriverKind,
    binaryPath: CanonicalBinaryPath,
    displayName: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(255)),
  }),
  Schema.Struct({
    kind: Schema.Literal("locate-binary"),
    instanceId: ProviderInstanceId,
    receiptId: PickerReceiptId,
  }),
  Schema.Struct({
    kind: Schema.Literal("locate-binary"),
    instanceId: ProviderInstanceId,
    scannedBinaryPath: CanonicalBinaryPath,
  }),
]);
export type DiscoveryCommand = typeof DiscoveryCommand.Type;

export const DiscoveryCommandResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("scan-completed"),
    snapshot: DiscoverySnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("candidate-connected"),
    instanceId: ProviderInstanceId,
  }),
  Schema.Struct({
    kind: Schema.Literal("binary-located"),
    instanceId: ProviderInstanceId,
    /** The first line the version probe printed. */
    version: DetectedVersion,
  }),
]);
export type DiscoveryCommandResult = typeof DiscoveryCommandResult.Type;

export const DiscoveryFailure = Schema.Union([
  Schema.Struct({
    category: Schema.Literal("invalid-configuration"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("unauthorized"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("unavailable"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("unsupported"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("unknown-candidate"),
    message: NonEmptyTrimmedString,
  }),
]);
export type DiscoveryFailure = typeof DiscoveryFailure.Type;

export const decodeDiscoveryReadiness = Schema.decodeUnknownSync(
  DiscoveryReadiness,
  STRICT_DECODE_OPTIONS,
);
export const decodeDiscoveryCandidate = Schema.decodeUnknownSync(
  DiscoveryCandidate,
  STRICT_DECODE_OPTIONS,
);
export const decodeDiscoveryScanStatus = Schema.decodeUnknownSync(
  DiscoveryScanStatus,
  STRICT_DECODE_OPTIONS,
);
export const decodeDiscoverySnapshot = Schema.decodeUnknownSync(
  DiscoverySnapshot,
  STRICT_DECODE_OPTIONS,
);
export const decodeDiscoveryCommand = Schema.decodeUnknownSync(
  DiscoveryCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeDiscoveryCommandResult = Schema.decodeUnknownSync(
  DiscoveryCommandResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeDiscoveryFailure = Schema.decodeUnknownSync(
  DiscoveryFailure,
  STRICT_DECODE_OPTIONS,
);
