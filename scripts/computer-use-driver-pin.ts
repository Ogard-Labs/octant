/**
 * Keeps the bundled computer-use driver current. Octant's driver SDK is built
 * into the app, so the app can update its driver by itself only within one
 * wire contract; a release on a newer contract needs a new Octant with the
 * matching SDK. In November 2026 the pin sat on 0.38.0 (contract 0.8) for a
 * month while upstream moved to 0.62.1 (contract 0.9), and every in-app update
 * was refused at the handshake.
 *
 * `check` compares upstream's newest driver release with the pin: the
 * contract, and the canonical manifest schemas of the driver tools Octant
 * calls. Octant sends the flat MCP form of those arguments, which the manifest
 * does not publish, so the comparison only flags a release to read closely.
 * `apply` rewrites every pinned value for that release. The weekly
 * `computer-use-driver` workflow runs both and opens one draft pull request;
 * a person still runs the live Computer use check before it merges.
 *
 * This reaches the network, so it never runs in `verify` or the app.
 */
import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { BUNDLED_CUA_DRIVER } from "../apps/desktop/src/computerUseDriverRelease";
import {
  COMPUTER_DRIVER_CONTRACT,
  isNewerComputerDriver,
} from "../apps/desktop/src/computerUseDriverUpdates";

/**
 * The driver tools Octant calls (computerUseControlHost.ts,
 * computerUseSdkRuntime.ts, computerUseProbe.ts). `launch_app`,
 * `check_permissions` and `health_report` are not in upstream's contract
 * manifest, so only the live check covers them.
 */
export const CALLED_DRIVER_TOOLS = [
  "list_apps",
  "list_windows",
  "get_window_state",
  "start_session",
  "end_session",
  "click",
  "type_text",
  "press_key",
  "scroll",
] as const;

const VERSION = /^(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})\.(0|[1-9]\d{0,7})$/;
const API = "https://api.github.com/repos/trycua/cua";

export interface DriverPin {
  readonly version: string;
  readonly sha256: string;
  readonly assetId: number;
  readonly assetBytes: number;
  readonly contract: { readonly major: number; readonly minor: number };
}

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function github(fetch: Fetch, path: string): Promise<unknown> {
  const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
  const response = await fetch(`${API}${path}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "octant-driver-pin",
      ...(token === undefined || token === "" ? {} : { authorization: `Bearer ${token}` }),
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path}.`);
  return response.json();
}

/** Upstream's newest stable driver release with its macOS asset, as a pin. */
export async function newestDriverRelease(fetch: Fetch): Promise<Omit<DriverPin, "contract">> {
  let newest: Omit<DriverPin, "contract"> | undefined;
  for (let page = 1; page <= 5; page += 1) {
    const releases = await github(fetch, `/releases?per_page=20&page=${page}`);
    if (!Array.isArray(releases)) throw new Error("The release listing is invalid.");
    for (const release of releases) {
      if (!record(release) || release.draft === true || typeof release.tag_name !== "string")
        continue;
      const version = release.tag_name.replace(/^cua-driver-rs-v/, "");
      if (release.tag_name !== `cua-driver-rs-v${version}` || !VERSION.test(version)) continue;
      const assets = Array.isArray(release.assets) ? release.assets : [];
      const asset: unknown = assets.find(
        (item: unknown) =>
          record(item) && item.name === `cua-driver-rs-${version}-darwin-universal-binary.tar.gz`,
      );
      if (
        !record(asset) ||
        typeof asset.id !== "number" ||
        typeof asset.size !== "number" ||
        typeof asset.digest !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(asset.digest)
      )
        continue;
      if (newest === undefined || isNewerComputerDriver(version, newest.version))
        newest = {
          version,
          sha256: asset.digest.slice("sha256:".length),
          assetId: asset.id,
          assetBytes: asset.size,
        };
    }
    if (releases.length < 20) break;
  }
  if (newest === undefined) throw new Error("No stable driver release with a macOS asset.");
  return newest;
}

/** The contract manifest upstream publishes at a driver release's tag. */
export async function driverManifest(
  fetch: Fetch,
  version: string,
): Promise<Readonly<Record<string, unknown>>> {
  if (!VERSION.test(version)) throw new Error("The driver version is invalid.");
  const file = await github(
    fetch,
    `/contents/libs/cua-driver/contract/manifest.json?ref=cua-driver-rs-v${version}`,
  );
  if (!record(file) || file.encoding !== "base64" || typeof file.content !== "string")
    throw new Error("The contract manifest is invalid.");
  const manifest: unknown = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
  if (!record(manifest) || typeof manifest.contract_version !== "string")
    throw new Error("The contract manifest is invalid.");
  return manifest;
}

export function manifestContract(manifest: Readonly<Record<string, unknown>>) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(
    String(manifest.contract_version),
  );
  if (match === null) throw new Error("The contract version is invalid.");
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/** Each called tool whose published input or output schema differs, or that is gone. */
export function changedCalledTools(
  pinned: Readonly<Record<string, unknown>>,
  candidate: Readonly<Record<string, unknown>>,
): ReadonlyArray<string> {
  const tools = (manifest: Readonly<Record<string, unknown>>) =>
    new Map(
      (Array.isArray(manifest.tools) ? manifest.tools : [])
        .filter(record)
        .map((tool) => [String(tool.name), tool] as const),
    );
  const before = tools(pinned);
  const after = tools(candidate);
  const shape = (tool: Readonly<Record<string, unknown>> | undefined) =>
    tool === undefined
      ? undefined
      : JSON.stringify([tool.input_schema, tool.success_output_schema]);
  return CALLED_DRIVER_TOOLS.filter((name) => {
    if (!before.has(name)) return false;
    return !after.has(name) || shape(before.get(name)) !== shape(after.get(name));
  });
}

function replaceOnce(text: string, pattern: RegExp, replacement: string, file: string): string {
  const matches = text.match(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`));
  if (matches?.length !== 1)
    throw new Error(`${file}: expected one pinned value, found ${matches?.length ?? 0}.`);
  return text.replace(pattern, replacement);
}

/** Each pinned file's new text. Throws when a file no longer has exactly one pin to move. */
export function pinnedFiles(
  read: (path: string) => string,
  pin: DriverPin,
): ReadonlyArray<{ readonly path: string; readonly text: string }> {
  const v = pin.version;
  const files: Array<{ path: string; text: string }> = [];
  const edit = (path: string, ...rules: ReadonlyArray<readonly [RegExp, string]>) => {
    let text = read(path);
    for (const [pattern, replacement] of rules)
      text = replaceOnce(text, pattern, replacement, path);
    files.push({ path, text });
  };
  edit(
    "apps/desktop/package.json",
    [/"@trycua\/cua-driver": "[0-9.]+"/, `"@trycua/cua-driver": "${v}"`],
    [/"@trycua\/cua-driver-darwin-arm64": "[0-9.]+"/, `"@trycua/cua-driver-darwin-arm64": "${v}"`],
  );
  edit("package.json", [
    /"@trycua\/cua-driver@[0-9.]+": "patches\/cua-driver-[0-9.]+\.patch"/,
    `"@trycua/cua-driver@${v}": "patches/cua-driver-${v}.patch"`,
  ]);
  edit(
    "apps/desktop/src/computerUseDriverRelease.ts",
    [/(BUNDLED_CUA_DRIVER: ComputerDriverRelease = \{\n {2}version: )"[0-9.]+"/, `$1"${v}"`],
    [
      /cua-driver-rs-v[0-9.]+\/cua-driver-rs-[0-9.]+-darwin-universal-binary\.tar\.gz"/,
      `cua-driver-rs-v${v}/cua-driver-rs-${v}-darwin-universal-binary.tar.gz"`,
    ],
    [/(\n {2}sha256: )"[a-f0-9]{64}"/, `$1"${pin.sha256}"`],
  );
  edit("apps/desktop/src/computerUseDriverUpdates.ts", [
    /COMPUTER_DRIVER_CONTRACT = \{ major: \d+, minor: \d+ \}/,
    `COMPUTER_DRIVER_CONTRACT = { major: ${pin.contract.major}, minor: ${pin.contract.minor} }`,
  ]);
  edit("scripts/packaged-browser-owner-driver-cache.ts", [
    /PINNED_DRIVER_ASSET = \{ id: \d+, bytes: \d+ \}/,
    `PINNED_DRIVER_ASSET = { id: ${pin.assetId}, bytes: ${pin.assetBytes} }`,
  ]);
  return files;
}

async function main(): Promise<void> {
  const root = resolve(import.meta.dirname, "..");
  const command = process.argv[2];
  const expected = process.argv[3];
  if (command !== "check" && !(command === "apply" && expected !== undefined))
    throw new Error("Usage: bun scripts/computer-use-driver-pin.ts check | apply <version>");
  const pinnedVersion = BUNDLED_CUA_DRIVER.version;
  const newest = await newestDriverRelease(fetch);
  const newer = isNewerComputerDriver(newest.version, pinnedVersion);
  const pinnedManifest = await driverManifest(fetch, pinnedVersion);
  const newestManifest = newer ? await driverManifest(fetch, newest.version) : pinnedManifest;
  const contract = manifestContract(newestManifest);
  const pin: DriverPin = { ...newest, contract };
  const contractMoved =
    contract.major !== COMPUTER_DRIVER_CONTRACT.major ||
    contract.minor !== COMPUTER_DRIVER_CONTRACT.minor;
  const changed = changedCalledTools(pinnedManifest, newestManifest);
  const summary = [
    `Moves the bundled computer-use driver from ${pinnedVersion} to ${newest.version}.`,
    "",
    `- Contract: ${COMPUTER_DRIVER_CONTRACT.major}.${COMPUTER_DRIVER_CONTRACT.minor} → ${contract.major}.${contract.minor}${contractMoved ? " (a new contract: installs on the old Octant cannot update to this driver by themselves)" : " (unchanged)"}`,
    `- Called tools whose canonical manifest schema changed: ${changed.length === 0 ? "none" : changed.map((name) => `\`${name}\``).join(", ")}`,
    `- Release notes: https://github.com/trycua/cua/releases?q=cua-driver-rs-v&expanded=true`,
    "",
    "The manifest's schemas are upstream's canonical (`target`) form, not the flat MCP arguments Octant sends, so a change here flags a release to read closely and an empty list proves nothing. Before this merges, a person compares the flat arguments with `cua-driver describe <tool>` for each called tool, runs Settings › Computer use › Test on an Apple Silicon Mac with the packaged build, and has an agent observe, click and type in one app. `launch_app`, `check_permissions` and `health_report` are outside the manifest, so only those checks cover them.",
  ].join("\n");
  if (process.env.GITHUB_OUTPUT !== undefined)
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `newer=${newer}\nversion=${newest.version}\ncontract_moved=${contractMoved}\n`,
    );
  console.log(newer ? summary : `The bundled driver ${pinnedVersion} is current.`);
  if (command === "check" || !newer) return;
  // `check` and `apply` ask upstream separately; a release published between
  // them must not land under the version the workflow already announced.
  if (newest.version !== expected)
    throw new Error(`Upstream moved from ${expected} to ${newest.version}; run the job again.`);
  const texts = new Map<string, string>();
  for (const path of [
    "apps/desktop/package.json",
    "package.json",
    "apps/desktop/src/computerUseDriverRelease.ts",
    "apps/desktop/src/computerUseDriverUpdates.ts",
    "scripts/packaged-browser-owner-driver-cache.ts",
  ])
    texts.set(path, await readFile(join(root, path), "utf8"));
  const read = (path: string) => {
    const text = texts.get(path);
    if (text === undefined) throw new Error(`${path} was not read.`);
    return text;
  };
  for (const file of pinnedFiles(read, pin)) await writeFile(join(root, file.path), file.text);
  await rename(
    join(root, `patches/cua-driver-${pinnedVersion}.patch`),
    join(root, `patches/cua-driver-${newest.version}.patch`),
  );
}

if (import.meta.main) await main();
