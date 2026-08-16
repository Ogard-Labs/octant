import { createHash, createPublicKey, timingSafeEqual } from "node:crypto";

const MAX_PUBLIC_KEY_LENGTH = 4_096;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const SPKI_PEM_PATTERN =
  /^-----BEGIN PUBLIC KEY-----\s+([A-Za-z0-9+/=\s]+?)\s*-----END PUBLIC KEY-----\s*$/;
const BASE64_BODY_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

export interface CanonicalDeviceKeyFacts {
  readonly canonicalPem: string;
  readonly fingerprint: string;
}

/**
 * Parses a submitted device public key as a strict SPKI PEM envelope
 * (`BEGIN/END PUBLIC KEY` only — never certificates or alternate containers),
 * requires EC P-256/prime256v1, and derives the SHA-256 fingerprint from the
 * canonical DER export. Malformed, private, non-P256, multi-block, and
 * ambiguous encodings are rejected indistinguishably.
 */
export function canonicalDeviceKeyFacts(publicKey: string): CanonicalDeviceKeyFacts | undefined {
  if (
    publicKey.trim().length === 0 ||
    publicKey.length > MAX_PUBLIC_KEY_LENGTH ||
    publicKey.includes("PRIVATE KEY")
  ) {
    return undefined;
  }
  const envelope = SPKI_PEM_PATTERN.exec(publicKey.trim());
  if (envelope === null) return undefined;
  const body = envelope[1]!.replace(/\s+/g, "");
  if (body.length === 0 || !BASE64_BODY_PATTERN.test(body)) return undefined;
  try {
    const key = createPublicKey(`-----BEGIN PUBLIC KEY-----\n${body}\n-----END PUBLIC KEY-----\n`);
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") {
      return undefined;
    }
    const der = key.export({ format: "der", type: "spki" });
    const canonicalPem = key.export({ format: "pem", type: "spki" }).toString().trim();
    return {
      canonicalPem,
      fingerprint: createHash("sha256").update(der).digest("hex"),
    };
  } catch {
    return undefined;
  }
}

export function deviceKeyFingerprintMatches(
  fingerprint: string,
  facts: CanonicalDeviceKeyFacts,
): boolean {
  if (!FINGERPRINT_PATTERN.test(fingerprint)) return false;
  const expected = Buffer.from(facts.fingerprint, "hex");
  const candidate = Buffer.from(fingerprint, "hex");
  return expected.length === candidate.length && timingSafeEqual(expected, candidate);
}
