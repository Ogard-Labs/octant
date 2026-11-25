import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const repositoryRoot = resolve(import.meta.dirname, "..");
const defaultSource = resolve(
  repositoryRoot,
  "apps/desktop/native/speech-helper/OctantSpeechHelper.swift",
);
const defaultDestination = resolve(repositoryRoot, "apps/desktop/dist/native/octant-speech-helper");

/** Apple's on-device dictation API first appears in this SDK. */
const MINIMUM_SDK_MAJOR = 26;

/**
 * The helper declares macOS 26, above the app's own floor: it is nothing but
 * calls into an API that starts there, and the host never starts it on an
 * older system.
 */
export const speechHelperBuildArgs = (
  source: string,
  destination: string,
): readonly [string, ...string[]] => [
  "--sdk",
  "macosx",
  "swiftc",
  "-parse-as-library",
  "-swift-version",
  "5",
  "-O",
  "-target",
  "arm64-apple-macos26.0",
  "-o",
  destination,
  source,
];

/** Apple Speech is Darwin-only; Linux and Windows builds must not require swiftc. */
export function shouldBuildSpeechHelper(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin";
}

/**
 * Release Xcodes in /Applications that may carry the SDK: the numbered
 * installs newest first (as CI images name them), then the unnumbered
 * `Xcode.app` a person installs from the App Store. A beta is never chosen:
 * what ships is built with a released compiler, and the SDK check still
 * decides whether any of them will do.
 */
export function speechToolchainCandidates(
  applications: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return applications
    .flatMap((name) => {
      const match = /^Xcode_(\d+)(?:\.(\d+))?(?:\.(\d+))?\.app$/.exec(name);
      return match === null
        ? []
        : [{ name, version: match.slice(1).map((part) => Number(part ?? 0)) }];
    })
    .sort((a, b) => {
      for (const index of [0, 1, 2]) {
        const order = (b.version[index] ?? 0) - (a.version[index] ?? 0);
        if (order !== 0) return order;
      }
      return a.name.localeCompare(b.name);
    })
    .map(({ name }) => join("/Applications", name, "Contents/Developer"))
    .concat(
      applications.includes("Xcode.app") ? ["/Applications/Xcode.app/Contents/Developer"] : [],
    );
}

export interface SpeechToolchainProbes {
  readonly listApplications: () => Promise<ReadonlyArray<string>>;
  /** The macOS SDK version of a developer directory, or of the selected one. */
  readonly sdkVersion: (developerDirectory: string | undefined) => Promise<string | undefined>;
}

export type SpeechToolchain =
  | { readonly kind: "selected" }
  | { readonly kind: "installed"; readonly developerDirectory: string }
  | { readonly kind: "absent" };

/**
 * Where a macOS 26 SDK can be found. The release runners select an older Xcode
 * and also install newer ones, and every other helper must keep the one that
 * is selected, so only this helper looks further.
 */
export async function findSpeechToolchain(
  probes: SpeechToolchainProbes = liveProbes,
): Promise<SpeechToolchain> {
  if (hasSpeechSdk(await probes.sdkVersion(undefined))) return { kind: "selected" };
  for (const developerDirectory of speechToolchainCandidates(await probes.listApplications())) {
    if (hasSpeechSdk(await probes.sdkVersion(developerDirectory)))
      return { kind: "installed", developerDirectory };
  }
  return { kind: "absent" };
}

function hasSpeechSdk(version: string | undefined): boolean {
  return Number(/^\d+/.exec(version ?? "")?.[0] ?? 0) >= MINIMUM_SDK_MAJOR;
}

const liveProbes: SpeechToolchainProbes = {
  listApplications: async () => {
    try {
      return await readdir("/Applications");
    } catch {
      return [];
    }
  },
  sdkVersion: async (developerDirectory) => {
    try {
      const { stdout } = await promisify(execFile)(
        "/usr/bin/xcrun",
        ["--sdk", "macosx", "--show-sdk-version"],
        { env: toolchainEnvironment(developerDirectory), timeout: 60_000 },
      );
      return stdout.trim();
    } catch {
      return undefined;
    }
  },
};

function toolchainEnvironment(developerDirectory: string | undefined): NodeJS.ProcessEnv {
  return developerDirectory === undefined
    ? process.env
    : { ...process.env, DEVELOPER_DIR: developerDirectory };
}

/** Builds the helper, or answers `skipped` where no macOS 26 SDK is installed. */
export async function buildSpeechHelper(
  source = defaultSource,
  destination = defaultDestination,
): Promise<"built" | "skipped"> {
  if (!shouldBuildSpeechHelper()) return "skipped";
  const toolchain = await findSpeechToolchain();
  if (toolchain.kind === "absent") return "skipped";
  const resolvedSource = resolve(repositoryRoot, source);
  const resolvedDestination = resolve(repositoryRoot, destination);
  const moduleCache = resolve(tmpdir(), "octant-swift-module-cache");
  await mkdir(dirname(resolvedDestination), { recursive: true });
  await mkdir(moduleCache, { recursive: true });
  const child = spawn(
    "/usr/bin/xcrun",
    speechHelperBuildArgs(resolvedSource, resolvedDestination),
    {
      env: {
        ...toolchainEnvironment(
          toolchain.kind === "installed" ? toolchain.developerDirectory : undefined,
        ),
        CLANG_MODULE_CACHE_PATH: moduleCache,
      },
      stdio: "inherit",
    },
  );
  const [exitCode] = (await once(child, "exit")) as [number | null];
  if (exitCode !== 0) throw new Error("Octant speech helper build failed.");
  await chmod(resolvedDestination, 0o755);
  return "built";
}

if (import.meta.main && (await buildSpeechHelper()) === "skipped" && shouldBuildSpeechHelper())
  console.warn(
    "Octant speech helper skipped: no Xcode with the macOS 26 SDK is installed, so this build has no on-device dictation.",
  );
