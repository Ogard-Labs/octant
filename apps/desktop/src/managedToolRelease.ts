import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, lstat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 256 * 1024 * 1024;
const MAX_DEPENDENCY_PACKAGES = 64;
const MAX_DOCUMENT_BYTES = 16 * 1024 * 1024;
const REGISTRY_ORIGIN = "registry.npmjs.org";
const VERSION = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/;
const PACKAGE_NAME = /^(@[a-z0-9-][a-z0-9._-]*\/)?[a-z0-9-][a-z0-9._-]*$/;
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/=]+$/;

/** A managed tool's identity: which npm package it comes from and what runs it. */
export interface ManagedToolDescriptor {
  readonly tool: string;
  readonly packageName: string;
  /** Entry point inside the unpacked package, relative to its root. */
  readonly entrypoint: string;
  /** Platforms the tool can actually serve on; it is absent elsewhere. */
  readonly platforms: ReadonlyArray<NodeJS.Platform>;
  /**
   * `node` runs under the desktop runtime. `executable` is a native binary
   * spawned directly. Lifecycle scripts are never run either way.
   */
  readonly runtime?: "node" | "executable";
  /**
   * Platform package that holds the binary. Version checks still use
   * `packageName`; the staged bytes are this package at the same version.
   * Keys are `${platform}-${arch}`.
   */
  readonly platformPackages?: Readonly<Partial<Record<string, string>>>;
  /** Archive byte cap. Absent uses the channel default. */
  readonly maxArchiveBytes?: number;
  /**
   * When false, the packager does not vendor the tree into the app. Updates
   * still stage into the managed location on demand.
   */
  readonly shipInApp?: boolean;
}

export interface ManagedToolRelease {
  readonly packageName: string;
  readonly version: string;
  readonly url: string;
  readonly integrity: string;
}

export interface StagedManagedTool {
  readonly version: string;
  /** Directory holding package contents plus its resolved node_modules. */
  readonly path: string;
  readonly entrypoint: string;
}

export type ManagedFetch = (url: string, signal: AbortSignal) => Promise<Uint8Array>;

export const MANAGED_TOOLS: ReadonlyArray<ManagedToolDescriptor> = [
  {
    tool: "serve-sim",
    packageName: "serve-sim",
    entrypoint: "dist/serve-sim.js",
    // The iOS Simulator stream needs simctl; the tool is meaningless elsewhere.
    platforms: ["darwin"],
  },
  {
    tool: "serve-avd",
    packageName: "serve-avd",
    entrypoint: "dist/serve-avd.js",
    // serve-avd drives adb; Octant's device surfaces exist on macOS and Linux.
    platforms: ["darwin", "linux"],
  },
  {
    tool: "opencode",
    packageName: "@opencode/cli",
    entrypoint: "bin/opencode",
    platforms: ["darwin", "linux"],
    runtime: "executable",
    // The platform package is a native binary larger than the device-tool
    // trees, and its wrapper runs a lifecycle script. Stage the platform
    // package on demand instead of shipping that script or the binary in the app.
    shipInApp: false,
    maxArchiveBytes: 128 * 1024 * 1024,
    platformPackages: {
      "darwin-arm64": "@opencode/cli-darwin-arm64",
      "darwin-x64": "@opencode/cli-darwin-x64",
      "linux-arm64": "@opencode/cli-linux-arm64",
      "linux-x64": "@opencode/cli-linux-x64",
    },
  },
];

/**
 * The version pinned into shipped app bundles. `integrity` is the registry's
 * published sha512 of the tarball — the package-level analogue of the driver
 * release's sha256; there is no publisher signature for an npm package, so the
 * hash plus the pinned URL is what we verify.
 */
export const BUNDLED_MANAGED_TOOL_RELEASES: ReadonlyArray<ManagedToolRelease> = [
  {
    packageName: "serve-sim",
    version: "0.1.46",
    url: "https://registry.npmjs.org/serve-sim/-/serve-sim-0.1.46.tgz",
    integrity:
      "sha512-zdKNOv+6qbdCkhtUMEbzX0ymrb2EJK54dZvs+n3YOK15LEcpapGA9/NpSSYEphpI420kTgUWqKNmkxLoWWaVzg==",
  },
  {
    packageName: "serve-avd",
    version: "0.1.3",
    url: "https://registry.npmjs.org/serve-avd/-/serve-avd-0.1.3.tgz",
    integrity:
      "sha512-Ya3eQFp17YHcjXYIzWdLLPG9lNLgaXgnd8D+RDY8xLvGQQtPsMHBCOUyPqtYJ5VeePchQDbkCg6h9ch2q5PrLQ==",
  },
  {
    packageName: "@opencode/cli",
    version: "2.0.22",
    url: "https://registry.npmjs.org/@opencode/cli/-/cli-2.0.22.tgz",
    integrity:
      "sha512-BJzGgplZ3owjPh4Cq5vbe7zMSgYXugOMJmrdlRriUl/9/rKitvK/F+ruk5JJOlIe4fw0bQ+UBAvN8+XGbUqTPw==",
  },
];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

export function isManagedToolRelease(value: ManagedToolRelease): boolean {
  if (!PACKAGE_NAME.test(value.packageName) || !VERSION.test(value.version)) return false;
  if (!SHA512_INTEGRITY.test(value.integrity)) return false;
  const fileBase = value.packageName.startsWith("@")
    ? value.packageName.slice(value.packageName.lastIndexOf("/") + 1)
    : value.packageName;
  return (
    value.url ===
    `https://${REGISTRY_ORIGIN}/${value.packageName}/-/${fileBase}-${value.version}.tgz`
  );
}

/** Platform package for this host, when the descriptor stages one instead of `packageName`. */
export function platformPackageName(
  descriptor: ManagedToolDescriptor,
  platform: NodeJS.Platform,
  arch: string,
): string | undefined {
  return descriptor.platformPackages?.[`${platform}-${arch}`];
}

function releasePackageAllowed(descriptor: ManagedToolDescriptor, packageName: string): boolean {
  if (descriptor.platformPackages === undefined) return packageName === descriptor.packageName;
  return Object.values(descriptor.platformPackages).includes(packageName);
}

/**
 * True when `candidate` is the managed root or a path inside it. An update
 * may write only there. Choosing Octant's copy selects that location; it
 * never authorizes replacing a binary stored somewhere else.
 */
export function isInsideManagedToolLocation(managedRoot: string, candidate: string): boolean {
  const root = resolve(managedRoot);
  const target = resolve(candidate);
  return target === root || target.startsWith(`${root}${sep}`);
}

/**
 * Turns the upstream package's latest release into the bytes this host
 * stages. A platform package is read at the same version; its lifecycle
 * script is never executed.
 */
export async function resolveManagedToolRelease(
  descriptor: ManagedToolDescriptor,
  upstream: ManagedToolRelease,
  fetchJson: ManagedFetch,
  signal: AbortSignal,
  host: { readonly platform: NodeJS.Platform; readonly arch: string } = {
    platform: process.platform,
    arch: process.arch,
  },
): Promise<ManagedToolRelease> {
  if (upstream.packageName !== descriptor.packageName || !isManagedToolRelease(upstream))
    throw new Error("Tool release is invalid.");
  const platformPackage = platformPackageName(descriptor, host.platform, host.arch);
  if (platformPackage === undefined) {
    if (descriptor.platformPackages !== undefined)
      throw new Error("Tool has no build for this host.");
    return upstream;
  }
  if (!PACKAGE_NAME.test(platformPackage)) throw new Error("Tool name is invalid.");
  const bytes = await fetchJson(
    `https://${REGISTRY_ORIGIN}/${platformPackage}/${upstream.version}`,
    signal,
  );
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new Error("Tool metadata is too large.");
  const document: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const release = managedToolReleaseFromResponse(platformPackage, document);
  if (release === undefined || release.version !== upstream.version)
    throw new Error("No verifiable tool release was found.");
  return release;
}

/** Reads one version entry of the registry package document into a verifiable release. */
export function managedToolReleaseFromResponse(
  packageName: string,
  value: unknown,
): ManagedToolRelease | undefined {
  if (!record(value)) return undefined;
  const version = readString(value.version);
  const dist = record(value.dist) ? value.dist : undefined;
  if (version === undefined || dist === undefined) return undefined;
  const url = readString(dist.tarball);
  const integrity = readString(dist.integrity);
  if (url === undefined || integrity === undefined) return undefined;
  const candidate: ManagedToolRelease = { packageName, version, url, integrity };
  return isManagedToolRelease(candidate) ? candidate : undefined;
}

/** Bounds a download to https on the npm registry, following at most 3 redirects. */
export async function boundedRegistryDownload(
  url: string,
  limit: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  let current = url;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const parsed = new URL(current);
    if (
      parsed.protocol !== "https:" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.hostname !== REGISTRY_ORIGIN
    )
      throw new Error("Tool download origin refused.");
    const response = await fetch(current, {
      signal,
      redirect: "manual",
      credentials: "omit",
      headers: { "user-agent": "Octant", accept: "application/octet-stream" },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (location === null) throw new Error("Tool download redirect is incomplete.");
      current = new URL(location, current).href;
      continue;
    }
    if (!response.ok || response.body === null) throw new Error("Tool download unavailable.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > limit) throw new Error("Tool download exceeds the size limit.");
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
    }
    return Buffer.concat(chunks, size);
  }
  throw new Error("Tool download redirected too many times.");
}

/**
 * Reads the latest release from the full package document's `dist-tags`.
 * The registry's `/<name>/latest` shortcut has been observed answering 200
 * with the body `[object Object]`, so it is not trusted as the source.
 */
export async function latestManagedToolRelease(
  packageName: string,
  fetchJson: ManagedFetch,
  signal: AbortSignal,
): Promise<ManagedToolRelease> {
  if (!PACKAGE_NAME.test(packageName)) throw new Error("Tool name is invalid.");
  const bytes = await fetchJson(`https://${REGISTRY_ORIGIN}/${packageName}`, signal);
  if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new Error("Tool metadata is too large.");
  const document: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const tags =
    record(document) && record(document["dist-tags"]) ? document["dist-tags"] : undefined;
  const latest = tags === undefined ? undefined : readString(tags.latest);
  const versions = record(document) && record(document.versions) ? document.versions : undefined;
  const release =
    latest === undefined || versions === undefined
      ? undefined
      : managedToolReleaseFromResponse(packageName, versions[latest]);
  if (release === undefined) throw new Error("No verifiable tool release was found.");
  return release;
}

interface PackageManifest {
  readonly name: string;
  readonly version: string;
  readonly dependencies: Readonly<Record<string, string>>;
  readonly bin?: string;
}

function manifestFrom(value: unknown, expectedName: string): PackageManifest {
  if (!record(value)) throw new Error("Tool package manifest is invalid.");
  const name = readString(value.name);
  const version = readString(value.version);
  if (name !== expectedName || version === undefined || !VERSION.test(version))
    throw new Error("Tool package identity does not match its release.");
  const dependencies: Record<string, string> = {};
  if (record(value.dependencies)) {
    for (const [dependencyName, range] of Object.entries(value.dependencies)) {
      if (!PACKAGE_NAME.test(dependencyName)) throw new Error("Tool dependency name is invalid.");
      if (typeof range !== "string") throw new Error("Tool dependency range is invalid.");
      dependencies[dependencyName] = range;
    }
  }
  const binField = value.bin;
  let bin: string | undefined;
  if (typeof binField === "string") bin = binField;
  else if (record(binField)) bin = readString(binField[expectedName]);
  return {
    name,
    version,
    dependencies,
    ...(bin !== undefined && /^[A-Za-z0-9_./@-]+$/.test(bin) && !bin.startsWith("/")
      ? { bin }
      : {}),
  };
}

/** Highest version in `versions` satisfying a caret/exact/tilde range; undefined when none do. */
export function maxSatisfyingVersion(
  range: string,
  versions: ReadonlyArray<string>,
): string | undefined {
  const trimmed = range.trim();
  let best: string | undefined;
  const consider = (version: string) => {
    if (!VERSION.test(version)) return;
    const parts = version.split(".").map(Number);
    const major = parts[0];
    const minor = parts[1];
    const patch = parts[2];
    if (major === undefined || minor === undefined || patch === undefined) return;
    let lower: string | undefined;
    let upperExclusive: string | undefined;
    if (trimmed.startsWith("^")) {
      lower = trimmed.slice(1);
      if (!VERSION.test(lower)) return;
      const base = lower.split(".").map(Number);
      if (base[0] === undefined) return;
      upperExclusive = base[0] === 0 ? `0.${(base[1] ?? 0) + 1}.0` : `${base[0] + 1}.0.0`;
    } else if (trimmed.startsWith("~")) {
      lower = trimmed.slice(1);
      if (!VERSION.test(lower)) return;
      const base = lower.split(".").map(Number);
      if (base[0] === undefined || base[1] === undefined) return;
      upperExclusive = `${base[0]}.${base[1] + 1}.0`;
    } else {
      if (!VERSION.test(trimmed)) return;
      if (version !== trimmed) return;
      lower = trimmed;
      upperExclusive = undefined;
    }
    const below = compareVersions(version, lower) < 0;
    const above = upperExclusive !== undefined && compareVersions(version, upperExclusive) >= 0;
    if (below || above) return;
    if (best === undefined || compareVersions(version, best) > 0) best = version;
  };
  for (const version of versions) consider(version);
  return best;
}

export function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    const x = a[index];
    const y = b[index];
    if (x === undefined || y === undefined) return 0;
    if (x !== y) return x - y;
  }
  return 0;
}

interface RegistryPackageVersion {
  readonly version: string;
  readonly url: string;
  readonly integrity: string;
  readonly dependencies: Readonly<Record<string, string>>;
}

/** Reads a full packument (`/<name>`) into per-version release rows. */
function packageVersionsFromResponse(value: unknown): ReadonlyArray<RegistryPackageVersion> {
  if (!record(value) || !record(value.versions)) return [];
  const rows: RegistryPackageVersion[] = [];
  for (const [version, detail] of Object.entries(value.versions)) {
    if (!VERSION.test(version) || !record(detail)) continue;
    const dist = record(detail.dist) ? detail.dist : undefined;
    const url = dist === undefined ? undefined : readString(dist.tarball);
    const integrity = dist === undefined ? undefined : readString(dist.integrity);
    if (url === undefined || integrity === undefined || !SHA512_INTEGRITY.test(integrity)) continue;
    const dependencies: Record<string, string> = {};
    if (record(detail.dependencies)) {
      for (const [name, range] of Object.entries(detail.dependencies)) {
        if (typeof range === "string" && PACKAGE_NAME.test(name)) dependencies[name] = range;
      }
    }
    rows.push({ version, url, integrity, dependencies });
  }
  return rows;
}

export interface PlannedPackage {
  readonly name: string;
  readonly version: string;
  readonly url: string;
  readonly integrity: string;
  /** Location the package extracts into, relative to the staged root. */
  readonly destination: string;
  readonly dependencies: Readonly<Record<string, string>>;
}

interface ResolutionEdge {
  readonly name: string;
  readonly range: string;
  /** Directory that owns the dependency; nesting goes beneath it. */
  readonly parentDestination: string;
}

/**
 * Resolves the dependency closure of a staged package against the registry.
 * Flat `node_modules` with per-owner nesting on a version conflict — the same
 * placement rule npm applies — bounded so a hostile or malformed closure stops
 * rather than ballooning.
 */
export async function planDependencyClosure(
  root: PackageManifest,
  fetchPackument: ManagedFetch,
  signal: AbortSignal,
): Promise<ReadonlyArray<PlannedPackage>> {
  const planned = new Map<string, PlannedPackage>();
  const satisfied = new Map<string, Map<string, PlannedPackage>>();
  const queue: ResolutionEdge[] = [];
  const enqueue = (edge: ResolutionEdge) => {
    queue.push(edge);
  };
  for (const [name, range] of Object.entries(root.dependencies))
    enqueue({ name, range, parentDestination: "" });

  const registryDocument = async (name: string): Promise<unknown> => {
    const bytes = await fetchPackument(`https://${REGISTRY_ORIGIN}/${name}`, signal);
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) throw new Error("Package metadata is too large.");
    return JSON.parse(new TextDecoder().decode(bytes));
  };

  let fetched = 0;
  while (queue.length > 0) {
    if (planned.size >= MAX_DEPENDENCY_PACKAGES)
      throw new Error("Tool dependency closure exceeds the limit.");
    const edge = queue.shift();
    if (edge === undefined) break;

    // A same-named package already visible to this edge is reused: the flat
    // layer owns it, or an ancestor's nested copy does.
    const flat = planned.get(edge.name);
    if (flat !== undefined && satisfiesRange(flat.version, edge.range)) continue;

    const versions = packageVersionsFromResponse(await registryDocument(edge.name));
    fetched += 1;
    if (fetched > MAX_DEPENDENCY_PACKAGES)
      throw new Error("Tool dependency closure exceeds the limit.");
    const version = maxSatisfyingVersion(
      edge.range,
      versions.map((row) => row.version),
    );
    const row = versions.find((candidate) => candidate.version === version);
    if (row === undefined)
      throw new Error(`No verifiable release satisfies ${edge.name}@${edge.range}.`);

    const hasFlatConflict = flat !== undefined && !satisfiesRange(flat.version, edge.range);
    const destination = hasFlatConflict
      ? `${edge.parentDestination}/node_modules/${edge.name}`
      : `node_modules/${edge.name}`;
    const package_: PlannedPackage = {
      name: edge.name,
      version: row.version,
      url: row.url,
      integrity: row.integrity,
      destination,
      dependencies: row.dependencies,
    };
    if (hasFlatConflict) {
      let nested = satisfied.get(edge.name);
      if (nested === undefined) {
        nested = new Map();
        satisfied.set(edge.name, nested);
      }
      const prior = nested.get(destination);
      if (prior !== undefined) continue;
      nested.set(destination, package_);
    } else {
      planned.set(edge.name, package_);
    }
    for (const [name, range] of Object.entries(row.dependencies))
      enqueue({ name, range, parentDestination: destination });
  }
  const all: PlannedPackage[] = [...planned.values()];
  for (const nested of satisfied.values()) all.push(...nested.values());
  return all;
}

function satisfiesRange(version: string, range: string): boolean {
  return maxSatisfyingVersion(range, [version]) === version;
}

/** Extracts a package tarball under `destination`, rejecting unsafe members. */
async function extractTarballSafely(
  archive: string,
  destination: string,
  signal: AbortSignal,
): Promise<void> {
  const listing = await exec("/usr/bin/tar", ["-tzf", archive], {
    timeout: 60_000,
    maxBuffer: 8 * 1024 * 1024,
    signal,
  });
  const entries = listing.stdout.split("\n").filter((name) => name.trim() !== "");
  for (const name of entries) {
    const relative = name.replace(/^\.\//, "").replace(/^package\//, "");
    if (relative === "") continue;
    if (
      relative.startsWith("/") ||
      relative.startsWith("..") ||
      relative.includes("/../") ||
      name.includes(":")
    )
      throw new Error("Tool archive entries are unsafe.");
  }
  await mkdir(destination, { recursive: true });
  await exec("/usr/bin/tar", ["-xzf", archive, "-C", destination, "--strip-components", "1"], {
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
    signal,
  });
}

function verifySha512(bytes: Uint8Array, integrity: string): void {
  const expected = integrity.replace(/^sha512-/, "");
  const observed = createHash("sha512").update(bytes).digest("base64");
  if (observed !== expected) throw new Error("Tool archive hash does not match.");
}

/**
 * Stages a managed tool release plus its dependency closure into
 * `<root>/<version>` and returns the path to its entrypoint. Nothing inside a
 * candidate is executed during staging.
 */
export async function stageManagedTool(
  descriptor: ManagedToolDescriptor,
  release: ManagedToolRelease,
  root: string,
  fetchBytes: ManagedFetch,
  signal: AbortSignal,
): Promise<StagedManagedTool> {
  if (!releasePackageAllowed(descriptor, release.packageName) || !isManagedToolRelease(release))
    throw new Error("Tool release is invalid.");
  if (!isInsideManagedToolLocation(root, join(root, release.version)))
    throw new Error("Tool activation path is invalid.");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink())
    throw new Error("Tool storage is invalid.");
  const destination = join(root, release.version);
  const stagedEntry = join(destination, descriptor.entrypoint);
  const existing = await lstat(destination).catch(() => undefined);
  if (existing !== undefined) {
    if (!existing.isDirectory() || existing.isSymbolicLink())
      throw new Error("Tool version directory is invalid.");
    await verifyStagedTool(descriptor, destination, release.version);
    return { version: release.version, path: destination, entrypoint: stagedEntry };
  }

  const staging = join(root, `.stage-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    const archiveBytes = await fetchBytes(release.url, signal);
    const archiveLimit = descriptor.maxArchiveBytes ?? MAX_ARCHIVE_BYTES;
    if (archiveBytes.byteLength > archiveLimit)
      throw new Error("Tool archive exceeds the size limit.");
    verifySha512(archiveBytes, release.integrity);
    const archive = join(staging, "release.tgz");
    await writeFileSafe(archive, archiveBytes, signal);

    const packageRoot = join(staging, "pkg");
    await extractTarballSafely(archive, packageRoot, signal);
    const manifest = manifestFrom(
      JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")),
      release.packageName,
    );
    if (manifest.version !== release.version)
      throw new Error("Tool package version does not match its release.");

    const dependencies = await planDependencyClosure(manifest, fetchBytes, signal);
    let totalBytes = archiveBytes.byteLength;
    for (const dependency of dependencies) {
      const dependencyBytes = await fetchBytes(dependency.url, signal);
      totalBytes += dependencyBytes.byteLength;
      if (totalBytes > MAX_PACKAGE_BYTES)
        throw new Error("Tool dependency tree exceeds the size limit.");
      verifySha512(dependencyBytes, dependency.integrity);
      const dependencyArchive = join(staging, `dep-${randomUUID()}.tgz`);
      await writeFileSafe(dependencyArchive, dependencyBytes, signal);
      await extractTarballSafely(
        dependencyArchive,
        join(packageRoot, dependency.destination),
        signal,
      );
      await rm(dependencyArchive, { force: true });
      // The extracted package must be what the closure resolved.
      const dependencyManifest = manifestFrom(
        JSON.parse(
          await readFile(join(packageRoot, dependency.destination, "package.json"), "utf8"),
        ),
        dependency.name,
      );
      if (dependencyManifest.version !== dependency.version)
        throw new Error("Tool dependency version does not match its release.");
    }

    if (manifest.bin !== undefined) {
      const binMetadata = await lstat(join(packageRoot, manifest.bin)).catch(() => undefined);
      if (binMetadata === undefined || !binMetadata.isFile())
        throw new Error("Tool binary path is missing from its package.");
    }
    const entrypointPath = join(packageRoot, descriptor.entrypoint);
    const entrypointMetadata = await lstat(entrypointPath).catch(() => undefined);
    if (entrypointMetadata === undefined || !entrypointMetadata.isFile())
      throw new Error("Tool entry point is missing from its package.");
    if (signal.aborted) throw new Error("Tool staging cancelled.");
    await rm(archive, { force: true });
    await rename(packageRoot, destination);
    return { version: release.version, path: destination, entrypoint: stagedEntry };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

async function writeFileSafe(path: string, bytes: Uint8Array, signal: AbortSignal): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, bytes, { mode: 0o600, signal });
}

async function verifyStagedTool(
  descriptor: ManagedToolDescriptor,
  root: string,
  version: string,
): Promise<void> {
  const parsed: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (!record(parsed)) throw new Error("Tool package manifest is invalid.");
  const name = readString(parsed.name);
  if (name === undefined || !releasePackageAllowed(descriptor, name))
    throw new Error("Tool package identity does not match its release.");
  const manifest = manifestFrom(parsed, name);
  if (manifest.version !== version) throw new Error("Installed tool version is invalid.");
  const entrypoint = await lstat(join(root, descriptor.entrypoint)).catch(() => undefined);
  if (entrypoint === undefined || !entrypoint.isFile())
    throw new Error("Installed tool entry point is missing.");
}

export async function readInstalledManagedTool(
  descriptor: ManagedToolDescriptor,
  root: string,
): Promise<StagedManagedTool | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(join(root, "current.json"), "utf8"));
    if (!record(value) || typeof value.version !== "string" || !VERSION.test(value.version))
      return undefined;
    const path = join(root, value.version);
    await verifyStagedTool(descriptor, path, value.version);
    const entrypoint = join(path, descriptor.entrypoint);
    return { version: value.version, path, entrypoint };
  } catch {
    return undefined;
  }
}

export async function commitManagedTool(root: string, staged: StagedManagedTool): Promise<void> {
  if (
    !VERSION.test(staged.version) ||
    staged.path !== join(root, staged.version) ||
    !isInsideManagedToolLocation(root, staged.path)
  )
    throw new Error("Tool activation path is invalid.");
  const temporary = join(root, `.current-${randomUUID()}.json`);
  await writeFile(temporary, JSON.stringify({ version: staged.version }), {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, join(root, "current.json"));
}
