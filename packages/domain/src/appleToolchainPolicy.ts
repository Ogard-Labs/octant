import type {
  AppleBuildEvidence,
  AppleBuildRequest,
  AppleBundleIdentifier,
  AppleDeviceId,
  AppleDeviceLease,
  AppleDeviceRecord,
  AppleDeviceRefusalReason,
  AppleDeviceRequest,
  AppleDeviceToolingOperation,
  AppleEvidenceReference,
  ApplePlatform,
  AppleRuntimeSnapshot,
  AppleSimulatorRecord,
  AppleSimulatorRequest,
  AppleToolchainDiscovery,
  EventActor,
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
  /**
   * The host holds this thread's Simulator open to input (0142, 0152). Input is
   * then allowed without a one-shot approval on the request; Allow input is
   * what opened the grant. The pane sends none for clicks, because it only
   * ever learns of the grant, and cannot make one.
   */
  readonly inputGranted?: boolean;
}

// Repair input rides the same grant as a tap: it is input to the device a
// person already allowed, sent only when that person asks for it.
const SIMULATOR_INPUT_KINDS = new Set(["tap", "swipe", "type-text", "key-press", "repair-input"]);

/**
 * How long one approved Allow input keeps a Simulator open to further input
 * on its thread. Confirming every tap made the live device unusable, so an
 * approval covers the Simulator for this long after each delivered input
 * instead of covering one action.
 */
export const APPLE_INPUT_GRANT_MS = 15 * 60_000;

/** Whether the host's snapshot says this Simulator is open to input right now. */
export function appleInputGrantIsLive(
  snapshot: Pick<AppleRuntimeSnapshot, "inputGrants"> | undefined,
  simulatorId: string,
  nowMs: number,
): boolean {
  return (snapshot?.inputGrants ?? []).some(
    (grant) => String(grant.simulatorId) === simulatorId && Date.parse(grant.expiresAt) > nowMs,
  );
}

export function isAppleSimulatorInputKind(
  kind: AppleSimulatorRequest["kind"] | AppleBuildEvidence["kind"],
): boolean {
  return SIMULATOR_INPUT_KINDS.has(kind);
}

/** Whether this action is the confirmation that opens a destination to input. */
export function isAppleSimulatorOpenInputKind(
  kind: AppleSimulatorRequest["kind"] | AppleBuildEvidence["kind"],
): boolean {
  return kind === "open-input";
}

/** Whether a succeeded, approved action should open or renew the input grant. */
export function appleActionOpensInputGrant(
  kind: AppleSimulatorRequest["kind"] | AppleBuildEvidence["kind"],
): boolean {
  return isAppleSimulatorInputKind(kind) || isAppleSimulatorOpenInputKind(kind);
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

export function isAppleScreenRecordingKind(kind: AppleSimulatorRequest["kind"]): boolean {
  return kind === "start-recording" || kind === "stop-recording";
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
  // Stopping a recording ends what a person already approved starting, so it
  // never asks again; starting one writes the screen to disk and does.
  const readOnly =
    request.kind === "logs" || request.kind === "screenshot" || request.kind === "stop-recording";
  const scoped = evaluateScope(
    request,
    scope,
    !readOnly,
    isAppleSimulatorInputKind(request.kind) && scope.inputGranted === true,
  );
  if (scoped.kind === "denied") return scoped;
  if (
    (isAppleSimulatorInputKind(request.kind) ||
      isAppleSimulatorOpenInputKind(request.kind) ||
      request.kind === "open-url" ||
      request.kind === "rotate" ||
      isAppleScreenRecordingKind(request.kind)) &&
    request.requestedBy === undefined
  ) {
    return { kind: "denied", reason: "actor-required" };
  }
  // Repairing input restarts the Simulator's home screen and closes its apps,
  // and Open URL, Rotate and screen recording are offered only in the pane.
  // Only a person may ask for any of them; an agent or the host never does it
  // for them.
  if (
    (request.kind === "repair-input" ||
      request.kind === "open-url" ||
      request.kind === "rotate" ||
      isAppleScreenRecordingKind(request.kind)) &&
    request.requestedBy?.kind !== "local-user" &&
    request.requestedBy?.kind !== "remote-device"
  ) {
    return { kind: "denied", reason: "person-required" };
  }
  if (request.kind === "open-url" && request.url === undefined) {
    return { kind: "denied", reason: "url-required" };
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
      request.kind === "open-url" ||
      request.kind === "start-recording" ||
      request.kind === "rotate" ||
      isAppleSimulatorInputKind(request.kind) ||
      isAppleSimulatorOpenInputKind(request.kind)) &&
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
  coveredByGrant = false,
): AppleToolchainPolicyDecision {
  const identity = evaluateIdentity(request, scope);
  if (identity.kind === "denied") return identity;
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
  return { kind: "allowed" };
}

function evaluateIdentity(
  request: Pick<
    AppleBuildRequest | AppleSimulatorRequest | AppleDeviceRequest,
    "authority" | "checkoutId" | "threadId"
  >,
  scope: Pick<AppleExecutionScope, "authority" | "checkoutId" | "threadId">,
): AppleDevicePolicyDecision {
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
  return { kind: "allowed" };
}

export type AppleDevicePolicyDecision =
  | { readonly kind: "allowed" }
  | { readonly kind: "denied"; readonly reason: AppleDeviceRefusalReason };

export interface AppleDeviceExecutionScope {
  readonly authority: ToolActionAuthority;
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  readonly executionPolicy: ProviderExecutionPolicy;
  /** The host validated this request's one-use approval receipt. */
  readonly approvalValid: boolean;
  /**
   * Who answered that approval, from the host's receipt. A lease, an
   * uninstall, and an upload count only when a person at the Mac answered.
   */
  readonly approvedBy?: EventActor;
}

/** What the host knows about its device layer when the request arrives. */
export interface AppleDeviceHost {
  /** Only a macOS host lends a device layer; nothing stands in for one. */
  readonly macos: boolean;
  readonly toolchain: Pick<AppleToolchainDiscovery, "available">;
  readonly tooling: ReadonlyArray<AppleDeviceToolingOperation>;
  readonly devices: ReadonlyArray<AppleDeviceRecord>;
  readonly leases: ReadonlyArray<AppleDeviceLease>;
  /**
   * Whether the Current Release Boundary admits distribution. Decision 7 of
   * the design keeps it closed until a maintainer request and a boundary
   * change land in their own PR, so every upload is refused until then.
   */
  readonly distributionEnabled: boolean;
}

export interface AppleDeviceBundle {
  readonly deviceId: AppleDeviceId;
  readonly bundleIdentifier: AppleBundleIdentifier;
}

/** What this thread's own work produced, installed, and launched, as the host recorded it. */
export interface AppleDeviceThreadHoldings {
  readonly builtProducts: ReadonlyArray<AppleEvidenceReference>;
  readonly installed: ReadonlyArray<AppleDeviceBundle>;
  readonly launched: ReadonlyArray<AppleDeviceBundle>;
}

type AppleDeviceKind = AppleDeviceRequest["kind"];

const DEVICE_TOOLING: Readonly<
  Record<AppleDeviceKind, ReadonlyArray<AppleDeviceToolingOperation>>
> = {
  discover: ["list-devices"],
  status: ["list-devices"],
  "use-device": [],
  "release-device": [],
  screenshot: ["screenshot"],
  logs: ["console-logs"],
  build: [],
  run: ["install-app", "launch-app"],
  install: ["install-app"],
  launch: ["launch-app"],
  terminate: ["terminate-process"],
  uninstall: ["uninstall-app"],
  "provisioning-update": [],
  upload: [],
};

// Effects a thread's posture decides, one approval per request.
const DEVICE_EFFECT_KINDS: ReadonlySet<AppleDeviceKind> = new Set([
  "build",
  "run",
  "install",
  "launch",
  "terminate",
]);

// Operations that reach the device itself and so need it able to answer.
// A build signs for the device but does not touch it.
const DEVICE_REACHING_KINDS: ReadonlySet<AppleDeviceKind> = new Set([
  "screenshot",
  "logs",
  "run",
  "install",
  "launch",
  "terminate",
  "uninstall",
]);

const deviceAllowed: AppleDevicePolicyDecision = { kind: "allowed" };
const deviceDenied = (reason: AppleDeviceRefusalReason): AppleDevicePolicyDecision => ({
  kind: "denied",
  reason,
});

/**
 * Authority for a physical Apple device, distribution included
 * (docs/design/apple-devices.md). A Simulator grant, the thread's Full
 * access, and a device lease never stand in for one another: a lease starts,
 * moves, and an uninstall or upload runs only on a confirmation a person at
 * the Mac answered, under every posture. Every check that can refuse without
 * asking runs first, so nobody is asked to approve a call that would then be
 * refused.
 */
export function evaluateAppleDeviceRequest(
  request: AppleDeviceRequest,
  scope: AppleDeviceExecutionScope,
  host: AppleDeviceHost,
  holdings: AppleDeviceThreadHoldings,
): AppleDevicePolicyDecision {
  const identity = evaluateIdentity(request, scope);
  if (identity.kind === "denied") return identity;
  const actor = request.requestedBy;
  if (actor.kind === "agent" && String(actor.threadId) !== String(request.threadId)) {
    return deviceDenied("thread-mismatch");
  }
  if (!host.macos || !host.toolchain.available) return deviceDenied("toolchain-unavailable");
  // Octant never passes -allowProvisioningUpdates: it mutates the person's
  // developer account, so no posture, actor, or approval reaches it.
  if (request.kind === "provisioning-update") {
    return deviceDenied("provisioning-updates-not-offered");
  }
  if (request.kind === "upload" && !host.distributionEnabled) {
    return deviceDenied("distribution-not-enabled");
  }
  // Remote clients observe only; widening later is cheaper than narrowing.
  if (actor.kind === "remote-device" && request.kind !== "discover" && request.kind !== "status") {
    return deviceDenied("local-person-required");
  }
  if (
    (request.kind === "uninstall" ||
      request.kind === "upload" ||
      request.fromThreadId !== undefined) &&
    actor.kind !== "local-user"
  ) {
    return deviceDenied("person-required");
  }
  if (
    scope.executionPolicy === "plan" &&
    (DEVICE_EFFECT_KINDS.has(request.kind) ||
      request.kind === "uninstall" ||
      request.kind === "upload")
  ) {
    return deviceDenied("read-only-policy");
  }
  if (request.approval.kind === "denied") return deviceDenied("approval-denied");
  if (DEVICE_TOOLING[request.kind].some((operation) => !host.tooling.includes(operation))) {
    return deviceDenied("operation-unavailable");
  }
  if (request.kind === "upload") return confirmedByLocalPerson(request, scope);
  if (request.kind === "discover") return deviceAllowed;

  const device = host.devices.find(
    (candidate) => String(candidate.deviceId) === String(request.deviceId),
  );
  if (device === undefined) return deviceDenied("invalid-destination");
  if (request.kind === "status") return deviceAllowed;
  const lease = host.leases.find(
    (candidate) => String(candidate.deviceId) === String(device.deviceId),
  );
  if (request.kind === "use-device") return evaluateLeaseStart(request, scope, device, lease);

  if (lease === undefined || !leaseBelongsTo(lease, request)) {
    // Another thread's lease is refused without naming that thread.
    return deviceDenied(
      lease !== undefined && String(lease.threadId) !== String(request.threadId)
        ? "destination-leased"
        : "lease-required",
    );
  }
  if (request.kind === "release-device") return deviceAllowed;
  if (DEVICE_REACHING_KINDS.has(request.kind) && device.state !== "connected") {
    return deviceDenied(device.state);
  }
  const owned = evaluateThreadOwnership(request, holdings);
  if (owned.kind === "denied") return owned;
  if (request.kind === "uninstall") return confirmedByLocalPerson(request, scope);
  if (
    DEVICE_EFFECT_KINDS.has(request.kind) &&
    decidesCodeEffectsByApproval(scope.executionPolicy) &&
    (request.approval.kind !== "approved" || !scope.approvalValid)
  ) {
    return deviceDenied("approval-required");
  }
  return deviceAllowed;
}

function leaseBelongsTo(
  lease: AppleDeviceLease,
  request: Pick<AppleDeviceRequest, "threadId" | "checkoutId">,
): boolean {
  return (
    String(lease.threadId) === String(request.threadId) &&
    String(lease.checkoutId) === String(request.checkoutId)
  );
}

function evaluateLeaseStart(
  request: AppleDeviceRequest,
  scope: AppleDeviceExecutionScope,
  device: AppleDeviceRecord,
  lease: AppleDeviceLease | undefined,
): AppleDevicePolicyDecision {
  if (device.state === "unavailable") return deviceDenied("unavailable");
  if (request.fromThreadId !== undefined) {
    // The person confirmed moving the lease from the thread they were shown;
    // if it changed hands since, that confirmation no longer describes it.
    if (
      lease === undefined ||
      String(lease.threadId) !== String(request.fromThreadId) ||
      String(lease.threadId) === String(request.threadId)
    ) {
      return deviceDenied("lease-changed");
    }
    return confirmedByLocalPerson(request, scope);
  }
  if (lease !== undefined) {
    return leaseBelongsTo(lease, request) ? deviceAllowed : deviceDenied("destination-leased");
  }
  return confirmedByLocalPerson(request, scope);
}

function evaluateThreadOwnership(
  request: AppleDeviceRequest,
  holdings: AppleDeviceThreadHoldings,
): AppleDevicePolicyDecision {
  if (request.kind === "install") {
    const artifact = request.artifact;
    return artifact !== undefined && holdings.builtProducts.includes(artifact)
      ? deviceAllowed
      : deviceDenied("invalid-artifact");
  }
  if (
    request.kind !== "launch" &&
    request.kind !== "terminate" &&
    request.kind !== "uninstall" &&
    request.kind !== "logs"
  ) {
    return deviceAllowed;
  }
  const sameBundle = (held: AppleDeviceBundle) =>
    String(held.deviceId) === String(request.deviceId) &&
    held.bundleIdentifier === request.bundleIdentifier;
  if (!holdings.installed.some(sameBundle)) return deviceDenied("foreign-bundle");
  // Octant stops and reads only the process it launched, never one by name.
  if (
    (request.kind === "terminate" || request.kind === "logs") &&
    !holdings.launched.some(sameBundle)
  ) {
    return deviceDenied("process-not-owned");
  }
  return deviceAllowed;
}

function confirmedByLocalPerson(
  request: Pick<AppleDeviceRequest, "approval">,
  scope: AppleDeviceExecutionScope,
): AppleDevicePolicyDecision {
  if (
    request.approval.kind !== "approved" ||
    !scope.approvalValid ||
    scope.approvedBy === undefined
  ) {
    return deviceDenied("confirmation-required");
  }
  if (scope.approvedBy.kind !== "local-user") return deviceDenied("local-person-required");
  return deviceAllowed;
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
  request: Pick<AppleSimulatorRequest, "kind" | "text" | "key" | "target" | "point" | "toPoint">,
): { readonly severity: "note"; readonly message: string } {
  if (request.kind === "swipe" && request.point !== undefined && request.toPoint !== undefined) {
    return {
      severity: "note",
      message: `swipe completed (x=${request.point.x}, y=${request.point.y} to x=${request.toPoint.x}, y=${request.toPoint.y})`,
    };
  }
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

/**
 * Evidence for Open URL keeps the address's origin only. Its path and query
 * can carry tokens or personal data, so, like typed text, they are shown in
 * the confirmation and never recorded.
 */
export function deviceOpenUrlDiagnostic(
  url: string | undefined,
  outcome: string,
): { readonly severity: "note"; readonly message: string } {
  let origin = "unknown origin";
  try {
    if (url !== undefined) origin = new URL(url).origin;
  } catch {
    // The contract only admits parseable addresses; nothing else to keep.
  }
  return {
    severity: "note",
    message: `open-url ${outcome} (${origin}; path and query not recorded)`,
  };
}

export function redactedAppleOpenInputDiagnostic(): {
  readonly severity: "note";
  readonly message: string;
} {
  return { severity: "note", message: "Input is allowed to this Simulator." };
}
