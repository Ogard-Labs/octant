import {
  decodeHostHelloV1,
  decodePairingStatusResultV1,
  type HostHelloV1,
  type PairingStatusResultV1,
  type StableHostId,
} from "@octant/contracts/remote-access";
import { bindFetchPort } from "./bindFetchPort";

const CLIENT_SUPPORTED_PROTOCOL_RANGE = { min: 1, max: 1 } as const;
const CLIENT_BROWSER_CAPABILITIES = ["webcrypto"] as const;
const KEY_ALGORITHM: EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };
const KEY_USAGES: KeyUsage[] = ["sign", "verify"];
const PEM_LINE_LENGTH = 64;

export interface RemotePairingTicket {
  readonly ticketId: string;
  readonly ticketProof: string;
}

export interface RemoteDeviceKeyPair {
  readonly publicKey: CryptoKey;
  readonly privateKey: CryptoKey;
}

export interface RemoteDeviceKeyStore {
  /**
   * When true, pairing generates extractable private keys so the store can
   * persist PKCS8 material in platform secure storage (Expo SecureStore /
   * Keychain). Browser IndexedDB stores keep this false and use non-extractable
   * CryptoKeys.
   */
  readonly requiresExtractablePrivateKeys?: boolean;
  readonly set: (
    keyPair: RemoteDeviceKeyPair,
    options: {
      readonly origin: string;
      readonly hostId: StableHostId;
      readonly deviceId?: string;
    },
  ) => Promise<string>;
  readonly get: (keyId: string) => Promise<RemoteDeviceKeyPair | undefined>;
  /** Persist non-secret registration facts next to the origin-scoped key. */
  readonly updateMetadata: (
    keyId: string,
    metadata: {
      readonly deviceId: string;
      readonly credentialGeneration: number;
      readonly hostKeyFingerprint: string;
    },
  ) => Promise<void>;
  /** Remove previously approved registrations for this origin after a new
   * approval is committed. Pending claims (records without approved metadata)
   * are preserved so a concurrent pairing in another tab is not destroyed. */
  readonly removeOtherApprovedForOrigin: (origin: string, keepKeyId: string) => Promise<void>;
  /** Find the most recent complete registration for this exact remote origin. */
  readonly findByOrigin: (origin: string) => Promise<RemoteDeviceKeyMetadata | undefined>;
  readonly remove: (keyId: string) => Promise<void>;
}

export interface RemoteDeviceKeyMetadata {
  readonly keyId: string;
  readonly origin: string;
  readonly hostId: StableHostId;
  readonly deviceId: string;
  readonly credentialGeneration: number;
  readonly hostKeyFingerprint: string;
}

interface StoredDeviceKeyRecord {
  readonly keyId: string;
  readonly origin: string;
  readonly hostId: StableHostId;
  readonly deviceId?: string;
  readonly credentialGeneration?: number;
  readonly hostKeyFingerprint?: string;
  readonly createdAt: string;
  readonly keyPair: RemoteDeviceKeyPair;
}

export type RemotePairingFailureCategory =
  | "denied"
  | "expired"
  | "invalid"
  | "rate-limited"
  | "unavailable";

export interface RemotePairingClaim {
  readonly ticketId: string;
  readonly hostId: StableHostId;
  readonly hostDisplayName: string;
  readonly hostKeyFingerprint: string;
  readonly origin: string;
  readonly comparisonCode: string;
  readonly deviceKeyFingerprint: string;
  readonly deviceKeyId: string;
  readonly deviceLabel: string;
  readonly sourceClass: string;
  readonly claimedAt: string;
  readonly expiresAt: string;
}

export interface RemotePairingApproval {
  readonly ticketId: string;
  readonly hostId: StableHostId;
  readonly deviceId: string;
  readonly credentialGeneration: number;
  readonly deviceKeyId: string;
  readonly origin: string;
}

export type RemotePairingStatus =
  | { readonly kind: "pending"; readonly claim: RemotePairingClaim }
  | { readonly kind: "approved"; readonly approval: RemotePairingApproval }
  | {
      readonly kind: "failed";
      readonly category: "denied" | "expired" | "invalid" | "rate-limited" | "unavailable";
      readonly message: string;
      /** Keep the approved claim so the caller can retry local persistence. */
      readonly retryable?: boolean;
    };

export class RemotePairingFailure extends Error {
  readonly category: "invalid" | "unauthorized" | "rate-limited" | "unavailable";

  constructor(
    category: RemotePairingFailure["category"],
    message = "Remote pairing request failed.",
  ) {
    super(message);
    this.name = "RemotePairingFailure";
    this.category = category;
  }
}

export function isRemotePairingFailure(error: unknown): error is RemotePairingFailure {
  return error instanceof RemotePairingFailure;
}

export interface RemotePairingClientOptions {
  readonly baseUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly webBuildVersion: string;
  readonly deviceKeyStore?: RemoteDeviceKeyStore;
  readonly now?: () => number;
}

export interface RemotePairingClient {
  readonly requestHostHello: () => Promise<HostHelloV1>;
  readonly claimPairing: (input: {
    readonly ticket: RemotePairingTicket;
    readonly deviceLabel: string;
    readonly hostHello: HostHelloV1;
  }) => Promise<RemotePairingClaim>;
  readonly pollPairingStatus: (input: {
    readonly ticket: RemotePairingTicket;
    readonly claim: RemotePairingClaim;
  }) => Promise<RemotePairingStatus>;
  readonly removeDeviceKey: (keyId: string) => Promise<void>;
}

export function createRemotePairingClient(
  options: RemotePairingClientOptions,
): RemotePairingClient {
  const fetch = bindFetchPort(options.fetch);
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const origin = new URL(baseUrl).origin;
  const webBuildVersion = options.webBuildVersion;
  const deviceKeyStore = options.deviceKeyStore ?? createDefaultDeviceKeyStore();
  const now = options.now ?? (() => Date.now());

  const requestHostHello = async (): Promise<HostHelloV1> => {
    const url = new URL("/api/remote/hello", baseUrl);
    let response: Response;
    try {
      response = await fetch(url.toString(), { method: "GET" });
    } catch (error) {
      throw transportFailure(error);
    }
    if (!response.ok) {
      throw statusFailure(response.status);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new RemotePairingFailure("unavailable", "Host hello response was invalid.");
    }
    let hello: HostHelloV1;
    try {
      hello = decodeHostHelloV1(body);
    } catch {
      throw new RemotePairingFailure("invalid", "Host hello response was invalid.");
    }
    if (hello.remoteOrigin !== origin) {
      throw new RemotePairingFailure("invalid", "Host hello origin does not match this page.");
    }
    if (new Date(hello.expiresAt).getTime() <= now()) {
      throw new RemotePairingFailure("unavailable", "Host hello has expired.");
    }
    return hello;
  };

  const claimPairing = async (input: {
    readonly ticket: RemotePairingTicket;
    readonly deviceLabel: string;
    readonly hostHello: HostHelloV1;
  }): Promise<RemotePairingClaim> => {
    if (input.hostHello.remoteOrigin !== origin) {
      throw new RemotePairingFailure("invalid", "Host hello origin does not match this page.");
    }
    if (new Date(input.hostHello.expiresAt).getTime() <= now()) {
      throw new RemotePairingFailure("unavailable", "Host hello has expired.");
    }
    const trimmedLabel = input.deviceLabel.trim();
    if (trimmedLabel.length === 0) {
      throw new RemotePairingFailure("invalid", "Device label is required.");
    }
    if (trimmedLabel.length > 128) {
      throw new RemotePairingFailure("invalid", "Device label is too long.");
    }

    let keyPair: RemoteDeviceKeyPair;
    let keyId: string;
    try {
      const extractable = deviceKeyStore.requiresExtractablePrivateKeys === true;
      const generated = (await crypto.subtle.generateKey(
        KEY_ALGORITHM,
        extractable,
        KEY_USAGES,
      )) as {
        publicKey: CryptoKey;
        privateKey: CryptoKey;
      };
      keyPair = generated;
      keyId = await deviceKeyStore.set(keyPair, {
        origin,
        hostId: input.hostHello.hostId,
      });
    } catch {
      throw new RemotePairingFailure("unavailable", "This browser could not create a device key.");
    }

    let publicKeyPem: string;
    let fingerprint: string;
    try {
      publicKeyPem = await exportPublicKeyPem(keyPair.publicKey);
      fingerprint = await publicKeyFingerprint(keyPair.publicKey);
    } catch {
      await deviceKeyStore.remove(keyId).catch(() => undefined);
      throw new RemotePairingFailure(
        "unavailable",
        "This browser could not export the device key.",
      );
    }

    const requestBody = {
      ticketId: input.ticket.ticketId,
      ticketProof: input.ticket.ticketProof,
      hostHelloNonce: input.hostHello.nonce,
      devicePublicKey: publicKeyPem,
      deviceKeyFingerprint: fingerprint,
      deviceLabel: trimmedLabel,
      origin,
      clientHello: {
        webBuildVersion,
        supportedProtocolRange: CLIENT_SUPPORTED_PROTOCOL_RANGE,
        browserCapabilities: [...CLIENT_BROWSER_CAPABILITIES],
      },
    };

    let response: Response;
    try {
      response = await fetch(new URL("/api/remote/pairing", baseUrl).toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      });
    } catch (error) {
      await deviceKeyStore.remove(keyId).catch(() => undefined);
      throw transportFailure(error);
    }
    if (!response.ok) {
      await deviceKeyStore.remove(keyId).catch(() => undefined);
      throw statusFailure(response.status);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      await deviceKeyStore.remove(keyId).catch(() => undefined);
      throw new RemotePairingFailure("unavailable", "Pairing response was invalid.");
    }
    const claim = decodePairingClaim(body);
    if (claim === undefined) {
      await deviceKeyStore.remove(keyId).catch(() => undefined);
      throw new RemotePairingFailure("unavailable", "Pairing response was invalid.");
    }
    if (claim.ticketId !== input.ticket.ticketId || claim.hostId !== input.hostHello.hostId) {
      await deviceKeyStore.remove(keyId).catch(() => undefined);
      throw new RemotePairingFailure("unavailable", "Pairing response did not match this ticket.");
    }
    return {
      ...claim,
      hostDisplayName: input.hostHello.displayName,
      hostKeyFingerprint: input.hostHello.hostKeyFingerprint,
      deviceKeyId: keyId,
      deviceKeyFingerprint: fingerprint,
    };
  };

  const pollPairingStatus = async (input: {
    readonly ticket: RemotePairingTicket;
    readonly claim: RemotePairingClaim;
  }): Promise<RemotePairingStatus> => {
    const requestBody = {
      ticketId: input.ticket.ticketId,
      ticketProof: input.ticket.ticketProof,
    };
    let response: Response;
    try {
      response = await fetch(new URL("/api/remote/pairing/status", baseUrl).toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      });
    } catch (error) {
      return failedStatus("unavailable", transportMessage(error));
    }
    if (response.status === 429) {
      return failedStatus("rate-limited", "Too many pairing status requests. Try again later.");
    }
    if (!response.ok) {
      return failedStatus("unavailable", "Pairing status request failed.");
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return failedStatus("unavailable", "Pairing status response was invalid.");
    }
    let result: PairingStatusResultV1;
    try {
      result = decodePairingStatusResultV1(body);
    } catch {
      return failedStatus("unavailable", "Pairing status response was invalid.");
    }
    if (result.status === "pending") {
      return { kind: "pending", claim: input.claim };
    }
    if (result.status === "approved") {
      // The host approved the public key sent during claim. If that private
      // key is gone, generating a replacement would produce a false
      // "approved" state: the replacement cannot authenticate as the
      // approved device. Fail closed and require pairing again.
      const keyPair = await deviceKeyStore.get(input.claim.deviceKeyId).catch(() => undefined);
      if (keyPair === undefined) {
        return failedStatus(
          "unavailable",
          "This browser lost its approved device key; pair it again.",
        );
      }
      try {
        await deviceKeyStore.updateMetadata(input.claim.deviceKeyId, {
          deviceId: result.deviceId,
          credentialGeneration: result.credentialGeneration,
          hostKeyFingerprint: input.claim.hostKeyFingerprint,
        });
        await deviceKeyStore.removeOtherApprovedForOrigin(origin, input.claim.deviceKeyId);
      } catch {
        return failedStatus(
          "unavailable",
          "This browser could not save the approved device; retry to finish pairing.",
          true,
        );
      }
      return {
        kind: "approved",
        approval: {
          ticketId: input.ticket.ticketId,
          hostId: input.claim.hostId,
          deviceId: result.deviceId,
          credentialGeneration: result.credentialGeneration,
          deviceKeyId: input.claim.deviceKeyId,
          origin,
        },
      };
    }
    const expiresAt = new Date(input.claim.expiresAt).getTime();
    if (now() >= expiresAt) {
      await deviceKeyStore.remove(input.claim.deviceKeyId).catch(() => undefined);
      return failedStatus("expired", "This pairing request has expired.");
    }
    await deviceKeyStore.remove(input.claim.deviceKeyId).catch(() => undefined);
    return failedStatus("denied", "The host denied this pairing request.");
  };

  const removeDeviceKey = async (keyId: string): Promise<void> => {
    await deviceKeyStore.remove(keyId).catch(() => undefined);
  };

  return { requestHostHello, claimPairing, pollPairingStatus, removeDeviceKey };
}

export function readPairingFragment(href: string): RemotePairingTicket | undefined {
  try {
    const url = new URL(href);
    const params = new URLSearchParams(url.hash.replace(/^#/, ""));
    const ticketId = params.get("ticketId");
    const ticketProof = params.get("ticketProof");
    if (ticketId === null || ticketProof === null) return undefined;
    if (!isUuid(ticketId) || !isBase64Url(ticketProof)) return undefined;
    return { ticketId, ticketProof };
  } catch {
    return undefined;
  }
}

export function parseTypedPairingCode(value: string): RemotePairingTicket | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    return readPairingFragment(trimmed);
  }
  if (trimmed.startsWith("#")) {
    return readPairingFragment(`https://placeholder.test${trimmed}`);
  }
  const fragmentMatch = /^ticketId=([^&]+)&ticketProof=([^&]+)$/.exec(trimmed);
  if (fragmentMatch !== null) {
    const [, ticketId, ticketProof] = fragmentMatch;
    if (
      ticketId !== undefined &&
      ticketProof !== undefined &&
      isUuid(ticketId) &&
      isBase64Url(ticketProof)
    ) {
      return { ticketId, ticketProof };
    }
  }
  return undefined;
}

export function isRemotePairingOrigin(href: string): boolean {
  try {
    const url = new URL(href);
    if (url.protocol !== "https:") return false;
    const host = url.hostname.toLowerCase();
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "::1" ||
      host === "0.0.0.0" ||
      host.startsWith("127.")
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function createInMemoryDeviceKeyStore(): RemoteDeviceKeyStore {
  const records = new Map<string, StoredDeviceKeyRecord>();
  return {
    async set(keyPair, options) {
      const keyId = crypto.randomUUID();
      records.set(keyId, {
        keyId,
        origin: options.origin,
        hostId: options.hostId,
        createdAt: new Date().toISOString(),
        keyPair,
        ...(options.deviceId === undefined ? {} : { deviceId: options.deviceId }),
      });
      return keyId;
    },
    async get(keyId) {
      return records.get(keyId)?.keyPair;
    },
    async updateMetadata(keyId, metadata) {
      const record = records.get(keyId);
      if (record === undefined) {
        throw new Error("Remote device key no longer exists.");
      }
      records.set(keyId, { ...record, ...metadata });
    },
    async removeOtherApprovedForOrigin(origin, keepKeyId) {
      const keepRecord = records.get(keepKeyId);
      if (keepRecord === undefined || keepRecord.origin !== origin) {
        throw new Error("Remote device key no longer exists.");
      }
      for (const [keyId, record] of records) {
        if (keyId === keepKeyId) continue;
        if (record.origin !== origin) continue;
        // Only previously approved registrations are replaced; a pending claim
        // (no approved metadata yet) must survive a concurrent approval.
        if (metadataFromRecord(record) !== undefined) records.delete(keyId);
      }
    },
    async findByOrigin(origin) {
      let best: StoredDeviceKeyRecord | undefined;
      for (const record of records.values()) {
        if (record.origin !== origin) continue;
        if (metadataFromRecord(record) === undefined) continue;
        // Prefer the most recently stored registration so a re-approved device
        // is never shadowed by a stale record left by an interrupted pairing.
        if (best === undefined || record.createdAt >= best.createdAt) {
          best = record;
        }
      }
      return best === undefined ? undefined : metadataFromRecord(best);
    },
    async remove(keyId) {
      records.delete(keyId);
    },
  };
}

export function createIndexedDbDeviceKeyStore(): RemoteDeviceKeyStore {
  if (typeof indexedDB === "undefined") {
    throw new Error("IndexedDB is not available in this environment.");
  }

  const DB_NAME = "OctantRemoteDeviceKeys";
  const DB_VERSION = 1;
  const STORE_NAME = "keys";

  const openDb = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "keyId" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("Failed to open remote device key store."));
    });

  return {
    async set(keyPair, options) {
      const keyId = crypto.randomUUID();
      const db = await openDb();
      const record: StoredDeviceKeyRecord = {
        keyId,
        origin: options.origin,
        hostId: options.hostId,
        createdAt: new Date().toISOString(),
        keyPair,
        ...(options.deviceId === undefined ? {} : { deviceId: options.deviceId }),
      };
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.put(record);
        request.onsuccess = () => resolve(keyId);
        request.onerror = () => reject(new Error("Failed to store remote device key."));
      });
    },
    async get(keyId) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, "readonly");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(keyId);
        request.onsuccess = () => {
          const record = request.result as StoredDeviceKeyRecord | undefined;
          resolve(record?.keyPair);
        };
        request.onerror = () => reject(new Error("Failed to read remote device key."));
      });
    },
    async updateMetadata(keyId, metadata) {
      const db = await openDb();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(keyId);
        request.onsuccess = () => {
          const record = request.result as StoredDeviceKeyRecord | undefined;
          if (record === undefined) {
            reject(new Error("Remote device key no longer exists."));
            return;
          }
          const update = store.put({ ...record, ...metadata });
          update.onerror = () => transaction.abort();
        };
        request.onerror = () => reject(new Error("Failed to read remote device key metadata."));
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(new Error("Failed to update remote device metadata."));
        transaction.onerror = () => reject(new Error("Failed to update remote device metadata."));
      });
    },
    async removeOtherApprovedForOrigin(origin, keepKeyId) {
      const db = await openDb();
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const keepRequest = store.get(keepKeyId);
        keepRequest.onsuccess = () => {
          const keepRecord = keepRequest.result as StoredDeviceKeyRecord | undefined;
          if (keepRecord === undefined || keepRecord.origin !== origin) {
            transaction.abort();
            return;
          }
          const request = store.openCursor();
          request.onsuccess = () => {
            const cursor = request.result;
            if (cursor === null) {
              return;
            }
            const record = cursor.value as StoredDeviceKeyRecord;
            if (
              record.origin === origin &&
              record.keyId !== keepKeyId &&
              metadataFromRecord(record) !== undefined
            ) {
              cursor.delete();
            }
            cursor.continue();
          };
          request.onerror = () => transaction.abort();
        };
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(new Error("Remote device key no longer exists."));
        transaction.onerror = () => reject(new Error("Failed to replace remote device metadata."));
      });
    },
    async findByOrigin(origin) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, "readonly");
        const request = transaction.objectStore(STORE_NAME).openCursor();
        let best: StoredDeviceKeyRecord | undefined;
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor === null) {
            resolve(best === undefined ? undefined : metadataFromRecord(best));
            return;
          }
          const record = cursor.value as StoredDeviceKeyRecord;
          if (
            record.origin === origin &&
            metadataFromRecord(record) !== undefined &&
            (best === undefined || record.createdAt >= best.createdAt)
          ) {
            best = record;
          }
          cursor.continue();
        };
        request.onerror = () => reject(new Error("Failed to enumerate remote device metadata."));
      });
    },
    async remove(keyId) {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE_NAME, "readwrite");
        const store = transaction.objectStore(STORE_NAME);
        const request = store.delete(keyId);
        request.onerror = () => transaction.abort();
        transaction.oncomplete = () => resolve(undefined);
        transaction.onabort = () => reject(new Error("Failed to remove remote device key."));
        transaction.onerror = () => reject(new Error("Failed to remove remote device key."));
      });
    },
  };
}

function metadataFromRecord(record: StoredDeviceKeyRecord): RemoteDeviceKeyMetadata | undefined {
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

export function createDefaultDeviceKeyStore(): RemoteDeviceKeyStore {
  if (typeof indexedDB !== "undefined") {
    try {
      return createIndexedDbDeviceKeyStore();
    } catch {
      return createInMemoryDeviceKeyStore();
    }
  }
  return createInMemoryDeviceKeyStore();
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  let base = `${url.origin}${url.pathname}`;
  if (!base.endsWith("/")) {
    base += "/";
  }
  return base;
}

async function exportPublicKeyPem(publicKey: CryptoKey): Promise<string> {
  const spki = await crypto.subtle.exportKey("spki", publicKey);
  const base64 = btoa(String.fromCharCode(...new Uint8Array(spki)));
  const lines: string[] = [];
  for (let i = 0; i < base64.length; i += PEM_LINE_LENGTH) {
    lines.push(base64.slice(i, i + PEM_LINE_LENGTH));
  }
  return `-----BEGIN PUBLIC KEY-----\n${lines.join("\n")}\n-----END PUBLIC KEY-----`;
}

async function publicKeyFingerprint(publicKey: CryptoKey): Promise<string> {
  const spki = await crypto.subtle.exportKey("spki", publicKey);
  const digest = await crypto.subtle.digest("SHA-256", spki);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function decodePairingClaim(
  body: unknown,
): Omit<RemotePairingClaim, "hostDisplayName" | "hostKeyFingerprint" | "deviceKeyId"> | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  if (record.kind !== "pending") return undefined;
  if (typeof record.ticketId !== "string" || !isUuid(record.ticketId)) return undefined;
  if (typeof record.hostId !== "string" || !isUuid(record.hostId)) return undefined;
  if (typeof record.deviceLabel !== "string") return undefined;
  if (
    typeof record.deviceKeyFingerprint !== "string" ||
    !/^[0-9a-f]{64}$/i.test(record.deviceKeyFingerprint)
  )
    return undefined;
  if (typeof record.origin !== "string") return undefined;
  if (typeof record.sourceClass !== "string") return undefined;
  if (typeof record.comparisonCode !== "string" || !/^\d{6}$/.test(record.comparisonCode))
    return undefined;
  if (typeof record.claimedAt !== "string") return undefined;
  if (typeof record.expiresAt !== "string") return undefined;
  return {
    ticketId: record.ticketId,
    hostId: record.hostId as StableHostId,
    deviceLabel: record.deviceLabel,
    deviceKeyFingerprint: record.deviceKeyFingerprint,
    origin: record.origin,
    sourceClass: record.sourceClass,
    comparisonCode: record.comparisonCode,
    claimedAt: record.claimedAt,
    expiresAt: record.expiresAt,
  };
}

function failedStatus(
  category: RemotePairingFailureCategory,
  message: string,
  retryable?: boolean,
): Extract<RemotePairingStatus, { kind: "failed" }> {
  return {
    kind: "failed",
    category,
    message,
    ...(retryable === undefined ? {} : { retryable }),
  };
}

function transportFailure(error: unknown): RemotePairingFailure {
  return new RemotePairingFailure(
    isAbortError(error) ? "unavailable" : "unavailable",
    isAbortError(error) ? "Remote pairing request was aborted." : "Octant host is unreachable.",
  );
}

function statusFailure(status: number): RemotePairingFailure {
  if (status === 429) {
    return new RemotePairingFailure("rate-limited", "Too many pairing requests. Try again later.");
  }
  if (status === 400) {
    return new RemotePairingFailure("invalid", "Remote pairing request was invalid.");
  }
  if (status === 401 || status === 403) {
    return new RemotePairingFailure("unauthorized", "Remote pairing request was rejected.");
  }
  return new RemotePairingFailure("unavailable", "Octant host is unavailable.");
}

function transportMessage(error: unknown): string {
  return isAbortError(error)
    ? "Remote pairing request was aborted."
    : "Octant host is unreachable.";
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"
  );
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isBase64Url(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value) && value.length > 0;
}
