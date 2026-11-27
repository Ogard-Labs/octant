import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { createGunzip } from "node:zlib";
import { AggregateId } from "@octant/contracts";
import type {
  MemberBuildDownload,
  MemberBuildDownloadRefusal,
  MemberInstallTarget,
} from "@octant/contracts/shield-servers";
import { AppVersion } from "@octant/contracts/app-updates";
import { compareAppVersions, resolveHeadlessBuildOffer, ringForVersion } from "@octant/domain";
import {
  createReleaseFeedVerifier,
  decodeHeadlessArtifactManifest,
  fetchReleaseFeedDocument,
  fetchVerifiedArtifact,
  HEADLESS_ARTIFACT_MANIFEST_FILENAME,
  HEADLESS_ARTIFACT_SIGNATURE_FILENAME,
  headlessBuildFeedRelativePath,
  inspectHeadlessArtifact,
  RELEASE_TRUSTED_KEYS,
  resolveUpdateFeedBaseUrl,
  verifyHeadlessArtifactSignature,
  type ReleaseRing,
} from "@octant/host-runtime";
import { Schema } from "effect";

/**
 * The signed headless builds this computer can install on a server.
 * Canonical: docs/design/hub-and-spokes.md § Adding a computer over SSH.
 *
 * The newest `octant-<version>-<target>.tar.gz` for the server's target in a
 * folder in Octant's data folder is used: one the person put there, or one
 * downloaded from this computer's ring when none there suits the server.
 * Every build is checked here before a byte goes to the server: each file
 * against the manifest's digest, and the manifest against the release keys of
 * the ring its signature names, with the same code `octant server install`
 * runs on the server.
 *
 * A download reads the ring's signed listing of the build through the same
 * feed and transport the desktop updater uses, and believes nothing in it
 * until its signature verifies against the ring's release keys. The bytes
 * must hash to the digest that listing names, then pass the check above, and
 * only then are they renamed into the folder; anything else is deleted.
 */

const execFileAsync = promisify(execFile);

/** The headless CLI's own wire version: a build for another one could not join this computer. */
const WIRE_VERSION = "1";
/** A release build is tens of megabytes; anything near this is not one. */
const MAX_BUILD_BYTES = 1024 * 1024 * 1024;
/**
 * The unpacked size a build may claim. The archive is unpacked before its
 * signature can be checked, so a small archive that inflates without bound
 * would fill this computer's temporary folder; it is measured first.
 */
const MAX_UNPACKED_BYTES = 2 * 1024 * 1024 * 1024;
const BUILD_NAME = /^octant-(.+)-(darwin-arm64|linux-x64|linux-arm64)\.tar\.gz$/;
/** Finished downloads kept for the sheet to read; older ones are forgotten. */
const KEPT_DOWNLOADS = 32;
/** What a listing request says about this computer: the ring and target in its path, and this. */
const FEED_USER_AGENT = "Octant";

const decodeAggregateId = Schema.decodeUnknownSync(AggregateId);
const isAppVersion = Schema.is(AppVersion);

export type HeadlessBuildCheck =
  | {
      readonly status: "verified";
      readonly bytes: Buffer;
      readonly sha256: string;
      /** Digests of the build's manifest and signature files, to recognize the same build on the server. */
      readonly manifestSha256: string;
      readonly signatureSha256: string;
      readonly version: string;
      /** The store version the build migrates to, so an update can tell whether it migrates. */
      readonly storeVersion: number;
      readonly ring: ReleaseRing;
    }
  | {
      readonly status: "refused";
      readonly reason: "unreadable" | "wrong-target" | "files-mismatch" | "unsigned" | "unverified";
    };

export interface HeadlessBuilds {
  /** Where the person puts builds, named in the sheet when none is there. */
  readonly folder: string;
  /** The newest build for a target in the folder, by its file name, or nothing. */
  readonly find: (target: MemberInstallTarget) => Promise<string | undefined>;
  readonly check: (path: string, target: MemberInstallTarget) => Promise<HeadlessBuildCheck>;
  /**
   * Starts downloading the build for a target from this computer's ring, or
   * joins the download already running for it; `newerThan` refuses a build
   * that is not newer than the server's. Nothing when this computer reads no
   * feed.
   */
  readonly download: (input: {
    readonly target: MemberInstallTarget;
    readonly newerThan?: string;
  }) => MemberBuildDownload | undefined;
  readonly downloadProgress: (downloadId: string) => MemberBuildDownload | undefined;
  /**
   * A sheet reading the download closed. When it was the last one, the
   * download stops: its feed requests are cancelled and nothing is kept.
   */
  readonly leaveDownload: (downloadId: string) => MemberBuildDownload | undefined;
}

/** Where this computer reads the signed release feed. */
export interface HeadlessBuildFeed {
  /** The feed base the desktop updater uses, `https://octant.sh/updates` unless overridden. */
  readonly baseUrl: string;
  /** The ring this computer follows now. */
  readonly ring: () => ReleaseRing;
  /** Tests only: production reaches the feed with the updater's own transport. */
  readonly fetch?: typeof globalThis.fetch;
}

interface RunningDownload {
  readonly key: string;
  current: MemberBuildDownload;
  /**
   * The open sheets reading this download. The feed is asked only while a
   * sheet is open (docs/architecture.md, the headless feed), so the last one
   * to close stops both requests and keeps nothing.
   */
  readers: number;
  readonly stop: AbortController;
  /** Stops the download once no sheet has read it for a while. */
  unread?: ReturnType<typeof setTimeout>;
}

/**
 * How long a running download goes unread before it stops. An open sheet
 * reads every second; a sheet whose window closed or lost its connection
 * never sends its leave, and without this bound its reader would keep the
 * feed requests going.
 */
const UNREAD_DOWNLOAD_MS = 30_000;

export function createHeadlessBuilds(options: {
  readonly folder: string;
  /** The keys each ring believes; tests only, production reads Octant's release keys. */
  readonly trustedKeys?: Readonly<Record<ReleaseRing, ReadonlyArray<string>>>;
  /** Where builds are downloaded from; without it, only builds the person placed are used. */
  readonly feed?: HeadlessBuildFeed;
  readonly uuid?: () => string;
  /** The unpacked size a build may claim; tests only. */
  readonly maxUnpackedBytes?: number;
  /** How long a running download may go unread; tests only. */
  readonly unreadDownloadMs?: number;
}): HeadlessBuilds {
  const verifier = createReleaseFeedVerifier(options.trustedKeys ?? RELEASE_TRUSTED_KEYS);
  const uuid = options.uuid ?? randomUUID;
  const downloads = new Map<string, RunningDownload>();

  const stop = (running: RunningDownload, message: string) => {
    const { state } = running.current;
    if (state !== "downloading" && state !== "verifying") return;
    running.current = { ...running.current, state: "refused", refusal: "unreachable", message };
    running.stop.abort();
  };

  /** A sheet read the download: it runs on for another unread bound. */
  const read = (running: RunningDownload) => {
    clearTimeout(running.unread);
    const { state } = running.current;
    if (state !== "downloading" && state !== "verifying") return;
    running.unread = setTimeout(
      () =>
        stop(
          running,
          "The download stopped when no sheet read it any more, so Octant kept nothing.",
        ),
      options.unreadDownloadMs ?? UNREAD_DOWNLOAD_MS,
    );
    running.unread.unref?.();
  };

  /** Runs one download to its end, updating what the sheet reads at each stage. */
  const run = async (
    running: RunningDownload,
    feed: HeadlessBuildFeed,
    newerThan: string | undefined,
  ): Promise<void> => {
    const { target, ring } = running.current;
    const signal = running.stop.signal;
    const finish = (refusal: MemberBuildDownloadRefusal, message: string) => {
      // A download its last sheet stopped already says so.
      if (signal.aborted) return;
      running.current = { ...running.current, state: "refused", refusal, message };
    };
    const place = `Put octant-<version>-${target}.tar.gz from Octant's release in ${options.folder}, then try again.`;
    const listing = await fetchReleaseFeedDocument(
      `${feed.baseUrl.replace(/\/+$/, "")}/${headlessBuildFeedRelativePath({ ring, target })}`,
      {
        method: "GET",
        headers: { accept: "application/json", "user-agent": FEED_USER_AGENT },
        redirect: "manual",
        credentials: "omit",
      },
      feed.fetch,
      signal,
    );
    if (listing.kind === "unreachable") {
      return finish(
        "unreachable",
        `No signed Octant build for ${target} is on this computer, and the ${ring} release could not be reached or lists none. ${place}`,
      );
    }
    const offer =
      listing.kind === "fetched"
        ? resolveHeadlessBuildOffer({
            document: listing.document,
            target,
            ring,
            verifySignature: verifier.verify,
          })
        : undefined;
    if (offer?.kind !== "offer") {
      return finish(
        "untrusted-listing",
        `The ${ring} release's listing of the build for ${target} did not verify against Octant's release keys, so nothing was downloaded. ${place}`,
      );
    }
    const version = String(offer.release.version);
    running.current = { ...running.current, version };
    if (newerThan !== undefined && !isNewerVersion(version, newerThan)) {
      return finish(
        "no-newer-release",
        `The newest signed build on the ${ring} release for ${target} is ${version}, which is not newer than the ${newerThan} the server runs. Put a newer release build in ${options.folder}, then try again.`,
      );
    }
    const artifact = await fetchVerifiedArtifact(
      { url: offer.release.url, sha256: offer.release.sha256, maxBytes: MAX_BUILD_BYTES },
      feed.fetch,
      signal,
    );
    if (artifact.kind === "unreachable") {
      return finish(
        "unreachable",
        `Octant ${version} for ${target} could not be downloaded from the ${ring} release. ${place}`,
      );
    }
    if (artifact.kind === "corrupt") {
      return finish(
        "digest-mismatch",
        `The downloaded build does not match the digest the ${ring} release's signed listing names, so Octant kept nothing. ${place}`,
      );
    }
    if (signal.aborted) return;
    running.current = { ...running.current, state: "verifying" };
    // A name `find` never matches, so a build is never used before it is checked.
    const staged = join(options.folder, `.download-${uuid()}`);
    // The refusal says nothing was kept, so the staged file goes before the
    // sheet can read it.
    const discard = async (message: string) => {
      await rm(staged, { force: true });
      finish("build-unverified", message);
    };
    try {
      await mkdir(options.folder, { recursive: true, mode: 0o700 });
      const file = await open(staged, "wx", 0o600);
      try {
        await file.writeFile(artifact.bytes);
      } finally {
        await file.close();
      }
      const checked = await builds.check(staged, target);
      if (signal.aborted) return;
      if (checked.status === "refused") {
        return await discard(`${downloadedRefusal(checked.reason)} Octant kept nothing. ${place}`);
      }
      if (checked.version !== version || checked.ring !== offer.release.ring) {
        return await discard(
          `The downloaded build is not the ${version} the ${ring} release lists, so Octant kept nothing. ${place}`,
        );
      }
      await rename(staged, join(options.folder, `octant-${version}-${target}.tar.gz`));
      running.current = { ...running.current, state: "ready" };
    } finally {
      await rm(staged, { force: true });
    }
  };

  const builds: HeadlessBuilds = {
    folder: options.folder,
    download: ({ target, newerThan }) => {
      const feed = options.feed;
      if (feed === undefined) return undefined;
      const ring = feed.ring();
      const key = `${ring}:${target}:${newerThan ?? ""}`;
      for (const running of downloads.values()) {
        const { state } = running.current;
        if (running.key === key && (state === "downloading" || state === "verifying")) {
          running.readers += 1;
          read(running);
          return running.current;
        }
      }
      const running: RunningDownload = {
        key,
        current: { downloadId: decodeAggregateId(uuid()), target, ring, state: "downloading" },
        readers: 1,
        stop: new AbortController(),
      };
      downloads.set(String(running.current.downloadId), running);
      read(running);
      for (const id of [...downloads.keys()].slice(
        0,
        Math.max(0, downloads.size - KEPT_DOWNLOADS),
      )) {
        downloads.delete(id);
      }
      if (ring === "preview") {
        // Octant Nightly follows preview and never installs a host, so its
        // releases carry no headless build to ask for.
        running.current = {
          ...running.current,
          state: "refused",
          refusal: "no-release",
          message: `No signed Octant build for ${target} is on this computer, and Octant Nightly's preview ring carries none. Put octant-<version>-${target}.tar.gz from Octant's release in ${options.folder}, then try again.`,
        };
        return running.current;
      }
      void run(running, feed, newerThan).catch(() => {
        running.current = {
          ...running.current,
          state: "refused",
          refusal: "build-unverified",
          message: `The downloaded build could not be kept in ${options.folder}, so Octant kept nothing.`,
        };
      });
      return running.current;
    },
    downloadProgress: (downloadId) => {
      const running = downloads.get(downloadId);
      if (running === undefined) return undefined;
      read(running);
      return running.current;
    },
    leaveDownload: (downloadId) => {
      const running = downloads.get(downloadId);
      if (running === undefined) return undefined;
      running.readers = Math.max(0, running.readers - 1);
      if (running.readers === 0) {
        clearTimeout(running.unread);
        stop(running, "The download stopped when its sheet closed, so Octant kept nothing.");
      }
      return running.current;
    },
    find: async (target) => {
      let names: ReadonlyArray<string>;
      try {
        names = await readdir(options.folder);
      } catch {
        return undefined;
      }
      const versions = names.flatMap((name) => {
        const match = BUILD_NAME.exec(name);
        return match?.[1] !== undefined && match[2] === target ? [{ name, version: match[1] }] : [];
      });
      const newest = versions.sort((left, right) =>
        compareBuildVersions(right.version, left.version),
      )[0];
      return newest === undefined ? undefined : join(options.folder, newest.name);
    },
    check: async (path, target) => {
      let bytes: Buffer;
      try {
        if ((await stat(path)).size > MAX_BUILD_BYTES) return refused("unreadable");
        bytes = await readFile(path);
      } catch {
        return refused("unreadable");
      }
      if (!(await unpacksWithin(bytes, options.maxUnpackedBytes ?? MAX_UNPACKED_BYTES))) {
        return refused("unreadable");
      }
      const workspace = await mkdtemp(join(tmpdir(), "octant-member-build-"));
      try {
        try {
          await execFileAsync("tar", ["-xzf", path, "-C", workspace, "--no-same-owner"]);
        } catch {
          return refused("unreadable");
        }
        const entries = await readdir(workspace);
        const [name] = entries;
        if (name === undefined || entries.length !== 1) return refused("unreadable");
        const root = join(workspace, name);
        let manifestBytes: Buffer;
        try {
          manifestBytes = await readFile(join(root, HEADLESS_ARTIFACT_MANIFEST_FILENAME));
          const declared = decodeHeadlessArtifactManifest(manifestBytes.toString("utf8"));
          if (`${declared.target.platform}-${declared.target.arch}` !== target) {
            return refused("wrong-target");
          }
        } catch {
          return refused("unreadable");
        }
        const [platform = "", arch = ""] = target.split("-");
        const inspection = await inspectHeadlessArtifact({
          artifactRoot: root,
          runtime: { platform, arch, wireVersion: WIRE_VERSION },
        });
        if (!inspection.ok) return refused("files-mismatch");
        const signatureBytes = await readFile(
          join(root, HEADLESS_ARTIFACT_SIGNATURE_FILENAME),
        ).catch(() => undefined);
        const signature = verifyHeadlessArtifactSignature({
          manifest: inspection.manifest,
          signatureText: signatureBytes?.toString("utf8"),
          verifier,
        });
        if (signature.status === "refused") {
          return refused(signature.reason === "missing" ? "unsigned" : "unverified");
        }
        // A verified signature was read from this file, so it is there.
        if (signatureBytes === undefined) return refused("unsigned");
        return {
          status: "verified",
          bytes,
          sha256: sha256(bytes),
          manifestSha256: sha256(manifestBytes),
          signatureSha256: sha256(signatureBytes),
          version: inspection.manifest.artifactVersion,
          storeVersion: inspection.manifest.storeVersion,
          ring: signature.ring,
        };
      } finally {
        await rm(workspace, { force: true, recursive: true });
      }
    },
  };
  return builds;
}

/** Whether `candidate` is a later version than `installed`; a final release outranks its own candidate. */
export function isNewerVersion(candidate: string, installed: string): boolean {
  return compareBuildVersions(candidate, installed) > 0;
}

function downloadedRefusal(
  reason: Extract<HeadlessBuildCheck, { readonly status: "refused" }>["reason"],
): string {
  switch (reason) {
    case "unsigned":
      return "The downloaded build carries no release signature.";
    case "unverified":
      return "The downloaded build is not signed by a key Octant trusts for its release ring.";
    case "files-mismatch":
      return "A file in the downloaded build does not match its manifest.";
    case "wrong-target":
      return "The downloaded build is for another system.";
    case "unreadable":
      return "The downloaded build could not be read.";
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function refused(
  reason: Extract<HeadlessBuildCheck, { readonly status: "refused" }>["reason"],
): HeadlessBuildCheck {
  return { status: "refused", reason };
}

/**
 * Where this computer downloads builds from: the feed base the desktop
 * updater resolves (`OCTANT_UPDATE_FEED_BASE_URL`, else Octant's), and the
 * ring the person chose in Settings › Updates, else the ring this build
 * belongs to. An unusable override turns downloads off rather than falling
 * back to Octant's feed, as the updater refuses it; the person then places a
 * build by hand.
 */
export function headlessBuildFeedFor(input: {
  readonly environment: Record<string, string | undefined>;
  readonly chosenRing: () => ReleaseRing | undefined;
  readonly version: string;
}): HeadlessBuildFeed | undefined {
  let baseUrl: string;
  try {
    baseUrl = resolveUpdateFeedBaseUrl(input.environment);
  } catch {
    return undefined;
  }
  const builtRing: ReleaseRing = isAppVersion(input.version)
    ? ringForVersion(input.version)
    : "stable";
  return { baseUrl, ring: () => input.chosenRing() ?? builtRing };
}

/**
 * Orders two build versions: negative when `left` is older. A prerelease
 * sorts below the release it leads to, so `1.2.3` outranks
 * `1.2.3-candidate.20261120.1`; a plain numeric string comparison put the
 * candidate first. Names that are not app versions fall back to that
 * comparison.
 */
export function compareBuildVersions(left: string, right: string): number {
  return isAppVersion(left) && isAppVersion(right)
    ? compareAppVersions(left, right)
    : left.localeCompare(right, undefined, { numeric: true });
}

/**
 * Whether the gzip archive inflates to at most `limit` bytes. It measures the
 * bytes already read (the same ones hashed and sent), writing nothing, and
 * `pipeline` closes every stream on an error or an early stop, so a corrupt
 * or oversized archive is a refusal rather than an unhandled stream error.
 */
async function unpacksWithin(bytes: Buffer, limit: number): Promise<boolean> {
  let total = 0;
  const counted = new Writable({
    write(chunk: Buffer, _encoding, done) {
      total += chunk.length;
      done(total > limit ? new Error("The build unpacks past its limit.") : null);
    },
  });
  try {
    await pipeline(Readable.from([bytes]), createGunzip(), counted);
  } catch {
    return false;
  }
  return true;
}
