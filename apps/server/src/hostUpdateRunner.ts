import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import {
  HEADLESS_ARTIFACT_MANIFEST_FILENAME,
  HEADLESS_ARTIFACT_SIGNATURE_FILENAME,
  isPathConfinedWithin,
} from "@octant/host-runtime";

const execFileAsync = promisify(execFile);

/**
 * Out-of-service upgrade runner for standalone headless hosts.
 *
 * Stopping `octant.service` (systemd) or `app.octant.server` (launchd) sends
 * signals to processes inside that service's control group / job, so a plain
 * child process would die mid-upgrade. This module launches the installed
 * `octant server upgrade` outside the host's own service:
 * - Linux: `systemd-run --user --collect --no-block --unit=octant-upgrade-<id>`
 * - macOS: private one-shot LaunchAgent plist loaded via `launchctl bootstrap`
 *
 * Neither path ever passes `--self-built`, and only safe non-secret path
 * variables are propagated.
 */

export interface UpgradeCommandRunner {
  run(
    command: string,
    args: readonly string[],
  ): Promise<{ readonly stdout: string; readonly stderr: string }>;
}

const defaultRunner: UpgradeCommandRunner = {
  run: async (command, args) =>
    execFileAsync(command, [...args], {
      shell: false,
      timeout: 30_000,
      maxBuffer: 64 * 1_024,
      env: { ...process.env, LC_ALL: "C" },
    }),
};

export interface UnpackVerifiedBuildInput {
  readonly tarPath: string;
  readonly workDirectory: string;
  readonly expectedManifestSha256: string;
  readonly expectedSignatureSha256: string;
  readonly runner?: UpgradeCommandRunner;
}

export type UnpackVerifiedBuildResult =
  | { readonly status: "unpacked"; readonly artifactRoot: string }
  | { readonly status: "refused"; readonly reason: "build-unverified" | "digest-mismatch" };

export async function unpackVerifiedBuildForUpgrade(
  input: UnpackVerifiedBuildInput,
): Promise<UnpackVerifiedBuildResult> {
  const runner = input.runner ?? defaultRunner;
  const unpackRoot = join(input.workDirectory, "unpacked");
  await mkdir(unpackRoot, { recursive: true, mode: 0o700 });
  try {
    await runner.run("tar", ["-xzf", input.tarPath, "-C", unpackRoot, "--no-same-owner"]);
  } catch {
    return { status: "refused", reason: "build-unverified" };
  }
  const entries = await readdir(unpackRoot);
  const [topDirectory] = entries;
  if (topDirectory === undefined || entries.length !== 1) {
    return { status: "refused", reason: "build-unverified" };
  }
  const artifactRoot = join(unpackRoot, topDirectory);
  try {
    const manifestBytes = await readFile(join(artifactRoot, HEADLESS_ARTIFACT_MANIFEST_FILENAME));
    const signatureBytes = await readFile(join(artifactRoot, HEADLESS_ARTIFACT_SIGNATURE_FILENAME));
    if (
      sha256Hex(manifestBytes) !== input.expectedManifestSha256 ||
      sha256Hex(signatureBytes) !== input.expectedSignatureSha256
    ) {
      return { status: "refused", reason: "digest-mismatch" };
    }
  } catch {
    return { status: "refused", reason: "build-unverified" };
  }
  return { status: "unpacked", artifactRoot };
}

export interface LaunchOutOfServiceUpgradeInput {
  readonly platform: "linux" | "darwin";
  readonly uid: number;
  readonly requestId: string;
  readonly installRoot: string;
  readonly stateDirectory: string;
  readonly artifactRoot: string;
  readonly updateContextPath: string;
  /** Safe non-secret path environment so the upgrade CLI resolves the same host paths. */
  readonly environment: Readonly<Record<string, string>>;
  readonly runner?: UpgradeCommandRunner;
}

export type LaunchOutOfServiceUpgradeResult =
  | { readonly status: "launched"; readonly cleanupLaunchdPlist?: string }
  | { readonly status: "failed" };

const ALLOWED_ENV_KEYS = new Set([
  "OCTANT_DATA_DIR",
  "OCTANT_INSTALL_ROOT",
  "OCTANT_LOGS_DIR",
  "OCTANT_SERVER_PORT",
  "XDG_DATA_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
]);

function safeUpgradeEnvironment(
  source: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (!ALLOWED_ENV_KEYS.has(key)) continue;
    if (
      value.length === 0 ||
      value.includes("\0") ||
      value.includes("\n") ||
      value.includes("\r")
    ) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

function shortUnitSuffix(requestId: string): string {
  const cleaned = requestId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 16);
  return cleaned.length > 0 ? cleaned : "run";
}

function escapeXml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[character] ?? character,
  );
}

function launchdUpgradePlist(input: {
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0"><dict>',
    `<key>Label</key><string>${escapeXml(input.label)}</string>`,
    "<key>ProgramArguments</key><array>",
    `<string>${escapeXml(input.command)}</string>${input.args
      .map((argument) => `<string>${escapeXml(argument)}</string>`)
      .join("")}`,
    "</array>",
    `<key>EnvironmentVariables</key><dict>${Object.entries(input.environment)
      .map(([key, value]) => `<key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`)
      .join("")}</dict>`,
    "<key>RunAtLoad</key><true/>",
    "<key>KeepAlive</key><false/>",
    "<key>AbandonProcessGroup</key><true/>",
    "</dict></plist>\n",
  ].join("");
}

/**
 * Spawns `<installRoot>/current/bin/octant server upgrade` outside the host's
 * own service unit/job so stopping the host does not terminate the upgrader.
 */
export async function launchOutOfServiceUpgrade(
  input: LaunchOutOfServiceUpgradeInput,
): Promise<LaunchOutOfServiceUpgradeResult> {
  if (
    !isAbsolute(input.installRoot) ||
    !isAbsolute(input.artifactRoot) ||
    !isPathConfinedWithin(input.stateDirectory, input.updateContextPath)
  ) {
    return { status: "failed" };
  }
  const cliPath = join(input.installRoot, "current", "bin", "octant");
  try {
    const cliStat = await lstat(cliPath);
    if (!cliStat.isFile() && !cliStat.isSymbolicLink()) return { status: "failed" };
  } catch {
    return { status: "failed" };
  }

  // Never pass `--self-built`: remote upgrades accept only release-signed builds.
  const upgradeArgs = [
    "server",
    "upgrade",
    "--artifact",
    input.artifactRoot,
    "--install-root",
    input.installRoot,
    "--update-context",
    input.updateContextPath,
  ] as const;
  const environment = safeUpgradeEnvironment(input.environment);
  const runner = input.runner ?? defaultRunner;
  const suffix = shortUnitSuffix(input.requestId);

  if (input.platform === "linux") {
    const setEnvArgs = Object.entries(environment).map(
      ([key, value]) => `--setenv=${key}=${value}`,
    );
    try {
      await runner.run("/usr/bin/systemd-run", [
        "--user",
        "--collect",
        "--no-block",
        `--unit=octant-upgrade-${suffix}`,
        ...setEnvArgs,
        "--",
        cliPath,
        ...upgradeArgs,
      ]);
      return { status: "launched" };
    } catch {
      return { status: "failed" };
    }
  }

  const label = `app.octant.upgrade.${suffix}`;
  const plistPath = join(input.stateDirectory, "host-update", `${label}.plist`);
  if (!isPathConfinedWithin(input.stateDirectory, plistPath)) {
    return { status: "failed" };
  }
  const temporaryPlist = `${plistPath}.tmp`;
  try {
    await mkdir(dirname(plistPath), { recursive: true, mode: 0o700 });
    const contents = launchdUpgradePlist({
      label,
      command: cliPath,
      args: upgradeArgs,
      environment,
    });
    await writeFile(temporaryPlist, contents, { encoding: "utf8", mode: 0o600 });
    await chmod(temporaryPlist, 0o600);
    await rename(temporaryPlist, plistPath);
    await runner.run("/bin/launchctl", ["bootstrap", `gui/${input.uid}`, plistPath]);
    return { status: "launched", cleanupLaunchdPlist: plistPath };
  } catch {
    await rm(temporaryPlist, { force: true }).catch(() => undefined);
    await rm(plistPath, { force: true }).catch(() => undefined);
    return { status: "failed" };
  }
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}
