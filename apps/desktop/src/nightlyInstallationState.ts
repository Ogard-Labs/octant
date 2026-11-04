import type {
  NightlyInstallationApplication,
  NightlyInstallationOperation,
  NightlyInstallationPhase,
  NightlyInstallationReason,
  NightlyInstallationState,
} from "@octant/contracts/nightly-installation";
import type { AppVersion } from "@octant/contracts/app-updates";

const REASONS: ReadonlyArray<NightlyInstallationReason> = [
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
];
const OPERATIONS: ReadonlyArray<NightlyInstallationOperation> = ["install", "open", "remove"];
const PHASES: ReadonlyArray<NightlyInstallationPhase> = [
  "checking",
  "downloading",
  "verifying",
  "installing",
  "opening",
  "removing",
  "cancelling",
];
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: ReadonlyArray<string>): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
function invalid(): never {
  throw new TypeError("Invalid Nightly installation state.");
}
function application(value: unknown): NightlyInstallationApplication {
  if (!record(value)) return invalid();
  if (value.kind === "absent" && keys(value, ["kind"])) return Object.freeze({ kind: "absent" });
  if (
    value.kind === "installed" &&
    keys(value, ["kind", "version", "running"]) &&
    typeof value.version === "string" &&
    value.version.length <= 64 &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]{1,64})?$/.test(value.version) &&
    typeof value.running === "boolean"
  )
    return Object.freeze({
      kind: "installed",
      version: value.version as AppVersion,
      running: value.running,
    });
  return invalid();
}
/** Sandboxed preload validation without pulling Effect or host code into the renderer bridge. */
export function decodeNightlyInstallationState(value: unknown): NightlyInstallationState {
  if (!record(value) || value.productName !== "Octant Nightly") return invalid();
  const productName = value.productName;
  if (value.status === "loading" && keys(value, ["status", "productName"]))
    return Object.freeze({ status: "loading", productName });
  if (value.status === "ready" && keys(value, ["status", "productName", "application"]))
    return Object.freeze({
      status: "ready",
      productName,
      application: application(value.application),
    });
  if (
    value.status === "working" &&
    keys(value, ["status", "productName", "application", "operation", "phase", "cancellable"]) &&
    typeof value.operation === "string" &&
    OPERATIONS.includes(value.operation as NightlyInstallationOperation) &&
    typeof value.phase === "string" &&
    PHASES.includes(value.phase as NightlyInstallationPhase) &&
    typeof value.cancellable === "boolean"
  )
    return Object.freeze({
      status: "working",
      productName,
      application: application(value.application),
      operation: value.operation as NightlyInstallationOperation,
      phase: value.phase as NightlyInstallationPhase,
      cancellable: value.cancellable,
    });
  if (
    (value.status === "refused" || value.status === "failed" || value.status === "unavailable") &&
    keys(
      value,
      value.status === "unavailable"
        ? ["status", "productName", "reason", "message"]
        : ["status", "productName", "application", "reason", "message"],
    ) &&
    typeof value.reason === "string" &&
    REASONS.includes(value.reason as NightlyInstallationReason) &&
    typeof value.message === "string" &&
    value.message.length > 0 &&
    value.message.length <= 240
  ) {
    const reason = value.reason as NightlyInstallationReason;
    const message = value.message;
    return Object.freeze(
      value.status === "unavailable"
        ? { status: "unavailable", productName, reason, message }
        : {
            status: value.status,
            productName,
            reason,
            message,
            application: application(value.application),
          },
    );
  }
  return invalid();
}
