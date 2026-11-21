import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { MemberInstallTarget } from "@octant/contracts/shield-servers";
import {
  createReleaseFeedVerifier,
  decodeHeadlessArtifactManifest,
  HEADLESS_ARTIFACT_MANIFEST_FILENAME,
  HEADLESS_ARTIFACT_SIGNATURE_FILENAME,
  inspectHeadlessArtifact,
  RELEASE_TRUSTED_KEYS,
  verifyHeadlessArtifactSignature,
  type ReleaseRing,
} from "@octant/host-runtime";

/**
 * The signed headless builds this computer can install on a server.
 * Canonical: docs/design/hub-and-spokes.md § Adding a computer over SSH.
 *
 * Octant downloads no build itself yet: the person puts the release's
 * `octant-<version>-<target>.tar.gz` in a folder in Octant's data folder, and
 * the newest one for the server's target is used. Every build is checked here
 * before a byte goes to the server: each file against the manifest's digest,
 * and the manifest against the release keys of the ring its signature names,
 * with the same code `octant server install` runs on the server.
 */

const execFileAsync = promisify(execFile);

/** The headless CLI's own wire version: a build for another one could not join this computer. */
const WIRE_VERSION = "1";
/** A release build is tens of megabytes; anything near this is not one. */
const MAX_BUILD_BYTES = 1024 * 1024 * 1024;
const BUILD_NAME = /^octant-(.+)-(darwin-arm64|linux-x64|linux-arm64)\.tar\.gz$/;

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
}

export function createHeadlessBuilds(options: {
  readonly folder: string;
  /** The keys each ring believes; tests only, production reads Octant's release keys. */
  readonly trustedKeys?: Readonly<Record<ReleaseRing, ReadonlyArray<string>>>;
}): HeadlessBuilds {
  const verifier = createReleaseFeedVerifier(options.trustedKeys ?? RELEASE_TRUSTED_KEYS);
  return {
    folder: options.folder,
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
        right.version.localeCompare(left.version, undefined, { numeric: true }),
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
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function refused(
  reason: Extract<HeadlessBuildCheck, { readonly status: "refused" }>["reason"],
): HeadlessBuildCheck {
  return { status: "refused", reason };
}
