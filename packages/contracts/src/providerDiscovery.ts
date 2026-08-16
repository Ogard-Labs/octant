import { Schema } from "effect";
import { UtcTimestamp } from "./events";
import { HostId } from "./host";
import { ProviderDriverKind, ProviderInstanceId } from "./providers";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

// ── Discovery readiness ─────────────────────────────────────────────────────

export const DiscoveryReadiness = Schema.Literal(
  "ready",
  "unauthenticated",
  "incompatible",
  "unavailable",
  "unknown",
);
export type DiscoveryReadiness = typeof DiscoveryReadiness.Type;

// ── Discovery candidate ─────────────────────────────────────────────────────

const SafePathSummary = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512));
const CanonicalBinaryPath = Schema.NonEmptyTrimmedString.pipe(
  Schema.filter((path) => path.startsWith("/")),
);
const DetectedVersion = Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(128));

export const DiscoveryCandidate = Schema.Struct({
  driverKind: ProviderDriverKind,
  displayName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  binaryPath: CanonicalBinaryPath,
  version: Schema.optional(DetectedVersion),
  readiness: DiscoveryReadiness,
  pathSummary: SafePathSummary,
  onboardingGuidance: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024))),
  detectedAt: UtcTimestamp,
}).annotations(strict);
export type DiscoveryCandidate = typeof DiscoveryCandidate.Type;

// ── Discovery scan status ───────────────────────────────────────────────────

export const DiscoveryScanStatus = Schema.Literal("completed", "partial", "cancelled", "failed");
export type DiscoveryScanStatus = typeof DiscoveryScanStatus.Type;

// ── Discovery snapshot ──────────────────────────────────────────────────────

export const DiscoverySnapshot = Schema.Struct({
  hostId: HostId,
  candidates: Schema.Array(DiscoveryCandidate).pipe(
    Schema.filter((candidates) => candidates.length <= 64),
  ),
  scannedAt: UtcTimestamp,
  scanDurationMs: Schema.Int.pipe(Schema.nonNegative()),
  status: DiscoveryScanStatus,
  message: Schema.optional(Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(1024))),
  autoRegisteredInstanceIds: Schema.optional(Schema.Array(ProviderInstanceId)),
}).annotations(strict);
export type DiscoverySnapshot = typeof DiscoverySnapshot.Type;

// ── Discovery commands ──────────────────────────────────────────────────────

export const DiscoveryCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("scan"),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("connect"),
    driverKind: ProviderDriverKind,
    binaryPath: CanonicalBinaryPath,
    displayName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(255)),
  }).annotations(strict),
);
export type DiscoveryCommand = typeof DiscoveryCommand.Type;

export const DiscoveryCommandResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("scan-completed"),
    snapshot: DiscoverySnapshot,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("candidate-connected"),
    instanceId: ProviderInstanceId,
  }).annotations(strict),
);
export type DiscoveryCommandResult = typeof DiscoveryCommandResult.Type;

export const DiscoveryFailure = Schema.Union(
  Schema.Struct({
    category: Schema.Literal("invalid-configuration"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("unauthorized"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("unavailable"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("unsupported"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("unknown-candidate"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
).annotations(strict);
export type DiscoveryFailure = typeof DiscoveryFailure.Type;

export const decodeDiscoveryReadiness = Schema.decodeUnknownSync(DiscoveryReadiness);
export const decodeDiscoveryCandidate = Schema.decodeUnknownSync(DiscoveryCandidate);
export const decodeDiscoveryScanStatus = Schema.decodeUnknownSync(DiscoveryScanStatus);
export const decodeDiscoverySnapshot = Schema.decodeUnknownSync(DiscoverySnapshot);
export const decodeDiscoveryCommand = Schema.decodeUnknownSync(DiscoveryCommand);
export const decodeDiscoveryCommandResult = Schema.decodeUnknownSync(DiscoveryCommandResult);
export const decodeDiscoveryFailure = Schema.decodeUnknownSync(DiscoveryFailure);
