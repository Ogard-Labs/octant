import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, open, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

type FetchPort = (url: string, init: RequestInit) => Promise<Response>;

type InstallerResult = { readonly ok: boolean; readonly upstreamFailure: boolean };
type ArtifactRequest = {
  readonly version: string;
  readonly artifactName: string;
  readonly platform?: string;
  readonly arch?: string;
  readonly isGeneric?: boolean;
  readonly checksums?: Readonly<Record<string, string>>;
  readonly cacheRoot?: string;
  readonly cacheMode: number;
  readonly tempDirectory: string;
  readonly mirrorOptions: { readonly resolveAssetURL: () => Promise<string> };
  readonly downloader: { readonly download: (url: string, target: string) => Promise<void> };
};
export interface ElectronDownloadPort {
  readonly downloadArtifact: (request: ArtifactRequest) => Promise<string>;
  readonly ElectronDownloadCacheMode: { readonly WriteOnly: number };
}
export interface InstalledElectron {
  readonly version: string;
  readonly platform: string;
  readonly arch: string;
  readonly checksums: Readonly<Record<string, string>>;
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function installedElectron(
  value: unknown,
  sums: unknown,
  platform: string,
  arch: string,
): InstalledElectron {
  if (
    !record(value) ||
    typeof value.version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(value.version) ||
    !["darwin", "linux", "win32"].includes(platform) ||
    !["arm64", "x64", "ia32", "armv7l"].includes(arch) ||
    !record(sums)
  )
    throw Error("The installed Electron target is unsupported.");
  const checksums: Record<string, string> = {};
  for (const [name, sum] of Object.entries(sums)) {
    if (!/^[A-Za-z0-9._-]+$/.test(name) || typeof sum !== "string" || !/^[0-9a-f]{64}$/.test(sum))
      throw Error("The installed Electron checksums are invalid.");
    checksums[name] = sum;
  }
  if (checksums[`electron-v${value.version}-${platform}-${arch}.zip`] === undefined)
    throw Error("The installed Electron package has no checksum for this target.");
  return { version: value.version, platform, arch, checksums };
}

/** Keep the ordinary installer authoritative, including extraction and its final verification. */
export async function ensureCiElectron(input: {
  readonly signal: AbortSignal;
  readonly install: () => Promise<InstallerResult>;
  readonly recover: () => Promise<void>;
}) {
  const initial = await input.install();
  if (initial.ok) return "normal";
  if (input.signal.aborted || !initial.upstreamFailure)
    throw Error("The normal Electron installer failed without an upstream download failure.");
  await input.recover();
  input.signal.throwIfAborted();
  if (!(await input.install()).ok)
    throw Error("The normal Electron installer did not verify the recovered artifact.");
  return "recovered";
}

async function boundedBody(
  response: Response,
  maximum: number,
  consume: (bytes: Uint8Array) => Promise<void>,
) {
  const reader = response.body?.getReader();
  if (reader === undefined) throw Error("The official release response has no body.");
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > maximum) throw Error("The official release response exceeds its bound.");
      await consume(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function cancelBody(response: Response) {
  await response.body?.cancel().catch(() => undefined);
}

/** Only the public API request carries authorization; CDN redirects never receive it. */
export async function fetchElectronAsset(input: {
  readonly target: InstalledElectron;
  readonly destination: string;
  readonly signal: AbortSignal;
  readonly token?: string;
  readonly fetch?: FetchPort;
}) {
  const fetcher = input.fetch ?? fetch;
  const { target, signal } = input;
  const archive = `electron-v${target.version}-${target.platform}-${target.arch}.zip`;
  const api = "https://api.github.com";
  const headers = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    ...(input.token === undefined ? {} : { authorization: `Bearer ${input.token}` }),
  };
  const metadata = await fetcher(
    `${api}/repos/electron/electron/releases/tags/v${target.version}`,
    {
      headers,
      redirect: "error",
      signal,
    },
  );
  if (!metadata.ok) {
    await cancelBody(metadata);
    throw Error(`The official Electron release API refused metadata (${metadata.status}).`);
  }
  const chunks: Buffer[] = [];
  await boundedBody(metadata, 2_000_000, async (bytes) => {
    chunks.push(Buffer.from(bytes));
  });
  const release: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    !record(release) ||
    release.tag_name !== `v${target.version}` ||
    release.draft !== false ||
    !Array.isArray(release.assets)
  )
    throw Error("The official Electron release metadata does not match the installed version.");
  const matches = release.assets.filter(
    (asset: unknown) => record(asset) && asset.name === archive,
  );
  const asset: unknown = matches[0];
  if (
    matches.length !== 1 ||
    !record(asset) ||
    !Number.isSafeInteger(asset.id) ||
    typeof asset.id !== "number" ||
    asset.id < 1 ||
    asset.url !== `${api}/repos/electron/electron/releases/assets/${asset.id}` ||
    asset.browser_download_url !==
      `https://github.com/electron/electron/releases/download/v${target.version}/${archive}`
  )
    throw Error("The official Electron asset identity does not match the installed target.");
  let url = asset.url;
  let response: Response | undefined;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const initial = url === asset.url;
    response = await fetcher(url, {
      headers: initial
        ? { ...headers, accept: "application/octet-stream" }
        : { accept: "application/octet-stream" },
      redirect: "manual",
      signal,
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    await cancelBody(response);
    if (location === null) throw Error("The official Electron asset redirect is missing.");
    const next = new URL(location, url);
    if (
      next.protocol !== "https:" ||
      next.hostname !== "release-assets.githubusercontent.com" ||
      next.port !== "" ||
      next.username !== "" ||
      next.password !== "" ||
      next.hash !== ""
    )
      throw Error("The official Electron asset redirected outside its allowed CDN.");
    url = next.href;
  }
  if (response === undefined || !response.ok) {
    if (response !== undefined) await cancelBody(response);
    throw Error("The official Electron asset could not be downloaded.");
  }
  const artifactResponse = response;
  const file = await open(input.destination, "wx", 0o600).catch(async (error: unknown) => {
    await cancelBody(artifactResponse);
    throw error;
  });
  let verified = false;
  try {
    const hash = createHash("sha256");
    await boundedBody(response, 512_000_000, async (bytes) => {
      hash.update(bytes);
      await file.writeFile(bytes);
    });
    if (hash.digest("hex") !== target.checksums[archive])
      throw Error("The official Electron archive differs from the installed package checksum.");
    verified = true;
  } finally {
    await file.close();
    if (!verified) await rm(input.destination, { force: true });
  }
}

export async function recoverCiElectron(input: {
  readonly target: InstalledElectron;
  readonly get: ElectronDownloadPort;
  readonly signal: AbortSignal;
  readonly token?: string;
  readonly cacheRoot?: string;
  readonly fetch?: FetchPort;
}) {
  const temporary = await mkdtemp(join(tmpdir(), "octant-ci-electron-"));
  const archive = `electron-v${input.target.version}-${input.target.platform}-${input.target.arch}.zip`;
  const standard = `https://github.com/electron/electron/releases/download/v${input.target.version}/`;
  const common = {
    version: input.target.version,
    cacheMode: input.get.ElectronDownloadCacheMode.WriteOnly,
    tempDirectory: temporary,
    ...(input.cacheRoot === undefined ? {} : { cacheRoot: input.cacheRoot }),
  };
  try {
    // Public generic-artifact API writes the normal SHASUMS cache entry too,
    // so a nested packager need not redownload a failing checksum URL.
    await input.get.downloadArtifact({
      ...common,
      artifactName: "SHASUMS256.txt",
      isGeneric: true,
      mirrorOptions: { resolveAssetURL: async () => `${standard}SHASUMS256.txt` },
      downloader: {
        download: async (url, destination) => {
          input.signal.throwIfAborted();
          if (url !== `${standard}SHASUMS256.txt`) throw Error("Unexpected checksum cache URL.");
          await writeFile(
            destination,
            Object.entries(input.target.checksums)
              .map(([name, checksum]) => `${checksum} *${name}\n`)
              .join(""),
            { flag: "wx" },
          );
        },
      },
    });
    await input.get.downloadArtifact({
      ...common,
      artifactName: "electron",
      platform: input.target.platform,
      arch: input.target.arch,
      checksums: input.target.checksums,
      mirrorOptions: { resolveAssetURL: async () => `${standard}${archive}` },
      downloader: {
        download: async (url, destination) => {
          if (url !== `${standard}${archive}`)
            throw Error("Unexpected Electron archive cache URL.");
          await fetchElectronAsset({
            target: input.target,
            destination,
            signal: input.signal,
            ...(input.token === undefined ? {} : { token: input.token }),
            ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
          });
        },
      },
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export function isUpstreamElectronDownloadFailure(message: string): boolean {
  return /Response code (?:429|5\d\d)\b|HTTPError:\s*(?:429|5\d\d)\b|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|fetch failed|network timeout/i.test(
    message,
  );
}

export function requireCiInstallerHost(platform: NodeJS.Platform): void {
  if (platform !== "darwin" && platform !== "linux")
    throw Error("The bounded CI installer requires a macOS or Linux process group.");
}

async function normalInstaller(path: string, signal: AbortSignal): Promise<InstallerResult> {
  requireCiInstallerHost(process.platform);
  signal.throwIfAborted();
  const env = { ...process.env };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  const child = spawn("node", [path], { env, stdio: ["ignore", "ignore", "pipe"], detached: true });
  let error = "";
  child.stderr.on("data", (chunk: Buffer) => {
    error = (error + chunk.toString()).slice(-8192);
  });
  let force: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* The owned installer exited. */
    }
    force ??= setTimeout(() => {
      if (child.pid !== undefined && child.exitCode === null && child.signalCode === null)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          /* The owned installer exited. */
        }
    }, 3000);
  };
  const timer = setTimeout(stop, 90_000);
  signal.addEventListener("abort", stop, { once: true });
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    return {
      ok: code === 0,
      upstreamFailure: isUpstreamElectronDownloadFailure(error),
    };
  } finally {
    clearTimeout(timer);
    if (force !== undefined) clearTimeout(force);
    signal.removeEventListener("abort", stop);
  }
}

function isElectronDownloadApi(value: unknown): value is ElectronDownloadPort {
  return (
    record(value) &&
    typeof value.downloadArtifact === "function" &&
    record(value.ElectronDownloadCacheMode) &&
    typeof value.ElectronDownloadCacheMode.WriteOnly === "number"
  );
}

export async function electronDownloadApi(packagePath: string): Promise<ElectronDownloadPort> {
  const requireElectron = createRequire(packagePath);
  const loaded: unknown = await import(
    pathToFileURL(requireElectron.resolve("@electron/get")).href
  );
  if (!isElectronDownloadApi(loaded))
    throw Error("The installed Electron download API is unavailable.");
  return loaded;
}

export function recoveryTargetFromEnvironment(env: NodeJS.ProcessEnv) {
  // The normal installer keeps every existing option. Recovery refuses a
  // custom target/cache bypass/mirror rather than changing what that means.
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue;
    if (
      /^(electron_(mirror|nightly_mirror|custom_dir|custom_filename|custom_version|override_dist_path|install_platform|install_arch)|(?:npm_config|npm_package_config)_(platform|arch|electron_(mirror|nightly_?mirror|custom_?(dir|filename|version))))$/i.test(
        name,
      ) ||
      (name === "force_no_cache" && value === "true")
    )
      throw Error("Electron recovery refuses custom installer targets or mirrors.");
  }
  return { platform: process.platform, arch: process.arch };
}

async function main() {
  const packagePath = resolve("node_modules/electron/package.json");
  const owner = new AbortController();
  const stop = () => owner.abort();
  const timer = setTimeout(stop, 240_000);
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  try {
    const result = await ensureCiElectron({
      signal: owner.signal,
      install: () => normalInstaller(join(dirname(packagePath), "install.js"), owner.signal),
      recover: async () => {
        const { platform, arch } = recoveryTargetFromEnvironment(process.env);
        const target = installedElectron(
          JSON.parse(await readFile(packagePath, "utf8")),
          JSON.parse(await readFile(join(dirname(packagePath), "checksums.json"), "utf8")),
          platform,
          arch,
        );
        const get = await electronDownloadApi(packagePath);
        console.log(
          "Normal Electron release download failed; recovering the same checksum-verified official asset.",
        );
        await recoverCiElectron({
          target,
          get,
          signal: owner.signal,
          ...(process.env.GH_TOKEN === undefined ? {} : { token: process.env.GH_TOKEN }),
          ...(process.env.electron_config_cache === undefined
            ? {}
            : { cacheRoot: process.env.electron_config_cache }),
        });
      },
    });
    console.log(`Pinned Electron installation verified (${result}).`);
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGTERM", stop);
    process.removeListener("SIGINT", stop);
  }
}

if (import.meta.main)
  void main().catch(() => {
    console.error("Pinned Electron CI installation failed; no unverified artifact was installed.");
    process.exitCode = 1;
  });
