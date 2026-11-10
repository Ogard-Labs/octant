import { createHash } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  BUNDLED_CUA_DRIVER,
  stageComputerDriver,
} from "../apps/desktop/src/computerUseDriverRelease";
import {
  requestOfficialQaApi,
  writeVerifiedElectronFile as writeVerifiedDriverArchive,
} from "./packaged-browser-owner-electron-cache";

const version = "0.38.0";
const assetId = 661454894;
const assetName = "cua-driver-rs-0.38.0-darwin-universal-binary.tar.gz";
const assetBytes = 53208248;
const sha256 = "2bb8dc4a7e69185ffd04c4a9c0eab590bd2c54b72c2c1be13ab675be4f487732";
const browserUrl = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${version}/${assetName}`;
const assetUrl = `https://api.github.com/repos/trycua/cua/releases/assets/${assetId}`;
const repositoryRoot = resolve(import.meta.dirname, "..");
const markerName = "owned-browser-driver-seed.txt";
const record = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function requirePinnedBrowserDriverRelease(value: unknown): void {
  if (
    !record(value) ||
    value.tag_name !== `cua-driver-rs-v${version}` ||
    value.draft !== false ||
    value.prerelease !== true ||
    !Array.isArray(value.assets)
  )
    throw Error("Official metadata does not describe the pinned driver prerelease.");
  const assets = value.assets.filter((asset: unknown) => record(asset) && asset.name === assetName);
  const asset: unknown = assets[0];
  if (
    assets.length !== 1 ||
    !record(asset) ||
    asset.id !== assetId ||
    asset.state !== "uploaded" ||
    asset.size !== assetBytes ||
    asset.digest !== `sha256:${sha256}` ||
    asset.browser_download_url !== browserUrl ||
    asset.url !== assetUrl
  )
    throw Error("Official pinned driver asset identity or digest changed.");
}

export function requireBrowserDriverRedirect(location: string): URL {
  const url = new URL(location);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "release-assets.githubusercontent.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    !/^\/github-production-release-asset\/925270205\/[a-zA-Z0-9-]+$/.test(url.pathname)
  )
    throw Error("Official driver asset API returned an unexpected redirect.");
  return url;
}

/** Never remove an unknown cache, including one that predates this workflow attempt. */
export async function removeOwnedBrowserDriverCache(root: string, owner: string): Promise<void> {
  const cache = join(root, ".computer-use-driver");
  const info = await lstat(cache).catch((error: unknown) => {
    if (record(error) && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (info === undefined) return;
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    info.uid !== process.getuid?.() ||
    (info.mode & 0o077) !== 0 ||
    (await realpath(cache)) !== cache
  )
    throw Error("Refusing cleanup of an unknown driver cache.");
  const marker = join(cache, markerName);
  const identity = await lstat(marker);
  if (
    !identity.isFile() ||
    identity.isSymbolicLink() ||
    identity.uid !== process.getuid?.() ||
    identity.nlink !== 1 ||
    identity.size !== Buffer.byteLength(owner) ||
    (identity.mode & 0o077) !== 0 ||
    (await readFile(marker, "utf8")) !== owner
  )
    throw Error("Refusing cleanup of a driver cache owned by another attempt.");
  await rm(cache, { recursive: true });
  const remaining = await lstat(cache).catch((error: unknown) => {
    if (record(error) && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (remaining !== undefined) throw Error("Owned driver cache cleanup did not finish.");
}

export async function releaseMetadata(signal: AbortSignal): Promise<unknown> {
  const response = await requestOfficialQaApi(
    `https://api.github.com/repos/trycua/cua/releases/tags/cua-driver-rs-v${version}`,
    "application/vnd.github+json",
    signal,
  );
  if (response.status !== 200 || response.body === null) {
    await response.body?.cancel();
    throw Error(`Official driver metadata is unavailable (HTTP ${response.status}).`);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 1024 * 1024) throw Error("Official driver metadata exceeded its bound.");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function archiveResponse(signal: AbortSignal): Promise<Response> {
  const headers = { accept: "application/octet-stream", "user-agent": "Octant native QA" };
  const response = await requestOfficialQaApi(assetUrl, headers.accept, signal);
  if (response.status === 200) return response;
  const location = response.headers.get("location");
  await response.body?.cancel();
  if (response.status !== 302 || location === null)
    throw Error(`Official driver asset API refused the request (HTTP ${response.status}).`);
  return fetch(requireBrowserDriverRedirect(location), {
    headers,
    credentials: "omit",
    redirect: "manual",
    signal,
  });
}

async function main(): Promise<void> {
  const temporary = process.env.RUNNER_TEMP;
  const run = process.env.GITHUB_RUN_ID,
    attempt = process.env.GITHUB_RUN_ATTEMPT;
  if (
    process.platform !== "darwin" ||
    process.arch !== "arm64" ||
    temporary === undefined ||
    run === undefined ||
    attempt === undefined ||
    !/^\d+$/.test(run) ||
    !/^\d+$/.test(attempt)
  )
    throw Error("The owned driver fixture requires its macOS arm64 workflow.");
  for (const path of [repositoryRoot, temporary]) {
    const info = await lstat(path);
    if (
      !info.isDirectory() ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o022) !== 0 ||
      (await realpath(path)) !== resolve(path)
    )
      throw Error("Owned fixture directory identity is unavailable.");
  }
  if (
    BUNDLED_CUA_DRIVER.version !== version ||
    BUNDLED_CUA_DRIVER.url !== browserUrl ||
    BUNDLED_CUA_DRIVER.sha256 !== sha256
  )
    throw Error("Canonical bundled driver pin changed.");
  const owner = `${run}:${attempt}:native:${version}:${sha256}`;
  if (process.argv.length === 3 && process.argv[2] === "--cleanup") {
    await removeOwnedBrowserDriverCache(repositoryRoot, owner);
    console.log("Owned Browser QA driver cache removed or absent.");
    return;
  }
  if (process.argv.length !== 2 || Bun.version !== "1.4.4")
    throw Error("Unexpected driver fixture arguments or runtime.");
  const cache = join(repositoryRoot, ".computer-use-driver");
  const staging = await mkdtemp(join(temporary, "browser-owner-driver-seed."));
  const controller = new AbortController();
  const stop = () => controller.abort(Error("Owned driver fixture cancelled."));
  const timer = setTimeout(stop, 180_000);
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  let cacheCreated = false,
    completed = false;
  try {
    const marker = join(staging, markerName);
    await writeFile(marker, owner, { mode: 0o600, flag: "wx" });
    await mkdir(cache, { mode: 0o700 });
    cacheCreated = true;
    try {
      await link(marker, join(cache, markerName));
    } catch (error) {
      await rmdir(cache);
      cacheCreated = false;
      throw error;
    }
    requirePinnedBrowserDriverRelease(await releaseMetadata(controller.signal));
    const archive = join(staging, assetName);
    await writeVerifiedDriverArchive(
      await archiveResponse(controller.signal),
      archive,
      { bytes: assetBytes, sha256 },
      controller.signal,
    );
    controller.signal.throwIfAborted();
    const staged = await stageComputerDriver(
      BUNDLED_CUA_DRIVER,
      cache,
      controller.signal,
      await readFile(archive),
    );
    controller.signal.throwIfAborted();
    if (staged.version !== version || staged.path !== join(cache, version, "cua-driver"))
      throw Error("Canonical driver staging returned an unexpected identity.");
    const lockSha256 = createHash("sha256")
      .update(await readFile(join(repositoryRoot, "bun.lock")))
      .digest("hex");
    controller.signal.throwIfAborted();
    completed = true;
    console.log(
      JSON.stringify({
        status: "seeded",
        version,
        assetId,
        assetBytes,
        sha256,
        prerelease: true,
        canonicalVerifierCompleted: true,
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
      if (cacheCreated && !completed) await removeOwnedBrowserDriverCache(repositoryRoot, owner);
    }
  }
}

if (import.meta.main) await main();
