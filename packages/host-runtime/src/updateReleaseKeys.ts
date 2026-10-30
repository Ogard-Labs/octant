import { createPublicKey, verify, type KeyObject } from "node:crypto";

/** The update rings a release key is trusted for. */
export type ReleaseRing = "stable" | "preview" | "candidate";

/**
 * The public halves of the keys that sign Octant's update feeds, as base64 DER
 * (SPKI). Public verification keys only: no private key lives in this
 * repository. The desktop app and a headless host read the same list, so a hub
 * with no desktop can check a mirrored feed the way an install does.
 *
 * The release tooling rewrites the matching constants in
 * `apps/desktop/src/appUpdateFeed.ts`, so a desktop test requires the two to
 * agree and a rotation that updates only one fails there.
 */
export const RELEASE_STABLE_PUBLIC_KEY =
  "MCowBQYDK2VwAyEA5n78HQaS4Z3kQbVzFG3NCUaW3Gkx4ZogaxpTYPt4B/8=";

/** Signs preview and candidate feeds only; see the desktop updater for why it is separate from the stable key. */
export const RELEASE_PREVIEW_PUBLIC_KEY =
  "MCowBQYDK2VwAyEAAySanIDCejRkQ3oaFsVukg6T7YS+0MaEfYcsdlrSSHc=";

/**
 * Which keys each ring believes. Preview and candidate also believe the stable
 * key, because whoever holds it can already sign stable releases.
 */
export const RELEASE_TRUSTED_KEYS: Readonly<Record<ReleaseRing, ReadonlyArray<string>>> = {
  stable: [RELEASE_STABLE_PUBLIC_KEY],
  preview: [RELEASE_PREVIEW_PUBLIC_KEY, RELEASE_STABLE_PUBLIC_KEY],
  candidate: [RELEASE_PREVIEW_PUBLIC_KEY, RELEASE_STABLE_PUBLIC_KEY],
};

export interface ReleaseFeedVerifier {
  /** Whether this signature is one a key trusted for `ring` produced over these exact bytes. */
  readonly verify: (message: Uint8Array, signature: string, ring: ReleaseRing) => boolean;
  /** Whether any usable key is configured for this ring at all. */
  readonly configured: (ring: ReleaseRing) => boolean;
}

/**
 * Ed25519 verification against the release keys of each ring. Fails closed: no
 * key for the ring, an unusable key, a malformed signature, or a signature over
 * different bytes all return false.
 */
export function createReleaseFeedVerifier(
  trustedKeys: Readonly<Record<ReleaseRing, ReadonlyArray<string>>> = RELEASE_TRUSTED_KEYS,
): ReleaseFeedVerifier {
  const keysFor = (ring: ReleaseRing): ReadonlyArray<KeyObject> =>
    trustedKeys[ring].flatMap((publicKeyBase64) => {
      const key = parsePublicKey(publicKeyBase64);
      return key === undefined ? [] : [key];
    });
  return {
    configured: (ring) => keysFor(ring).length > 0,
    verify: (message, signature, ring) =>
      keysFor(ring).some((key) => {
        try {
          return verify(null, message, key, Buffer.from(signature, "base64"));
        } catch {
          return false;
        }
      }),
  };
}

function parsePublicKey(publicKeyBase64: string): KeyObject | undefined {
  if (publicKeyBase64 === "") return undefined;
  try {
    const key = createPublicKey({
      key: Buffer.from(publicKeyBase64, "base64"),
      format: "der",
      type: "spki",
    });
    // An unusable key is the same as no key, which keeps "we cannot check"
    // from ever reading as "it checked out".
    return key.asymmetricKeyType === "ed25519" ? key : undefined;
  } catch {
    return undefined;
  }
}
