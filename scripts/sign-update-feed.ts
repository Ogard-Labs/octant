/**
 * Build and sign the update feed a release is published behind.
 *
 * This is the other half of `docs/decisions/0034`: the app refuses anything it
 * cannot verify against a compiled-in Ed25519 key, so a release that is not
 * signed here does not exist as far as any install is concerned.
 *
 * What is signed is the release document, canonically encoded — the same bytes
 * `@octant/domain` reconstructs before verifying, so the signature covers the
 * meaning rather than the whitespace a server happened to send.
 *
 * The private key lives with the maintainer and reaches a build host as a
 * secret. Everything here that decides *what* to sign is pure and tested; the
 * key handling is at the edges, so the shape of a feed is exercised on hosts
 * that hold no key.
 */

import { createHash, createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  type AppReleaseRing,
  type AppUpdateFeed,
  type AppUpdateRelease,
  decodeAppUpdateFeed,
  decodeAppUpdateRelease,
  isAppReleaseRing,
} from "@octant/contracts/app-updates";
import { canonicalReleaseBytes } from "@octant/domain";

export const FEED_PRIVATE_KEY_ENVIRONMENT_VARIABLE = "OCTANT_UPDATE_FEED_PRIVATE_KEY";

export interface ReleaseInput {
  readonly version: string;
  readonly ring: AppReleaseRing;
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
  return decodeAppUpdateRelease({
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

/** The name a ring's feed is served under, matching what the app asks for. */
export function feedFileName(platform: string, arch: string): string {
  return `${platform}-${arch}.json`;
}

/** Where a feed sits under the published base: `<ring>/<platform>-<arch>.json`. */
export function feedRelativePath(release: ReleaseInput | AppUpdateRelease): string {
  return `${release.ring}/${feedFileName(release.platform, release.arch)}`;
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
  environment: NodeJS.ProcessEnv = process.env,
): FeedSigningMaterial {
  const privateKey = (environment[FEED_PRIVATE_KEY_ENVIRONMENT_VARIABLE] ?? "").trim();
  if (privateKey === "") {
    return {
      kind: "unsigned-refuse",
      reason: `${FEED_PRIVATE_KEY_ENVIRONMENT_VARIABLE} is not set, so this release cannot be signed.`,
    };
  }
  return { kind: "ready", privateKey };
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
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] ?? "";
    if (!argument.startsWith("--")) continue;
    const equals = argument.indexOf("=");
    if (equals === -1) {
      const next = argv[index + 1];
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
  if (!isAppReleaseRing(ring)) throw new Error(`--ring must be stable or preview, not ${ring}.`);
  const notesFile = values.get("notes-file");
  return {
    version: required("version"),
    ring,
    platform: required("platform"),
    arch: required("arch"),
    url: required("url"),
    artifact: required("artifact"),
    releasedAt: required("released-at"),
    out: required("out"),
    ...(notesFile === undefined || notesFile === "" ? {} : { notesFile }),
  };
}

async function main(argv: ReadonlyArray<string>): Promise<void> {
  if (argv.includes("--generate-key")) {
    const pair = generateFeedKeyPair();
    console.log(`public  (compile into OCTANT_UPDATE_PUBLIC_KEY):\n${pair.publicKey}\n`);
    console.log(
      `private (store as the ${FEED_PRIVATE_KEY_ENVIRONMENT_VARIABLE} secret):\n${pair.privateKey}`,
    );
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
    platform: command.platform,
    arch: command.arch,
    url: command.url,
    sha256: sha256Hex(artifact),
    releasedAt: command.releasedAt,
    ...(notes === undefined ? {} : { notes: notes.trim().slice(0, 4096) }),
  };

  if (dryRun) {
    const { release, feedPath } = dryRunFeedDocument(releaseInput);
    const material = resolveFeedSigningMaterial();
    console.log(`Dry-run feed path: <base>/${feedPath}`);
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

  const material = resolveFeedSigningMaterial();
  if (material.kind === "unsigned-refuse") {
    throw new Error(material.reason);
  }
  const release = buildRelease(releaseInput);
  const feed = signFeed(release, material.privateKey);
  await mkdir(dirname(command.out), { recursive: true });
  await writeFile(command.out, `${JSON.stringify(feed, null, 2)}\n`, "utf8");
  console.log(`Signed ${release.ring} feed for ${release.version}: ${command.out}`);
  console.log(`Publish it at <base>/${feedRelativePath(release)}`);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
