import { execFile } from "node:child_process";
import { lstat, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type {
  AppReleaseRing,
  AppVersion,
  NightlyInstallRefusal,
  NightlyInstallState,
} from "@octant/contracts/app-updates";
import { resolveNightlyInstallRelease } from "@octant/domain";
import {
  createFeedVerifier,
  fetchUpdateFeed,
  fetchVerifiedArtifact,
  type FeedVerifier,
  isEmptyFeedMarker,
  updateFeedUrl,
} from "./appUpdateFeed";
import type { NativeDesktopPeerStatus } from "./desktopPeerStatus";

const run = promisify(execFile);

export const NIGHTLY_BUNDLE_IDENTIFIER = "app.octant.desktop.nightly";
const NIGHTLY_BUNDLE_NAME = "Octant Nightly.app";
const MAX_ARTIFACT_BYTES = 600 * 1024 * 1024;
// Strict nested validation of a freshly extracted bundle hashes every file.
// The native side bounds itself at 20 seconds; this only stops a lost answer
// from holding the row in "installing".
const NATIVE_BOUND_MS = 25_000;

/**
 * Where Nightly goes: beside the running Octant, and nowhere a caller chooses.
 *
 * Derived from the running executable, so the only bundle Octant ever writes
 * is `Octant Nightly.app` in the directory that holds `Octant.app`. A launch
 * that is not a plain `Octant.app` bundle, or one macOS translocated to a
 * read-only random path, has no "beside" to install into.
 */
export function nightlyInstallLocation(
  executablePath: string,
):
  | { readonly kind: "location"; readonly octant: string; readonly nightly: string }
  | { readonly kind: "refused"; readonly refusal: "unsupported-install" } {
  const suffix = "/Octant.app/Contents/MacOS/Octant";
  if (!executablePath.startsWith("/") || !executablePath.endsWith(suffix)) {
    return { kind: "refused", refusal: "unsupported-install" };
  }
  const parent = executablePath.slice(0, -suffix.length);
  if (parent === "" || parent.includes("/AppTranslocation/") || parent.split("/").includes("..")) {
    return { kind: "refused", refusal: "unsupported-install" };
  }
  return {
    kind: "location",
    octant: `${parent}/Octant.app`,
    nightly: `${parent}/${NIGHTLY_BUNDLE_NAME}`,
  };
}

export interface NightlyInstallerRole {
  readonly packaged: boolean;
  readonly flavor: "stable" | "nightly";
  readonly platform: string;
  /** The ring Octant's own updater follows right now; `candidate` is Preview. */
  readonly ring: AppReleaseRing;
}

/**
 * May this app manage a Nightly beside itself, and may it install one now?
 *
 * Only packaged Octant manages Nightly: Nightly never installs itself, and a
 * development build has no signed identity to compare a download with.
 * Installing additionally needs Octant on Preview and macOS, where the
 * code-signature check exists.
 */
export function nightlyInstallerAuthority(
  role: NightlyInstallerRole,
):
  | { readonly kind: "none" }
  | { readonly kind: "manage"; readonly install: "allowed" | NightlyInstallRefusal } {
  if (!role.packaged || role.flavor !== "stable") return { kind: "none" };
  if (role.platform !== "darwin") return { kind: "manage", install: "unsupported-platform" };
  if (role.ring !== "candidate") return { kind: "manage", install: "not-on-preview" };
  return { kind: "manage", install: "allowed" };
}

export interface NightlyInstallerOptions {
  /** Read on every call: the ring can change while Octant runs. */
  readonly role: () => NightlyInstallerRole;
  readonly executablePath: string;
  readonly feedBaseUrl: string;
  readonly app: { readonly version: AppVersion; readonly platform: string; readonly arch: string };
  /** A private directory for the download; never the install location. */
  readonly temporaryDirectory: string;
  readonly native: () => Pick<NativeDesktopPeerStatus, "verifyNightly" | "openNightly"> | undefined;
  readonly trash: (path: string) => Promise<void>;
  readonly verifier?: FeedVerifier;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly maxArtifactBytes?: number;
  readonly extract?: (archive: string, destination: string) => Promise<void>;
  readonly readBundleIdentifier?: (bundle: string) => Promise<string | undefined>;
}

async function dittoExtract(archive: string, destination: string): Promise<void> {
  // ditto keeps the bundle's symlinks, extended attributes and signature
  // intact, which a generic unzip does not.
  await run("/usr/bin/ditto", ["-x", "-k", archive, destination], { timeout: 120_000 });
}

async function plistBundleIdentifier(bundle: string): Promise<string | undefined> {
  try {
    const { stdout } = await run(
      "/usr/bin/plutil",
      ["-extract", "CFBundleIdentifier", "raw", "-o", "-", join(bundle, "Contents", "Info.plist")],
      { timeout: 5_000 },
    );
    return stdout.trim();
  } catch {
    return undefined;
  }
}

async function bounded(operation: () => Promise<unknown> | undefined): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation() ?? Promise.resolve(undefined),
      new Promise<unknown>((resolve) => {
        timer = setTimeout(() => resolve(undefined), NATIVE_BOUND_MS);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function answered(value: unknown, kind: "verified" | "started"): boolean {
  return typeof value === "object" && value !== null && "kind" in value && value.kind === kind;
}

/**
 * What a native answer other than success means for the row. A signature that
 * did not match is `code-signature`; a check that ran out of time or could not
 * run says so, rather than blaming the publisher.
 */
function nativeRefusal(value: unknown): NightlyInstallRefusal {
  const reason =
    typeof value === "object" && value !== null && "reason" in value ? value.reason : undefined;
  if (reason === "not-installed") return "not-installed";
  if (reason === "invalid-peer" || reason === "unsigned-build" || reason === "incompatible-host")
    return "code-signature";
  return "check-unavailable";
}

/**
 * Install, open and remove Octant Nightly beside Octant, only when the person
 * asks.
 *
 * Three checks stand between the preview feed and an app on disk: the feed's
 * signature against the preview ring's keys with the signed ring `preview`, the
 * artifact's hash from that signed feed, and on macOS Nightly's own code
 * requirement (its bundle id, Apple-anchored, Octant's Developer ID team) on
 * the extracted bundle before anything moves into place. Octant's own updater
 * never reads this feed and never runs this.
 */
export function createNightlyInstaller(options: NightlyInstallerOptions) {
  const verifier = options.verifier ?? createFeedVerifier();
  const extract = options.extract ?? dittoExtract;
  const readBundleIdentifier = options.readBundleIdentifier ?? plistBundleIdentifier;
  let operation: "installing" | "removing" | undefined;
  // Claimed before the first await, so a second click cannot start a second
  // install, or a remove, while the first is still checking the location.
  let claimed = false;

  async function occupant(path: string): Promise<"empty" | "nightly" | "other"> {
    let entry;
    try {
      entry = await lstat(path);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? "empty" : "other";
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) return "other";
    return (await readBundleIdentifier(path)) === NIGHTLY_BUNDLE_IDENTIFIER ? "nightly" : "other";
  }

  async function state(
    refusal?: NightlyInstallRefusal,
    message?: string,
  ): Promise<NightlyInstallState> {
    const authority = nightlyInstallerAuthority(options.role());
    if (authority.kind === "none") return { status: "unavailable" };
    const detail = {
      ...(refusal === undefined ? {} : { refusal }),
      ...(refusal === undefined ? {} : { message: message ?? refusalMessage(refusal) }),
    };
    if (operation !== undefined) return { status: operation, ...detail };
    const location = nightlyInstallLocation(options.executablePath);
    const installed =
      location.kind === "location" && (await occupant(location.nightly)) === "nightly";
    if (installed) return { status: "installed", ...detail };
    // Stable without Nightly shows no row; an unsupported platform is told
    // only when it asks, and gets its Nightly from the website.
    if (authority.install !== "allowed" && refusal === undefined) return { status: "unavailable" };
    return { status: "not-installed", ...detail };
  }

  async function install(): Promise<NightlyInstallState> {
    if (claimed) return state();
    claimed = true;
    try {
      return await installClaimed();
    } finally {
      claimed = false;
    }
  }

  async function installClaimed(): Promise<NightlyInstallState> {
    const authority = nightlyInstallerAuthority(options.role());
    if (authority.kind === "none") return { status: "unavailable" };
    if (authority.install !== "allowed") return state(authority.install);
    const location = nightlyInstallLocation(options.executablePath);
    if (location.kind === "refused") return state(location.refusal);
    if ((await occupant(location.nightly)) === "other") return state("occupied");
    const native = options.native();
    if (native?.verifyNightly === undefined) return state("code-signature");
    operation = "installing";
    let download: string | undefined;
    let staging: string | undefined;
    try {
      const refusal = await (async (): Promise<NightlyInstallRefusal | undefined> => {
        if (!verifier.configured("preview")) return "untrusted-signature";
        const fetched = await fetchUpdateFeed(
          updateFeedUrl(options.feedBaseUrl, {
            ring: "preview",
            platform: options.app.platform,
            arch: options.app.arch,
          }),
          {
            version: String(options.app.version),
            platform: options.app.platform,
            arch: options.app.arch,
          },
          options.fetchImpl,
        );
        if (fetched.kind !== "fetched") return fetched.kind;
        if (isEmptyFeedMarker(fetched.document)) return "no-release";
        const offer = resolveNightlyInstallRelease({
          document: fetched.document,
          platform: options.app.platform,
          arch: options.app.arch,
          verifySignature: verifier.verify,
        });
        if (offer.kind === "refuse") return offer.refusal;
        const artifact = await fetchVerifiedArtifact(
          {
            url: offer.release.url,
            sha256: offer.release.sha256,
            maxBytes: options.maxArtifactBytes ?? MAX_ARTIFACT_BYTES,
          },
          options.fetchImpl,
        );
        if (artifact.kind === "corrupt") return "corrupt-artifact";
        if (artifact.kind !== "verified") return "unreachable";

        download = await mkdtemp(join(options.temporaryDirectory, "octant-nightly-download-"));
        const archive = join(download, "nightly.zip");
        await writeFile(archive, artifact.bytes, { mode: 0o600, flag: "wx" });
        // Extracted beside the target, so the final move is a rename on one
        // volume rather than a copy that could leave half a bundle in place.
        try {
          staging = await mkdtemp(join(dirname(location.nightly), ".octant-nightly-install-"));
        } catch {
          return "not-writable";
        }
        await extract(archive, staging);
        const entries = await readdir(staging);
        const staged = join(staging, NIGHTLY_BUNDLE_NAME);
        if (entries.length !== 1 || entries[0] !== NIGHTLY_BUNDLE_NAME) return "code-signature";
        const stagedEntry = await lstat(staged);
        if (!stagedEntry.isDirectory() || stagedEntry.isSymbolicLink()) return "code-signature";
        const verdict = await bounded(() => native.verifyNightly?.(staged));
        if (!answered(verdict, "verified")) return nativeRefusal(verdict);

        // Checked again just before the move: the location may have changed
        // while the download ran.
        const current = await occupant(location.nightly);
        if (current === "other") return "occupied";
        const previous = join(staging, "previous.app");
        if (current === "nightly") await rename(location.nightly, previous);
        try {
          await rename(staged, location.nightly);
        } catch {
          if (current === "nightly") {
            try {
              await rename(previous, location.nightly);
            } catch {
              // Never delete the only copy of the previous Nightly: leave the
              // staging folder where the person can find it.
              staging = undefined;
            }
          }
          return "not-writable";
        }
        return undefined;
      })();
      operation = undefined;
      return await state(refusal);
    } catch {
      operation = undefined;
      return state(undefined).then((current) => ({
        ...current,
        message: "Octant could not install Octant Nightly. Nothing was changed.",
      }));
    } finally {
      operation = undefined;
      if (download !== undefined) await rm(download, { recursive: true, force: true });
      if (staging !== undefined) await rm(staging, { recursive: true, force: true });
    }
  }

  async function open(): Promise<NightlyInstallState> {
    if (claimed) return state();
    if (nightlyInstallerAuthority(options.role()).kind === "none") return { status: "unavailable" };
    const location = nightlyInstallLocation(options.executablePath);
    if (location.kind === "refused" || (await occupant(location.nightly)) !== "nightly") {
      return state("not-installed");
    }
    const native = options.native();
    const opened = await bounded(() => native?.openNightly?.(location.nightly));
    return answered(opened, "started") ? state() : state(nativeRefusal(opened));
  }

  async function remove(): Promise<NightlyInstallState> {
    if (claimed) return state();
    claimed = true;
    try {
      return await removeClaimed();
    } finally {
      claimed = false;
    }
  }

  async function removeClaimed(): Promise<NightlyInstallState> {
    if (nightlyInstallerAuthority(options.role()).kind === "none") return { status: "unavailable" };
    const location = nightlyInstallLocation(options.executablePath);
    if (location.kind === "refused" || (await occupant(location.nightly)) !== "nightly") {
      return state("not-installed");
    }
    operation = "removing";
    try {
      // The Trash, not a delete: the person can take it back. Shared data lives
      // outside the bundle and is left alone.
      await options.trash(location.nightly);
      operation = undefined;
      return await state();
    } catch {
      operation = undefined;
      return state(undefined).then((current) => ({
        ...current,
        message: "Octant could not move Octant Nightly to the Trash.",
      }));
    } finally {
      operation = undefined;
    }
  }

  return Object.freeze({ state: () => state(), install, open, remove });
}

function refusalMessage(refusal: NightlyInstallRefusal): string {
  switch (refusal) {
    case "unreachable":
      return "The Nightly download could not be reached.";
    case "malformed":
      return "The Nightly feed answered with something Octant could not read.";
    case "untrusted-signature":
      return "The Nightly feed was not signed by Octant's preview or stable key, so nothing was installed.";
    case "wrong-platform":
      return "That Nightly build is not built for this computer.";
    case "wrong-ring":
      return "The Nightly feed held a build signed for another ring, so it was refused.";
    case "corrupt-artifact":
      return "The download did not match the hash in the signed feed, so it was discarded.";
    case "no-release":
      return "No Nightly build is published yet.";
    case "code-signature":
      return "The downloaded app is not Octant Nightly signed by Octant's own developer, so it was not installed.";
    case "check-unavailable":
      return "Octant could not finish checking Octant Nightly's code signature, so nothing was changed. Try again.";
    case "occupied":
      return "Another app is already named Octant Nightly beside Octant, so Octant left it alone.";
    case "not-writable":
      return "Octant cannot write beside itself, so Nightly was not installed.";
    case "unsupported-install":
      return "This copy of Octant is not in a folder Nightly can be placed beside. Move Octant to Applications first.";
    case "unsupported-platform":
      return "Installing Octant Nightly from Octant is not supported on this platform. Download it from octant.sh.";
    case "not-on-preview":
      return "Octant installs Nightly only while it follows Preview.";
    case "not-installed":
      return "Octant Nightly is not installed beside Octant.";
  }
}
