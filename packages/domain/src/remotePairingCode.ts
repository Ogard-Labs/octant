import { classifyRemoteListenerAddress } from "./remoteAccessPolicy";

/**
 * The app pairing code for a listener that serves a certificate the host made
 * itself: `octant-pair-1.` followed by the unpadded base64url of a JSON object
 * holding the listener origin, the pairing ticket id and proof, and the pin of
 * the listener's key. It has no URL scheme on purpose, so no operating system
 * hands it to an app that registered one; only Octant's own scanner or paste
 * field reads it. It never carries key material: the pin is a public hash.
 */
export const PAIRING_CODE_PREFIX = "octant-pair-1.";

/** The only pin algorithm a client knows; a code naming another is refused, never skipped. */
export const PAIRING_CODE_PIN_ALGORITHM = "sha256";

/** Far above any code the host makes; a longer paste is refused before decoding. */
const MAX_PAIRING_CODE_LENGTH = 1_024;
const VERSIONED_CODE = /^octant-pair-([^.]*)\.(.*)$/s;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
// 32 bytes as unpadded base64url: 43 characters whose last one carries no spare bits.
const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const TICKET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PIN_ALGORITHM = /^([a-z0-9]+)-/;
const FIELDS = ["origin", "ticketId", "ticketProof", "pin"] as const;

export interface PairingCodeContents {
  /** The listener's exact HTTPS origin on a private LAN or Tailscale address. */
  readonly origin: string;
  readonly ticketId: string;
  readonly ticketProof: string;
  /** `sha256-` plus the unpadded base64url SHA-256 of the listener certificate's public key. */
  readonly pin: string;
}

export type PairingCodeRefusal =
  /** Not text this format describes at all. */
  | "not-a-pairing-code"
  /** A later code version, or a pin algorithm this client does not know. */
  | "newer-version"
  /** The right prefix, but a field is missing, extra, malformed, or not canonical. */
  | "damaged"
  /** An origin that is not a private LAN or Tailscale HTTPS address. */
  | "not-private";

export const PAIRING_CODE_REFUSAL_COPY: Readonly<Record<PairingCodeRefusal, string>> = {
  "not-a-pairing-code": "This isn't an Octant pairing code.",
  "newer-version": "This pairing code needs a newer version of Octant.",
  damaged:
    "This pairing code is incomplete or damaged. Copy the whole code from that computer again, or scan its QR code.",
  "not-private":
    "This pairing code names an address outside a private network or Tailscale, so Octant won't use it.",
};

export type PairingCodeBuild =
  | { readonly status: "built"; readonly code: string }
  | { readonly status: "refused"; readonly reason: PairingCodeRefusal };

export type PairingCodeReading =
  | { readonly status: "read"; readonly contents: PairingCodeContents }
  | { readonly status: "refused"; readonly reason: PairingCodeRefusal };

/** Builds the code, refusing contents a client would refuse to read. */
export function buildPairingCode(contents: PairingCodeContents): PairingCodeBuild {
  const refusal = refuseContents(contents);
  if (refusal !== undefined) return { status: "refused", reason: refusal };
  return { status: "built", code: encodeContents(contents) };
}

/**
 * Reads a pasted or scanned code. Only the exact bytes `buildPairingCode`
 * would produce for the same contents pass: an unknown field, a missing one,
 * a repeated key, extra whitespace inside the JSON, or a non-canonical
 * base64url spelling is refused, so one ticket has exactly one code.
 */
export function readPairingCode(text: string): PairingCodeReading {
  const code = text.trim();
  if (code.length > MAX_PAIRING_CODE_LENGTH) return refused("not-a-pairing-code");
  const versioned = VERSIONED_CODE.exec(code);
  if (versioned === null) return refused("not-a-pairing-code");
  const [, version = "", payload = ""] = versioned;
  if (version !== "1") {
    return refused(/^[1-9][0-9]{0,5}$/.test(version) ? "newer-version" : "not-a-pairing-code");
  }
  const json = decodeBase64UrlAscii(payload);
  if (json === undefined) return refused("damaged");
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return refused("damaged");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return refused("damaged");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== FIELDS.length || !FIELDS.every((field) => keys.includes(field))) {
    return refused("damaged");
  }
  const { origin, ticketId, ticketProof, pin } = record;
  if (
    typeof origin !== "string" ||
    typeof ticketId !== "string" ||
    typeof ticketProof !== "string" ||
    typeof pin !== "string"
  ) {
    return refused("damaged");
  }
  const contents: PairingCodeContents = { origin, ticketId, ticketProof, pin };
  const refusal = refuseContents(contents);
  if (refusal !== undefined) return refused(refusal);
  if (encodeContents(contents) !== code) return refused("damaged");
  return { status: "read", contents };
}

/**
 * Whether a listener's origin and pin could go into a code. The host checks
 * this before it mints a ticket, so a listener a code cannot name never
 * leaves a live ticket behind.
 */
export function refusePairingCodeListener(listener: {
  readonly origin: string;
  readonly pin: string;
}): PairingCodeRefusal | undefined {
  // The pin algorithm is judged first: a code from a later Octant that pins
  // with another hash must say so rather than look damaged.
  const algorithm = PIN_ALGORITHM.exec(listener.pin)?.[1];
  if (algorithm === undefined) return "damaged";
  if (algorithm !== PAIRING_CODE_PIN_ALGORITHM) return "newer-version";
  if (!BASE64URL_32_BYTES.test(listener.pin.slice(algorithm.length + 1))) return "damaged";
  return refuseOrigin(listener.origin);
}

function refuseContents(contents: PairingCodeContents): PairingCodeRefusal | undefined {
  const listenerRefusal = refusePairingCodeListener(contents);
  if (listenerRefusal !== undefined) return listenerRefusal;
  if (!TICKET_ID.test(contents.ticketId) || !BASE64URL_32_BYTES.test(contents.ticketProof)) {
    return "damaged";
  }
  return undefined;
}

function refuseOrigin(origin: string): PairingCodeRefusal | undefined {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return "damaged";
  }
  // `URL.origin` drops a path, query, fragment, credentials, a trailing slash,
  // and the default port, so equality means the text is exactly an origin.
  if (parsed.protocol !== "https:" || parsed.origin !== origin) return "damaged";
  const hostname = parsed.hostname.replace(/^\[(.*)\]$/, "$1");
  const reach = classifyRemoteListenerAddress(hostname);
  return reach === "lan-private" || reach === "tailscale" ? undefined : "not-private";
}

function encodeContents(contents: PairingCodeContents): string {
  // Fixed key order, no whitespace: the JSON text is part of the canonical form.
  const json = JSON.stringify({
    origin: contents.origin,
    ticketId: contents.ticketId,
    ticketProof: contents.ticketProof,
    pin: contents.pin,
  });
  return `${PAIRING_CODE_PREFIX}${encodeBase64UrlAscii(json)}`;
}

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** Every field is validated ASCII before encoding, so a byte is a character code. */
function encodeBase64UrlAscii(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index += 3) {
    const a = text.charCodeAt(index);
    const b = index + 1 < text.length ? text.charCodeAt(index + 1) : undefined;
    const c = index + 2 < text.length ? text.charCodeAt(index + 2) : undefined;
    const bits = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    out += ALPHABET.charAt((bits >> 18) & 63) + ALPHABET.charAt((bits >> 12) & 63);
    if (b !== undefined) out += ALPHABET.charAt((bits >> 6) & 63);
    if (c !== undefined) out += ALPHABET.charAt(bits & 63);
  }
  return out;
}

/** Decodes to printable ASCII, or nothing; a non-canonical spelling is caught by re-encoding. */
function decodeBase64UrlAscii(payload: string): string | undefined {
  if (!BASE64URL.test(payload) || payload.length % 4 === 1) return undefined;
  let out = "";
  let bits = 0;
  let width = 0;
  for (const character of payload) {
    // Only the bits not yet emitted matter; masking keeps the shift in range.
    bits = ((bits << 6) | ALPHABET.indexOf(character)) & 0xffff;
    width += 6;
    if (width >= 8) {
      width -= 8;
      const byte = (bits >> width) & 0xff;
      if (byte < 0x20 || byte > 0x7e) return undefined;
      out += String.fromCharCode(byte);
    }
  }
  return out;
}

function refused(reason: PairingCodeRefusal): PairingCodeReading {
  return { status: "refused", reason };
}
