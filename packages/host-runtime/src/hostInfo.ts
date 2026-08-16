import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { HostRuntimePaths } from "./paths";
import type { HostRuntimeServiceMode } from "./ownerReceipt";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SERVICE_MODES = new Set<HostRuntimeServiceMode>([
  "desktop",
  "foreground",
  "web",
  "service",
  "maintenance",
]);

export interface HostInfoReceipt {
  readonly schemaVersion: 1;
  readonly hostId: string;
  readonly instanceId: string;
  readonly url: string;
  readonly controlEndpoint: string;
  readonly serviceMode: HostRuntimeServiceMode;
  readonly serverVersion: string;
  readonly wireVersion: string;
  readonly updatedAt: string;
}

export class HostInfoReceiptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostInfoReceiptError";
  }
}

export function encodeHostInfoReceipt(receipt: HostInfoReceipt): string {
  validate(receipt);
  return JSON.stringify(receipt);
}

export function decodeHostInfoReceipt(input: string): HostInfoReceipt {
  if (Buffer.byteLength(input) > 4_096) invalid();
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    invalid();
  }
  validate(value);
  return Object.freeze({ ...(value as HostInfoReceipt) });
}

export async function writeHostInfoReceipt(
  paths: HostRuntimePaths,
  receipt: HostInfoReceipt,
): Promise<void> {
  if (receipt.controlEndpoint !== paths.socketPath) {
    throw new HostInfoReceiptError("Octant host-info control endpoint is inconsistent.");
  }
  const directory = dirname(paths.hostInfoPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.host-info-${receipt.instanceId}.tmp`);
  await writeFile(temporary, encodeHostInfoReceipt(receipt), {
    encoding: "utf8",
    mode: 0o600,
  });
  await chmod(temporary, 0o600);
  await rename(temporary, paths.hostInfoPath);
}

export async function readHostInfoReceipt(
  paths: HostRuntimePaths,
): Promise<HostInfoReceipt | undefined> {
  try {
    const receipt = decodeHostInfoReceipt(await readFile(paths.hostInfoPath, "utf8"));
    return receipt.controlEndpoint === paths.socketPath ? receipt : undefined;
  } catch {
    return undefined;
  }
}

export async function clearHostRuntimeProjections(
  paths: HostRuntimePaths,
  owner: { readonly instanceId: string; readonly bridgeSecret?: string | undefined },
): Promise<void> {
  const hostInfo = await readHostInfoReceipt(paths);
  if (hostInfo?.instanceId === owner.instanceId) {
    await unlinkOwnedFile(paths.hostInfoPath, paths.uid);
  }
  if (owner.bridgeSecret !== undefined) {
    const bridgeSecret = await readOwnedFile(paths.bridgeSecretPath, paths.uid);
    if (bridgeSecret?.trim() === owner.bridgeSecret) {
      await unlinkOwnedFile(paths.bridgeSecretPath, paths.uid);
    }
  }
}

async function readOwnedFile(path: string, uid: number): Promise<string | undefined> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.uid !== uid || (metadata.mode & 0o077) !== 0)
      return undefined;
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function unlinkOwnedFile(path: string, uid: number): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.uid !== uid || (metadata.mode & 0o077) !== 0) return;
    await unlink(path);
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      (error as { readonly code?: unknown }).code !== "ENOENT"
    ) {
      throw error;
    }
  }
}

function validate(value: unknown): asserts value is HostInfoReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalid();
  const receipt = value as Record<string, unknown>;
  const expected = [
    "controlEndpoint",
    "hostId",
    "instanceId",
    "schemaVersion",
    "serverVersion",
    "serviceMode",
    "updatedAt",
    "url",
    "wireVersion",
  ];
  if (Object.keys(receipt).sort().join("\0") !== expected.sort().join("\0")) invalid();
  if (receipt.schemaVersion !== 1) invalid();
  if (typeof receipt.hostId !== "string" || !UUID.test(receipt.hostId)) invalid();
  if (typeof receipt.instanceId !== "string" || !UUID.test(receipt.instanceId)) invalid();
  if (
    typeof receipt.controlEndpoint !== "string" ||
    !isAbsolute(receipt.controlEndpoint) ||
    Buffer.byteLength(receipt.controlEndpoint) > 255
  ) {
    invalid();
  }
  if (!validLocalUrl(receipt.url)) invalid();
  if (!SERVICE_MODES.has(receipt.serviceMode as HostRuntimeServiceMode)) invalid();
  if (!boundedString(receipt.serverVersion, 64) || !boundedString(receipt.wireVersion, 64)) {
    invalid();
  }
  if (
    !boundedString(receipt.updatedAt, 64) ||
    Number.isNaN(Date.parse(receipt.updatedAt as string))
  ) {
    invalid();
  }
}

function validLocalUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 256) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "http:" &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
      url.port !== "" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}

function boundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function invalid(): never {
  throw new HostInfoReceiptError("Octant host-info receipt is malformed or incompatible.");
}
