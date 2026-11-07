/**
 * Build and sign the update feed a release is published behind.
 *
 * This is the other half of update trust: the app refuses anything it
 * cannot verify against a compiled-in Ed25519 key, so a release that is not
 * signed here does not exist as far as any install is concerned.
 *
 * What is signed is the release document, canonically encoded — the same bytes
 * `@octant/domain` reconstructs before verifying, so the signature covers the
 * meaning rather than the whitespace a server happened to send.
 *
 * The private key lives with the maintainer and reaches a build host as a
 * secret. Each ring has its own: stable is signed with the key only the
 * approval-gated stable environment holds, and preview and candidate with a
 * separate preview key, because the preview workflow runs unreviewed `main`
 * and anything that runs there can read its key. Everything here that decides
 * *what* to sign is pure and tested; the key handling is at the edges, so the
 * shape of a feed is exercised on hosts that hold no key.
 *
 * The signed release names its app, from the build's flavor, so Octant and
 * Octant Nightly each refuse the other's builds. Installs built before that
 * field decode a feed strictly and call a document carrying it malformed, so
 * `--legacy-document` writes the old shape for the one name such Octant
 * installs still read (`legacyUpdateFeedRelativePath`). Nothing writes the old
 * shape for Nightly: the old preview names were read by Octant builds.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type AppReleaseRing,
  type AppUpdateFeed,
  type AppUpdateRelease,
  APP_RELEASE_RINGS,
  decodeAppUpdateFeed,
  decodeAppUpdateRelease,
  isAppReleaseRing,
} from "@octant/contracts/app-updates";
import { canonicalReleaseBytes, canonicalReleaseBytesWithoutProduct } from "@octant/domain";
import { type DesktopFlavor, desktopIdentity } from "@octant/host-runtime";
import {
  legacyUpdateFeedRelativePath,
  OCTANT_UPDATE_TRUSTED_KEYS,
  updateFeedRelativePath,
} from "../apps/desktop/src/appUpdateFeed";

export const FEED_PRIVATE_KEY_ENVIRONMENT_VARIABLE = "OCTANT_UPDATE_FEED_PRIVATE_KEY";
export const FEED_PREVIEW_PRIVATE_KEY_ENVIRONMENT_VARIABLE =
  "OCTANT_UPDATE_FEED_PREVIEW_PRIVATE_KEY";

/**
 * The secret a ring's feed is signed with.
 *
 * Chosen by ring rather than passed in, so the preview workflow cannot sign
 * with the stable key by forgetting to switch variables, and the stable
 * workflow never reads the preview one.
 */
export function feedPrivateKeyVariable(ring: AppReleaseRing): string {
  return ring === "stable"
    ? FEED_PRIVATE_KEY_ENVIRONMENT_VARIABLE
    : FEED_PREVIEW_PRIVATE_KEY_ENVIRONMENT_VARIABLE;
}

export interface ReleaseInput {
  readonly version: string;
  readonly ring: AppReleaseRing;
  /** The build's flavor, which names the app the release is for. */
  readonly flavor: DesktopFlavor;
  readonly platform: string;
  readonly arch: string;
  readonly url: string;
  readonly sha256: string;
  readonly releasedAt: string;
  readonly notes?: string;
}

/**
 * Validate a release against the contract the app will decode it with.
 *
 * Deliberately the same decoder rather than a looser local check: a feed that
 * this script would emit but the app would call malformed is a release nobody
 * can install, and the place to find that out is here rather than on someone's
 * machine.
 */
export function buildRelease(input: ReleaseInput): AppUpdateRelease {
  const identity = desktopIdentity(input.flavor);
  if (!(identity.rings as ReadonlyArray<AppReleaseRing>).includes(input.ring)) {
    // A build's flavor follows its ring. A Nightly signed for `candidate` would
    // reach Octant's Preview channel and be refused there as the wrong app.
    throw new Error(`${identity.productName} is not published on the ${input.ring} ring.`);
  }
  return decodeAppUpdateRelease({
    product: identity.updateProduct,
    version: input.version,
    ring: input.ring,
    platform: input.platform,
    arch: input.arch,
    url: input.url,
    sha256: input.sha256,
    releasedAt: input.releasedAt,
    ...(input.notes === undefined || input.notes === "" ? {} : { notes: input.notes }),
  });
}

/**
 * Where a feed sits under the published base. The app's own addressing, so the
 * publisher cannot drift from what installs ask for.
 */
export function feedRelativePath(release: ReleaseInput | AppUpdateRelease): string {
  return updateFeedRelativePath(release);
}

/**
 * The old-shape document for installs built before the release named its app:
 * the same release without `product`, signed over the encoding they verify.
 *
 * Refused for any release but an Octant candidate, the one ring whose old name
 * belongs to Octant alone (`legacyUpdateFeedRelativePath`).
 */
export interface LegacyFeedDocument {
  readonly schemaVersion: 1;
  readonly release: Omit<AppUpdateRelease, "product">;
  readonly signature: string;
}

export function legacyFeedRelativePath(release: AppUpdateRelease): string {
  const path = legacyUpdateFeedRelativePath(release);
  if (path === undefined || release.product !== "octant") {
    throw new Error(
      `No old-shape feed is published for ${release.product} on the ${release.ring} ring.`,
    );
  }
  return path;
}

export function signLegacyFeed(
  release: AppUpdateRelease,
  privateKeyBase64: string,
): LegacyFeedDocument {
  legacyFeedRelativePath(release);
  const { product: _product, ...unnamed } = release;
  const key = createPrivateKey({
    key: Buffer.from(privateKeyBase64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const signature = sign(null, canonicalReleaseBytesWithoutProduct(unnamed), key).toString(
    "base64",
  );
  // The schema check of the current shape, so the old one cannot drift past
  // what the release fields and signature allow.
  decodeAppUpdateFeed({ schemaVersion: 1, release, signature });
  return { schemaVersion: 1, release: unnamed, signature };
}

/**
 * Sign a release into the document the app fetches.
 *
 * The signature is produced over `canonicalReleaseBytes`, and the result is
 * decoded before being returned — so a signature that would not satisfy the
 * app's own schema fails here instead of being published.
 */
export function signFeed(release: AppUpdateRelease, privateKeyBase64: string): AppUpdateFeed {
  const key = createPrivateKey({
    key: Buffer.from(privateKeyBase64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const signature = sign(null, canonicalReleaseBytes(release), key).toString("base64");
  return decodeAppUpdateFeed({ schemaVersion: 1, release, signature });
}

/**
 * Mint a release key pair, as base64 DER.
 *
 * A convenience for the one time this is needed: the public half is compiled
 * into the app and the private half becomes a secret. Printed rather than
 * written anywhere, so the private half never lands in a file this repository
 * could accidentally track.
 */
export function generateFeedKeyPair(): { readonly publicKey: string; readonly privateKey: string } {
  const pair = generateKeyPairSync("ed25519");
  return {
    publicKey: pair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Whether this host can sign a feed right now.
 *
 * A missing private key is not a soft skip at publish time: an unsigned feed
 * document must never be written where a signed one belongs. Dry-run
 * scaffolding validates the release shape and path without minting that file.
 */
export type FeedSigningMaterial =
  | { readonly kind: "ready"; readonly privateKey: string }
  | { readonly kind: "unsigned-refuse"; readonly reason: string };

export function resolveFeedSigningMaterial(
  ring: AppReleaseRing,
  environment: NodeJS.ProcessEnv = process.env,
): FeedSigningMaterial {
  const variable = feedPrivateKeyVariable(ring);
  const privateKey = (environment[variable] ?? "").trim();
  if (privateKey === "") {
    return {
      kind: "unsigned-refuse",
      reason: `${variable} is not set, so this ${ring} release cannot be signed.`,
    };
  }
  return { kind: "ready", privateKey };
}

/**
 * Refuse to sign with a key the app does not trust for this ring.
 *
 * Signing still works with any key, so without this a preview release signed
 * before its public half was compiled in, or a secret pasted into the wrong
 * environment, would publish a feed every install refuses. Checking against
 * the same table the app verifies with makes that a failed release job instead.
 */
export function refuseUntrustedSigningKey(
  privateKeyBase64: string,
  ring: AppReleaseRing,
  trustedKeys: Readonly<Record<AppReleaseRing, ReadonlyArray<string>>> = OCTANT_UPDATE_TRUSTED_KEYS,
): { readonly kind: "trusted" } | { readonly kind: "refused"; readonly reason: string } {
  let publicKey: string;
  try {
    const privateKey = createPrivateKey({
      key: Buffer.from(privateKeyBase64, "base64"),
      format: "der",
      type: "pkcs8",
    });
    publicKey = createPublicKey(privateKey.export({ format: "pem", type: "pkcs8" }))
      .export({ format: "der", type: "spki" })
      .toString("base64");
  } catch {
    return { kind: "refused", reason: "the signing key is not a base64 PKCS8 private key." };
  }
  if (trustedKeys[ring].includes(publicKey)) return { kind: "trusted" };
  return {
    kind: "refused",
    reason: `the app does not trust this key for the ${ring} ring; compile its public half (${publicKey}) into apps/desktop/src/appUpdateFeed.ts first.`,
  };
}

/**
 * Validate the release the workflow would publish, and name its feed path,
 * without producing a signature.
 *
 * Used by release-matrix scaffolding when the signing secret is absent: the
 * path and schema still have to match `<ring>/<platform>-<arch>.json`, and
 * refusing to write an unsigned feed is the correct outcome.
 */
export function dryRunFeedDocument(input: ReleaseInput): {
  readonly release: AppUpdateRelease;
  readonly feedPath: string;
} {
  const release = buildRelease(input);
  return { release, feedPath: feedRelativePath(release) };
}

export interface FeedCommand {
  readonly version: string;
  readonly ring: AppReleaseRing;
  readonly flavor: DesktopFlavor;
  /** Write the old-shape document for its legacy name instead. */
  readonly legacyDocument: boolean;
  readonly platform: string;
  readonly arch: string;
  readonly url: string;
  readonly artifact: string;
  readonly releasedAt: string;
  readonly out: string;
  readonly notesFile?: string;
}

/**
 * Read the command line into a complete instruction, or say what is missing.
 *
 * Every field is required rather than defaulted. A feed built from guesses is
 * a signed statement about a release nobody checked, and the failure mode —
 * publishing last release's URL under this release's version — is invisible
 * until someone downloads it.
 */
export function parseFeedCommand(argv: ReadonlyArray<string>): FeedCommand {
  const values = new Map<string, string>();
  const valued = argv.filter((argument) => argument !== "--legacy-document");
  for (let index = 0; index < valued.length; index += 1) {
    const argument = valued[index] ?? "";
    if (!argument.startsWith("--")) continue;
    const equals = argument.indexOf("=");
    if (equals === -1) {
      const next = valued[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`${argument} needs a value.`);
      }
      values.set(argument.slice(2), next);
      index += 1;
    } else {
      values.set(argument.slice(2, equals), argument.slice(equals + 1));
    }
  }
  const required = (name: string): string => {
    const value = values.get(name);
    if (value === undefined || value === "") throw new Error(`--${name} is required.`);
    return value;
  };
  const ring = required("ring");
  if (!isAppReleaseRing(ring)) {
    throw new Error(
      `--ring must be a known release ring (${APP_RELEASE_RINGS.join(", ")}), not ${ring}.`,
    );
  }
  const flavor = required("flavor");
  if (flavor !== "stable" && flavor !== "nightly") {
    throw new Error(`--flavor must be stable or nightly, not ${flavor}.`);
  }
  const notesFile = values.get("notes-file");
  return {
    version: required("version"),
    ring,
    flavor,
    legacyDocument: argv.includes("--legacy-document"),
    platform: required("platform"),
    arch: required("arch"),
    url: required("url"),
    artifact: required("artifact"),
    releasedAt: required("released-at"),
    out: required("out"),
    ...(notesFile === undefined || notesFile === "" ? {} : { notesFile }),
  };
}

/**
 * `--print-feed-path --ring <ring> --platform <p> --arch <a> [--legacy-document]`:
 * the file name, under the ring's mailbox, that a feed is published as.
 */
export function printedFeedPath(argv: ReadonlyArray<string>): string {
  const value = (name: string): string => {
    const index = argv.indexOf(`--${name}`);
    const found = index === -1 ? undefined : argv[index + 1];
    if (found === undefined || found === "" || found.startsWith("--")) {
      throw new Error(`--${name} is required.`);
    }
    return found;
  };
  const target = { ring: value("ring"), platform: value("platform"), arch: value("arch") };
  if (!isAppReleaseRing(target.ring)) throw new Error(`Unknown release ring ${target.ring}.`);
  if (!argv.includes("--legacy-document")) return updateFeedRelativePath(target);
  const legacy = legacyUpdateFeedRelativePath(target);
  if (legacy === undefined) {
    throw new Error(`No old-shape feed is published on the ${target.ring} ring.`);
  }
  return legacy;
}

async function main(argv: ReadonlyArray<string>): Promise<void> {
  if (argv.includes("--generate-key")) {
    const pair = generateFeedKeyPair();
    console.log(
      `public  (compile into OCTANT_UPDATE_PUBLIC_KEY for stable, or OCTANT_UPDATE_PREVIEW_PUBLIC_KEY for preview):\n${pair.publicKey}\n`,
    );
    console.log(
      `private (store as the ${FEED_PRIVATE_KEY_ENVIRONMENT_VARIABLE} secret in the stable environment, or ${FEED_PREVIEW_PRIVATE_KEY_ENVIRONMENT_VARIABLE} in the preview environment):\n${pair.privateKey}`,
    );
    return;
  }
  if (argv.includes("--print-feed-path")) {
    // The workflows name the files they publish from here, so a feed cannot
    // land at a name the app does not read.
    console.log(printedFeedPath(argv));
    return;
  }
  const dryRun = argv.includes("--dry-run");
  const command = parseFeedCommand(argv.filter((argument) => argument !== "--dry-run"));
  // Hashed from the artifact on disk rather than taken as an argument: the
  // hash is what the app checks the downloaded bytes against, and a hash
  // supplied by hand is a hash of whatever the author believed was there.
  const artifact = await readFile(command.artifact);
  const notes =
    command.notesFile === undefined ? undefined : await readFile(command.notesFile, "utf8");
  const releaseInput: ReleaseInput = {
    version: command.version,
    ring: command.ring,
    flavor: command.flavor,
    platform: command.platform,
    arch: command.arch,
    url: command.url,
    sha256: sha256Hex(artifact),
    releasedAt: command.releasedAt,
    ...(notes === undefined ? {} : { notes: notes.trim().slice(0, 4096) }),
  };

  if (dryRun) {
    const { release, feedPath } = dryRunFeedDocument(releaseInput);
    const material = resolveFeedSigningMaterial(release.ring);
    console.log(
      `Dry-run feed path: <base>/${command.legacyDocument ? legacyFeedRelativePath(release) : feedPath}`,
    );
    console.log(
      `Dry-run release schema ok for ${release.version} (${release.platform}-${release.arch}).`,
    );
    if (material.kind === "unsigned-refuse") {
      console.log(`Unsigned refuse: ${material.reason}`);
      console.log("No feed file written.");
      return;
    }
    console.log("Signing material is present; re-run without --dry-run to write a signed feed.");
    return;
  }

  const material = resolveFeedSigningMaterial(command.ring);
  if (material.kind === "unsigned-refuse") {
    throw new Error(material.reason);
  }
  const trust = refuseUntrustedSigningKey(material.privateKey, command.ring);
  if (trust.kind === "refused") {
    throw new Error(`Refusing to sign: ${trust.reason}`);
  }
  const release = buildRelease(releaseInput);
  const feed = command.legacyDocument
    ? signLegacyFeed(release, material.privateKey)
    : signFeed(release, material.privateKey);
  const published = command.legacyDocument
    ? legacyFeedRelativePath(release)
    : feedRelativePath(release);
  await mkdir(dirname(command.out), { recursive: true });
  await writeFile(command.out, `${JSON.stringify(feed, null, 2)}\n`, "utf8");
  console.log(`Signed ${release.ring} feed for ${release.version}: ${command.out}`);
  console.log(`Publish it at <base>/${published}`);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
