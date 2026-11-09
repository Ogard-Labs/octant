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

import type { WindowsListenerTlsFiles } from "@octant/host-runtime";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  X509Certificate,
} from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { Schema } from "effect";
import { ListenerKeyTransition, StableHostId } from "@octant/contracts";
import { LISTENER_KEY_TRANSITION_WINDOW_MS, listenerKeyTransitionPayload } from "@octant/domain";
import type { PrivateListenerTls } from "../privateListener";
import {
  certificatePem,
  encodeListenerCertificate,
  isListenerDnsName,
} from "./listenerCertificateDer";

const REMOTE_SUBDIR = "remote";
export const SELF_MADE_LISTENER_KEY_FILE = "private-listener-tls-key.pem";
export const SELF_MADE_LISTENER_CERTIFICATE_FILE = "private-listener-tls-cert.pem";
export const LISTENER_KEY_TRANSITION_FILE = "private-listener-key-transition.json";
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
  readonly transition: () => ListenerKeyTransition | undefined;
  readonly prepareTransition: (input: {
    readonly hostId: string;
    readonly origin: string;
  }) =>
    | { readonly status: "prepared"; readonly transition: ListenerKeyTransition }
    | { readonly status: "refused"; readonly code: "invalid-transition" };
  readonly activateTransition: (
    newPin: string,
  ) =>
    | { readonly status: "activated" }
    | { readonly status: "refused"; readonly code: "invalid-transition" };
  readonly cancelTransition: () => boolean;
}

export interface CreateSelfMadeListenerCertificateStoreOptions {
  readonly dataDirectory: string;
  readonly now?: () => Date;
  readonly tlsFiles?: WindowsListenerTlsFiles | undefined;
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
  const transitionPath = join(directory, LISTENER_KEY_TRANSITION_FILE);
  const decodeStage = Schema.decodeUnknownSync(
    Schema.Struct({
      transition: ListenerKeyTransition,
      newKeyPem: Schema.NonEmptyString,
    }).annotations({ parseOptions: { onExcessProperty: "error" } }),
  );
  const keyPin = (pem: string): string =>
    `sha256-${createHash("sha256")
      .update(createPublicKey(pem).export({ format: "der", type: "spki" }))
      .digest("base64url")}`;
  const currentPin = (): string => {
    const current = readOwnerOnlyKey(keyPath);
    if (current.status !== "loaded") throw new Error("Listener key unavailable.");
    return keyPin(current.pem);
  };
  const readStage = (): ReturnType<typeof decodeStage> | undefined => {
    const loaded = readOwnerOnlyKey(transitionPath);
    if (loaded.status === "missing") return undefined;
    if (loaded.status === "exposed") throw new Error("Listener transition exposed.");
    const value: unknown = JSON.parse(loaded.pem);
    if (value === null) return undefined;
    const stage = decodeStage(value);
    const t = stage.transition;
    const oldKey = createPublicKey({
      key: Buffer.from(t.oldPublicKey, "base64url"),
      type: "spki",
      format: "der",
    });
    const newKey = createPrivateKey(stage.newKeyPem);
    if (
      newKey.asymmetricKeyType !== "ec" ||
      newKey.asymmetricKeyDetails?.namedCurve !== "prime256v1" ||
      keyPin(stage.newKeyPem) !== t.newPin ||
      keyPin(String(oldKey.export({ type: "spki", format: "pem" }))) !== t.oldPin ||
      Date.parse(t.expiresAt) - Date.parse(t.preparedAt) !== LISTENER_KEY_TRANSITION_WINDOW_MS ||
      !verify(
        "sha256",
        Buffer.from(listenerKeyTransitionPayload(t)),
        { key: oldKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(t.signature, "base64url"),
      )
    ) {
      throw new Error("Invalid listener transition.");
    }
    return stage;
  };

  const store: SelfMadeListenerCertificateStore = {
    ensure: (hostname) => {
      const address = listenerAddress(hostname);
      if (address === undefined) return { status: "refused", code: "invalid-tls" };
      const files = options.tlsFiles;
      if (
        (files !== undefined && files.dataDirectory !== options.dataDirectory) ||
        (process.platform === "win32" && files === undefined)
      )
        return { status: "refused", code: "invalid-tls" };
      let keyPem: string;
      try {
        if (files !== undefined) {
          let loaded = files.read("key");
          if (loaded.status === "missing") {
            const generated = generateKeyPairSync("ec", { namedCurve: "P-256" });
            const candidate = Buffer.from(
              generated.privateKey.export({ format: "pem", type: "pkcs8" }),
            );
            try {
              loaded = files.createKey(candidate);
            } finally {
              candidate.fill(0);
            }
          }
          if (loaded.status === "exposed") return { status: "refused", code: "tls-key-exposed" };
          if (loaded.status !== "ready") return { status: "refused", code: "invalid-tls" };
          try {
            if (loaded.bytes.length === 0 || loaded.bytes.length > 4096)
              return { status: "refused", code: "invalid-tls" };
            keyPem = loaded.bytes.toString("utf8");
          } finally {
            loaded.bytes.fill(0);
          }
        } else {
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
      let certificate: string | undefined;
      if (files === undefined)
        certificate = readUsableCertificate(certificatePath, publicKey, address, at);
      else {
        const loaded = files.read("certificate");
        if (loaded.status !== "ready" && loaded.status !== "missing")
          return { status: "refused", code: "invalid-tls" };
        if (loaded.status === "ready") {
          try {
            if (loaded.bytes.length > 16384) return { status: "refused", code: "invalid-tls" };
            certificate = usableCertificate(loaded.bytes.toString("utf8"), publicKey, address, at);
          } finally {
            loaded.bytes.fill(0);
          }
        }
      }
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
          if (files === undefined) writeOwnerOnly(certificatePath, certificate);
          else {
            const candidate = Buffer.from(certificate);
            try {
              const saved = files.replaceCertificate(candidate);
              if (saved.status !== "ready") return { status: "refused", code: "invalid-tls" };
              try {
                const admitted = usableCertificate(
                  saved.bytes.toString("utf8"),
                  publicKey,
                  address,
                  at,
                );
                if (admitted === undefined) return { status: "refused", code: "invalid-tls" };
                certificate = admitted;
              } finally {
                saved.bytes.fill(0);
              }
            } finally {
              candidate.fill(0);
            }
          }
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
    transition: () => {
      try {
        const stage = readStage();
        if (stage === undefined || Date.parse(stage.transition.expiresAt) <= now().getTime())
          return undefined;
        const pin = currentPin();
        return pin === stage.transition.oldPin || pin === stage.transition.newPin
          ? stage.transition
          : undefined;
      } catch {
        return undefined;
      }
    },
    prepareTransition: (input) => {
      try {
        const origin = new URL(input.origin);
        if (origin.protocol !== "https:" || origin.origin !== input.origin)
          throw new Error("Invalid origin.");
        const hostId = Schema.decodeUnknownSync(StableHostId)(input.hostId);
        const serving = store.ensure(origin.hostname);
        if (serving.status !== "ready") throw new Error("Listener key unavailable.");
        const previous = readStage();
        const at = now();
        if (previous !== undefined && Date.parse(previous.transition.expiresAt) > at.getTime()) {
          const t = previous.transition;
          if (
            t.oldPin !== serving.tlsPin ||
            t.origin !== input.origin ||
            String(t.hostId) !== String(hostId)
          )
            throw new Error("A transition is already active.");
          return { status: "prepared", transition: t };
        }
        const generated = generateKeyPairSync("ec", { namedCurve: "P-256" });
        const unsigned = Schema.decodeUnknownSync(ListenerKeyTransition.omit("signature"))({
          version: 1 as const,
          hostId,
          origin: input.origin,
          oldPin: serving.tlsPin,
          newPin: keyPin(String(generated.publicKey.export({ type: "spki", format: "pem" }))),
          oldPublicKey: createPublicKey(String(serving.tls.key))
            .export({ type: "spki", format: "der" })
            .toString("base64url"),
          preparedAt: at.toISOString(),
          expiresAt: new Date(at.getTime() + LISTENER_KEY_TRANSITION_WINDOW_MS).toISOString(),
        });
        const transition = Schema.decodeUnknownSync(ListenerKeyTransition)({
          ...unsigned,
          signature: sign("sha256", Buffer.from(listenerKeyTransitionPayload(unsigned)), {
            key: String(serving.tls.key),
            dsaEncoding: "ieee-p1363",
          }).toString("base64url"),
        });
        writeOwnerOnly(
          transitionPath,
          JSON.stringify({
            transition,
            newKeyPem: String(generated.privateKey.export({ type: "pkcs8", format: "pem" })),
          }),
        );
        return { status: "prepared", transition };
      } catch {
        return { status: "refused", code: "invalid-transition" };
      }
    },
    activateTransition: (newPin) => {
      try {
        const stage = readStage();
        if (stage === undefined || stage.transition.newPin !== newPin)
          throw new Error("Transition changed.");
        const pin = currentPin();
        if (pin === newPin) return { status: "activated" };
        const t = stage.transition;
        if (
          pin !== t.oldPin ||
          Date.parse(t.preparedAt) > now().getTime() ||
          Date.parse(t.expiresAt) <= now().getTime()
        )
          throw new Error("Transition expired.");
        // The signed stage is durable first. If power fails after replacing the
        // key, ensure renews the old certificate for this same new key.
        writeOwnerOnly(keyPath, stage.newKeyPem);
        return { status: "activated" };
      } catch {
        return { status: "refused", code: "invalid-transition" };
      }
    },
    cancelTransition: () => {
      try {
        const stage = readStage();
        if (stage === undefined) return true;
        if (currentPin() !== stage.transition.oldPin) return false;
        writeOwnerOnly(transitionPath, "null");
        return true;
      } catch {
        return false;
      }
    },
  };
  return store;
}

type LoadedKey =
  | { readonly status: "missing" }
  | { readonly status: "exposed" }
  | { readonly status: "loaded"; readonly pem: string };

/**
 * The name the certificate is made for: an IPv4 or unscoped IPv6 address
 * (brackets dropped), or a DNS name `isListenerDnsName` accepts. Anything else
 * is refused before a key or certificate is touched.
 */
function listenerAddress(hostname: string): string | undefined {
  const address = hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (address.includes("%")) return undefined;
  if (isIP(address) !== 0) return address;
  return isListenerDnsName(address) ? address : undefined;
}

/**
 * Opens a listener file without following a link and without blocking: a
 * FIFO put at the path would otherwise hold the open until a writer appears.
 * Anything but a regular file is refused once it is open.
 */
function openRegularFile(path: string): number {
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  if (!fstatSync(descriptor).isFile()) {
    closeSync(descriptor);
    throw new Error("The listener file is not a regular file.");
  }
  return descriptor;
}

/**
 * Reads the key through one descriptor opened without following a link, so
 * the owner and mode checked are those of the file actually read. The check
 * reads the owner and mode bits only; an access control list that grants
 * another user read access is not seen.
 *
 * An empty key file that is owner-only counts as missing, so a new key is
 * made: a crash or power loss can leave a renamed file whose contents never
 * reached the disk, and an empty file holds no key that could have leaked.
 * Any other unreadable key, a truncated one included, stays refused, because
 * replacing it would silently change the pin.
 */
function readOwnerOnlyKey(path: string): LoadedKey {
  let descriptor: number;
  try {
    descriptor = openRegularFile(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { status: "missing" };
    throw error;
  }
  try {
    const stats = fstatSync(descriptor);
    const uid = process.getuid?.();
    if ((uid !== undefined && stats.uid !== uid) || (stats.mode & 0o077) !== 0) {
      return { status: "exposed" };
    }
    if (stats.size === 0) return { status: "missing" };
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
  try {
    const descriptor = openRegularFile(path);
    try {
      pem = readFileSync(descriptor, "utf8");
    } finally {
      closeSync(descriptor);
    }
  } catch {
    return undefined;
  }
  return usableCertificate(pem, publicKey, address, at);
}

function usableCertificate(
  pem: string,
  publicKey: ReturnType<typeof createPublicKey>,
  address: string,
  at: Date,
): string | undefined {
  let certificate: X509Certificate;
  try {
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
  try {
    const covered =
      isIP(address) === 0
        ? certificate.checkHost(address) === address
        : certificate.checkIP(address) === address;
    return covered ? pem : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Writes a staging file created exclusively, owner-only, and without following
 * a link, flushes it, renames it over the target, and flushes the directory,
 * so a crash leaves either the old file or the complete new one.
 */
export function writeOwnerOnly(path: string, contents: string): void {
  const staging = `${path}.${process.pid}.tmp`;
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  let descriptor: number;
  try {
    descriptor = openSync(staging, flags, 0o600);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    // A staging file a crashed write left under this process id. Unlinking
    // removes the entry itself, never a link's target.
    unlinkSync(staging);
    descriptor = openSync(staging, flags, 0o600);
  }
  try {
    const bytes = Buffer.from(contents, "utf8");
    let written = 0;
    while (written < bytes.length) {
      written += writeSync(descriptor, bytes, written, bytes.length - written);
    }
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(staging, path);
  syncDirectory(dirname(path));
}

function syncDirectory(directory: string): void {
  const descriptor = openSync(directory, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } catch (error) {
    // Some file systems cannot flush a directory; the rename itself is done.
    if (errorCode(error) !== "EINVAL" && errorCode(error) !== "ENOTSUP") throw error;
  } finally {
    closeSync(descriptor);
  }
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}
