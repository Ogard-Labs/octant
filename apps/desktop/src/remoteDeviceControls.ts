import { randomUUID as defaultRandomUUID } from "node:crypto";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const LABEL_PATTERN = /^(?!.*[\\/])[^\r\n]{1,128}$/;
const REASON_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export type RemoteDeviceControlFailureCode =
  | "invalid"
  | "unauthorized"
  | "unavailable"
  | "not-found"
  | "conflict"
  | "failed";

const FAILURE_MESSAGES: Readonly<Record<RemoteDeviceControlFailureCode, string>> = {
  invalid: "Octant rejected an invalid local device request.",
  unauthorized: "Octant rejected the local device request.",
  unavailable: "Octant local device controls are unavailable.",
  "not-found": "Octant could not find that device or pairing request.",
  conflict: "Octant could not apply the device change because state changed.",
  failed: "Octant could not apply the local device change.",
};

export class RemoteDeviceControlFailure extends Error {
  constructor(readonly code: RemoteDeviceControlFailureCode) {
    super(FAILURE_MESSAGES[code]);
    this.name = "RemoteDeviceControlFailure";
  }
}

export type DeviceSourceClass = "loopback" | "lan-private" | "tailscale" | "unknown";
export type DeviceState = "active" | "revoked" | "expired";

export interface PendingPairingRequest {
  readonly kind: "pending";
  readonly ticketId: string;
  readonly hostId: string;
  readonly deviceLabel: string;
  readonly deviceKeyFingerprint: string;
  readonly origin: string;
  readonly sourceClass: DeviceSourceClass;
  readonly comparisonCode: string;
  readonly claimedAt: string;
  readonly expiresAt: string;
}

export interface DeviceInventoryEntry {
  readonly hostId: string;
  readonly deviceId: string;
  readonly deviceKeyFingerprint: string;
  readonly deviceLabel: string;
  readonly origin: string;
  readonly protocolFloor: number;
  readonly credentialGeneration: number;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly lastSeenAt: string;
  readonly state: DeviceState;
  readonly revokedAt?: string;
  readonly revokedReason?: string;
}

export interface RemoteCredentialOperationReceipt {
  readonly commandId: string;
  readonly result: "applied" | "already-applied";
  readonly occurredAt: string;
}

export interface RemoteDeviceControlRuntime {
  readonly listPairingRequests: () => Promise<ReadonlyArray<PendingPairingRequest>>;
  readonly approvePairingRequest: (input: {
    readonly ticketId: string;
  }) => Promise<{ readonly decision: "approved"; readonly device: DeviceInventoryEntry }>;
  readonly denyPairingRequest: (input: {
    readonly ticketId: string;
    readonly reasonCode: string;
  }) => Promise<{ readonly decision: "denied" }>;
  readonly getDeviceInventory: () => Promise<ReadonlyArray<DeviceInventoryEntry>>;
  readonly renameDevice: (input: {
    readonly deviceId: string;
    readonly deviceLabel: string;
  }) => Promise<DeviceInventoryEntry>;
  readonly revokeDevice: (input: {
    readonly deviceId: string;
    readonly commandId: string;
  }) => Promise<RemoteCredentialOperationReceipt>;
  readonly revokeAllDevices: (input: {
    readonly commandId: string;
  }) => Promise<RemoteCredentialOperationReceipt>;
  readonly reconcileExpiredDevices: (input: {
    readonly commandId: string;
  }) => Promise<RemoteCredentialOperationReceipt>;
}

export interface RemoteDeviceControlService {
  readonly listPairingRequests: () => Promise<ReadonlyArray<PendingPairingRequest>>;
  readonly approvePairingRequest: (ticketId: string) => Promise<{
    readonly decision: "approved";
    readonly device: DeviceInventoryEntry;
  }>;
  readonly denyPairingRequest: (
    ticketId: string,
    reasonCode: string,
  ) => Promise<{
    readonly decision: "denied";
  }>;
  readonly getDeviceInventory: () => Promise<ReadonlyArray<DeviceInventoryEntry>>;
  readonly renameDevice: (deviceId: string, deviceLabel: string) => Promise<DeviceInventoryEntry>;
  readonly revokeDevice: (deviceId: string) => Promise<RemoteCredentialOperationReceipt>;
  readonly revokeAllDevices: () => Promise<RemoteCredentialOperationReceipt>;
  readonly reconcileExpiredDevices: () => Promise<RemoteCredentialOperationReceipt>;
}

export function createRemoteDeviceControlService(options: {
  readonly runtime: RemoteDeviceControlRuntime;
  readonly uuid?: () => string;
}): RemoteDeviceControlService {
  const uuid = options.uuid ?? defaultRandomUUID;
  const invoke = async <T>(operation: () => Promise<T>): Promise<T> => {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof RemoteDeviceControlFailure) throw error;
      throw new RemoteDeviceControlFailure("unavailable");
    }
  };
  return Object.freeze({
    listPairingRequests: () => invoke(options.runtime.listPairingRequests),
    approvePairingRequest: async (ticketId: string) => {
      validateUuid(ticketId, "pairing request");
      return await invoke(() => options.runtime.approvePairingRequest({ ticketId }));
    },
    denyPairingRequest: async (ticketId: string, reasonCode: string) => {
      validateUuid(ticketId, "pairing request");
      validateReason(reasonCode);
      return await invoke(() => options.runtime.denyPairingRequest({ ticketId, reasonCode }));
    },
    getDeviceInventory: () => invoke(options.runtime.getDeviceInventory),
    renameDevice: async (deviceId: string, deviceLabel: string) => {
      validateUuid(deviceId, "device");
      validateLabel(deviceLabel);
      return await invoke(() =>
        options.runtime.renameDevice({ deviceId, deviceLabel: deviceLabel.trim() }),
      );
    },
    revokeDevice: async (deviceId: string) => {
      validateUuid(deviceId, "device");
      return await invoke(() => options.runtime.revokeDevice({ deviceId, commandId: uuid() }));
    },
    revokeAllDevices: () => invoke(() => options.runtime.revokeAllDevices({ commandId: uuid() })),
    reconcileExpiredDevices: () =>
      invoke(() => options.runtime.reconcileExpiredDevices({ commandId: uuid() })),
  });
}

export interface RemoteDeviceControlHttpRuntimeOptions {
  readonly serverUrl: string;
  readonly desktopBridgeSecret: string;
  readonly windowCapability: string;
  readonly fetch?: typeof globalThis.fetch;
}

export function createRemoteDeviceControlHttpRuntime(
  options: RemoteDeviceControlHttpRuntimeOptions,
): RemoteDeviceControlRuntime {
  const fetch = options.fetch ?? globalThis.fetch;
  return {
    listPairingRequests: async () =>
      decodePending(await request(fetch, options, "GET", "/api/desktop/remote/pairing-requests")),
    approvePairingRequest: async (input) =>
      decodeApproval(
        await request(
          fetch,
          options,
          "POST",
          "/api/desktop/remote/pairing-requests/approve",
          input,
        ),
      ),
    denyPairingRequest: async (input) =>
      decodeDecision(
        await request(fetch, options, "POST", "/api/desktop/remote/pairing-requests/deny", input),
      ),
    getDeviceInventory: async () =>
      decodeDevices(await request(fetch, options, "GET", "/api/desktop/remote/devices")),
    renameDevice: async (input) =>
      decodeDevice(
        await request(fetch, options, "POST", "/api/desktop/remote/devices/rename", input),
      ),
    revokeDevice: async (input) =>
      decodeReceipt(
        await request(fetch, options, "POST", "/api/desktop/remote/devices/revoke", input),
      ),
    revokeAllDevices: async (input) =>
      decodeReceipt(
        await request(fetch, options, "POST", "/api/desktop/remote/devices/revoke-all", input),
      ),
    reconcileExpiredDevices: async (input) =>
      decodeReceipt(
        await request(
          fetch,
          options,
          "POST",
          "/api/desktop/remote/devices/reconcile-expired",
          input,
        ),
      ),
  };
}

async function request(
  fetch: typeof globalThis.fetch,
  options: RemoteDeviceControlHttpRuntimeOptions,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(new URL(path, options.serverUrl), {
      method,
      headers: {
        "x-octant-desktop-secret": options.desktopBridgeSecret,
        "x-octant-window-capability": options.windowCapability,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new RemoteDeviceControlFailure("unavailable");
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new RemoteDeviceControlFailure(response.ok ? "failed" : "unavailable");
  }
  if (!response.ok) throw new RemoteDeviceControlFailure(decodeFailureCode(value));
  return value;
}

function decodePending(value: unknown): ReadonlyArray<PendingPairingRequest> {
  requireExactKeys(value, ["pending"]);
  if (!Array.isArray(value.pending)) throw new RemoteDeviceControlFailure("failed");
  return Object.freeze(value.pending.map(decodePendingEntry));
}

function decodeApproval(value: unknown): {
  readonly decision: "approved";
  readonly device: DeviceInventoryEntry;
} {
  requireExactKeys(value, ["decision", "device"]);
  if (!record(value.device)) {
    throw new RemoteDeviceControlFailure("failed");
  }
  requireExactKeys(value.decision, ["decidedAt", "decision", "hostId", "reasonCode", "ticketId"]);
  if (value.decision.decision !== "approved") {
    throw new RemoteDeviceControlFailure("failed");
  }
  return Object.freeze({ decision: "approved", device: decodeDeviceEntry(value.device) });
}

function decodeDecision(value: unknown): { readonly decision: "denied" } {
  requireExactKeys(value, ["decision"]);
  if (!record(value.decision)) throw new RemoteDeviceControlFailure("failed");
  requireExactKeys(value.decision, ["decidedAt", "decision", "hostId", "reasonCode", "ticketId"]);
  if (value.decision.decision !== "denied") {
    throw new RemoteDeviceControlFailure("failed");
  }
  return { decision: "denied" };
}

function decodeDevices(value: unknown): ReadonlyArray<DeviceInventoryEntry> {
  requireExactKeys(value, ["devices"]);
  if (!Array.isArray(value.devices)) throw new RemoteDeviceControlFailure("failed");
  return Object.freeze(value.devices.map(decodeDeviceEntry));
}

function decodeDevice(value: unknown): DeviceInventoryEntry {
  requireExactKeys(value, ["device"]);
  if (!record(value.device)) throw new RemoteDeviceControlFailure("failed");
  return decodeDeviceEntry(value.device);
}

function decodeReceipt(value: unknown): RemoteCredentialOperationReceipt {
  requireExactKeys(value, ["receipt"]);
  if (!record(value.receipt)) throw new RemoteDeviceControlFailure("failed");
  const receipt = value.receipt;
  requireExactKeys(receipt, ["commandId", "occurredAt", "result"]);
  if (
    !record(receipt) ||
    !UUID_PATTERN.test(String(receipt.commandId)) ||
    (receipt.result !== "applied" && receipt.result !== "already-applied") ||
    typeof receipt.occurredAt !== "string"
  ) {
    throw new RemoteDeviceControlFailure("failed");
  }
  return Object.freeze({
    commandId: receipt.commandId as string,
    result: receipt.result,
    occurredAt: receipt.occurredAt as string,
  });
}

function decodePendingEntry(value: unknown): PendingPairingRequest {
  requireExactKeys(value, [
    "claimedAt",
    "comparisonCode",
    "deviceKeyFingerprint",
    "deviceLabel",
    "expiresAt",
    "hostId",
    "kind",
    "origin",
    "sourceClass",
    "ticketId",
  ]);
  if (
    value.kind !== "pending" ||
    !UUID_PATTERN.test(String(value.ticketId)) ||
    !UUID_PATTERN.test(String(value.hostId)) ||
    typeof value.deviceLabel !== "string" ||
    !FINGERPRINT_PATTERN.test(String(value.deviceKeyFingerprint)) ||
    typeof value.origin !== "string" ||
    !["loopback", "lan-private", "tailscale", "unknown"].includes(String(value.sourceClass)) ||
    !/^\d{6}$/.test(String(value.comparisonCode)) ||
    !isUtcTimestamp(value.claimedAt) ||
    !isUtcTimestamp(value.expiresAt)
  ) {
    throw new RemoteDeviceControlFailure("failed");
  }
  return Object.freeze({
    kind: "pending",
    ticketId: value.ticketId as string,
    hostId: value.hostId as string,
    deviceLabel: value.deviceLabel,
    deviceKeyFingerprint: value.deviceKeyFingerprint as string,
    origin: value.origin,
    sourceClass: value.sourceClass as DeviceSourceClass,
    comparisonCode: value.comparisonCode as string,
    claimedAt: value.claimedAt as string,
    expiresAt: value.expiresAt as string,
  });
}

function decodeDeviceEntry(value: Record<string, unknown>): DeviceInventoryEntry {
  const required = [
    "createdAt",
    "credentialGeneration",
    "deviceId",
    "deviceKeyFingerprint",
    "deviceLabel",
    "expiresAt",
    "hostId",
    "lastSeenAt",
    "origin",
    "protocolFloor",
    "state",
  ];
  const allowed = new Set([...required, "revokedAt", "revokedReason"]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    required.some((key) => !(key in value))
  ) {
    throw new RemoteDeviceControlFailure("failed");
  }
  if (
    !UUID_PATTERN.test(String(value.hostId)) ||
    !UUID_PATTERN.test(String(value.deviceId)) ||
    !FINGERPRINT_PATTERN.test(String(value.deviceKeyFingerprint)) ||
    typeof value.deviceLabel !== "string" ||
    typeof value.origin !== "string" ||
    !isHttpsOrigin(value.origin) ||
    !Number.isSafeInteger(value.protocolFloor) ||
    (value.protocolFloor as number) < 1 ||
    !Number.isSafeInteger(value.credentialGeneration) ||
    (value.credentialGeneration as number) < 1 ||
    typeof value.createdAt !== "string" ||
    typeof value.expiresAt !== "string" ||
    typeof value.lastSeenAt !== "string" ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.expiresAt) ||
    !isTimestamp(value.lastSeenAt) ||
    !["active", "revoked", "expired"].includes(String(value.state))
  ) {
    throw new RemoteDeviceControlFailure("failed");
  }
  return Object.freeze({
    hostId: value.hostId as string,
    deviceId: value.deviceId as string,
    deviceKeyFingerprint: value.deviceKeyFingerprint as string,
    deviceLabel: value.deviceLabel,
    origin: value.origin,
    protocolFloor: value.protocolFloor as number,
    credentialGeneration: value.credentialGeneration as number,
    createdAt: value.createdAt as string,
    expiresAt: value.expiresAt as string,
    lastSeenAt: value.lastSeenAt as string,
    state: value.state as DeviceState,
    ...(typeof value.revokedAt === "string" ? { revokedAt: value.revokedAt } : {}),
    ...(typeof value.revokedReason === "string" ? { revokedReason: value.revokedReason } : {}),
  });
}

function requireExactKeys(
  value: unknown,
  expected: readonly string[],
): asserts value is Record<string, unknown> {
  if (!record(value)) throw new RemoteDeviceControlFailure("failed");
  const actual = Object.keys(value).sort();
  const keys = [...expected].sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    throw new RemoteDeviceControlFailure("failed");
  }
}

function isHttpsOrigin(value: string): boolean {
  try {
    const origin = new URL(value);
    return origin.protocol === "https:" && origin.username === "" && origin.password === "";
  } catch {
    return false;
  }
}

function isTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function isUtcTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !UTC_TIMESTAMP_PATTERN.test(value)) return false;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

function decodeFailureCode(value: unknown): RemoteDeviceControlFailureCode {
  if (
    record(value) &&
    ["invalid", "unauthorized", "unavailable", "not-found", "conflict"].includes(
      String(value.category),
    )
  ) {
    return value.category as RemoteDeviceControlFailureCode;
  }
  return "unavailable";
}

function validateUuid(value: string, kind: string): void {
  if (!UUID_PATTERN.test(value)) throw new RemoteDeviceControlFailure("invalid");
  void kind;
}

function validateLabel(value: string): void {
  if (!LABEL_PATTERN.test(value.trim())) throw new RemoteDeviceControlFailure("invalid");
}

function validateReason(value: string): void {
  if (!REASON_PATTERN.test(value)) throw new RemoteDeviceControlFailure("invalid");
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
