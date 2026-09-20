import { spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const defaultSourceDirectory = resolve(repositoryRoot, "apps/desktop/native/device-helper");
const defaultDestination = resolve(repositoryRoot, "apps/desktop/dist/native/octant-device-helper");

/**
 * Every file the helper is compiled from, relative to its directory. Listed
 * rather than globbed so a stray file cannot join the build, and so the
 * vendored files stay visibly separate from Octant's own.
 */
export const DEVICE_HELPER_SOURCES = [
  "main.swift",
  "SimulatorBridge.swift",
  "GuestInputConnection.swift",
  "KeyUsages.swift",
  "vendor/simulator-hid/DTUHIDModels.swift",
  "vendor/simulator-hid/XPCEncoder.swift",
] as const;

export const deviceHelperBuildArgs = (
  sourceDirectory: string,
  destination: string,
): readonly [string, ...string[]] => [
  "swiftc",
  "-O",
  "-target",
  "arm64-apple-macos14.0",
  "-o",
  destination,
  ...DEVICE_HELPER_SOURCES.map((source) => resolve(sourceDirectory, source)),
];

/** The device helper drives Apple Simulators; Linux and Windows builds must not require swiftc. */
export function shouldBuildDeviceHelper(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin";
}

function optionValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

export async function buildDeviceHelper(
  sourceDirectory = optionValue("--source") ?? defaultSourceDirectory,
  destination = optionValue("--destination") ?? defaultDestination,
): Promise<void> {
  if (!shouldBuildDeviceHelper()) return;
  const resolvedSources = resolve(repositoryRoot, sourceDirectory);
  const resolvedDestination = resolve(repositoryRoot, destination);
  const moduleCache = resolve(tmpdir(), "octant-swift-module-cache");
  await mkdir(dirname(resolvedDestination), { recursive: true });
  await mkdir(moduleCache, { recursive: true });
  const [command, ...args] = deviceHelperBuildArgs(resolvedSources, resolvedDestination);
  const child = spawn(command, args, {
    env: { ...process.env, CLANG_MODULE_CACHE_PATH: moduleCache },
    stdio: "inherit",
  });
  const [exitCode] = (await once(child, "exit")) as [number | null];
  if (exitCode !== 0) {
    throw new Error("Octant device helper build failed.");
  }
  await chmod(resolvedDestination, 0o755);
}

if (import.meta.main) await buildDeviceHelper();
