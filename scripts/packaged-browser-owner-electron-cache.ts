import { setTimeout as delay } from "node:timers/promises";
import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Cache } from "../node_modules/@electron/get/dist/Cache.js";

const version = "43.7.11";
const archiveName = `electron-v${version}-darwin-arm64.zip`;
const archiveId = 638764792;
const archiveBytes = 123515515;
const archiveHash = "e60ad7fb9c030ddfb5005a6bc54712bc78c2d3e760f7f010fa5b997e956aaefa";
const manifestId = 638792834;
const manifestBytes = 7680;
const manifestHash = "511bcd0f740c686d5f4dab62ccb95d3b48db8ee2ad7ce5f943527fbca7e8735a";
const browserUrl = `https://github.com/electron/electron/releases/download/v${version}/${archiveName}`;
const releaseUrl = `https://api.github.com/repos/electron/electron/releases/tags/v${version}`;
const repositoryRoot = resolve(import.meta.dirname, "..");
const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function requirePinnedElectronRelease(value: unknown): void {
  if (
    !record(value) ||
    value.tag_name !== `v${version}` ||
    value.draft !== false ||
    value.prerelease !== false ||
    !Array.isArray(value.assets)
  )
    throw Error("Official release metadata does not describe the pinned stable Electron release.");
  for (const [id, name, size, hash] of [
    [archiveId, archiveName, archiveBytes, archiveHash],
    [manifestId, "SHASUMS256.txt", manifestBytes, manifestHash],
  ] as const) {
    const assets = value.assets.filter((asset: unknown) => record(asset) && asset.name === name);
    const asset: unknown = assets[0];
    if (
      assets.length !== 1 ||
      !record(asset) ||
      asset.id !== id ||
      asset.state !== "uploaded" ||
      asset.size !== size ||
      asset.digest !== `sha256:${hash}` ||
      asset.url !== `https://api.github.com/repos/electron/electron/releases/assets/${id}` ||
      asset.browser_download_url !==
        `https://github.com/electron/electron/releases/download/v${version}/${name}`
    )
      throw Error("Official release asset identity, size or digest changed.");
  }
}

export function requireOfficialElectronRedirect(location: string): URL {
  const url = new URL(location);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "release-assets.githubusercontent.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    !/^\/github-production-release-asset\/9384267\/[a-zA-Z0-9-]+$/.test(url.pathname)
  )
    throw Error("Official asset API returned an unexpected redirect.");
  return url;
}

export async function writeVerifiedElectronFile(
  response: Response,
  path: string,
  proof: Readonly<{ bytes: number; sha256: string }>,
  signal: AbortSignal,
): Promise<void> {
  if (response.status !== 200 || response.body === null)
    throw Error("Asset response is unavailable.");
  const length = response.headers.get("content-length");
  if (length !== null && length !== String(proof.bytes))
    throw Error("Asset length header changed.");
  const file = await open(path, "wx", 0o600);
  const reader = response.body.getReader();
  const abort = () => void reader.cancel().catch(() => {});
  signal.addEventListener("abort", abort, { once: true });
  let complete = false;
  try {
    let bytes = 0;
    const hash = createHash("sha256");
    for (;;) {
      signal.throwIfAborted();
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > proof.bytes) throw Error("Asset exceeded its pinned byte count.");
      hash.update(chunk.value);
      await file.writeFile(chunk.value);
    }
    if (bytes !== proof.bytes || hash.digest("hex") !== proof.sha256)
      throw Error("Asset bytes do not match the pinned checksum.");
    complete = true;
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    await file.close();
    if (!complete) await rm(path);
  }
}

async function officialApi(url: string, accept: string, signal: AbortSignal): Promise<Response> {
  const token = process.env.OCTANT_QA_GITHUB_TOKEN;
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(url, {
      headers: { accept, ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
      redirect: "manual",
      signal,
    });
    if (attempt >= 2 || (response.status !== 429 && response.status < 500)) return response;
    await response.body?.cancel();
    await delay(200 * (attempt + 1), undefined, { signal });
  }
}

export async function readRelease(signal: AbortSignal): Promise<unknown> {
  const response = await officialApi(releaseUrl, "application/vnd.github+json", signal);
  if (response.status !== 200 || response.body === null) {
    await response.body?.cancel();
    throw Error(`Official release metadata is unavailable (HTTP ${response.status}).`);
  }
  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1024 * 1024) throw Error("Official release metadata exceeded its bound.");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function officialAsset(
  id: typeof archiveId | typeof manifestId,
  signal: AbortSignal,
): Promise<Response> {
  const headers = { accept: "application/octet-stream" };
  const response = await officialApi(
    `https://api.github.com/repos/electron/electron/releases/assets/${id}`,
    headers.accept,
    signal,
  );
  if (response.status === 200) return response;
  const location = response.headers.get("location");
  await response.body?.cancel();
  if (response.status !== 302 || location === null)
    throw Error(`Official asset API refused the request (HTTP ${response.status}).`);
  // Only one redirect to official release storage. The workflow token stays
  // on the fixed GitHub API requests and is never forwarded to asset storage.
  return fetch(requireOfficialElectronRedirect(location), { headers, redirect: "manual", signal });
}

async function ownedCache(): Promise<Readonly<{ root: string; cache: string; owner: string }>> {
  const root = process.env.RUNNER_TEMP;
  if (process.platform !== "darwin" || process.arch !== "arm64" || root === undefined)
    throw Error("This fixture requires the owned macOS arm64 runner.");
  const info = await lstat(root);
  if (
    (await realpath(root)) !== resolve(root) ||
    !info.isDirectory() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o022) !== 0
  )
    throw Error("Runner temporary directory identity is unavailable.");
  const cache = join(root, "browser-owner-electron-cache");
  if (process.env.electron_config_cache !== cache)
    throw Error("Installer cache is not the isolated fixture cache.");
  const run = process.env.GITHUB_RUN_ID;
  const attempt = process.env.GITHUB_RUN_ATTEMPT;
  if (run === undefined || attempt === undefined || !/^\d+$/.test(run) || !/^\d+$/.test(attempt))
    throw Error("Owned workflow identity is unavailable.");
  return { root, cache, owner: `${run}:${attempt}:native:${archiveHash}` };
}

async function main(): Promise<void> {
  const { root, cache, owner } = await ownedCache();
  if (process.argv.length === 3 && process.argv[2] === "--cleanup") {
    const info = await lstat(cache).catch((error: unknown) => {
      if (record(error) && error.code === "ENOENT") return undefined;
      throw error;
    });
    if (info === undefined) return;
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      (await readFile(join(cache, "owned-seed.txt"), "utf8")) !== owner
    )
      throw Error("Refusing cleanup of an unowned Electron cache.");
    await rm(cache, { recursive: true });
    console.log("Owned Browser QA Electron cache removed.");
    return;
  }
  if (process.argv.length !== 2 || Bun.version !== "1.4.4")
    throw Error("Unexpected fixture arguments or Bun version.");
  const installed: unknown = JSON.parse(
    await readFile(join(repositoryRoot, "node_modules/electron/package.json"), "utf8"),
  );
  const bundled: unknown = JSON.parse(
    await readFile(join(repositoryRoot, "node_modules/electron/checksums.json"), "utf8"),
  );
  if (
    !record(installed) ||
    installed.version !== version ||
    !record(bundled) ||
    bundled[archiveName] !== archiveHash
  )
    throw Error("Installed Electron version or bundled checksum changed.");
  const priorInstall = await lstat(join(repositoryRoot, "node_modules/electron/path.txt")).catch(
    (error: unknown) => {
      if (record(error) && error.code === "ENOENT") return undefined;
      throw error;
    },
  );
  // Without path.txt the normal installer cannot take its isInstalled shortcut;
  // it must validate the seeded archive before creating the executable path.
  if (priorInstall !== undefined)
    throw Error("This cache proof requires a fresh Electron install.");
  const staging = await mkdtemp(join(root, "browser-owner-electron-seed."));
  const controller = new AbortController();
  const stop = () => controller.abort(Error("Owned cache seeding cancelled."));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  const timer = setTimeout(stop, 180_000);
  let cacheCreated = false;
  let published = false;
  try {
    requirePinnedElectronRelease(await readRelease(controller.signal));
    const manifest = join(staging, "SHASUMS256.txt");
    await writeVerifiedElectronFile(
      await officialAsset(manifestId, controller.signal),
      manifest,
      { bytes: manifestBytes, sha256: manifestHash },
      controller.signal,
    );
    const entries = (await readFile(manifest, "utf8"))
      .split("\n")
      .filter((line) => line.endsWith(` *${archiveName}`));
    if (entries.length !== 1 || entries[0] !== `${archiveHash} *${archiveName}`)
      throw Error("Official checksum manifest does not match the bundled checksum.");
    const archive = join(staging, archiveName);
    await writeVerifiedElectronFile(
      await officialAsset(archiveId, controller.signal),
      archive,
      { bytes: archiveBytes, sha256: archiveHash },
      controller.signal,
    );
    controller.signal.throwIfAborted();
    await mkdir(cache, { mode: 0o700 });
    cacheCreated = true;
    await writeFile(join(cache, "owned-seed.txt"), owner, { flag: "wx", mode: 0o600 });
    const cachePath = new Cache(cache).getCachePath(browserUrl, archiveName);
    if (
      dirname(dirname(cachePath)) !== cache ||
      !/^[a-f0-9]{64}$/.test(dirname(cachePath).slice(cache.length + 1))
    )
      throw Error("Installed Electron cache layout changed.");
    await mkdir(dirname(cachePath), { mode: 0o700 });
    const lockSha256 = createHash("sha256")
      .update(await readFile(join(repositoryRoot, "bun.lock")))
      .digest("hex");
    controller.signal.throwIfAborted();
    // A hard link publishes only the fully verified, closed file, atomically
    // refusing an existing destination. Staging and cache share RUNNER_TEMP.
    await link(archive, cachePath);
    controller.signal.throwIfAborted();
    published = true;
    console.log(
      JSON.stringify({
        status: "seeded",
        version,
        archiveId,
        archiveBytes,
        sha256: archiveHash,
        officialManifestMatched: true,
        bundledChecksumMatched: true,
        bun: Bun.version,
        lockSha256,
      }),
    );
  } finally {
    controller.abort();
    clearTimeout(timer);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
    try {
      await rm(staging, { recursive: true });
    } finally {
      if (cacheCreated && !published) await rm(cache, { recursive: true });
    }
  }
}

if (import.meta.main) await main();
