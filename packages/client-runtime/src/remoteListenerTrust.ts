// How a client decides whether a private listener's TLS connection may carry
// a request, shared by every client that reaches another host as a paired
// device.
//
// Each platform's TLS layer (the desktop main process, the phone's native
// module, Node) gathers the facts these functions judge and lets no request
// bytes out until they accept: the addresses a name resolves to before it
// connects, the connected peer address, and, during the handshake, the served
// leaf key's pin and whether the platform's own validation passed. The pin
// replaces platform validation for a pinned origin; it is never an extra
// option on top of it.

import { classifyRemoteListenerAddress, PAIRING_CODE_PIN_ALGORITHM } from "@octant/domain";

/** How one origin's certificate is trusted. */
export type ListenerTrust =
  /** The platform's chain, name, and date validation; a self-made certificate never passes it. */
  | { readonly kind: "platform" }
  /** Only a leaf whose SubjectPublicKeyInfo hashes to this pin; platform validation is not consulted. */
  | { readonly kind: "pinned"; readonly pin: string };

/**
 * The trust a client keeps for one listener origin, stored with that origin's
 * pairing record.
 */
export interface ListenerOriginTrust {
  readonly current: ListenerTrust;
  /**
   * The next trust the host announced over a session that passed `current`.
   * Until `until`, either trust passes, and the first connection that passes
   * only this one makes it current.
   */
  readonly staged?: { readonly trust: ListenerTrust; readonly until: string };
}

/**
 * The longest staged window a client honours, counted from now: the host
 * announces the next trust for up to 30 days. A window ending later is
 * ignored, so a damaged or hostile record cannot keep an old trust alive.
 */
export const MAX_STAGED_TRUST_WINDOW_MS = 30 * 24 * 60 * 60 * 1_000;

/** The trust of an origin paired before pins existed, or through a certificate the person pasted. */
export const PLATFORM_LISTENER_TRUST: ListenerOriginTrust = { current: { kind: "platform" } };

export type ListenerTrustRefusal =
  /** A pinned origin served a key whose hash is not the pin. */
  | "pin-mismatch"
  /** An origin with no pin served a certificate the platform could not verify. */
  | "platform-untrusted"
  /** The pin names a hash this client does not know. */
  | "newer-version"
  /** A resolved or connected address is not private LAN or Tailscale. */
  | "not-private-address";

export const LISTENER_TRUST_REFUSAL_COPY: Readonly<Record<ListenerTrustRefusal, string>> = {
  "pin-mismatch":
    "This isn't the computer you paired with: its security key has changed. Octant stopped before sending anything. If its key was replaced on purpose, pair again from that computer.",
  "platform-untrusted":
    "Octant couldn't verify this computer's certificate. Pair with the full pairing code or QR code from that computer.",
  "newer-version": "This pairing code needs a newer version of Octant.",
  "not-private-address":
    "This computer's address isn't on a private network or Tailscale, so Octant stopped before sending anything.",
};

export type ListenerAddressJudgement =
  | { readonly status: "private"; readonly address: string }
  | { readonly status: "refused"; readonly reason: "not-private-address" };

/**
 * Judges the addresses a listener's name resolved to, before connecting, or
 * the one address a connection reached, after.
 *
 * Every address must be an IP literal that the listener address classifier
 * calls private LAN or Tailscale. A name is judged by its spelling elsewhere,
 * and a `*.ts.net` spelling proves nothing: a public Tailscale Funnel name has
 * it too, so only the address decides. One public answer refuses the whole
 * name rather than skipping to a private one, because a name that also points
 * outside the private network is not a private listener's name. The returned
 * address is the one to connect to, so a second lookup cannot answer
 * differently.
 */
export function judgeListenerAddresses(
  addresses: ReadonlyArray<string | undefined>,
): ListenerAddressJudgement {
  const first = addresses[0];
  if (first === undefined || !addresses.every(isPrivateListenerAddress)) {
    return { status: "refused", reason: "not-private-address" };
  }
  return { status: "private", address: first };
}

export type ListenerCertificateJudgement =
  | {
      readonly status: "accepted";
      /** The trust to keep for the origin from now on. */
      readonly trust: ListenerOriginTrust;
    }
  | { readonly status: "refused"; readonly reason: ListenerTrustRefusal };

/**
 * Judges one TLS handshake with a listener origin, before the client sends
 * anything over it.
 *
 * A pinned trust passes only on the served pin and never reads
 * `platformTrusted`, so a certificate a public authority issued for the same
 * name does not pass, and the certificate's dates are not checked: anyone
 * holding the key can make a fresh certificate, and a device with a wrong
 * clock would be locked out. A platform trust passes only on
 * `platformTrusted`, so an origin with no pin never accepts a self-made
 * certificate.
 */
export function judgeListenerCertificate(input: {
  readonly trust: ListenerOriginTrust;
  /** `sha256-` pin of the served leaf's SubjectPublicKeyInfo; undefined when no leaf was served. */
  readonly servedPin: string | undefined;
  /** Whether the platform's own chain, name, and date validation passed. */
  readonly platformTrusted: boolean;
  readonly now: number;
}): ListenerCertificateJudgement {
  const passes = (trust: ListenerTrust): boolean =>
    trust.kind === "platform"
      ? input.platformTrusted
      : pinAlgorithm(trust.pin) === PAIRING_CODE_PIN_ALGORITHM &&
        input.servedPin !== undefined &&
        input.servedPin === trust.pin;
  const { current, staged } = input.trust;
  // A window whose end cannot be read is over, and one ending further out
  // than the host ever announces is not honoured.
  const stagedUntil = staged === undefined ? Number.NaN : Date.parse(staged.until);
  const stagedLive =
    stagedUntil > input.now && stagedUntil - input.now <= MAX_STAGED_TRUST_WINDOW_MS;
  if (passes(current)) {
    return { status: "accepted", trust: stagedLive ? input.trust : { current } };
  }
  if (staged !== undefined && stagedLive && passes(staged.trust)) {
    return { status: "accepted", trust: { current: staged.trust } };
  }
  if (current.kind === "platform") return { status: "refused", reason: "platform-untrusted" };
  return {
    status: "refused",
    reason:
      pinAlgorithm(current.pin) === PAIRING_CODE_PIN_ALGORITHM ? "pin-mismatch" : "newer-version",
  };
}

/** The pin for a SubjectPublicKeyInfo whose SHA-256 digest the platform computed. */
export function listenerPinFromSha256(digest: Uint8Array): string {
  if (digest.byteLength !== 32) {
    throw new Error("A listener pin needs a 32-byte SHA-256 digest.");
  }
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  const base64url = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  return `${PAIRING_CODE_PIN_ALGORITHM}-${base64url}`;
}

/**
 * Reads a stored trust, or nothing when it is malformed, so a damaged record
 * is never read as a weaker one. A pin naming an unknown hash is kept and
 * refused when judged, so it says a newer Octant is needed.
 */
export function decodeListenerOriginTrust(value: unknown): ListenerOriginTrust | undefined {
  if (!isRecord(value)) return undefined;
  const current = decodeListenerTrust(value.current);
  if (current === undefined) return undefined;
  if (value.staged === undefined) return { current };
  if (!isRecord(value.staged) || typeof value.staged.until !== "string") return undefined;
  const stagedTrust = decodeListenerTrust(value.staged.trust);
  if (stagedTrust === undefined || !Number.isFinite(Date.parse(value.staged.until))) {
    return undefined;
  }
  return { current, staged: { trust: stagedTrust, until: value.staged.until } };
}

function decodeListenerTrust(value: unknown): ListenerTrust | undefined {
  if (!isRecord(value)) return undefined;
  if (value.kind === "platform") return { kind: "platform" };
  if (value.kind !== "pinned" || typeof value.pin !== "string") return undefined;
  if (!/^[a-z0-9]+-[A-Za-z0-9_-]+$/.test(value.pin)) return undefined;
  return { kind: "pinned", pin: value.pin };
}

function pinAlgorithm(pin: string): string | undefined {
  return /^([a-z0-9]+)-/.exec(pin)?.[1];
}

function isPrivateListenerAddress(address: string | undefined): boolean {
  // Only an IP literal: the classifier calls a `*.ts.net` name Tailscale by
  // its spelling. An IPv4-mapped IPv6 form or a zone is refused, not unwrapped.
  if (address === undefined) return false;
  const literal =
    /^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/.test(address) ||
    (address.includes(":") && /^[0-9A-Fa-f:]+$/.test(address));
  if (!literal) return false;
  const reach = classifyRemoteListenerAddress(address);
  return reach === "lan-private" || reach === "tailscale";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
