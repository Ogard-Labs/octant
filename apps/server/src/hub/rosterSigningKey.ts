// The hub's roster signing key, kept in the hub's own key store: a file in the
// Octant data folder that only the person's account can read, so the hub can
// sign a roster before anyone logs in. It is made on first use; private bytes
// cross only the internal storage/import boundary, never the public signer.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import type { WindowsRosterSigningKeyFile } from "@octant/host-runtime";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SUBDIR = "hub";
const KEY_FILE = "roster-signing-key.pem";

export interface RosterSigner {
  /** The base64url SubjectPublicKeyInfo spokes verify the roster with. */
  readonly publicKey: string;
  readonly sign: (payload: string) => string;
}

export interface RosterSigningKeyStore {
  readonly signer: () => RosterSigner;
}

export function createRosterSigningKeyStore(
  dataDirectory: string,
  nativeFile?: WindowsRosterSigningKeyFile,
): RosterSigningKeyStore {
  const directory = join(dataDirectory, SUBDIR);
  const path = join(directory, KEY_FILE);
  let loaded: RosterSigner | undefined;
  return {
    signer: () => {
      if (
        (nativeFile !== undefined && nativeFile.dataDirectory !== dataDirectory) ||
        (process.platform === "win32" && nativeFile === undefined)
      )
        return unavailable();
      if (loaded !== undefined) return loaded;
      if (nativeFile !== undefined) {
        loaded = nativeSigner(nativeFile);
        return loaded;
      }
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      chmodSync(directory, 0o700);
      let pem: string;
      if (existsSync(path)) {
        pem = readFileSync(path, "utf8");
      } else {
        const generated = generateKeyPairSync("ec", { namedCurve: "P-256" });
        pem = String(generated.privateKey.export({ format: "pem", type: "pkcs8" }));
        writeFileSync(path, pem, { mode: 0o600 });
      }
      // A key file left readable by others is narrowed rather than trusted as it is.
      chmodSync(path, 0o600);
      const privateKey = createPrivateKey(pem);
      loaded = rosterSigner(privateKey, createPublicKey(pem));
      return loaded;
    },
  };
}

function unavailable(): never {
  throw new Error("The roster private signing storage is unavailable or unsafe.");
}

function nativeSigner(file: WindowsRosterSigningKeyFile): RosterSigner {
  try {
    let reading = file.read();
    if (reading.status === "missing") {
      const generated = generateKeyPairSync("ec", { namedCurve: "P-256" });
      const candidate = Buffer.from(generated.privateKey.export({ format: "pem", type: "pkcs8" }));
      try {
        reading = file.create(candidate);
      } finally {
        candidate.fill(0);
      }
    }
    if (reading.status !== "ready") return unavailable();
    try {
      if (reading.bytes.length === 0 || reading.bytes.length > 4096) return unavailable();
      const key = createPrivateKey(reading.bytes);
      if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
        return unavailable();
      return rosterSigner(key, createPublicKey(reading.bytes));
    } finally {
      reading.bytes.fill(0);
    }
  } catch {
    return unavailable();
  }
}

function rosterSigner(
  privateKey: ReturnType<typeof createPrivateKey>,
  publicKey: ReturnType<typeof createPublicKey>,
): RosterSigner {
  return {
    publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64url"),
    sign: (payload) =>
      sign("sha256", Buffer.from(payload, "utf8"), {
        key: privateKey,
        dsaEncoding: "ieee-p1363",
      }).toString("base64url"),
  };
}
