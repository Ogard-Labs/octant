// Expo / native secure-storage adapter for remote device keys.
//
// Browser IndexedDB can structured-clone non-extractable CryptoKeys. Mobile
// SecureStore only persists strings, so this store requires extractable keys,
// exports PKCS8 + SPKI once into the secure vault, and re-imports CryptoKeys on
// read. Private key material never appears on RemoteDeviceKeyMetadata or in
// thrown error messages.

import type { StableHostId } from "@octant/contracts/remote-access";
import type {
  RemoteDeviceKeyMetadata,
  RemoteDeviceKeyPair,
  RemoteDeviceKeyStore,
} from "./remotePairingClient";

const CATALOG_KEY = "octant.remote.device-keys.v1";
const KEY_ALGORITHM: EcKeyImportParams = { name: "ECDSA", namedCurve: "P-256" };
const KEY_USAGES: KeyUsage[] = ["sign", "verify"];

export interface ExpoSecureStringStorage {
  readonly getItem: (key: string) => Promise<string | null>;
  readonly setItem: (key: string, value: string) => Promise<void>;
  readonly deleteItem: (key: string) => Promise<void>;
}

interface PersistedDeviceKeyRecord {
  readonly keyId: string;
  readonly origin: string;
  readonly hostId: StableHostId;
  readonly createdAt: string;
  readonly privateKeyPkcs8Base64: string;
  readonly publicKeySpkiBase64: string;
  readonly deviceId?: string;
  readonly credentialGeneration?: number;
  readonly hostKeyFingerprint?: string;
}

export interface ExpoSecureDeviceKeyStoreOptions {
  readonly storage: ExpoSecureStringStorage;
  readonly subtle?: SubtleCrypto;
  readonly randomUUID?: () => string;
}

export function createExpoSecureDeviceKeyStore(
  options: ExpoSecureDeviceKeyStoreOptions,
): RemoteDeviceKeyStore {
  const subtle = options.subtle ?? globalThis.crypto.subtle;
  const randomUUID = options.randomUUID ?? (() => globalThis.crypto.randomUUID());
  const storage = options.storage;

  const readCatalog = async (): Promise<PersistedDeviceKeyRecord[]> => {
    const raw = await storage.getItem(CATALOG_KEY);
    if (raw === null || raw.length === 0) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("Remote device key catalog is corrupt.");
    }
    return parsed as PersistedDeviceKeyRecord[];
  };

  const writeCatalog = async (records: ReadonlyArray<PersistedDeviceKeyRecord>): Promise<void> => {
    if (records.length === 0) {
      await storage.deleteItem(CATALOG_KEY);
      return;
    }
    await storage.setItem(CATALOG_KEY, JSON.stringify(records));
  };

  const importKeyPair = async (record: PersistedDeviceKeyRecord): Promise<RemoteDeviceKeyPair> => {
    const privateKey = await subtle.importKey(
      "pkcs8",
      base64ToArrayBuffer(record.privateKeyPkcs8Base64),
      KEY_ALGORITHM,
      false,
      ["sign"],
    );
    const publicKey = await subtle.importKey(
      "spki",
      base64ToArrayBuffer(record.publicKeySpkiBase64),
      KEY_ALGORITHM,
      true,
      ["verify"],
    );
    return { publicKey, privateKey };
  };

  const store: RemoteDeviceKeyStore = {
    requiresExtractablePrivateKeys: true,

    async set(keyPair, setOptions) {
      let privateKeyPkcs8Base64: string;
      let publicKeySpkiBase64: string;
      try {
        privateKeyPkcs8Base64 = arrayBufferToBase64(
          await subtle.exportKey("pkcs8", keyPair.privateKey),
        );
        publicKeySpkiBase64 = arrayBufferToBase64(
          await subtle.exportKey("spki", keyPair.publicKey),
        );
      } catch {
        throw new Error(
          "Device private key is not exportable; enable requiresExtractablePrivateKeys for mobile secure storage.",
        );
      }

      const keyId = randomUUID();
      const record: PersistedDeviceKeyRecord = {
        keyId,
        origin: setOptions.origin,
        hostId: setOptions.hostId,
        createdAt: new Date().toISOString(),
        privateKeyPkcs8Base64,
        publicKeySpkiBase64,
        ...(setOptions.deviceId === undefined ? {} : { deviceId: setOptions.deviceId }),
      };
      const records = await readCatalog();
      records.push(record);
      await writeCatalog(records);
      return keyId;
    },

    async get(keyId) {
      const record = (await readCatalog()).find((entry) => entry.keyId === keyId);
      if (record === undefined) return undefined;
      return importKeyPair(record);
    },

    async updateMetadata(keyId, metadata) {
      const records = await readCatalog();
      const index = records.findIndex((entry) => entry.keyId === keyId);
      if (index < 0) {
        throw new Error("Remote device key no longer exists.");
      }
      const current = records[index]!;
      records[index] = {
        ...current,
        deviceId: metadata.deviceId,
        credentialGeneration: metadata.credentialGeneration,
        hostKeyFingerprint: metadata.hostKeyFingerprint,
      };
      await writeCatalog(records);
    },

    async removeOtherApprovedForOrigin(origin, keepKeyId) {
      const records = await readCatalog();
      const keep = records.find((entry) => entry.keyId === keepKeyId);
      if (keep === undefined || keep.origin !== origin) {
        throw new Error("Remote device key no longer exists.");
      }
      const next = records.filter((entry) => {
        if (entry.keyId === keepKeyId) return true;
        if (entry.origin !== origin) return true;
        return metadataFromPersisted(entry) === undefined;
      });
      await writeCatalog(next);
    },

    async findByOrigin(origin) {
      let best: PersistedDeviceKeyRecord | undefined;
      for (const record of await readCatalog()) {
        if (record.origin !== origin) continue;
        if (metadataFromPersisted(record) === undefined) continue;
        if (best === undefined || record.createdAt >= best.createdAt) {
          best = record;
        }
      }
      return best === undefined ? undefined : metadataFromPersisted(best);
    },

    async remove(keyId) {
      const records = await readCatalog();
      await writeCatalog(records.filter((entry) => entry.keyId !== keyId));
    },
  };

  return store;
}

export function createInMemoryExpoSecureStringStorage(): ExpoSecureStringStorage {
  const values = new Map<string, string>();
  return {
    async getItem(key) {
      return values.get(key) ?? null;
    },
    async setItem(key, value) {
      values.set(key, value);
    },
    async deleteItem(key) {
      values.delete(key);
    },
  };
}

function metadataFromPersisted(
  record: PersistedDeviceKeyRecord,
): RemoteDeviceKeyMetadata | undefined {
  if (
    record.deviceId === undefined ||
    record.credentialGeneration === undefined ||
    record.hostKeyFingerprint === undefined
  ) {
    return undefined;
  }
  return {
    keyId: record.keyId,
    origin: record.origin,
    hostId: record.hostId,
    deviceId: record.deviceId,
    credentialGeneration: record.credentialGeneration,
    hostKeyFingerprint: record.hostKeyFingerprint,
  };
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToArrayBuffer(value: string): ArrayBuffer {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}
