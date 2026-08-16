// Adapts the pairing client's origin-scoped RemoteDeviceKeyStore (CryptoKey pairs
// keyed by deviceKeyId) to the RemoteConnection DeviceKeyStore port (SPKI PEM +
// ieee-p1363 signatures).

import type { RemoteDeviceKeyStore } from "./remotePairingClient";
import type { DeviceKeyStore, DevicePublicKey } from "./remoteConnection";

const PEM_LINE_LENGTH = 64;

export function createPairingDeviceKeyAdapter(
  store: RemoteDeviceKeyStore,
  deviceKeyId: string,
): DeviceKeyStore {
  return {
    async loadOrCreate(): Promise<DevicePublicKey> {
      const keyPair = await store.get(deviceKeyId);
      if (keyPair === undefined) {
        throw new Error("Remote device key is missing; re-pairing is required.");
      }
      return derivePublicKey(keyPair.publicKey);
    },
    async current(): Promise<DevicePublicKey | undefined> {
      const keyPair = await store.get(deviceKeyId);
      if (keyPair === undefined) return undefined;
      return derivePublicKey(keyPair.publicKey);
    },
    async sign(payload: string): Promise<string> {
      const keyPair = await store.get(deviceKeyId);
      if (keyPair === undefined) {
        throw new Error("Remote device key is missing; re-pairing is required.");
      }
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        keyPair.privateKey,
        new TextEncoder().encode(payload),
      );
      return toBase64Url(new Uint8Array(signature));
    },
    async clear(): Promise<void> {
      await store.remove(deviceKeyId);
    },
  };
}

async function derivePublicKey(publicKey: CryptoKey): Promise<DevicePublicKey> {
  const spki = await crypto.subtle.exportKey("spki", publicKey);
  const pem = spkiToPem(spki);
  const digest = await crypto.subtle.digest("SHA-256", spki);
  const fingerprint = Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return { publicKeyPem: pem, fingerprint };
}

function spkiToPem(spki: ArrayBuffer): string {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(spki)));
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += PEM_LINE_LENGTH) {
    lines.push(base64.slice(i, i + PEM_LINE_LENGTH));
  }
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----`;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
