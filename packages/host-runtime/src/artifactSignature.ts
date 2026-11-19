import { createPrivateKey, sign } from "node:crypto";
import type { HeadlessArtifactManifest } from "./artifactManifest";
import type { ReleaseFeedVerifier, ReleaseRing } from "./updateReleaseKeys";

/**
 * The detached signature that sits beside `octant-artifact.json` in a headless
 * build. It is a separate file because the manifest decoder refuses unknown
 * keys, and because the release job that holds a ring's key signs the build
 * after the untrusted job that built it.
 */
export const HEADLESS_ARTIFACT_SIGNATURE_FILENAME = "octant-artifact.sig";

const SIGNATURE_FORMAT = "octant-artifact-signature/1";
const RELEASE_RINGS: ReadonlyArray<ReleaseRing> = ["stable", "preview", "candidate"];

export interface HeadlessArtifactSignature {
  readonly ring: ReleaseRing;
  /** Ed25519 over the manifest's canonical bytes, base64. */
  readonly signature: string;
}

export type HeadlessArtifactSignatureCheck =
  | { readonly status: "verified"; readonly ring: ReleaseRing }
  | { readonly status: "refused"; readonly reason: "missing" | "malformed" | "unverified" };

/**
 * The bytes a ring's key signs: the manifest as JSON with every object's keys
 * sorted and no whitespace, so re-encoding or reordering the file never changes
 * what was signed. Every component's digest is part of it, so the signature
 * covers each file the build installs.
 */
export function canonicalHeadlessArtifactManifestBytes(
  manifest: HeadlessArtifactManifest,
): Uint8Array {
  return new TextEncoder().encode(canonicalJson(manifest));
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Signs a build's manifest with a ring's private key (base64 PKCS8 DER), as the release job does. */
export function signHeadlessArtifactManifest(
  manifest: HeadlessArtifactManifest,
  ring: ReleaseRing,
  privateKeyBase64: string,
): HeadlessArtifactSignature {
  const key = createPrivateKey({
    key: Buffer.from(privateKeyBase64, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const signature = sign(null, canonicalHeadlessArtifactManifestBytes(manifest), key);
  return { ring, signature: signature.toString("base64") };
}

export function encodeHeadlessArtifactSignature(signature: HeadlessArtifactSignature): string {
  return `${JSON.stringify(
    { format: SIGNATURE_FORMAT, ring: signature.ring, signature: signature.signature },
    null,
    2,
  )}\n`;
}

/** The signature document, or undefined when it is not exactly one this version reads. */
export function decodeHeadlessArtifactSignature(
  text: string,
): HeadlessArtifactSignature | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.join(",") !== "format,ring,signature") return undefined;
  if (record["format"] !== SIGNATURE_FORMAT) return undefined;
  const ring = RELEASE_RINGS.find((candidate) => candidate === record["ring"]);
  const signature = record["signature"];
  if (ring === undefined || typeof signature !== "string" || signature.length === 0) {
    return undefined;
  }
  return { ring, signature };
}

/**
 * Checks a build against the release keys of the ring its signature names.
 * Fails closed: no signature, a document this version cannot read, or a
 * signature no trusted key made over these exact manifest bytes is refused.
 */
export function verifyHeadlessArtifactSignature(input: {
  readonly manifest: HeadlessArtifactManifest;
  readonly signatureText: string | undefined;
  readonly verifier: ReleaseFeedVerifier;
}): HeadlessArtifactSignatureCheck {
  if (input.signatureText === undefined) return { status: "refused", reason: "missing" };
  const decoded = decodeHeadlessArtifactSignature(input.signatureText);
  if (decoded === undefined) return { status: "refused", reason: "malformed" };
  const verified = input.verifier.verify(
    canonicalHeadlessArtifactManifestBytes(input.manifest),
    decoded.signature,
    decoded.ring,
  );
  return verified
    ? { status: "verified", ring: decoded.ring }
    : { status: "refused", reason: "unverified" };
}
