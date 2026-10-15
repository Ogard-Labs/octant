import {
  HOST_HELLO_CLIENT_NONCE_PARAMETER,
  type HostHelloV1,
} from "@octant/contracts/remote-access";
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
       * `host-outdated`: the hello carries no public key or does not answer
       * a client nonce, so this host was built before clients checked it.
       * Updating the host fixes it; the pairing stays.
       * `unproven`: the hello's key does not match its fingerprint, its
       * signature does not verify, or it answers another request's client
       * nonce, so whoever answered has not shown it holds the key it names
       * now.
       * `host-changed`: a proven hello from a different host id or identity
       * key than the one recorded at pairing.
       * `expired`: the hello's own expiry has passed (beyond the allowed
       * clock skew), so it is stale or replayed.
       */
      readonly reason: "host-outdated" | "unproven" | "host-changed" | "expired";
      readonly message: string;
    };

export const HOST_OUTDATED_MESSAGE =
  "This host runs an older Octant that cannot prove its identity. Update Octant on the host, then connect again.";
const UNPROVEN_MESSAGE = "This host could not prove its identity, so Octant did not connect.";
const CHANGED_MESSAGE = "Host identity or key fingerprint changed at the same endpoint.";
const EXPIRED_MESSAGE =
  "This host's hello had already expired, so Octant did not connect. Check this device's clock, then connect again.";

/**
 * How far past its stated expiry a hello is still accepted. Hosts issue hellos
 * valid for one minute; this absorbs a client clock running a little ahead
 * without keeping a captured hello usable for long.
 */
export const HOST_HELLO_CLOCK_SKEW_MS = 2 * 60 * 1_000;

/**
 * A fresh nonce for one hello request: 32 random bytes, unpadded base64url.
 * The host signs it into the hello, so a hello recorded from an earlier
 * request cannot answer this one.
 */
export function createHelloClientNonce(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

/** The hello route at `origin`, naming the request's client nonce. */
export function hostHelloUrl(origin: string, clientNonce: string): string {
  const url = new URL("/api/remote/hello", origin);
  url.searchParams.set(HOST_HELLO_CLIENT_NONCE_PARAMETER, clientNonce);
  return url.toString();
}

/**
 * A host built before client nonces refuses a hello request with a query as
 * an unknown route (404). Every Octant host serves the hello route, so that
 * answer means the host is too old, never that the route is missing.
 */
export const HOST_HELLO_OUTDATED_STATUS = 404;

/**
 * Checks a host hello before a client acts on it. The hello must carry the
 * host identity public key, that key must hash (SHA-256 of its DER
 * SubjectPublicKeyInfo) to the fingerprint the hello states, the hello must
 * echo the client nonce this client sent with the request, and the hello's
 * signature (version 2, which covers that nonce) must verify against the
 * key. The hello must not have expired, and with a pin the proven host id
 * and fingerprint must also equal the ones recorded at pairing.
 *
 * Before this check, clients compared only the fingerprint a host stated
 * about itself, so anything that answered at the paired origin could state
 * the paired fingerprint and pass. Checking the signature alone still let it
 * replay a genuine hello it had recorded, because the hello's own nonce is
 * the host's; the client nonce makes each hello answer one request.
 */
export async function verifyHostHello(
  hello: HostHelloV1,
  context: {
    readonly pinned?: PinnedHostIdentity | undefined;
    readonly now: number;
    readonly clientNonce: string;
  },
): Promise<HostHelloVerification> {
  const pinned = context.pinned;
  if (hello.hostPublicKey === undefined || hello.clientNonce === undefined) {
    return { status: "refused", reason: "host-outdated", message: HOST_OUTDATED_MESSAGE };
  }
  const expiresAt = Date.parse(hello.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt + HOST_HELLO_CLOCK_SKEW_MS <= context.now) {
    return { status: "refused", reason: "expired", message: EXPIRED_MESSAGE };
  }
  const unproven = { status: "refused", reason: "unproven", message: UNPROVEN_MESSAGE } as const;
  if (hello.clientNonce !== context.clientNonce) return unproven;
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

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
