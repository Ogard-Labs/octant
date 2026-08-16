import { isAbsolute } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEX_256 = /^[0-9a-f]{64}$/;
const SERVICE_MODES = new Set<HostRuntimeServiceMode>([
  "desktop",
  "foreground",
  "web",
  "service",
  "maintenance",
]);

export type HostRuntimeServiceMode = "desktop" | "foreground" | "web" | "service" | "maintenance";

export interface HostRuntimeOwnerReceipt {
  readonly schemaVersion: 1;
  readonly hostId: string;
  readonly instanceId: string;
  readonly endpoint: string;
  readonly pid: number;
  readonly processStart: string;
  readonly serverVersion: string;
  readonly wireVersion: string;
  readonly serviceMode: HostRuntimeServiceMode;
  readonly nonceDigest: string;
  readonly createdAt: string;
}

export class HostRuntimeReceiptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostRuntimeReceiptError";
  }
}

export function encodeOwnerReceipt(receipt: HostRuntimeOwnerReceipt): string {
  validateReceipt(receipt);
  return JSON.stringify(receipt);
}

export function decodeOwnerReceipt(input: string): HostRuntimeOwnerReceipt {
  if (Buffer.byteLength(input) > 4_096) {
    throw new HostRuntimeReceiptError("Octant owner receipt exceeds the size limit.");
  }
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new HostRuntimeReceiptError("Octant owner receipt is not valid JSON.");
  }
  validateReceipt(value);
  return Object.freeze({ ...(value as HostRuntimeOwnerReceipt) });
}

function validateReceipt(value: unknown): asserts value is HostRuntimeOwnerReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const receipt = value as Record<string, unknown>;
  const expectedKeys = [
    "createdAt",
    "endpoint",
    "hostId",
    "instanceId",
    "nonceDigest",
    "pid",
    "processStart",
    "schemaVersion",
    "serverVersion",
    "serviceMode",
    "wireVersion",
  ];
  if (Object.keys(receipt).sort().join("\0") !== expectedKeys.sort().join("\0")) invalid();
  if (receipt.schemaVersion !== 1) invalid();
  if (typeof receipt.hostId !== "string" || !UUID.test(receipt.hostId)) invalid();
  if (typeof receipt.instanceId !== "string" || !UUID.test(receipt.instanceId)) invalid();
  if (
    typeof receipt.endpoint !== "string" ||
    !isAbsolute(receipt.endpoint) ||
    Buffer.byteLength(receipt.endpoint) > 255
  ) {
    invalid();
  }
  if (!Number.isSafeInteger(receipt.pid) || (receipt.pid as number) <= 0) invalid();
  if (!boundedString(receipt.processStart, 128)) invalid();
  if (!boundedString(receipt.serverVersion, 64)) invalid();
  if (!boundedString(receipt.wireVersion, 64)) invalid();
  if (!SERVICE_MODES.has(receipt.serviceMode as HostRuntimeServiceMode)) invalid();
  if (typeof receipt.nonceDigest !== "string" || !HEX_256.test(receipt.nonceDigest)) invalid();
  if (
    !boundedString(receipt.createdAt, 64) ||
    Number.isNaN(Date.parse(receipt.createdAt as string))
  ) {
    invalid();
  }
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function invalid(): never {
  throw new HostRuntimeReceiptError("Octant owner receipt is malformed or incompatible.");
}
