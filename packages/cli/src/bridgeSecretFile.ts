import { realpathSync } from "node:fs";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  decodeHostInfoReceipt,
  deriveHostRuntimeHostId,
  prepareHostRuntimePaths,
  resolveHostRuntimePaths,
  writeBridgeSecretProjection,
  writeHostInfoReceipt,
  type HostRuntimePaths,
} from "@octant/host-runtime";

export interface BridgeSecretFileInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly temporaryDirectory?: string;
  readonly uid?: number;
}

export interface HostInfo {
  readonly url: string;
  readonly instanceId: string;
}

export function resolveBridgeSecretFilePath(input: BridgeSecretFileInput): string {
  return resolvePaths(input).bridgeSecretPath;
}

export function resolveHostInfoFilePath(input: BridgeSecretFileInput): string {
  return resolvePaths(input).hostInfoPath;
}

function resolvePaths(input: BridgeSecretFileInput): HostRuntimePaths {
  return resolveHostRuntimePaths({
    env: input.env,
    platform: input.platform,
    home: input.home,
    temporaryDirectory: input.temporaryDirectory ?? canonicalTemporaryDirectory(),
    uid: input.uid ?? process.getuid?.() ?? 0,
  });
}

export async function readBridgeSecretFile(
  input: BridgeSecretFileInput,
): Promise<string | undefined> {
  try {
    const path = resolveBridgeSecretFilePath(input);
    const content = await readFile(path, "utf8");
    const trimmed = content.trim();
    return trimmed === "" ? undefined : trimmed;
  } catch {
    return undefined;
  }
}

export async function writeBridgeSecretFile(
  input: BridgeSecretFileInput,
  secret: string,
): Promise<void> {
  const paths = resolvePaths(input);
  await prepareHostRuntimePaths(paths);
  await writeBridgeSecretProjection(paths, secret);
}

export async function clearBridgeSecretFile(input: BridgeSecretFileInput): Promise<void> {
  try {
    await unlink(resolveBridgeSecretFilePath(input));
  } catch {
    // best-effort cleanup
  }
}

export async function readHostInfoFile(
  input: BridgeSecretFileInput,
): Promise<HostInfo | undefined> {
  try {
    const paths = resolvePaths(input);
    const content = await readFile(paths.hostInfoPath, "utf8");
    try {
      const versioned = decodeHostInfoReceipt(content);
      return versioned.controlEndpoint === paths.socketPath
        ? { url: versioned.url, instanceId: versioned.instanceId }
        : undefined;
    } catch {
      // A strict versioned receipt may never be reinterpreted as legacy data.
    }
    const parsed = JSON.parse(content) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      hasVersionedHostInfoField(parsed)
    ) {
      return undefined;
    }
    const legacy = parsed as Record<string, unknown>;
    if (!isValidLoopbackUrl(legacy.url) || !isNonEmptyString(legacy.instanceId)) return undefined;
    return {
      url: legacy.url,
      instanceId: legacy.instanceId,
    };
  } catch {
    return undefined;
  }
}

function hasVersionedHostInfoField(value: object): boolean {
  const record = value as Record<string, unknown>;
  return [
    "schemaVersion",
    "hostId",
    "controlEndpoint",
    "serviceMode",
    "serverVersion",
    "wireVersion",
    "updatedAt",
  ].some((key) => key in record);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isValidLoopbackUrl(value: unknown): value is string {
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

export async function writeHostInfoFile(
  input: BridgeSecretFileInput,
  info: HostInfo,
): Promise<void> {
  const paths = resolvePaths(input);
  await prepareHostRuntimePaths(paths);
  await writeHostInfoReceipt(paths, {
    schemaVersion: 1,
    hostId: deriveHostRuntimeHostId(paths.dataDirectory),
    instanceId: info.instanceId,
    url: info.url,
    controlEndpoint: paths.socketPath,
    serviceMode: "web",
    serverVersion: "0.0.0-dev",
    wireVersion: "1",
    updatedAt: new Date().toISOString(),
  });
}

export async function clearHostInfoFile(input: BridgeSecretFileInput): Promise<void> {
  try {
    await unlink(resolveHostInfoFilePath(input));
  } catch {
    // best-effort cleanup
  }
}

function canonicalTemporaryDirectory(): string {
  try {
    return realpathSync(tmpdir());
  } catch {
    return resolve(tmpdir());
  }
}
