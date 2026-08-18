import type { ProtocolRange } from "@octant/contracts/remote-access";

export const PAIRING_TICKET_TTL_MS = 5 * 60 * 1_000;
export const PAIRING_MAX_FAILED_ATTEMPTS = 5;
export const SESSION_IDLE_TTL_MS = 15 * 60 * 1_000;
export const SESSION_ABSOLUTE_TTL_MS = 12 * 60 * 60 * 1_000;
export const SESSION_ROTATION_INTERVAL_MS = 15 * 60 * 1_000;
export const REMOTE_REQUEST_CLOCK_SKEW_MS = 30 * 1_000;
export const DEVICE_INACTIVITY_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
export const DEVICE_ABSOLUTE_TTL_MS = 90 * 24 * 60 * 60 * 1_000;
export const DEVICE_LAST_SEEN_COARSEN_MS = 60 * 60 * 1_000;
export const REMOTE_DEVICE_SECURITY_FLOOR = 1;
export const DEVICE_LABEL_MAX_LENGTH = 128;

export type RemoteListenerAddressClass =
  | "loopback"
  | "lan-private"
  | "tailscale"
  | "public"
  | "invalid";

export function negotiateRemoteProtocol(input: {
  readonly server: ProtocolRange & { readonly securityFloor: number };
  readonly client: ProtocolRange & { readonly securityFloor: number };
}):
  | {
      readonly kind: "negotiated";
      readonly protocolVersion: number;
      readonly securityFloor: number;
    }
  | { readonly kind: "rejected"; readonly reason: "incompatible" | "security-floor" } {
  const minimum = Math.max(input.server.min, input.client.min);
  const maximum = Math.min(input.server.max, input.client.max);
  if (minimum > maximum) return { kind: "rejected", reason: "incompatible" };
  const securityFloor = Math.max(
    input.server.securityFloor,
    input.client.securityFloor,
    REMOTE_DEVICE_SECURITY_FLOOR,
  );
  if (securityFloor > maximum) return { kind: "rejected", reason: "security-floor" };
  return { kind: "negotiated", protocolVersion: maximum, securityFloor };
}

export function classifyRemoteListenerAddress(address: string): RemoteListenerAddressClass {
  const value = address.trim().toLowerCase();
  if (value === "" || value === "0.0.0.0" || value === "::") return "invalid";
  if (value === "127.0.0.1" || value === "::1" || value === "localhost") return "loopback";
  if (value.endsWith(".ts.net") || isTailscaleIpv4(value) || isTailscaleIpv6(value)) {
    return "tailscale";
  }
  if (isPrivateIpv4(value) || isPrivateIpv6(value)) return "lan-private";
  if (/^[a-z0-9.-]+$/.test(value) && !value.includes(".")) return "invalid";
  return "public";
}

export type RemoteActionDecision =
  | { readonly kind: "remote-approvable" }
  | { readonly kind: "local-host-required" }
  | { readonly kind: "rejected" };

const REMOTE_APPROVABLE_ACTIONS = new Set([
  "chat.send-turn",
  "chat.interrupt-turn",
  "work.create-artifact",
  "work.update-document",
  "code.create-thread",
  "code.plan-turn",
  // Local servers: a remote client may observe classified user/dev servers and
  // open one
  // through the existing Browser authority, and may stop a server Octant itself
  // owns under the ordinary owned-process rule.
  "code.local-servers.list",
  "code.local-servers.open",
  "code.local-servers.stop-owned",
  "project.overview.read",
  // Companion surfaces: a paired device may watch what the host is already
  // showing for a thread, and may act inside that view. Reading the browser's
  // observation, a simulator screenshot the Apple toolchain recorded, and a
  // terminal's output are all reads of state the host produced on its own.
  // `browser.interact` covers only gestures that land in the page the host
  // opened — pointing it elsewhere, typing into it, or opening and closing its
  // sessions are separate, host-only actions below.
  "browser.observe",
  "browser.interact",
  "simulator.observe",
  "terminal.read",
  "automation.manage",
  "preview.open-authorized",
  "settings.read-non-secret",
  "provider.list-models",
]);
const LOCAL_HOST_ACTIONS = new Set([
  "desktop.enable-listener",
  "desktop.disable-listener",
  "desktop.approve-device",
  "desktop.revoke-device",
  "desktop.revoke-all-devices",
  "desktop.rotate-host-key",
  "desktop.open-native-picker",
  "desktop.issue-local-approval",
  "desktop.bridge.invoke",
  "desktop.listener.configure",
  "desktop.device.rename",
  "provider.credentials.write",
  "provider.credentials.read",
  "extension.install",
  "extension.trust",
  "project.root.bind",
  "project.root.relink",
  "code.remember-full-access",
  "code.open-external-editor",
  // Local servers: stopping a leftover the user did not start through Octant
  // signals a
  // process outside Octant's ownership, so it stays on the host.
  "code.local-servers.stop-leftover",
  // Opening, navigating, closing, or typing into the host's browser is driving
  // the host rather than watching it, and terminal input runs commands there,
  // so both stay with the person at the machine.
  "browser.session.manage",
  "terminal.write",
  "host-key.rotate",
  "host.service.start",
  "host.service.stop",
  "host.service.restart",
  "host.service.enable",
  "host.service.disable",
  "host.service.status",
  "host.service.logs",
  "host.store.backup",
  "host.store.restore",
  "diagnostics.export",
]);

export function classifyRemoteAction(action: string): RemoteActionDecision {
  if (REMOTE_APPROVABLE_ACTIONS.has(action)) return { kind: "remote-approvable" };
  if (LOCAL_HOST_ACTIONS.has(action)) return { kind: "local-host-required" };
  return { kind: "rejected" };
}

export type PrincipalKind = "local-window" | "remote-device";

export type PrincipalActionDecision =
  | { readonly kind: "allow" }
  | {
      readonly kind: "deny";
      readonly reason:
        | "unknown-action"
        | "local-host-required"
        | "principal-laundering"
        | "remote-cannot-mint-local-receipt";
    };

/**
 * Principal-aware least-authority gate. Unknown actions fail closed. Remote
 * principals cannot become local-window or mint native/local receipts.
 */
export function authorizePrincipalAction(input: {
  readonly principalKind: PrincipalKind;
  readonly action: string;
  readonly requestedPrincipalKind?: PrincipalKind;
}): PrincipalActionDecision {
  if (
    input.requestedPrincipalKind !== undefined &&
    input.requestedPrincipalKind !== input.principalKind
  ) {
    return { kind: "deny", reason: "principal-laundering" };
  }

  // Explicit laundering / receipt-mint attempts.
  if (
    input.principalKind === "remote-device" &&
    (input.action === "desktop.issue-local-approval" ||
      input.action === "desktop.bridge.invoke" ||
      input.action === "principal.upgrade-to-local-window")
  ) {
    return { kind: "deny", reason: "remote-cannot-mint-local-receipt" };
  }

  const classification = classifyRemoteAction(input.action);
  if (classification.kind === "rejected") {
    return { kind: "deny", reason: "unknown-action" };
  }
  if (classification.kind === "local-host-required" && input.principalKind !== "local-window") {
    return { kind: "deny", reason: "local-host-required" };
  }
  return { kind: "allow" };
}

export function listRemoteActionCatalog(): {
  readonly remoteApprovable: ReadonlyArray<string>;
  readonly localHostRequired: ReadonlyArray<string>;
} {
  return {
    remoteApprovable: [...REMOTE_APPROVABLE_ACTIONS].sort(),
    localHostRequired: [...LOCAL_HOST_ACTIONS].sort(),
  };
}

export interface PairingAttemptState {
  readonly state: "pending" | "approved" | "denied" | "expired";
  readonly attempts: number;
  readonly now: number;
  readonly expiresAt: number;
}

export function evaluatePairingAttempt(input: PairingAttemptState):
  | { readonly kind: "accepted"; readonly attempts: number }
  | {
      readonly kind: "rejected";
      readonly reason: "expired" | "attempt-limit" | "already-consumed";
    } {
  if (input.state !== "pending") return { kind: "rejected", reason: "already-consumed" };
  if (input.now >= input.expiresAt) return { kind: "rejected", reason: "expired" };
  if (input.attempts >= PAIRING_MAX_FAILED_ATTEMPTS) {
    return { kind: "rejected", reason: "attempt-limit" };
  }
  return { kind: "accepted", attempts: input.attempts + 1 };
}

export interface PairingClaimState {
  readonly state: "pending" | "approved" | "denied" | "expired";
  readonly claimState: "unclaimed" | "claimed";
  readonly attempts: number;
  readonly now: number;
  readonly expiresAt: number;
  readonly proofMatches: boolean;
}

export function evaluatePairingClaim(input: PairingClaimState):
  | { readonly kind: "claimed"; readonly attempts: number }
  | {
      readonly kind: "rejected";
      readonly reason:
        | "expired"
        | "attempt-limit"
        | "already-consumed"
        | "already-claimed"
        | "invalid-proof";
      readonly attempts?: number;
    } {
  if (input.state !== "pending") return { kind: "rejected", reason: "already-consumed" };
  if (input.now >= input.expiresAt) return { kind: "rejected", reason: "expired" };
  if (input.claimState === "claimed") return { kind: "rejected", reason: "already-claimed" };
  if (input.attempts >= PAIRING_MAX_FAILED_ATTEMPTS) {
    return { kind: "rejected", reason: "attempt-limit", attempts: input.attempts };
  }
  if (!input.proofMatches) {
    const attempts = input.attempts + 1;
    if (attempts >= PAIRING_MAX_FAILED_ATTEMPTS) {
      return { kind: "rejected", reason: "attempt-limit", attempts };
    }
    return { kind: "rejected", reason: "invalid-proof", attempts };
  }
  return { kind: "claimed", attempts: input.attempts };
}

const DEVICE_LABEL_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} .'_-]{0,127}$/u;

export function normalizeDeviceLabel(
  value: string,
):
  | { readonly kind: "accepted"; readonly deviceLabel: string }
  | { readonly kind: "rejected"; readonly reason: "invalid-label" } {
  const deviceLabel = value.trim();
  if (
    deviceLabel.length === 0 ||
    deviceLabel.length > DEVICE_LABEL_MAX_LENGTH ||
    !DEVICE_LABEL_PATTERN.test(deviceLabel) ||
    deviceLabel.includes("/") ||
    deviceLabel.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(deviceLabel)
  ) {
    return { kind: "rejected", reason: "invalid-label" };
  }
  return { kind: "accepted", deviceLabel };
}

export function evaluateDeviceRegistration(input: {
  readonly state: "active" | "revoked" | "expired";
  readonly now: number;
  readonly createdAt: number;
  readonly lastSeenAt: number;
}):
  | { readonly kind: "active" }
  | {
      readonly kind: "expired";
      readonly reason: "absolute-expiry" | "inactivity-expiry";
    }
  | { readonly kind: "rejected"; readonly reason: "revoked" | "already-expired" } {
  if (input.state === "revoked") return { kind: "rejected", reason: "revoked" };
  if (input.state === "expired") return { kind: "rejected", reason: "already-expired" };
  if (input.now >= input.createdAt + DEVICE_ABSOLUTE_TTL_MS) {
    return { kind: "expired", reason: "absolute-expiry" };
  }
  if (input.now >= input.lastSeenAt + DEVICE_INACTIVITY_TTL_MS) {
    return { kind: "expired", reason: "inactivity-expiry" };
  }
  return { kind: "active" };
}

export function nextDeviceExpiry(input: {
  readonly createdAt: number;
  readonly lastSeenAt: number;
}): number {
  return Math.min(
    input.createdAt + DEVICE_ABSOLUTE_TTL_MS,
    input.lastSeenAt + DEVICE_INACTIVITY_TTL_MS,
  );
}

export function shouldPersistDeviceLastSeen(input: {
  readonly now: number;
  readonly lastSeenAt: number;
}): boolean {
  return input.now - input.lastSeenAt >= DEVICE_LAST_SEEN_COARSEN_MS;
}

export function evaluateSession(input: {
  readonly now: number;
  readonly issuedAt: number;
  readonly idleExpiresAt: number;
  readonly absoluteExpiresAt: number;
}):
  | { readonly kind: "active"; readonly rotate: boolean }
  | {
      readonly kind: "expired";
      readonly reason: "idle-expiry" | "absolute-expiry" | "clock-skew";
    } {
  if (input.now < input.issuedAt) {
    return { kind: "expired", reason: "clock-skew" };
  }
  if (input.now >= input.absoluteExpiresAt) {
    return { kind: "expired", reason: "absolute-expiry" };
  }
  if (input.now >= input.idleExpiresAt) return { kind: "expired", reason: "idle-expiry" };
  return {
    kind: "active",
    rotate: input.now - input.issuedAt >= SESSION_ROTATION_INTERVAL_MS,
  };
}

function isPrivateIpv4(value: string): boolean {
  const octets = value.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) return false;
  const parts = octets.map(Number);
  const [first, second] = parts;
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  return (
    first === 10 ||
    (first === 172 && second !== undefined && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  );
}

function isTailscaleIpv4(value: string): boolean {
  const octets = value.split(".");
  if (octets.length !== 4 || octets.some((octet) => !/^\d{1,3}$/.test(octet))) return false;
  const parts = octets.map(Number);
  const [first, second] = parts;
  return (
    parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) &&
    first === 100 &&
    second !== undefined &&
    second >= 64 &&
    second <= 127
  );
}

function isPrivateIpv6(value: string): boolean {
  if (!isIpv6Literal(value)) return false;
  return value.startsWith("fc") || value.startsWith("fd") || /^fe[89ab]/.test(value);
}

function isTailscaleIpv6(value: string): boolean {
  return isIpv6Literal(value) && value.startsWith("fd7a:115c:a1e0:");
}

function isIpv6Literal(value: string): boolean {
  const compressionIndex = value.indexOf("::");
  if (compressionIndex !== -1 && value.indexOf("::", compressionIndex + 2) !== -1) return false;
  const halves = compressionIndex === -1 ? [value, ""] : value.split("::");
  const left = halves[0] ?? "";
  const right = halves[1] ?? "";
  const groups = [
    ...(left === "" ? [] : left.split(":")),
    ...(right === "" ? [] : right.split(":")),
  ];
  if (groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return false;
  return compressionIndex === -1 ? groups.length === 8 : groups.length < 8;
}
