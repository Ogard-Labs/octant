import type {
  AppleBuildEvidence,
  AppleBuildRequest,
  ApplePlatform,
  AppleSimulatorRequest,
  AppleSimulatorRecord,
  AppleToolchainDiscovery,
  ToolActionAuthority,
} from "@octant/contracts";
import type { CodeCheckoutId, CodeThreadId, ProviderExecutionPolicy } from "@octant/contracts";
import { sameToolActionAuthority } from "@octant/contracts";
import { decidesCodeEffectsByApproval } from "./codePolicy";

export type AppleToolchainPolicyDecision =
  | { readonly kind: "allowed" }
  | { readonly kind: "denied"; readonly reason: string };

export interface AppleExecutionScope {
  readonly authority: ToolActionAuthority;
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly approvalValid: boolean;
}

const SIMULATOR_INPUT_KINDS = new Set(["tap", "type-text", "key-press"]);

export function isAppleSimulatorInputKind(
  kind: AppleSimulatorRequest["kind"] | AppleBuildEvidence["kind"],
): boolean {
  return SIMULATOR_INPUT_KINDS.has(kind);
}

export function evaluateAppleBuildRequest(
  request: AppleBuildRequest,
  toolchain: AppleToolchainDiscovery,
  scope: AppleExecutionScope,
  simulators: ReadonlyArray<AppleSimulatorRecord> = [],
): AppleToolchainPolicyDecision {
  const scoped = evaluateScope(request, scope, true);
  if (scoped.kind === "denied") return scoped;
  if (!toolchain.available) {
    return { kind: "denied", reason: "toolchain-unavailable" };
  }
  if (
    request.platform !== "macos" &&
    (request.kind === "run" || request.kind === "test" || request.simulatorId !== undefined)
  ) {
    const simulator = simulators.find((candidate) => candidate.simulatorId === request.simulatorId);
    if (simulator === undefined || simulator.platform !== request.platform) {
      return { kind: "denied", reason: "invalid-destination" };
    }
    if (simulator.state === "unavailable") {
      return { kind: "denied", reason: "destination-unavailable" };
    }
  }
  if (request.kind === "archive" && request.platform !== "macos" && request.platform !== "ios") {
    return { kind: "denied", reason: "Archive is only supported for macOS and iOS platforms." };
  }
  return { kind: "allowed" };
}

export function evaluateAppleSimulatorRequest(
  request: AppleSimulatorRequest,
  scope: AppleExecutionScope,
  simulators: ReadonlyArray<AppleSimulatorRecord>,
): AppleToolchainPolicyDecision {
  // Reading a running Simulator's logs or its screen changes nothing, so both
  // stay available under a read-only posture. Booting, shutting down,
  // terminating an app, and injecting tap/text/keys do change it, and go
  // through approval like any other Code effect.
  const readOnly = request.kind === "logs" || request.kind === "screenshot";
  const scoped = evaluateScope(request, scope, !readOnly);
  if (scoped.kind === "denied") return scoped;
  if (isAppleSimulatorInputKind(request.kind) && request.requestedBy === undefined) {
    return { kind: "denied", reason: "actor-required" };
  }
  const simulator = simulators.find((candidate) => candidate.simulatorId === request.simulatorId);
  if (simulator === undefined) return { kind: "denied", reason: "invalid-destination" };
  if (simulator.state === "unavailable") {
    return { kind: "denied", reason: "destination-unavailable" };
  }
  if (request.kind === "boot" && simulator.state !== "shutdown") {
    return { kind: "denied", reason: "destination-not-shutdown" };
  }
  if (
    (request.kind === "shutdown" ||
      request.kind === "terminate" ||
      request.kind === "logs" ||
      request.kind === "screenshot" ||
      isAppleSimulatorInputKind(request.kind)) &&
    simulator.state !== "booted"
  ) {
    return { kind: "denied", reason: "destination-not-booted" };
  }
  return { kind: "allowed" };
}

function evaluateScope(
  request: Pick<
    AppleBuildRequest | AppleSimulatorRequest,
    "approval" | "authority" | "checkoutId" | "threadId"
  >,
  scope: AppleExecutionScope,
  sideEffect: boolean,
): AppleToolchainPolicyDecision {
  if (request.authority.extension.kind !== "core") {
    return { kind: "denied", reason: "core-capability-required" };
  }
  if (request.authority.mode !== "code") return { kind: "denied", reason: "code-mode-required" };
  if (!sameToolActionAuthority(request.authority, scope.authority)) {
    return { kind: "denied", reason: "authority-mismatch" };
  }
  if (request.threadId !== scope.threadId) return { kind: "denied", reason: "thread-mismatch" };
  if (request.checkoutId !== scope.checkoutId) {
    return { kind: "denied", reason: "checkout-mismatch" };
  }
  if (sideEffect && scope.executionPolicy === "plan") {
    return { kind: "denied", reason: "read-only-policy" };
  }
  if (
    sideEffect &&
    decidesCodeEffectsByApproval(scope.executionPolicy) &&
    (request.approval.kind !== "approved" || !scope.approvalValid)
  ) {
    return { kind: "denied", reason: "approval-required" };
  }
  if (request.approval.kind === "denied") return { kind: "denied", reason: "approval-denied" };
  return { kind: "allowed" };
}

export function canUseSimulator(simulator: AppleSimulatorRecord, platform: ApplePlatform): boolean {
  if (simulator.platform !== platform) return false;
  if (simulator.state === "unavailable") return false;
  return true;
}

export function isSimulatorReady(simulator: AppleSimulatorRecord): boolean {
  return simulator.state === "booted";
}

export function canRecordAppleBuildEvidence(
  evidence: AppleBuildEvidence,
  request: AppleBuildRequest,
): boolean {
  return (
    evidence.actionId === request.actionId &&
    evidence.correlationId === request.correlationId &&
    sameToolActionAuthority(evidence.authority, request.authority) &&
    evidence.kind === request.kind
  );
}

export function requiresSimulatorForAction(
  kind: "build" | "test" | "run" | "clean" | "archive",
  platform: ApplePlatform,
): boolean {
  if (platform === "macos") return false;
  return kind === "run" || kind === "test";
}

export function isCoreAppleCapability(): boolean {
  return true;
}

/** Returns whether the toolchain can build for any Apple platform.
 *  On macOS a single Xcode install supports all 5 platforms (iOS, macOS,
 *  watchOS, tvOS, visionOS), so platform filtering is unnecessary at the
 *  policy level. Platform-specific SDK availability is checked by the
 *  adapter at build time. */
export function isToolchainAvailable(toolchain: AppleToolchainDiscovery): boolean {
  return toolchain.available;
}

/**
 * Typed text must never land in durable diagnostics. Length and kind stay so
 * evidence still shows that an input ran; the characters do not.
 */
export function redactedAppleInputDiagnostic(
  request: Pick<AppleSimulatorRequest, "kind" | "text" | "key" | "target" | "point">,
): { readonly severity: "note"; readonly message: string } {
  if (request.kind === "type-text") {
    const length = request.text?.length ?? 0;
    return {
      severity: "note",
      message: `type-text completed (length=${length}; redacted)`,
    };
  }
  if (request.kind === "key-press") {
    return {
      severity: "note",
      message: `key-press completed (key=${request.key ?? "unknown"})`,
    };
  }
  if (request.target !== undefined) {
    return {
      severity: "note",
      message: `tap completed (target=${request.target})`,
    };
  }
  if (request.point !== undefined) {
    return {
      severity: "note",
      message: `tap completed (x=${request.point.x}, y=${request.point.y})`,
    };
  }
  return { severity: "note", message: `${request.kind} completed` };
}
