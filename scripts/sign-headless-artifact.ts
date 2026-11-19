/**
 * Sign a headless build for release.
 *
 * The build job runs unreviewed code and holds no key, so it produces an
 * unsigned tarball. The release job, which holds the ring's key, unpacks that
 * tarball, checks every file against the manifest, signs the manifest and
 * packs it again. `octant server install` refuses a build without this
 * signature unless the person says they built it themselves.
 *
 * The key is chosen by ring through the feed signer, so the preview workflow
 * cannot sign with the stable key, and a key the CLI does not trust for the
 * ring fails the job instead of publishing a build every install refuses.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { isAppReleaseRing } from "@octant/contracts/app-updates";
import {
  createReleaseFeedVerifier,
  decodeHeadlessArtifactManifest,
  encodeHeadlessArtifactSignature,
  HEADLESS_ARTIFACT_MANIFEST_FILENAME,
  HEADLESS_ARTIFACT_SIGNATURE_FILENAME,
  inspectHeadlessArtifact,
  type HeadlessArtifactManifest,
  RELEASE_TRUSTED_KEYS,
  signHeadlessArtifactManifest,
  verifyHeadlessArtifactSignature,
  type ReleaseRing,
} from "@octant/host-runtime";
import { createDeterministicTarball } from "./package-headless";
import { refuseUntrustedSigningKey, resolveFeedSigningMaterial } from "./sign-update-feed";

const execFileAsync = promisify(execFile);

export type HeadlessArtifactSigning =
  | { readonly status: "signed"; readonly version: string }
  | { readonly status: "refused"; readonly reason: string };

export interface SignHeadlessArtifactDirectoryOptions {
  readonly artifactRoot: string;
  readonly ring: ReleaseRing;
  readonly privateKeyBase64: string;
  readonly trustedKeys?: Readonly<Record<ReleaseRing, ReadonlyArray<string>>>;
}

/** Checks an unpacked build against its manifest and writes its signature beside it. */
export async function signHeadlessArtifactDirectory(
  options: SignHeadlessArtifactDirectoryOptions,
): Promise<HeadlessArtifactSigning> {
  const trustedKeys = options.trustedKeys ?? RELEASE_TRUSTED_KEYS;
  const trust = refuseUntrustedSigningKey(options.privateKeyBase64, options.ring, trustedKeys);
  if (trust.kind === "refused") return { status: "refused", reason: trust.reason };
  let declared: HeadlessArtifactManifest;
  try {
    declared = decodeHeadlessArtifactManifest(
      await readFile(join(options.artifactRoot, HEADLESS_ARTIFACT_MANIFEST_FILENAME), "utf8"),
    );
  } catch {
    return { status: "refused", reason: "the build has no readable manifest." };
  }
  // Inspected as its own target so a build for another platform can be signed
  // on this one; what is checked is that every file matches its digest.
  const inspection = await inspectHeadlessArtifact({
    artifactRoot: options.artifactRoot,
    runtime: {
      platform: declared.target.platform,
      arch: declared.target.arch,
      wireVersion: declared.wireVersion,
    },
  });
  if (!inspection.ok) {
    return {
      status: "refused",
      reason: `the build does not match its manifest (${inspection.rejection.code}).`,
    };
  }
  const signatureText = encodeHeadlessArtifactSignature(
    signHeadlessArtifactManifest(inspection.manifest, options.ring, options.privateKeyBase64),
  );
  const check = verifyHeadlessArtifactSignature({
    manifest: inspection.manifest,
    signatureText,
    verifier: createReleaseFeedVerifier(trustedKeys),
  });
  if (check.status === "refused") {
    return { status: "refused", reason: `the signature did not verify (${check.reason}).` };
  }
  await writeFile(join(options.artifactRoot, HEADLESS_ARTIFACT_SIGNATURE_FILENAME), signatureText, {
    mode: 0o644,
  });
  return { status: "signed", version: inspection.manifest.artifactVersion };
}

/** Unpacks a build's tarball, signs it, and packs the signed build at `out`. */
export async function signHeadlessArtifactTarball(
  options: Omit<SignHeadlessArtifactDirectoryOptions, "artifactRoot"> & {
    readonly tarball: string;
    readonly out: string;
  },
): Promise<HeadlessArtifactSigning> {
  const workspace = await mkdtemp(join(tmpdir(), "octant-headless-sign-"));
  try {
    await execFileAsync("tar", ["-xzf", options.tarball, "-C", workspace]);
    const entries = await readdir(workspace);
    const [artifactName] = entries;
    if (artifactName === undefined || entries.length !== 1) {
      return { status: "refused", reason: "the tarball does not hold exactly one build." };
    }
    const artifactRoot = join(workspace, artifactName);
    const signed = await signHeadlessArtifactDirectory({ ...options, artifactRoot });
    if (signed.status === "refused") return signed;
    await writeFile(options.out, await createDeterministicTarball(artifactRoot, artifactName));
    return signed;
  } finally {
    await rm(workspace, { force: true, recursive: true });
  }
}

const USAGE =
  "Usage: sign-headless-artifact.ts --tarball <build.tar.gz> --ring <stable|preview|candidate> --out <signed.tar.gz>";

async function main(argv: ReadonlyArray<string>): Promise<void> {
  const value = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    return index === -1 ? undefined : argv[index + 1];
  };
  const tarball = value("--tarball");
  const ring = value("--ring");
  const out = value("--out");
  if (tarball === undefined || out === undefined || ring === undefined || !isAppReleaseRing(ring)) {
    throw new Error(USAGE);
  }
  const material = resolveFeedSigningMaterial(ring);
  if (material.kind === "unsigned-refuse") throw new Error(material.reason);
  const signed = await signHeadlessArtifactTarball({
    tarball: resolve(tarball),
    out: resolve(out),
    ring,
    privateKeyBase64: material.privateKey,
  });
  if (signed.status === "refused") {
    throw new Error(`Refusing to sign ${basename(tarball)}: ${signed.reason}`);
  }
  console.log(`Signed ${ring} headless build ${signed.version}: ${resolve(out)}`);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
