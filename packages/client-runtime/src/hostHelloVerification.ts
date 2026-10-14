import type { HostHelloV1 } from "@octant/contracts/remote-access";
import { buildHostHelloSignaturePayload } from "@octant/domain";

/** The host identity a paired client recorded when it paired. */
export interface PinnedHostIdentity {
  readonly hostId: string;
  readonly hostKeyFingerprint: string;
}

export type HostHelloVerification =
  | { readonly status: "verified" }
  | {
      readonly status: "refused";
      /**
       * `host-outdated`: the hello carries no public key, so this host was
       * built before clients checked it. Updating the host fixes it; the
       * pairing stays.
       * `unproven`: the hello's key does not match its fingerprint or its
       * signature does not verify, so whoever answered does not hold the key
       * it names.
       * `host-changed`: a proven hello from a different host id or identity
       * key than the one recorded at pairing.
       */
      readonly reason: "host-outdated" | "unproven" | "host-changed";
      readonly message: string;
    };

const OUTDATED_MESSAGE =
  "This host runs an older Octant that cannot prove its identity. Update Octant on the host, then connect again.";
const UNPROVEN_MESSAGE = "This host could not prove its identity, so Octant did not connect.";
const CHANGED_MESSAGE = "Host identity or key fingerprint changed at the same endpoint.";

/**
 * Checks a host hello before a client acts on it. The hello must carry the
 * host identity public key, that key must hash (SHA-256 of its DER
 * SubjectPublicKeyInfo) to the fingerprint the hello states, and the hello's
 * signature must verify against it. With a pin, the proven host id and
 * fingerprint must also equal the ones recorded at pairing.
 *
 * Before this check, clients compared only the fingerprint a host stated
 * about itself, so anything that answered at the paired origin could state
 * the paired fingerprint and pass.
 */
export async function verifyHostHello(
  hello: HostHelloV1,
  pinned?: PinnedHostIdentity,
): Promise<HostHelloVerification> {
  if (hello.hostPublicKey === undefined) {
    return { status: "refused", reason: "host-outdated", message: OUTDATED_MESSAGE };
  }
  const unproven = { status: "refused", reason: "unproven", message: UNPROVEN_MESSAGE } as const;
  const spki = fromBase64Url(hello.hostPublicKey);
  const signature = fromBase64Url(hello.signature);
  if (spki === undefined || signature === undefined) return unproven;
  try {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", spki));
    if (toHex(digest) !== hello.hostKeyFingerprint) return unproven;
    const key = await crypto.subtle.importKey(
      "spki",
      spki,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const verified = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      signature,
      new TextEncoder().encode(buildHostHelloSignaturePayload(hello)),
    );
    if (!verified) return unproven;
  } catch {
    return unproven;
  }
  if (
    pinned !== undefined &&
    (hello.hostId !== pinned.hostId || hello.hostKeyFingerprint !== pinned.hostKeyFingerprint)
  ) {
    return { status: "refused", reason: "host-changed", message: CHANGED_MESSAGE };
  }
  return { status: "verified" };
}

function fromBase64Url(value: string): Uint8Array<ArrayBuffer> | undefined {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) return undefined;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  try {
    const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return undefined;
  }
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
