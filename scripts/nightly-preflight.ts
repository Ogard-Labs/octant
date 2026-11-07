/**
 * The usable-client preflight a scheduled Octant Nightly must pass before it
 * is built, signed or published. It holds no secret: the preview workflow runs
 * it in its own job, with only a read-only `GITHUB_TOKEN`.
 *
 *  channels       Every desktop channel has a class in Nightly's client table,
 *                 and every core channel (pickers, credentials, approvals,
 *                 open-external, notifications, menus, links, the Browser) is
 *                 answered by Nightly's own main.
 *  client-smoke   The synthetic Nightly client smoke passes.
 *  packaged       An unsigned packaged Nightly passes its payload checks, its
 *                 development-build refusal and its test-data host start.
 *  compatibility  The newest published Octant (stable or candidate) publishes
 *                 a host feature list with Nightly's protocol and every feature
 *                 Nightly needs.
 *
 *   bun run nightly:preflight [--only <check>[,<check>…]] [--releases-fixture <file>]
 *
 * `--only` and `--releases-fixture` are for local runs; under CI they refuse,
 * so the workflow cannot pass a partial preflight.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { desktopIdentity } from "@octant/host-runtime";
import { NIGHTLY_HOST_FEATURES } from "@octant/contracts/nightly-browser";
import { DESKTOP_IPC_CHANNELS } from "../apps/desktop/src/ipcChannels";
import {
  NIGHTLY_CLIENT_CHANNELS,
  type NightlyChannelClass,
} from "../apps/desktop/src/nightlyClientChannels";
import { checkPackagedNightlyClient } from "./assert-packaged-nightly-client";
import { HOST_FEATURES_ASSET_NAME, readPublishedHostFeatures } from "./write-host-features";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

type ChannelKey = keyof typeof DESKTOP_IPC_CHANNELS;

/**
 * The channels a person cannot use Nightly without. Canvas prototypes,
 * Browser extensions, Computer Use, managed tools and a second Project window
 * are still brokered and refuse as not available yet; they are not core.
 */
export const NIGHTLY_CORE_CHANNELS = {
  pickers: [
    "selectProjectRoot",
    "selectLocalPluginFolder",
    "selectSkillFolder",
    "selectRuntimeBinary",
    "saveSupportBundle",
    "saveBrowserProofScreenshots",
  ],
  credentials: [
    "providerCredentialStatus",
    "setProviderCredential",
    "clearProviderCredential",
    "listProviderApiKeys",
    "addProviderApiKey",
    "renameProviderApiKey",
    "replaceProviderApiKey",
    "removeProviderApiKey",
    "setActiveProviderApiKey",
    "moveProviderApiKey",
  ],
  approvals: [
    "requestCodeOperationApproval",
    "updateCodeOperationApprovalAnchor",
    "cancelCodeOperationApproval",
    "approvalSurfacePalette",
  ],
  "open-external": [
    "browserSurfaceOpenExternal",
    "openCodeExternalEditor",
    "listOpenInApplications",
    "openCodeCheckoutInApplication",
    "previewHandoff",
  ],
  notifications: ["attentionNotify", "attentionBadge"],
  menus: ["nativeMenu", "openSettings", "startNewAgent", "quitShortcutHint"],
  links: ["codeDeepLink"],
  browser: ["browserHumanPresentation", "browserSurfaceCommand", "browserSurfaceTab"],
} as const satisfies Readonly<Record<string, ReadonlyArray<ChannelKey>>>;

const CHANNEL_CLASSES: ReadonlySet<string> = new Set<NightlyChannelClass>([
  "local",
  "brokered",
  "octant-only",
  "replaced",
]);

export type PreflightResult =
  | { readonly status: "passed"; readonly detail: string }
  | { readonly status: "failed"; readonly reasons: ReadonlyArray<string> };

/**
 * A core channel passes only as `local`. In this table `brokered` means
 * Nightly refuses it as not available yet (`nightlyClientRefusal`); a channel
 * Nightly answers through native-main admission is `local`, because Nightly's
 * own main answers it, and its gaps against what main registers already stop
 * Nightly from starting.
 */
export function checkChannelTable(
  channels: Readonly<Record<string, string>> = DESKTOP_IPC_CHANNELS,
  table: Readonly<Record<string, string>> = NIGHTLY_CLIENT_CHANNELS,
  core: Readonly<Record<string, ReadonlyArray<string>>> = NIGHTLY_CORE_CHANNELS,
): PreflightResult {
  const reasons: string[] = [];
  for (const key of Object.keys(channels)) {
    const channelClass = table[key];
    if (channelClass === undefined) reasons.push(`${key} has no class in Nightly's table.`);
    else if (!CHANNEL_CLASSES.has(channelClass))
      reasons.push(`${key} has an unknown class ${channelClass}.`);
  }
  for (const key of Object.keys(table))
    if (!(key in channels)) reasons.push(`${key} is classified but is not a desktop channel.`);
  let count = 0;
  for (const [group, keys] of Object.entries(core))
    for (const key of keys) {
      count += 1;
      if (!(key in channels))
        reasons.push(`Core ${group} channel ${key} is not a desktop channel.`);
      else if (table[key] !== "local")
        reasons.push(
          `Core ${group} channel ${key} is ${table[key] ?? "unclassified"}; Nightly must answer it.`,
        );
    }
  return reasons.length === 0
    ? {
        status: "passed",
        detail: `${Object.keys(channels).length} channels classified; ${count} core channels local`,
      }
    : { status: "failed", reasons };
}

/** A release as GitHub's releases API returns it; only these fields are read. */
export interface PublishedRelease {
  readonly tag_name: string;
  readonly draft: boolean;
  readonly published_at: string | null;
  readonly assets: ReadonlyArray<{
    readonly id: number;
    readonly name: string;
    readonly size: number;
  }>;
}

/** Octant's own releases: stable `v1.2.3` and candidate `v1.2.3-candidate.<date>.<run>`. */
const OCTANT_RELEASE_TAG = /^v(\d+\.\d+\.\d+(?:-candidate\.\d+\.\d+)?)$/;
const MAX_HOST_FEATURES_BYTES = 64 * 1024;

export function newestOctantRelease(
  releases: ReadonlyArray<PublishedRelease>,
): PublishedRelease | undefined {
  return releases
    .filter(
      (release) =>
        !release.draft &&
        release.published_at !== null &&
        OCTANT_RELEASE_TAG.test(release.tag_name),
    )
    .sort((left, right) => (right.published_at ?? "").localeCompare(left.published_at ?? ""))[0];
}

/**
 * Compare what this Nightly needs with what the newest published Octant says
 * its host offers. The document is unsigned and rides on a release any
 * repository writer can change, so this is advisory: it stops a scheduled
 * Nightly that would meet "Needs a newer Octant" everywhere, and is never read
 * outside CI.
 */
export async function checkPublishedCompatibility(input: {
  readonly releases: ReadonlyArray<PublishedRelease>;
  readonly download: (assetId: number) => Promise<unknown>;
  readonly required?: ReadonlyArray<string>;
}): Promise<PreflightResult> {
  const required = input.required ?? NIGHTLY_HOST_FEATURES;
  const publishFirst = (features: ReadonlyArray<string>, why: string): PreflightResult => ({
    status: "failed",
    reasons: [
      `Publish an Octant candidate with these host features first: ${features.join(", ")}. ${why}`,
    ],
  });
  const release = newestOctantRelease(input.releases);
  if (release === undefined) return publishFirst(required, "No Octant release is published.");
  const version = OCTANT_RELEASE_TAG.exec(release.tag_name)?.[1] ?? release.tag_name;
  const asset = release.assets.find((candidate) => candidate.name === HOST_FEATURES_ASSET_NAME);
  if (asset === undefined)
    return publishFirst(required, `Octant ${version} has no ${HOST_FEATURES_ASSET_NAME}.`);
  if (asset.size > MAX_HOST_FEATURES_BYTES)
    return publishFirst(required, `Octant ${version}'s ${HOST_FEATURES_ASSET_NAME} is too large.`);
  let value: unknown;
  try {
    value = await input.download(asset.id);
  } catch (error) {
    return publishFirst(
      required,
      `Octant ${version}'s ${HOST_FEATURES_ASSET_NAME} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const published = readPublishedHostFeatures(value);
  if (published.status === "unreadable")
    return publishFirst(required, `Octant ${version}'s ${HOST_FEATURES_ASSET_NAME} is unreadable.`);
  if (published.status === "protocol-mismatch")
    return publishFirst(
      required,
      `Octant ${version} speaks native client protocol ${published.published}; this Nightly speaks ${published.expected}.`,
    );
  // A document copied from another release would describe a host this Octant is not.
  if (String(published.document.octantVersion) !== version)
    return publishFirst(
      required,
      `Octant ${version}'s ${HOST_FEATURES_ASSET_NAME} describes Octant ${published.document.octantVersion}.`,
    );
  const offered = new Set(published.document.hostFeatures);
  const missing = required.filter((feature) => !offered.has(feature));
  if (missing.length > 0) return publishFirst(missing, `Octant ${version} does not offer them.`);
  return {
    status: "passed",
    detail: `Octant ${version} offers protocol ${published.document.nativeClientProtocol} and all ${required.length} features`,
  };
}

/** Read releases with the workflow's read-only token; GitHub lists newest first. */
export async function fetchPublishedReleases(
  repository: string,
  token: string | undefined,
): Promise<{
  readonly releases: ReadonlyArray<PublishedRelease>;
  readonly download: (assetId: number) => Promise<unknown>;
}> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  const api = `https://api.github.com/repos/${repository}`;
  const releases: PublishedRelease[] = [];
  for (let page = 1; page <= 3; page += 1) {
    const response = await fetch(`${api}/releases?per_page=100&page=${page}`, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub listed releases with HTTP ${response.status}.`);
    const batch = (await response.json()) as ReadonlyArray<PublishedRelease>;
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  return {
    releases,
    download: async (assetId) => {
      // The asset endpoint redirects to storage that refuses a second
      // credential, so the redirect is followed without the token.
      const response = await fetch(`${api}/releases/assets/${assetId}`, {
        headers: { ...headers, Accept: "application/octet-stream" },
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      const location = response.headers.get("location");
      const body =
        response.status >= 300 && response.status < 400 && location !== null
          ? await fetch(location, { signal: AbortSignal.timeout(30_000) })
          : response;
      if (!body.ok) throw new Error(`HTTP ${body.status}`);
      const text = await body.text();
      if (text.length > MAX_HOST_FEATURES_BYTES) throw new Error("the document is too large");
      return JSON.parse(text) as unknown;
    },
  };
}

function runScript(
  script: string,
  env: Readonly<Record<string, string>> = {},
): { readonly status: number; readonly stdout: string } {
  const ran = spawnSync(process.execPath, [join(root, "scripts", script)], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    timeout: 3_600_000,
  });
  process.stdout.write(ran.stdout ?? "");
  return { status: ran.status ?? 1, stdout: ran.stdout ?? "" };
}

/**
 * The packaged smoke reads its refusal alert through System Events and marks
 * that check unverified, still exiting 0, when it has no Accessibility access.
 * The preflight says so rather than reporting the refusal checked.
 */
export function refusalVerified(smokeOutput: string): boolean {
  return !/^unverified\s+2\. /m.test(smokeOutput);
}

async function clientSmoke(): Promise<PreflightResult> {
  const { status } = runScript("smoke-nightly-client.ts");
  return status === 0
    ? { status: "passed", detail: "scripts/smoke-nightly-client.ts passed" }
    : { status: "failed", reasons: [`scripts/smoke-nightly-client.ts exited ${status}.`] };
}

/**
 * The unsigned packaged smoke packages Nightly, checks its version, its
 * development-build refusal (read through System Events: without Accessibility
 * access that one check reports unverified rather than failing) and its
 * test-data host. The bundle it keeps is then checked as a release would be,
 * apart from the Developer ID, and removed.
 */
async function packagedSmoke(): Promise<PreflightResult> {
  if (process.platform !== "darwin" || process.arch !== "arm64")
    return { status: "failed", reasons: ["The packaged Nightly check needs Apple Silicon macOS."] };
  const out = join(root, "out");
  const before = new Set(existsSync(out) ? readdirSync(out) : []);
  try {
    const { status, stdout } = runScript("smoke-packaged-nightly-unsigned.ts", {
      OCTANT_NIGHTLY_PACKAGED_SMOKE_KEEP: "1",
    });
    if (status !== 0)
      return {
        status: "failed",
        reasons: [`scripts/smoke-packaged-nightly-unsigned.ts exited ${status}.`],
      };
    const bundle = join(out, `${desktopIdentity("nightly").productName}.app`);
    const checked = await checkPackagedNightlyClient({ bundle, signature: { kind: "any" } });
    if (checked.status === "refused") return { status: "failed", reasons: checked.reasons };
    if (refusalVerified(stdout))
      return {
        status: "passed",
        detail: "unsigned packaged Nightly: payload, refusal and test host checked",
      };
    console.log(
      "::warning::The development-build refusal was not read: this runner has no Accessibility access for System Events.",
    );
    return {
      status: "passed",
      detail:
        "unsigned packaged Nightly: payload and test host checked; development-build refusal unverified (no Accessibility access)",
    };
  } finally {
    if (existsSync(out))
      for (const entry of readdirSync(out))
        if (!before.has(entry)) await rm(join(out, entry), { recursive: true, force: true });
  }
}

async function compatibility(fixture: string | undefined): Promise<PreflightResult> {
  if (fixture !== undefined) {
    const parsed = JSON.parse(await readFile(fixture, "utf8")) as {
      readonly releases: ReadonlyArray<PublishedRelease>;
      readonly assets: Readonly<Record<string, unknown>>;
    };
    return checkPublishedCompatibility({
      releases: parsed.releases,
      download: async (assetId) => {
        if (!(String(assetId) in parsed.assets)) throw new Error("HTTP 404");
        return parsed.assets[String(assetId)];
      },
    });
  }
  const repository = process.env.GITHUB_REPOSITORY ?? "Ogard-Labs/octant";
  return checkPublishedCompatibility(
    await fetchPublishedReleases(repository, process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN),
  );
}

export const PREFLIGHT_CHECKS = ["channels", "client-smoke", "packaged", "compatibility"] as const;
export type PreflightCheck = (typeof PREFLIGHT_CHECKS)[number];

export function parsePreflightCommand(
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
): { readonly checks: ReadonlyArray<PreflightCheck>; readonly fixture?: string } {
  let checks: ReadonlyArray<PreflightCheck> = PREFLIGHT_CHECKS;
  let fixture: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument !== "--only" && argument !== "--releases-fixture")
      throw new Error(`Unknown argument ${argument}.`);
    if (value === undefined || value.startsWith("--"))
      throw new Error(`${argument} needs a value.`);
    index += 1;
    if (env.CI === "true" || env.GITHUB_ACTIONS === "true")
      throw new Error(`${argument} is for local runs; CI runs every check against GitHub.`);
    if (argument === "--releases-fixture") {
      fixture = value;
      continue;
    }
    const named = value.split(",");
    for (const name of named)
      if (!(PREFLIGHT_CHECKS as ReadonlyArray<string>).includes(name))
        throw new Error(`Unknown check ${name}; the checks are ${PREFLIGHT_CHECKS.join(", ")}.`);
    checks = PREFLIGHT_CHECKS.filter((check) => named.includes(check));
  }
  return { checks, ...(fixture !== undefined ? { fixture } : {}) };
}

if (import.meta.main) {
  const command = parsePreflightCommand(process.argv.slice(2), process.env);
  const results: Array<readonly [PreflightCheck, PreflightResult]> = [];
  for (const check of command.checks) {
    console.log(`\n== Nightly preflight: ${check}`);
    let result: PreflightResult;
    try {
      result =
        check === "channels"
          ? checkChannelTable()
          : check === "client-smoke"
            ? await clientSmoke()
            : check === "packaged"
              ? await packagedSmoke()
              : await compatibility(command.fixture);
    } catch (error) {
      result = {
        status: "failed",
        reasons: [error instanceof Error ? error.message : String(error)],
      };
    }
    results.push([check, result]);
  }
  console.log("\nNightly preflight");
  for (const [check, result] of results) {
    if (result.status === "passed") console.log(`pass  ${check} — ${result.detail}`);
    else for (const reason of result.reasons) console.log(`::error::${check}: ${reason}`);
  }
  const skipped = PREFLIGHT_CHECKS.filter((check) => !command.checks.includes(check));
  if (skipped.length > 0) console.log(`not run: ${skipped.join(", ")} (local partial run)`);
  process.exit(results.every(([, result]) => result.status === "passed") ? 0 : 1);
}
