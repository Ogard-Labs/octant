import { Schema } from "effect";
import { AppVersion } from "./appUpdates";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const productName = Schema.Literal("Octant Nightly");
const message = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(240));

export const NightlyInstallationApplication = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("absent") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("installed"),
    version: AppVersion,
    running: Schema.Boolean,
  }).annotations(strict),
);
export type NightlyInstallationApplication = typeof NightlyInstallationApplication.Type;

export const NightlyInstallationReason = Schema.Literal(
  "unsupported-platform",
  "unpackaged",
  "unsigned-build",
  "invalid-peer",
  "native-unavailable",
  "invalid-artifact",
  "incompatible-build",
  "not-installed",
  "already-installed",
  "running",
  "ambiguous-application",
  "unwritable-location",
  "busy",
  "cancelled",
  "deadline-exceeded",
  "closed",
  "unreachable",
  "malformed",
  "untrusted-signature",
  "wrong-ring",
  "wrong-platform",
  "corrupt-artifact",
  "owner-lost",
);
export type NightlyInstallationReason = typeof NightlyInstallationReason.Type;
export const NightlyInstallationOperation = Schema.Literal("install", "open", "remove");
export type NightlyInstallationOperation = typeof NightlyInstallationOperation.Type;
export const NightlyInstallationPhase = Schema.Literal(
  "checking",
  "downloading",
  "verifying",
  "installing",
  "opening",
  "removing",
  "cancelling",
);
export type NightlyInstallationPhase = typeof NightlyInstallationPhase.Type;

export const NightlyInstallationState = Schema.Union(
  Schema.Struct({ status: Schema.Literal("loading"), productName }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    productName,
    reason: NightlyInstallationReason,
    message,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("ready"),
    productName,
    application: NightlyInstallationApplication,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("working"),
    productName,
    application: NightlyInstallationApplication,
    operation: NightlyInstallationOperation,
    phase: NightlyInstallationPhase,
    cancellable: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("refused", "failed"),
    productName,
    application: NightlyInstallationApplication,
    reason: NightlyInstallationReason,
    message,
  }).annotations(strict),
);
export type NightlyInstallationState = typeof NightlyInstallationState.Type;
export const decodeNightlyInstallationState = Schema.decodeUnknownSync(NightlyInstallationState);
