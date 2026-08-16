import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalDeviceKeyFacts, deviceKeyFingerprintMatches } from "./deviceKeyFacts";

function p256Pem(): string {
  return generateKeyPairSync("ec", { namedCurve: "P-256" })
    .publicKey.export({ format: "pem", type: "spki" })
    .toString();
}

describe("canonicalDeviceKeyFacts", () => {
  it("parses EC P-256 SPKI and derives the SHA-256 fingerprint from canonical DER", () => {
    const pem = p256Pem();
    const facts = canonicalDeviceKeyFacts(pem);
    expect(facts).toBeDefined();
    const der = Buffer.from(
      pem.replace(/-----BEGIN PUBLIC KEY-----|-----END PUBLIC KEY-----|\n/g, ""),
      "base64",
    );
    expect(facts!.fingerprint).toBe(createHash("sha256").update(der).digest("hex"));
    expect(facts!.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(facts!.canonicalPem).toBe(pem.trim());
  });

  it("canonicalizes whitespace variant encodings to identical facts", () => {
    const pem = p256Pem();
    const compact = pem.replace(/\n/g, "");
    const respaced = `${"-----BEGIN PUBLIC KEY-----\n"}${compact
      .replace("-----BEGIN PUBLIC KEY-----", "")
      .replace("-----END PUBLIC KEY-----", "")}\n-----END PUBLIC KEY-----\n`;
    const baseline = canonicalDeviceKeyFacts(pem);
    const variant = canonicalDeviceKeyFacts(respaced);
    expect(variant).toBeDefined();
    expect(variant!.fingerprint).toBe(baseline!.fingerprint);
    expect(variant!.canonicalPem).toBe(baseline!.canonicalPem);
  });

  it("rejects malformed, private, non-P256, and alternate-encoding keys generically", () => {
    expect(canonicalDeviceKeyFacts("not-a-key")).toBeUndefined();
    expect(canonicalDeviceKeyFacts("")).toBeUndefined();
    expect(canonicalDeviceKeyFacts("x".repeat(5000))).toBeUndefined();

    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(
      canonicalDeviceKeyFacts(rsa.publicKey.export({ format: "pem", type: "spki" }).toString()),
    ).toBeUndefined();

    const p384 = generateKeyPairSync("ec", { namedCurve: "P-384" });
    expect(
      canonicalDeviceKeyFacts(p384.publicKey.export({ format: "pem", type: "spki" }).toString()),
    ).toBeUndefined();

    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const privatePem = pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
    expect(canonicalDeviceKeyFacts(privatePem)).toBeUndefined();

    const derOnly = pair.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    expect(canonicalDeviceKeyFacts(derOnly)).toBeUndefined();

    const pkcs1 = generateKeyPairSync("rsa", { modulusLength: 2048 });
    expect(
      canonicalDeviceKeyFacts(pkcs1.publicKey.export({ format: "pem", type: "pkcs1" }).toString()),
    ).toBeUndefined();
  });

  it("rejects certificate and alternate PEM containers even with a P-256 key inside", () => {
    // A real self-signed EC P-256 X.509 certificate: node accepts it as a key,
    // the helper must not.
    const certificate = [
      "-----BEGIN CERTIFICATE-----",
      "MIIBiDCCAS2gAwIBAgIUZ6pN2ixKX64+eUDDfmKAFGOhvPkwCgYIKoZIzj0EAwIw",
      "GTEXMBUGA1UEAwwOb3Blbm9yYml0LXRlc3QwHhcNMjYwNzI5MjI1NDAyWhcNMjYw",
      "NzMwMjI1NDAyWjAZMRcwFQYDVQQDDA5vcGVub3JiaXQtdGVzdDBZMBMGByqGSM49",
      "AgEGCCqGSM49AwEHA0IABJJM8yD3LA0hDruKxZebXgouIRGFylzrdjLaDbPwecw5",
      "PkOCLt5EK7Ulxni57Af3WxnsRijPM7VFjDtXtPPAoCajUzBRMB0GA1UdDgQWBBR3",
      "orDFBFcDZaGlfYGKvQokjRbkhTAfBgNVHSMEGDAWgBR3orDFBFcDZaGlfYGKvQok",
      "jRbkhTAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0kAMEYCIQDOJKOgsl7s",
      "ICphOd7nCKOVYh0+AEBJIJjoVATfeeW+MgIhAPCIJDv/ogZKX54NFIw9MY1QsBE6",
      "fU/7ZgxE7vv4u7bl",
      "-----END CERTIFICATE-----",
    ].join("\n");
    expect(canonicalDeviceKeyFacts(certificate)).toBeUndefined();

    const pem = p256Pem();
    const sec1Container = pem
      .replace("-----BEGIN PUBLIC KEY-----", "-----BEGIN EC PUBLIC KEY-----")
      .replace("-----END PUBLIC KEY-----", "-----END EC PUBLIC KEY-----");
    expect(canonicalDeviceKeyFacts(sec1Container)).toBeUndefined();

    const certificateContainer = pem
      .replace("-----BEGIN PUBLIC KEY-----", "-----BEGIN CERTIFICATE-----")
      .replace("-----END PUBLIC KEY-----", "-----END CERTIFICATE-----");
    expect(canonicalDeviceKeyFacts(certificateContainer)).toBeUndefined();
  });

  it("rejects trailing and multi-block material while accepting deliberate whitespace", () => {
    const pem = p256Pem();
    expect(canonicalDeviceKeyFacts(`${pem}\n\n`)).toBeDefined();
    expect(canonicalDeviceKeyFacts(`\n${pem}\n`)).toBeDefined();
    expect(canonicalDeviceKeyFacts(pem.replace(/\n/g, "\r\n"))).toBeDefined();

    expect(canonicalDeviceKeyFacts(`${pem}\ngarbage`)).toBeUndefined();
    expect(canonicalDeviceKeyFacts(`${pem}\n${pem}`)).toBeUndefined();
    expect(canonicalDeviceKeyFacts(`garbage\n${pem}`)).toBeUndefined();
    expect(canonicalDeviceKeyFacts(`${pem}-----END PUBLIC KEY-----`)).toBeUndefined();
    expect(canonicalDeviceKeyFacts(`${pem.trim()} \t extra`)).toBeUndefined();
  });
});

describe("deviceKeyFingerprintMatches", () => {
  it("matches the exact DER fingerprint and rejects mismatches without leaking", () => {
    const facts = canonicalDeviceKeyFacts(p256Pem())!;
    expect(deviceKeyFingerprintMatches(facts.fingerprint, facts)).toBe(true);
    const other = canonicalDeviceKeyFacts(p256Pem())!;
    expect(deviceKeyFingerprintMatches(other.fingerprint, facts)).toBe(false);
    expect(deviceKeyFingerprintMatches("f".repeat(64), facts)).toBe(false);
    expect(deviceKeyFingerprintMatches("not-hex", facts)).toBe(false);
    expect(deviceKeyFingerprintMatches(facts.fingerprint.toUpperCase(), facts)).toBe(false);
    expect(deviceKeyFingerprintMatches("", facts)).toBe(false);
  });
});
