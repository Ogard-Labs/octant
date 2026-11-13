import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
  OUTSIDE_PROVIDER_DRIVER_SIGNATURE_FORMAT,
  OUTSIDE_PROVIDER_DRIVER_SIGNATURE_PATH,
  outsideProviderDriverSignedMessage,
} from "@octant/plugin-api/outside-provider-driver";
import type { ExtensionArchiveEntry } from "./packageInspector";

/**
 * Signs a package's files as a publisher would, with a throwaway key made
 * for one test, and returns the signature file and the key's fingerprint.
 */
export function signPackageEntries(
  entries: ReadonlyArray<ExtensionArchiveEntry>,
  facts: { readonly name: string; readonly version: string },
): { readonly entry: ExtensionArchiveEntry; readonly fingerprint: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  const rawPublicKey = Buffer.from(String(jwk.x), "base64url");
  const files = entries
    .filter((entry) => entry.kind === "file" && entry.content !== undefined)
    .map((entry) => ({
      path: entry.path,
      sha256: createHash("sha256")
        .update(entry.content ?? new Uint8Array())
        .digest("hex"),
    }));
  const signature = sign(
    null,
    outsideProviderDriverSignedMessage({ ...facts, protocolVersions: [], files }),
    privateKey,
  );
  return {
    entry: {
      path: OUTSIDE_PROVIDER_DRIVER_SIGNATURE_PATH,
      kind: "file",
      content: new TextEncoder().encode(
        JSON.stringify({
          format: OUTSIDE_PROVIDER_DRIVER_SIGNATURE_FORMAT,
          ...facts,
          protocolVersions: [],
          files,
          publicKey: rawPublicKey.toString("base64"),
          signature: signature.toString("base64"),
        }),
      ),
    },
    fingerprint: `ed25519:${createHash("sha256").update(rawPublicKey).digest("hex")}`,
  };
}
