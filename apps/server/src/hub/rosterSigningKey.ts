// The hub's roster signing key, kept in the hub's own key store: a file in the
// Octant data folder that only the person's account can read, so the hub can
// sign a roster before anyone logs in. It is made on first use and its private
// half never leaves this module.

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
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

export function createRosterSigningKeyStore(dataDirectory: string): RosterSigningKeyStore {
  const directory = join(dataDirectory, SUBDIR);
  const path = join(directory, KEY_FILE);
  let loaded: RosterSigner | undefined;
  return {
    signer: () => {
      if (loaded !== undefined) return loaded;
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
      loaded = {
        publicKey: createPublicKey(pem)
          .export({ format: "der", type: "spki" })
          .toString("base64url"),
        sign: (payload) =>
          sign("sha256", Buffer.from(payload, "utf8"), {
            key: privateKey,
            dsaEncoding: "ieee-p1363",
          }).toString("base64url"),
      };
      return loaded;
    },
  };
}
