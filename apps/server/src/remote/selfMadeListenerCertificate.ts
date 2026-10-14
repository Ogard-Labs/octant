// The private listener's self-made certificate: its key, the certificate the
// host signs for it, renewal, and the pin a client will compare.
//
// When the listener is enabled without a pasted certificate the host makes an
// ECDSA P-256 key of its own and a one-year certificate for the listener's
// address. The key is separate from the host identity key: that key signs the
// remote hello and rotating it revokes every device, while this one only
// serves TLS. Both files live under the data directory's `remote/` folder,
// the boundary that already holds the host identity key, with the folder
// `0700` and each file `0600`, written to a staging file and renamed.
//
// Renewal keeps the key. A certificate that is missing, unreadable, made for
// another key or address, not yet valid, or within 30 days of its end is
// replaced by a new one for the same key, so the pin a client holds stays
// the same. Callers pass on only the pin and the certificate; the key goes to
// the TLS server in process and nowhere else.

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  X509Certificate,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import type { PrivateListenerTls } from "../privateListener";
import { certificatePem, encodeListenerCertificate } from "./listenerCertificateDer";

const REMOTE_SUBDIR = "remote";
export const SELF_MADE_LISTENER_KEY_FILE = "private-listener-tls-key.pem";
export const SELF_MADE_LISTENER_CERTIFICATE_FILE = "private-listener-tls-cert.pem";
const DAY_MS = 24 * 60 * 60 * 1_000;
const VALIDITY_MS = 365 * DAY_MS;
const RENEW_BEFORE_END_MS = 30 * DAY_MS;

export type SelfMadeListenerCertificate =
  | { readonly status: "ready"; readonly tls: PrivateListenerTls; readonly tlsPin: string }
  | {
      readonly status: "refused";
      /**
       * `tls-key-exposed`: the key file belongs to another OS user or other
       * users can open it, so it may no longer be secret. `invalid-tls`: the
       * key file is not a usable P-256 key, or the files cannot be written.
       */
      readonly code: "tls-key-exposed" | "invalid-tls";
    };

export interface SelfMadeListenerCertificateStore {
  /** Loads or makes the key, renews the certificate when due, and returns both with the pin. */
  readonly ensure: (hostname: string) => SelfMadeListenerCertificate;
}

export interface CreateSelfMadeListenerCertificateStoreOptions {
  readonly dataDirectory: string;
  readonly now?: () => Date;
}

/**
 * The pin for a certificate's key: `sha256-` and the unpadded base64url
 * SHA-256 of its DER SubjectPublicKeyInfo. Pinning the key rather than the
 * certificate is what lets renewal keep the pin.
 */
export function listenerTlsPin(certificate: string | Buffer | X509Certificate): string {
  const x509 =
    certificate instanceof X509Certificate ? certificate : new X509Certificate(certificate);
  const spki = x509.publicKey.export({ format: "der", type: "spki" });
  return `sha256-${createHash("sha256").update(spki).digest("base64url")}`;
}

export function createSelfMadeListenerCertificateStore(
  options: CreateSelfMadeListenerCertificateStoreOptions,
): SelfMadeListenerCertificateStore {
  const directory = join(options.dataDirectory, REMOTE_SUBDIR);
  const keyPath = join(directory, SELF_MADE_LISTENER_KEY_FILE);
  const certificatePath = join(directory, SELF_MADE_LISTENER_CERTIFICATE_FILE);
  const now = options.now ?? (() => new Date());

  return {
    ensure: (hostname) => {
      const address = hostname.replace(/^\[/, "").replace(/\]$/, "");
      let keyPem: string;
      try {
        mkdirSync(directory, { recursive: true, mode: 0o700 });
        // The folder may already exist from the host identity key with the
        // process umask's mode; narrow it to the owner.
        chmodSync(directory, 0o700);
        const loaded = readOwnerOnlyKey(keyPath);
        if (loaded.status === "exposed") return { status: "refused", code: "tls-key-exposed" };
        if (loaded.status === "missing") {
          const generated = generateKeyPairSync("ec", { namedCurve: "P-256" });
          keyPem = String(generated.privateKey.export({ format: "pem", type: "pkcs8" }));
          writeOwnerOnly(keyPath, keyPem);
        } else {
          keyPem = loaded.pem;
        }
      } catch {
        return { status: "refused", code: "invalid-tls" };
      }

      let privateKey: ReturnType<typeof createPrivateKey>;
      try {
        privateKey = createPrivateKey(keyPem);
      } catch {
        return { status: "refused", code: "invalid-tls" };
      }
      if (
        privateKey.asymmetricKeyType !== "ec" ||
        privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
      ) {
        return { status: "refused", code: "invalid-tls" };
      }
      const publicKey = createPublicKey(keyPem);

      const at = now();
      let certificate = readUsableCertificate(certificatePath, publicKey, address, at);
      if (certificate === undefined) {
        try {
          // Whole seconds: X.509 times carry no fractions, and a start later
          // than `at` would make the host's own validity check refuse it.
          const notBefore = new Date(Math.floor(at.getTime() / 1_000) * 1_000);
          certificate = certificatePem(
            encodeListenerCertificate({
              privateKey,
              publicKey,
              hostname: address,
              notBefore,
              notAfter: new Date(notBefore.getTime() + VALIDITY_MS),
            }),
          );
          writeOwnerOnly(certificatePath, certificate);
        } catch {
          return { status: "refused", code: "invalid-tls" };
        }
      }
      return {
        status: "ready",
        tls: { cert: certificate, key: keyPem },
        tlsPin: listenerTlsPin(certificate),
      };
    },
  };
}

type LoadedKey =
  | { readonly status: "missing" }
  | { readonly status: "exposed" }
  | { readonly status: "loaded"; readonly pem: string };

/**
 * Reads the key through one descriptor opened without following a link, so
 * the owner and mode checked are those of the file actually read.
 */
function readOwnerOnlyKey(path: string): LoadedKey {
  let descriptor: number;
  try {
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { status: "missing" };
    throw error;
  }
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) throw new Error("The listener key is not a regular file.");
    const uid = process.getuid?.();
    if ((uid !== undefined && stats.uid !== uid) || (stats.mode & 0o077) !== 0) {
      return { status: "exposed" };
    }
    return { status: "loaded", pem: readFileSync(descriptor, "utf8") };
  } finally {
    closeSync(descriptor);
  }
}

function readUsableCertificate(
  path: string,
  publicKey: ReturnType<typeof createPublicKey>,
  address: string,
  at: Date,
): string | undefined {
  let pem: string;
  let certificate: X509Certificate;
  try {
    pem = readFileSync(path, "utf8");
    certificate = new X509Certificate(pem);
  } catch {
    return undefined;
  }
  const certificateKey = certificate.publicKey.export({ format: "der", type: "spki" });
  const expectedKey = publicKey.export({ format: "der", type: "spki" });
  if (!certificateKey.equals(expectedKey)) return undefined;
  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);
  if (
    !Number.isFinite(validFrom) ||
    !Number.isFinite(validTo) ||
    at.getTime() < validFrom ||
    at.getTime() >= validTo - RENEW_BEFORE_END_MS
  ) {
    return undefined;
  }
  const name = address.toLowerCase();
  const covered =
    isIP(name) === 0 ? certificate.checkHost(name) === name : certificate.checkIP(name) === name;
  return covered ? pem : undefined;
}

function writeOwnerOnly(path: string, contents: string): void {
  const staging = `${path}.${process.pid}.tmp`;
  writeFileSync(staging, contents, { mode: 0o600 });
  // writeFileSync applies the mode only when it creates the file, so a staging
  // file left behind by a crashed write is narrowed here too.
  chmodSync(staging, 0o600);
  renameSync(staging, path);
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}
