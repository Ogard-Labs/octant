import { createHash } from "node:crypto";
import type {
  ExtensionCompatibility,
  ExtensionContentDigest,
  ExtensionDiagnostic,
  ExtensionPackageManifest,
} from "@octant/contracts/extensions";
import {
  decodeExtensionContentDigest,
  decodeExtensionPackageManifest,
} from "@octant/contracts/extensions";

export interface ExtensionArchiveEntry {
  readonly path: string;
  readonly kind: "file" | "directory" | "symlink" | "hardlink";
  readonly content?: Uint8Array;
  readonly executable?: boolean;
  readonly linkTarget?: string;
}

export interface ResolvedExtensionPackage {
  readonly format: string;
  readonly archiveBytes: number;
  readonly manifest: unknown;
  readonly entries: ReadonlyArray<ExtensionArchiveEntry>;
  readonly expectedDigest?: ExtensionContentDigest;
  readonly appVersion: string;
  readonly platform: NodeJS.Platform;
  readonly diagnostics?: ReadonlyArray<ExtensionDiagnostic>;
}

export interface ExtensionInspectionLimits {
  readonly maximumArchiveBytes: number;
  readonly maximumArchiveEntries: number;
  readonly maximumManifestBytes: number;
  readonly maximumPathBytes: number;
  readonly maximumFileBytes: number;
  readonly maximumExtractedBytes: number;
}

export interface InspectedExtensionFile {
  readonly path: string;
  readonly content: Uint8Array;
  readonly executable: boolean;
}

export interface InspectedExtensionPackage {
  readonly manifest: ExtensionPackageManifest;
  readonly files: ReadonlyArray<InspectedExtensionFile>;
  readonly entryPoints: Readonly<Record<string, string>>;
  readonly configurationReferences: Readonly<Record<string, string>>;
  readonly contentReferences: Readonly<Record<string, string>>;
  readonly totalBytes: number;
  readonly diagnostics?: ReadonlyArray<ExtensionDiagnostic>;
}

export class ExtensionInspectionError extends Error {
  override readonly name = "ExtensionInspectionError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const DEFAULT_EXTENSION_INSPECTION_LIMITS: ExtensionInspectionLimits = {
  maximumArchiveBytes: 64 * 1_024 * 1_024,
  maximumArchiveEntries: 4_096,
  maximumManifestBytes: 256 * 1_024,
  maximumPathBytes: 1_024,
  maximumFileBytes: 16 * 1_024 * 1_024,
  maximumExtractedBytes: 128 * 1_024 * 1_024,
};

export function calculateExtensionPackageDigest(
  manifest: unknown,
  entries: ReadonlyArray<ExtensionArchiveEntry>,
): ExtensionContentDigest {
  const hash = createHash("sha256");
  hash.update("octant.extension-package.v1\0");
  hash.update(stableJson(withoutDigest(manifest)));
  hash.update("\0");
  for (const entry of entries
    .filter((candidate) => candidate.kind === "file")
    .sort(compareArchiveEntries)) {
    hash.update(entry.kind);
    hash.update("\0");
    hash.update(entry.path);
    hash.update("\0");
    hash.update(entry.executable === true ? "1" : "0");
    hash.update("\0");
    if (entry.linkTarget !== undefined) hash.update(entry.linkTarget);
    hash.update("\0");
    if (entry.content !== undefined) hash.update(entry.content);
    hash.update("\0");
  }
  return decodeExtensionContentDigest(`sha256:${hash.digest("hex")}`);
}

export function inspectExtensionPackage(
  input: ResolvedExtensionPackage,
  limits: ExtensionInspectionLimits = DEFAULT_EXTENSION_INSPECTION_LIMITS,
): InspectedExtensionPackage {
  validateLimits(limits);
  if (input.format !== "zip" && input.format !== "tar" && input.format !== "directory") {
    fail("unsupported-format", "Package format is unsupported.");
  }
  if (!Number.isSafeInteger(input.archiveBytes) || input.archiveBytes < 0) {
    fail("archive-invalid", "Package size metadata is invalid.");
  }
  if (input.archiveBytes > limits.maximumArchiveBytes) {
    fail("archive-oversize", "Package archive exceeds the allowed limit.");
  }
  if (input.entries.length > limits.maximumArchiveEntries) {
    fail("archive-oversize", "Package entry count exceeds the allowed limit.");
  }
  let manifest: ExtensionPackageManifest;
  let rawEntryPoints: Readonly<Record<string, string>>;
  let rawConfigurationReferences: Readonly<Record<string, string>>;
  let rawContentReferences: Readonly<Record<string, string>>;
  const manifestBytes = Buffer.byteLength(stableJson(input.manifest), "utf8");
  if (manifestBytes > limits.maximumManifestBytes) {
    fail("manifest-oversize", "Package manifest exceeds the allowed limit.");
  }
  try {
    const prepared = prepareManifestForDecode(input.manifest);
    manifest = decodeExtensionPackageManifest(prepared.manifest);
    rawEntryPoints = prepared.entryPoints;
    rawConfigurationReferences = prepared.configurationReferences;
    rawContentReferences = prepared.contentReferences;
  } catch {
    fail("manifest-invalid", "Package manifest is invalid.");
  }

  validateProvenanceAndLicense(manifest);
  validateCompatibility(manifest.compatibility, input.appVersion, input.platform);

  const normalizedEntries: Array<ExtensionArchiveEntry> = [];
  const collisionKeys = new Set<string>();
  let totalBytes = 0;
  for (const entry of input.entries) {
    const path = normalizeArchivePath(entry.path, limits.maximumPathBytes);
    const collisionKey = path.normalize("NFKC").toLocaleLowerCase("en-US");
    if (collisionKeys.has(collisionKey)) {
      fail("duplicate-path", "Package contains duplicate normalized paths.");
    }
    collisionKeys.add(collisionKey);
    if (entry.kind === "symlink" || entry.kind === "hardlink") {
      fail("link-entry", "Package link entries are not allowed.");
    }
    if (entry.kind !== "file" && entry.kind !== "directory") {
      fail("entry-invalid", "Package contains an unsupported entry.");
    }
    if (entry.kind === "directory") {
      if (
        entry.content !== undefined ||
        entry.executable === true ||
        entry.linkTarget !== undefined
      ) {
        fail("entry-invalid", "Package directory entry is invalid.");
      }
      normalizedEntries.push({ path, kind: "directory" });
      continue;
    }
    if (entry.content === undefined || entry.linkTarget !== undefined) {
      fail("entry-invalid", "Package file entry is invalid.");
    }
    if (entry.content.byteLength > limits.maximumFileBytes) {
      fail("file-oversize", "Package file exceeds the allowed limit.");
    }
    totalBytes += entry.content.byteLength;
    if (totalBytes > limits.maximumExtractedBytes) {
      fail("archive-oversize", "Package extracted content exceeds the allowed limit.");
    }
    normalizedEntries.push({
      path,
      kind: "file",
      content: entry.content,
      executable: entry.executable === true,
    });
  }

  const calculatedDigest = calculateExtensionPackageDigest(input.manifest, normalizedEntries);
  if (
    calculatedDigest !== manifest.digest ||
    (input.expectedDigest !== undefined && input.expectedDigest !== calculatedDigest)
  ) {
    fail("digest-mismatch", "Package integrity verification failed.");
  }

  const filesByPath = new Map(
    normalizedEntries
      .filter(
        (entry): entry is ExtensionArchiveEntry & { readonly content: Uint8Array } =>
          entry.kind === "file" && entry.content !== undefined,
      )
      .map((entry) => [entry.path, entry]),
  );
  const declaredEntryPoints = new Set<string>();
  const entryPoints: Record<string, string> = {};
  const configurationReferences: Record<string, string> = {};
  const contentReferences: Record<string, string> = {};
  const safeComponents = manifest.components.map((component) => {
    let normalized = component;
    if (component.entryPoint !== undefined) {
      const rawEntryPoint = rawEntryPoints[component.id];
      if (rawEntryPoint === undefined) {
        fail("entry-point-missing", "Declared package entry point is unavailable.");
      }
      const entryPoint = normalizeArchivePath(rawEntryPoint, limits.maximumPathBytes);
      const entry = filesByPath.get(entryPoint);
      if (entry === undefined || entry.executable !== true) {
        fail("entry-point-missing", "Declared package entry point is unavailable.");
      }
      declaredEntryPoints.add(entryPoint);
      entryPoints[component.id] = entryPoint;
      normalized = { ...normalized, entryPoint: `entry:${component.id}` };
    }
    if (component.configurationReference !== undefined) {
      const rawReference = rawConfigurationReferences[component.id];
      if (rawReference === undefined) {
        fail("configuration-missing", "Declared package configuration is unavailable.");
      }
      const reference = normalizeArchivePath(rawReference, limits.maximumPathBytes);
      const entry = filesByPath.get(reference);
      if (entry === undefined || entry.executable === true) {
        fail("configuration-missing", "Declared package configuration is unavailable.");
      }
      configurationReferences[component.id] = reference;
      normalized = { ...normalized, configurationReference: `config:${component.id}` };
    }
    if (component.contentReference !== undefined) {
      const rawReference = rawContentReferences[component.id];
      if (rawReference === undefined) {
        fail("content-missing", "Declared package content is unavailable.");
      }
      const reference = normalizeArchivePath(rawReference, limits.maximumPathBytes);
      const entry = filesByPath.get(reference);
      if (entry === undefined || entry.executable === true) {
        fail("content-missing", "Declared package content is unavailable.");
      }
      contentReferences[component.id] = reference;
      normalized = { ...normalized, contentReference: `content:${component.id}` };
    }
    return normalized;
  });
  for (const entry of filesByPath.values()) {
    if (entry.executable === true && !declaredEntryPoints.has(entry.path)) {
      fail("undeclared-executable", "Package contains an undeclared executable entry point.");
    }
  }

  return {
    manifest: decodeExtensionPackageManifest({ ...manifest, components: safeComponents }),
    files: [...filesByPath.values()]
      .map((entry) => ({
        path: entry.path,
        content: entry.content,
        executable: entry.executable === true,
      }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    entryPoints,
    configurationReferences,
    contentReferences,
    totalBytes,
    ...(input.diagnostics === undefined ? {} : { diagnostics: input.diagnostics }),
  };
}

function prepareManifestForDecode(value: unknown): {
  readonly manifest: unknown;
  readonly entryPoints: Readonly<Record<string, string>>;
  readonly configurationReferences: Readonly<Record<string, string>>;
  readonly contentReferences: Readonly<Record<string, string>>;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail("manifest-invalid", "Package manifest is invalid.");
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.components)) {
    fail("manifest-invalid", "Package manifest is invalid.");
  }
  const entryPoints: Record<string, string> = {};
  const configurationReferences: Record<string, string> = {};
  const contentReferences: Record<string, string> = {};
  const components = record.components.map((component) => {
    if (typeof component !== "object" || component === null || Array.isArray(component)) {
      fail("manifest-invalid", "Package manifest is invalid.");
    }
    const componentRecord = component as Record<string, unknown>;
    if (typeof componentRecord.id !== "string") {
      fail("manifest-invalid", "Package manifest is invalid.");
    }
    const normalized = { ...componentRecord };
    if (componentRecord.entryPoint !== undefined) {
      if (typeof componentRecord.entryPoint !== "string") {
        fail("manifest-invalid", "Package manifest is invalid.");
      }
      entryPoints[componentRecord.id] = componentRecord.entryPoint;
      normalized.entryPoint = `entry:${componentRecord.id}`;
    }
    if (componentRecord.configurationReference !== undefined) {
      if (typeof componentRecord.configurationReference !== "string") {
        fail("manifest-invalid", "Package manifest is invalid.");
      }
      configurationReferences[componentRecord.id] = componentRecord.configurationReference;
      normalized.configurationReference = `config:${componentRecord.id}`;
    }
    if (componentRecord.contentReference !== undefined) {
      if (typeof componentRecord.contentReference !== "string") {
        fail("manifest-invalid", "Package manifest is invalid.");
      }
      contentReferences[componentRecord.id] = componentRecord.contentReference;
      normalized.contentReference = `content:${componentRecord.id}`;
    }
    return normalized;
  });
  return {
    manifest: { ...record, components },
    entryPoints,
    configurationReferences,
    contentReferences,
  };
}

function validateLimits(limits: ExtensionInspectionLimits): void {
  if (
    Object.values(limits).some(
      (value) => !Number.isSafeInteger(value) || value < 1 || value > 1024 * 1024 * 1024,
    )
  ) {
    fail("limits-invalid", "Package inspection limits are invalid.");
  }
}

function validateProvenanceAndLicense(manifest: ExtensionPackageManifest): void {
  if (manifest.license.kind === "unreported") {
    fail("license-missing", "Package license metadata is required.");
  }
  if (
    manifest.provenance.publisher === undefined ||
    (manifest.provenance.canonicalUrl === undefined &&
      manifest.provenance.sourceCommit === undefined)
  ) {
    fail("provenance-missing", "Package provenance metadata is required.");
  }
}

function validateCompatibility(
  compatibility: ExtensionCompatibility,
  appVersion: string,
  platform: NodeJS.Platform,
): void {
  const normalizedPlatform =
    platform === "darwin" ? "macos" : platform === "win32" ? "windows" : platform;
  if (
    (normalizedPlatform !== "macos" &&
      normalizedPlatform !== "linux" &&
      normalizedPlatform !== "windows") ||
    !compatibility.platforms.includes(normalizedPlatform)
  ) {
    fail("incompatible", "Package is incompatible with this host.");
  }
  const range = compatibility.app;
  if (
    range !== undefined &&
    (compareSemver(appVersion, range.minimum) < 0 ||
      (range.maximumExclusive !== undefined &&
        compareSemver(appVersion, range.maximumExclusive) >= 0))
  ) {
    fail("incompatible", "Package is incompatible with this app version.");
  }
}

export function isExtensionPackageCompatible(
  manifest: ExtensionPackageManifest,
  appVersion: string,
  platform: NodeJS.Platform,
): boolean {
  return isExtensionCompatibilityCompatible(manifest.compatibility, appVersion, platform);
}

export function isExtensionCompatibilityCompatible(
  compatibility: ExtensionCompatibility,
  appVersion: string,
  platform: NodeJS.Platform,
): boolean {
  try {
    validateCompatibility(compatibility, appVersion, platform);
    return true;
  } catch (error) {
    if (error instanceof ExtensionInspectionError && error.code === "incompatible") return false;
    throw error;
  }
}

function compareSemver(left: string, right: string): number {
  const parse = (value: string): [number, number, number, ReadonlyArray<string> | undefined] => {
    const match =
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(
        value,
      );
    if (match === null) fail("incompatible", "Package app compatibility is invalid.");
    return [Number(match[1]), Number(match[2]), Number(match[3]), match[4]?.split(".")];
  };
  const a = parse(left);
  const b = parse(right);
  for (const index of [0, 1, 2] as const) {
    const difference = a[index]! - b[index]!;
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  const aPre = a[3];
  const bPre = b[3];
  if (aPre === undefined || bPre === undefined) {
    return aPre === bPre ? 0 : aPre === undefined ? 1 : -1;
  }
  for (let index = 0; index < Math.max(aPre.length, bPre.length); index += 1) {
    const ai = aPre[index];
    const bi = bPre[index];
    if (ai === undefined || bi === undefined) return ai === bi ? 0 : ai === undefined ? -1 : 1;
    if (ai === bi) continue;
    const an = /^\d+$/.test(ai);
    const bn = /^\d+$/.test(bi);
    if (an && bn) return Number(ai) < Number(bi) ? -1 : 1;
    if (an !== bn) return an ? -1 : 1;
    return ai < bi ? -1 : 1;
  }
  return 0;
}

function normalizeArchivePath(rawPath: string, maximumPathBytes: number): string {
  if (
    rawPath.length === 0 ||
    rawPath.includes("\0") ||
    rawPath.includes("\\") ||
    rawPath.startsWith("/") ||
    rawPath.startsWith("//") ||
    /^[A-Za-z]:/.test(rawPath) ||
    Buffer.byteLength(rawPath, "utf8") > maximumPathBytes
  ) {
    fail(
      Buffer.byteLength(rawPath, "utf8") > maximumPathBytes ? "path-oversize" : "unsafe-path",
      "Package path is unsafe.",
    );
  }
  const segments = rawPath.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        [...segment].some((character) => {
          const codePoint = character.codePointAt(0)!;
          return codePoint <= 0x1f || codePoint === 0x7f;
        }),
    )
  ) {
    fail("unsafe-path", "Package path is unsafe.");
  }
  const normalized = segments.map((segment) => segment.normalize("NFC")).join("/");
  if (Buffer.byteLength(normalized, "utf8") > maximumPathBytes) {
    fail("path-oversize", "Package path exceeds the allowed limit.");
  }
  return normalized;
}

function withoutDigest(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const { digest: _digest, ...rest } = value as Record<string, unknown>;
  return rest;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

function compareArchiveEntries(left: ExtensionArchiveEntry, right: ExtensionArchiveEntry): number {
  const path = left.path.localeCompare(right.path);
  return path !== 0 ? path : left.kind.localeCompare(right.kind);
}

function fail(code: string, message: string): never {
  throw new ExtensionInspectionError(code, message);
}
