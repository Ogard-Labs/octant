/**
 * Write `octant-host-features.json`, the document each published Octant
 * release carries beside its archives.
 *
 * It says which native client protocol and which brokered features that
 * build's host offers an Octant Nightly window. A Nightly build attaches to
 * whatever Octant a person already has, so before Nightly is published its
 * preflight can compare what it needs with what the published Octant offers.
 *
 * Read from the contracts rather than written by hand: the host advertises
 * exactly `NIGHTLY_HOST_FEATURES` (its own test asserts that), so a list typed
 * into a workflow would drift from the build it describes.
 *
 *   bun scripts/write-host-features.ts --version <octant version> --out <file>
 */

import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { decodeAppVersion } from "@octant/contracts/app-updates";
import {
  decodeOctantHostFeaturesDocument,
  NIGHTLY_HOST_FEATURES,
  NIGHTLY_NATIVE_CLIENT_PROTOCOL,
  type OctantHostFeaturesDocument,
} from "@octant/contracts/nightly-browser";

export const HOST_FEATURES_ASSET_NAME = "octant-host-features.json";

/** The document for one Octant build, checked with the decoder a reader uses. */
export function hostFeaturesDocument(version: string): OctantHostFeaturesDocument {
  const octantVersion = decodeAppVersion(version);
  if (String(octantVersion).includes("-preview.")) {
    // Preview builds are Octant Nightly, which brokers nothing for a client.
    throw new Error(`${version} is an Octant Nightly version; only Octant hosts publish this.`);
  }
  return decodeOctantHostFeaturesDocument({
    schemaVersion: 1,
    octantVersion,
    nativeClientProtocol: NIGHTLY_NATIVE_CLIENT_PROTOCOL,
    hostFeatures: [...NIGHTLY_HOST_FEATURES],
  });
}

export type PublishedHostFeatures =
  | { readonly status: "compatible"; readonly document: OctantHostFeaturesDocument }
  | {
      readonly status: "protocol-mismatch";
      readonly published: number;
      readonly expected: number;
    }
  | { readonly status: "unreadable" };

/**
 * Read a published `octant-host-features.json` against this checkout's native
 * client protocol. A newer or older protocol is reported, not treated as an
 * unreadable document, so a check can say which Octant it needs.
 *
 * Advisory only: the asset is unsigned, so nothing outside CI may gate a
 * release on it until it is signed or hash-pinned.
 */
export function readPublishedHostFeatures(value: unknown): PublishedHostFeatures {
  let document: OctantHostFeaturesDocument;
  try {
    document = decodeOctantHostFeaturesDocument(value);
  } catch {
    return { status: "unreadable" };
  }
  if (document.nativeClientProtocol !== NIGHTLY_NATIVE_CLIENT_PROTOCOL) {
    return {
      status: "protocol-mismatch",
      published: document.nativeClientProtocol,
      expected: NIGHTLY_NATIVE_CLIENT_PROTOCOL,
    };
  }
  return { status: "compatible", document };
}

export function parseHostFeaturesCommand(argv: ReadonlyArray<string>): {
  readonly version: string;
  readonly out: string;
} {
  const value = (name: string): string => {
    const index = argv.indexOf(`--${name}`);
    const found = index === -1 ? undefined : argv[index + 1];
    if (found === undefined || found === "" || found.startsWith("--")) {
      throw new Error(`--${name} is required.`);
    }
    return found;
  };
  return { version: value("version"), out: value("out") };
}

async function main(argv: ReadonlyArray<string>): Promise<void> {
  const command = parseHostFeaturesCommand(argv);
  const document = hostFeaturesDocument(command.version);
  await mkdir(dirname(command.out), { recursive: true });
  await writeFile(command.out, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  console.log(`Wrote ${HOST_FEATURES_ASSET_NAME} for Octant ${command.version}: ${command.out}`);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}
