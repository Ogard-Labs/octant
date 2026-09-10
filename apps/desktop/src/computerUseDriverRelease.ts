import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, lstat, rm } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  isNewerComputerDriver,
  type ComputerDriverRelease,
  type StagedComputerDriver,
} from "./computerUseDriverUpdates";

const exec = promisify(execFile);
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024;
const MAX_BINARY_BYTES = 192 * 1024 * 1024;
const VERSION = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/;
export const CUA_DRIVER_PUBLISHER_REQUIREMENT =
  'anchor apple generic and identifier "cua-driver" and certificate leaf[subject.OU] = "YCK386LBJ7"';
export const BUNDLED_CUA_DRIVER: ComputerDriverRelease = {
  version: "0.26.0",
  url: "https://github.com/trycua/cua/releases/download/cua-driver-rs-v0.26.0/cua-driver-rs-0.26.0-darwin-universal-binary.tar.gz",
  sha256: "dccfb8f06a5b22a976a2391ca994d8c9ed8562a2cb16e779ee5428204666f265",
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A URL never chooses the publisher or artifact family. */
export function isComputerDriverRelease(value: ComputerDriverRelease): boolean {
  return (
    VERSION.test(value.version) &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    value.url ===
      `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${value.version}/cua-driver-rs-${value.version}-darwin-universal-binary.tar.gz`
  );
}

export function computerDriverReleaseFromResponse(
  value: unknown,
): ComputerDriverRelease | undefined {
  if (!Array.isArray(value) || value.length > 100) return undefined;
  let latest: ComputerDriverRelease | undefined;
  for (const release of value) {
    if (
      !record(release) ||
      release.draft === true ||
      typeof release.tag_name !== "string" ||
      !Array.isArray(release.assets)
    )
      continue;
    const version = release.tag_name.replace(/^cua-driver-rs-v/, "");
    if (release.tag_name !== `cua-driver-rs-v${version}` || !VERSION.test(version)) continue;
    const asset = release.assets.find(
      (item: unknown) =>
        record(item) && item.name === `cua-driver-rs-${version}-darwin-universal-binary.tar.gz`,
    );
    if (
      !record(asset) ||
      typeof asset.browser_download_url !== "string" ||
      typeof asset.digest !== "string"
    )
      continue;
    const candidate = {
      version,
      url: asset.browser_download_url,
      sha256: asset.digest.replace(/^sha256:/, ""),
    };
    if (!isComputerDriverRelease(candidate)) continue;
    if (latest === undefined || isNewerComputerDriver(candidate.version, latest.version))
      latest = candidate;
  }
  return latest;
}

async function boundedDownload(
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
      ![
        "api.github.com",
        "github.com",
        "release-assets.githubusercontent.com",
        "objects.githubusercontent.com",
      ].includes(parsed.hostname)
    )
      throw new Error("Driver download origin refused.");
    const response = await fetch(current, {
      signal,
      redirect: "manual",
      credentials: "omit",
      headers: { "user-agent": "Octant", accept: "application/vnd.github+json" },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (location === null) throw new Error("Driver redirect is incomplete.");
      current = new URL(location, current).href;
      continue;
    }
    if (!response.ok || response.body === null) throw new Error("Driver download unavailable.");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > limit) throw new Error("Driver download exceeds the size limit.");
        chunks.push(next.value);
      }
    } finally {
      await reader.cancel();
    }
    return Buffer.concat(chunks, size);
  }
  throw new Error("Driver download redirected too many times.");
}

export async function latestComputerDriverRelease(
  signal: AbortSignal,
): Promise<ComputerDriverRelease> {
  let latest: ComputerDriverRelease | undefined;
  for (let page = 1; page <= 5; page += 1) {
    const bytes = await boundedDownload(
      `https://api.github.com/repos/trycua/cua/releases?per_page=20&page=${page}`,
      2 * 1024 * 1024,
      signal,
    );
    const releases: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!Array.isArray(releases) || releases.length > 20)
      throw new Error("Driver release page is invalid.");
    const candidate = computerDriverReleaseFromResponse(releases);
    if (
      candidate !== undefined &&
      (latest === undefined || isNewerComputerDriver(candidate.version, latest.version))
    )
      latest = candidate;
    if (releases.length < 20) break;
  }
  if (latest === undefined) throw new Error("No verifiable stable driver release was found.");
  return latest;
}

/** Runs no candidate code until the publisher signature and architecture are verified. */
export async function verifyComputerDriverBinary(path: string, version: string): Promise<void> {
  if (process.platform !== "darwin" || !VERSION.test(version))
    throw new Error("Driver platform is unsupported.");
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_BINARY_BYTES)
    throw new Error("Driver file is invalid.");
  await exec(
    "/usr/bin/codesign",
    ["--verify", "--strict", "--test-requirement", `=${CUA_DRIVER_PUBLISHER_REQUIREMENT}`, path],
    { timeout: 30_000, maxBuffer: 64 * 1024 },
  );
  const architecture = await exec("/usr/bin/lipo", ["-archs", path], { timeout: 10_000 });
  if (!architecture.stdout.split(/\s+/).includes(process.arch === "arm64" ? "arm64" : "x86_64"))
    throw new Error("Driver architecture is incompatible.");
  const observed = await exec(path, ["--version"], {
    timeout: 10_000,
    maxBuffer: 4096,
    env: { PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8" },
  });
  if (observed.stdout.trim() !== `cua-driver ${version}`)
    throw new Error("Driver version does not match its release.");
}

export async function stageComputerDriver(
  release: ComputerDriverRelease,
  root: string,
  signal: AbortSignal,
  archiveBytes?: Uint8Array,
): Promise<StagedComputerDriver> {
  if (!isComputerDriverRelease(release)) throw new Error("Driver release is invalid.");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const rootMetadata = await lstat(root);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink())
    throw new Error("Driver storage is invalid.");
  const destination = join(root, release.version);
  const binary = join(destination, "cua-driver");
  try {
    const existing = await lstat(destination);
    if (!existing.isDirectory() || existing.isSymbolicLink())
      throw new Error("Driver version directory is invalid.");
    await verifyComputerDriverBinary(binary, release.version);
    return { version: release.version, path: binary };
  } catch (error) {
    if (!record(error) || error.code !== "ENOENT") throw error;
  }
  const staging = join(root, `.stage-${randomUUID()}`);
  await mkdir(staging, { mode: 0o700 });
  try {
    const bytes = archiveBytes ?? (await boundedDownload(release.url, MAX_ARCHIVE_BYTES, signal));
    if (
      bytes.byteLength > MAX_ARCHIVE_BYTES ||
      createHash("sha256").update(bytes).digest("hex") !== release.sha256
    )
      throw new Error("Driver archive hash does not match.");
    const archive = join(staging, "release.tar.gz");
    await writeFile(archive, bytes, { mode: 0o600, flag: "wx", signal });
    const listing = await exec("/usr/bin/tar", ["-tzf", archive], {
      timeout: 30_000,
      maxBuffer: 16 * 1024,
      signal,
    });
    const entries = listing.stdout.trim().split("\n");
    if (
      entries.filter((name) => name === "cua-driver").length !== 1 ||
      entries.some((name) => !/^[A-Za-z0-9_.-]+$/.test(name))
    )
      throw new Error("Driver archive entries are unsafe.");
    // Stream one named member to a newly created regular file. Archive paths,
    // modes and symlinks never become filesystem operations.
    const extracted = await exec("/usr/bin/tar", ["-xOzf", archive, "cua-driver"], {
      timeout: 30_000,
      encoding: "buffer",
      maxBuffer: MAX_BINARY_BYTES,
      signal,
    });
    const candidate = join(staging, "cua-driver");
    await writeFile(candidate, extracted.stdout, { mode: 0o755, flag: "wx", signal });
    await verifyComputerDriverBinary(candidate, release.version);
    if (signal.aborted) throw new Error("Driver staging cancelled.");
    await rm(archive);
    await rename(staging, destination);
    return { version: release.version, path: binary };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function readInstalledComputerDriver(
  root: string,
): Promise<StagedComputerDriver | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(join(root, "current.json"), "utf8"));
    if (!record(value) || typeof value.version !== "string" || !VERSION.test(value.version))
      return undefined;
    const path = join(root, value.version, "cua-driver");
    await verifyComputerDriverBinary(path, value.version);
    return { version: value.version, path };
  } catch {
    return undefined;
  }
}

export async function commitComputerDriver(
  root: string,
  driver: StagedComputerDriver,
): Promise<void> {
  if (!VERSION.test(driver.version) || driver.path !== join(root, driver.version, "cua-driver"))
    throw new Error("Driver activation path is invalid.");
  const temporary = join(root, `.current-${randomUUID()}.json`);
  await writeFile(temporary, JSON.stringify({ version: driver.version }), {
    mode: 0o600,
    flag: "wx",
  });
  await rename(temporary, join(root, "current.json"));
}
