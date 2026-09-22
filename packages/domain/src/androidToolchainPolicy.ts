import type {
  AndroidEmulatorRecord,
  AndroidEmulatorRequest,
  AndroidRuntimeSnapshot,
  AndroidSdkDiscovery,
  ToolActionAuthority,
} from "@octant/contracts";
import type { CodeCheckoutId, CodeThreadId, ProviderExecutionPolicy } from "@octant/contracts";
import { sameToolActionAuthority } from "@octant/contracts";
import { decidesCodeEffectsByApproval } from "./codePolicy";
import { APPLE_INPUT_GRANT_MS } from "./appleToolchainPolicy";

export type AndroidToolchainPolicyDecision =
  | { readonly kind: "allowed" }
  | { readonly kind: "denied"; readonly reason: string };

export interface AndroidExecutionScope {
  readonly authority: ToolActionAuthority;
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  readonly executionPolicy: ProviderExecutionPolicy;
  readonly approvalValid: boolean;
  readonly inputGranted?: boolean;
}

const INPUT_KINDS = new Set(["tap", "swipe", "type-text", "key-press"]);

export const ANDROID_INPUT_GRANT_MS = APPLE_INPUT_GRANT_MS;

export function androidInputGrantIsLive(
  snapshot: Pick<AndroidRuntimeSnapshot, "inputGrants"> | undefined,
  emulatorId: string,
  nowMs: number,
): boolean {
  return (snapshot?.inputGrants ?? []).some(
    (grant) => String(grant.emulatorId) === emulatorId && Date.parse(grant.expiresAt) > nowMs,
  );
}

export function isAndroidEmulatorInputKind(kind: AndroidEmulatorRequest["kind"]): boolean {
  return INPUT_KINDS.has(kind);
}

export function isAndroidEmulatorOpenInputKind(kind: AndroidEmulatorRequest["kind"]): boolean {
  return kind === "open-input";
}

export function androidActionOpensInputGrant(kind: AndroidEmulatorRequest["kind"]): boolean {
  return isAndroidEmulatorInputKind(kind) || isAndroidEmulatorOpenInputKind(kind);
}

export function evaluateAndroidEmulatorRequest(
  request: AndroidEmulatorRequest,
  scope: AndroidExecutionScope,
  emulators: ReadonlyArray<AndroidEmulatorRecord>,
  sdk: AndroidSdkDiscovery,
): AndroidToolchainPolicyDecision {
  const readOnly = request.kind === "screenshot";
  const sideEffect = !readOnly;
  const coveredByGrant = isAndroidEmulatorInputKind(request.kind) && scope.inputGranted === true;
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
    !(coveredByGrant && scope.approvalValid) &&
    (request.approval.kind !== "approved" || !scope.approvalValid)
  ) {
    return { kind: "denied", reason: "approval-required" };
  }
  if (request.approval.kind === "denied") return { kind: "denied", reason: "approval-denied" };
  if (
    (isAndroidEmulatorInputKind(request.kind) || isAndroidEmulatorOpenInputKind(request.kind)) &&
    request.requestedBy === undefined
  ) {
    return { kind: "denied", reason: "actor-required" };
  }
  if (!sdk.available) return { kind: "denied", reason: "toolchain-unavailable" };
  const emulator = emulators.find((candidate) => candidate.emulatorId === request.emulatorId);
  if (emulator === undefined) return { kind: "denied", reason: "invalid-destination" };
  if (emulator.state === "unavailable") {
    return { kind: "denied", reason: "destination-unavailable" };
  }
  if (request.kind === "boot" && emulator.state !== "shutdown") {
    return { kind: "denied", reason: "destination-not-shutdown" };
  }
  if (
    (request.kind === "shutdown" ||
      request.kind === "screenshot" ||
      request.kind === "install" ||
      request.kind === "launch" ||
      isAndroidEmulatorInputKind(request.kind) ||
      isAndroidEmulatorOpenInputKind(request.kind)) &&
    emulator.state !== "booted"
  ) {
    return { kind: "denied", reason: "destination-not-booted" };
  }
  return { kind: "allowed" };
}

export function redactedAndroidInputDiagnostic(
  request: Pick<AndroidEmulatorRequest, "kind" | "text" | "key" | "point" | "toPoint">,
): { readonly severity: "note"; readonly message: string } {
  if (request.kind === "open-input") {
    return { severity: "note", message: "Input is allowed to this emulator." };
  }
  if (request.kind === "swipe" && request.point !== undefined && request.toPoint !== undefined) {
    return {
      severity: "note",
      message: `swipe completed (x=${request.point.x}, y=${request.point.y} to x=${request.toPoint.x}, y=${request.toPoint.y})`,
    };
  }
  if (request.kind === "type-text") {
    return {
      severity: "note",
      message: `type-text completed (length=${request.text?.length ?? 0}; redacted)`,
    };
  }
  if (request.kind === "key-press") {
    return { severity: "note", message: `key-press completed (key=${request.key ?? "unknown"})` };
  }
  if (request.point !== undefined) {
    return {
      severity: "note",
      message: `tap completed (x=${request.point.x}, y=${request.point.y})`,
    };
  }
  return { severity: "note", message: `${request.kind} completed` };
}
