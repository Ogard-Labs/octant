import { createHash, createPublicKey, verify } from "node:crypto";
import {
  decodeExtensionPublisherKeyFingerprint,
  type ExtensionPublisherKeyFingerprint,
} from "@octant/contracts/extensions";
import {
  OUTSIDE_PROVIDER_DRIVER_SIGNATURE_PATH,
  decodeOutsideProviderDriverSignatureDocument,
  outsideProviderDriverSignedMessage,
} from "@octant/plugin-api/outside-provider-driver";
import type { ExtensionArchiveEntry } from "./packageInspector";

/** What a driver package's signature file says, once the host has checked it. */
export type OutsideDriverSignatureReading =
  | { readonly status: "unsigned" }
  | { readonly status: "signed"; readonly publisherKey: ExtensionPublisherKeyFingerprint }
  | { readonly status: "invalid" };

/** The package facts a signature must name exactly as the host read them. */
export interface OutsideDriverSignedFacts {
  readonly name: string;
  readonly version: string;
  readonly protocolVersions: ReadonlyArray<string>;
}

/**
 * Checks `octant-signature.json` against the package as the host read it.
 * The host hashes every other file itself and builds the signed message from
 * its own reading, so the file's list must name exactly those files with
 * exactly those hashes, and its name, version, and protocol versions must be
 * the package's. Any difference, an unreadable file, a link or other
 * non-file entry the signature cannot cover, or a signature that does not
 * verify under the key it carries is `invalid`; nothing in it is repeated.
 */
export function readOutsideDriverSignature(
  entries: ReadonlyArray<ExtensionArchiveEntry>,
  facts: OutsideDriverSignedFacts,
): OutsideDriverSignatureReading {
  const signatureEntry = entries.find(
    (entry) => entry.path === OUTSIDE_PROVIDER_DRIVER_SIGNATURE_PATH,
  );
  if (signatureEntry === undefined) return { status: "unsigned" };
  if (signatureEntry.kind !== "file" || signatureEntry.content === undefined) {
    return { status: "invalid" };
  }
  const decoded = decodeOutsideProviderDriverSignatureDocument(parseJson(signatureEntry.content));
  if (decoded._tag === "Left") return { status: "invalid" };
  const document = decoded.right;

  if (entries.some((entry) => entry.kind !== "file" && entry.kind !== "directory")) {
    return { status: "invalid" };
  }
  const files: Array<{ readonly path: string; readonly sha256: string }> = [];
  for (const entry of entries) {
    if (entry.kind !== "file" || entry.path === OUTSIDE_PROVIDER_DRIVER_SIGNATURE_PATH) continue;
    if (entry.content === undefined) return { status: "invalid" };
    files.push({
      path: entry.path,
      sha256: createHash("sha256").update(entry.content).digest("hex"),
    });
  }
  if (!sameFiles(files, document.files)) return { status: "invalid" };
  if (
    document.name !== facts.name ||
    document.version !== facts.version ||
    !sameSet(document.protocolVersions, facts.protocolVersions)
  ) {
    return { status: "invalid" };
  }

  const rawKey = Buffer.from(document.publicKey, "base64");
  if (rawKey.length !== 32) return { status: "invalid" };
  let verified: boolean;
  try {
    const key = createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: rawKey.toString("base64url") },
      format: "jwk",
    });
    verified = verify(
      null,
      outsideProviderDriverSignedMessage({
        name: facts.name,
        version: facts.version,
        protocolVersions: facts.protocolVersions,
        files,
      }),
      key,
      Buffer.from(document.signature, "base64"),
    );
  } catch {
    return { status: "invalid" };
  }
  if (!verified) return { status: "invalid" };
  return {
    status: "signed",
    publisherKey: decodeExtensionPublisherKeyFingerprint(
      `ed25519:${createHash("sha256").update(rawKey).digest("hex")}`,
    ),
  };
}

function sameFiles(
  computed: ReadonlyArray<{ readonly path: string; readonly sha256: string }>,
  listed: ReadonlyArray<{ readonly path: string; readonly sha256: string }>,
): boolean {
  if (computed.length !== listed.length) return false;
  const byPath = new Map(listed.map((file) => [file.path, file.sha256]));
  if (byPath.size !== listed.length) return false;
  return computed.every((file) => byPath.get(file.path) === file.sha256);
}

function sameSet(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === rightSet.size && [...leftSet].every((value) => rightSet.has(value));
}

function parseJson(content: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content)) as unknown;
  } catch {
    return undefined;
  }
}
