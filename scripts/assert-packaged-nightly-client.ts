/**
 * Check a packaged Octant Nightly before it is published.
 *
 * Packaging validates its payload as it builds; this reads the finished bundle
 * again after signing, so a signing or notarization step that changed it, or a
 * packaging change that stopped checking something, cannot publish a Nightly
 * that is not the client the preflight passed:
 *
 *  - a code signature (a Developer ID, from the release's team, when asked);
 *  - the desktop runtime's fuses (no Node mode, no inspector, ASAR only);
 *  - the native peer-status addon the window protocol admits a peer by;
 *  - the `octant-nightly://` link scheme in its Info.plist;
 *  - no file of the synthetic client smoke's harness, which stands in for the
 *    signed binding and answers pickers itself;
 *  - the full `octant-nightly` command bundle and its launcher.
 *
 *   bun scripts/assert-packaged-nightly-client.ts [--bundle <path>] [--require-developer-id]
 *
 * Without `--bundle` it reads `out/Octant Nightly.app`. With
 * `--require-developer-id`, `OCTANT_SIGNING_TEAM_ID` (when set) must match the
 * signature's team.
 */

import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { desktopIdentity } from "@octant/host-runtime";
import { readDesktopArchive, validateDesktopRuntimeFuses } from "./desktop-client-runtime";
import {
  collectPayloadEntries,
  isNightlyClientHarness,
  NIGHTLY_COMMAND_DIRECTORY_NAME,
  validateDarwinBundleIdentity,
  type PackagedPayloadEntry,
} from "./package-desktop";

const identity = desktopIdentity("nightly");

export const NIGHTLY_PEER_STATUS_ADDON =
  "Contents/Resources/native/octant-desktop-peer-status.node";
export const NIGHTLY_COMMAND_FILES = [
  `Contents/Resources/${NIGHTLY_COMMAND_DIRECTORY_NAME}/octant-nightly`,
  `Contents/Resources/${NIGHTLY_COMMAND_DIRECTORY_NAME}/octant-nightly.mjs`,
] as const;

export type SignatureRequirement =
  | { readonly kind: "any" }
  | { readonly kind: "developer-id"; readonly teamId?: string };

/** What the check reads from the bundle; the defaults read a real one on macOS. */
export interface NightlyBundleReader {
  readonly infoPlist: (bundle: string) => unknown;
  /** `codesign -dv` output, or undefined when the bundle carries no signature. */
  readonly signature: (bundle: string) => string | undefined;
  /** Whether `codesign --verify --deep --strict` accepts the bundle. */
  readonly signatureVerifies: (bundle: string) => boolean;
  readonly fuses: (bundle: string) => Promise<void>;
  /** Every file in the bundle, the sealed archive's entries included. */
  readonly entries: (bundle: string) => Promise<ReadonlyArray<PackagedPayloadEntry>>;
}

export type NightlyClientBundleCheck =
  | { readonly status: "passed" }
  | { readonly status: "refused"; readonly reasons: ReadonlyArray<string> };

export async function checkPackagedNightlyClient(input: {
  readonly bundle: string;
  readonly signature: SignatureRequirement;
  readonly reader?: NightlyBundleReader;
}): Promise<NightlyClientBundleCheck> {
  const reader = input.reader ?? macosBundleReader;
  const reasons: string[] = [];
  const bundle = input.bundle;
  if (!existsSync(bundle)) return { status: "refused", reasons: [`${bundle} does not exist.`] };

  try {
    validateDarwinBundleIdentity(reader.infoPlist(bundle), identity);
  } catch (error) {
    reasons.push(message(error));
  }

  const signature = reader.signature(bundle);
  if (signature === undefined) {
    reasons.push("The bundle carries no code signature.");
  } else if (input.signature.kind === "developer-id") {
    if (!/^Authority=Developer ID Application: /m.test(signature))
      reasons.push("The bundle is not signed with a Developer ID Application certificate.");
    const team = /^TeamIdentifier=(.+)$/m.exec(signature)?.[1]?.trim();
    if (input.signature.teamId !== undefined && team !== input.signature.teamId)
      reasons.push(`The signature's team is ${team ?? "missing"}, not ${input.signature.teamId}.`);
    if (!reader.signatureVerifies(bundle))
      reasons.push("codesign --verify --deep --strict refuses the bundle.");
  }

  try {
    await reader.fuses(bundle);
  } catch (error) {
    reasons.push(message(error));
  }

  for (const required of [NIGHTLY_PEER_STATUS_ADDON, ...NIGHTLY_COMMAND_FILES]) {
    const path = join(bundle, required);
    if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0)
      reasons.push(`The bundle is missing ${required}.`);
  }

  let entries: ReadonlyArray<PackagedPayloadEntry> = [];
  try {
    entries = await reader.entries(bundle);
  } catch (error) {
    reasons.push(message(error));
  }
  for (const entry of entries)
    if (isNightlyClientHarness(entry))
      reasons.push(`The bundle contains the Nightly client smoke harness in ${entry.path}.`);

  return reasons.length === 0 ? { status: "passed" } : { status: "refused", reasons };
}

const macosBundleReader: NightlyBundleReader = {
  infoPlist: (bundle) => JSON.parse(plutilJson(join(bundle, "Contents/Info.plist"))),
  signature: (bundle) => {
    const shown = spawnSync("/usr/bin/codesign", ["-dv", "--verbose=4", bundle], {
      encoding: "utf8",
      timeout: 60_000,
    });
    return shown.status === 0 ? `${shown.stdout}${shown.stderr}` : undefined;
  },
  signatureVerifies: (bundle) =>
    spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundle], {
      stdio: "ignore",
      timeout: 300_000,
    }).status === 0,
  fuses: (bundle) => validateDesktopRuntimeFuses(bundle),
  entries: async (bundle) => {
    // The sealed archive is read through its integrity record, as packaging
    // reads it, so its entries are the bytes the app will load.
    const archive = readDesktopArchive(
      join(bundle, "Contents/Resources/app.asar"),
      JSON.parse(
        plutilJson(join(bundle, "Contents/Info.plist"), ["-extract", "ElectronAsarIntegrity"]),
      ),
      // This bundle is already signed, and signing rewrote the unpacked natives.
      "signed",
    );
    return [...archive, ...(await collectPayloadEntries(join(bundle, "Contents")))];
  },
};

function plutilJson(path: string, extract: ReadonlyArray<string> = []): string {
  const converted = spawnSync(
    "/usr/bin/plutil",
    extract.length === 0
      ? ["-convert", "json", "-o", "-", path]
      : [...extract, "json", "-o", "-", path],
    { encoding: "utf8", timeout: 10_000 },
  );
  if (converted.status !== 0) throw new Error(`plutil could not read ${path}.`);
  return converted.stdout;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function parseAssertCommand(
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
  repositoryRoot: string,
): { readonly bundle: string; readonly signature: SignatureRequirement } {
  const known = new Set(["--bundle", "--require-developer-id"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (!known.has(argument)) throw new Error(`Unknown argument ${argument}.`);
    if (argument === "--bundle") index += 1;
  }
  const bundleIndex = argv.indexOf("--bundle");
  const bundle =
    bundleIndex === -1
      ? join(repositoryRoot, "out", `${identity.productName}.app`)
      : argv[bundleIndex + 1];
  if (bundle === undefined || bundle === "" || bundle.startsWith("--"))
    throw new Error("--bundle needs a path.");
  const teamId = env.OCTANT_SIGNING_TEAM_ID?.trim();
  return {
    bundle: resolve(bundle),
    signature: argv.includes("--require-developer-id")
      ? { kind: "developer-id", ...(teamId ? { teamId } : {}) }
      : { kind: "any" },
  };
}

if (import.meta.main) {
  if (process.platform !== "darwin") {
    console.error("The packaged Nightly client check reads a macOS bundle.");
    process.exit(2);
  }
  const command = parseAssertCommand(
    process.argv.slice(2),
    process.env,
    resolve(import.meta.dir, ".."),
  );
  const result = await checkPackagedNightlyClient(command);
  if (result.status === "refused") {
    for (const reason of result.reasons) console.error(`::error::${reason}`);
    process.exit(1);
  }
  console.log(`${command.bundle} is a packaged Octant Nightly client.`);
}
