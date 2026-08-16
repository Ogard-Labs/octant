// Remote exit evidence A — browser-side driver.
//
// This module is bundled for Chromium (`bun build --target=browser`) and
// served by the disposable host at the remote HTTPS origin. It drives the
// REAL client-runtime pairing/session/surface clients inside one isolated
// browser profile (IndexedDB device keys, Secure/HttpOnly session cookies,
// same-origin fetch), so the evidence covers the actual production transport
// and credential paths — not raw HTTP against the harness.
//
// Evidence contract: every returned value is redacted. Device keys, ticket
// proofs, session secrets, CSRF values, cookies, and raw identifiers never
// appear in driver output; identities are SHA-256 digests. The comparison
// code from a pairing claim is deliberately never echoed back.
//
// The page must be served from the same origin as the remote host (the
// production model: the web shell is served BY the host), and the harness
// coordinates host-side actions (approve, revoke, restart) between calls.

import {
  createDefaultDeviceKeyStore,
  createRemotePairingClient,
  createRemoteSessionBridge,
  exerciseRemoteChatMutation,
  exerciseRemoteChatSurface,
  exerciseRemoteCodeMutation,
  exerciseRemoteCodeSurface,
  exerciseRemoteWorkMutation,
  exerciseRemoteWorkSurface,
  exerciseRemoteProviderSurface,
  exerciseRemoteSettingsSurface,
  fetchRemoteOwnDeviceMetadata,
  isRemoteProductMutationFailure,
  remoteRevokeSelf,
  remoteSignOut,
  type RemotePairingApproval,
  type RemotePairingClaim,
  type RemotePairingClient,
  type RemoteSessionBridge,
  type RemoteSessionBridgeState,
} from "@octant/client-runtime";
import { buildRemoteKeyRotationProofPayload } from "@octant/domain";

const WEB_BUILD_VERSION = "0.1.0";
const DEVICE_KEY_DB_NAME = "OctantRemoteDeviceKeys";
const KEY_ALGORITHM: EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };
const KEY_USAGES: KeyUsage[] = ["sign", "verify"];
const PEM_LINE_LENGTH = 64;

export type RedactedDriverState =
  | { kind: "idle" }
  | {
      kind: "connecting" | "negotiating" | "authenticating" | "reconnecting" | "stale";
      hostIdDigest: string;
    }
  | { kind: "ready"; hostIdDigest: string; displayName: string }
  | { kind: "incompatible" | "unauthorized" | "unavailable"; reason: string };

export interface DriverOperationFailure {
  readonly ok: false;
  readonly category: string;
  readonly status?: number;
}

export type DriverOperationResult = { readonly ok: true } | DriverOperationFailure;

export interface EvidenceADriver {
  init(): Promise<{
    ok: true;
    originDigest: string;
    fragmentCleared: boolean;
    hadFragment: boolean;
    deviceKeyStorage: "indexeddb" | "memory";
  }>;
  hello(): Promise<{
    productId: string;
    hostIdDigest: string;
    displayName: string;
    hostKeyFingerprintDigest: string;
    originDigest: string;
  }>;
  pair(input: { ticketId: string; ticketProof: string; deviceLabel: string }): Promise<{
    status: "claimed";
    ticketIdDigest: string;
    hostIdDigest: string;
    deviceLabel: string;
    deviceKeyFingerprintDigest: string;
    originDigest: string;
    sourceClass: string;
    claimedAt: string;
    expiresAt: string;
  }>;
  pollApproval(): Promise<
    | {
        status: "approved";
        deviceIdDigest: string;
        credentialGeneration: number;
        originDigest: string;
      }
    | { status: "pending" }
    | { status: "failed"; category: string }
  >;
  connect(): Promise<RedactedDriverState>;
  state(): Promise<RedactedDriverState>;
  runChatSurface(): Promise<DriverOperationResult>;
  runChatMutation(): Promise<DriverOperationResult>;
  runWorkSurface(): Promise<DriverOperationResult>;
  runWorkMutation(): Promise<DriverOperationResult>;
  runCodeSurface(): Promise<DriverOperationResult>;
  runCodeMutation(): Promise<DriverOperationResult>;
  runProviderSurface(): Promise<DriverOperationResult>;
  runSettingsSurface(): Promise<DriverOperationResult>;
  probeSurfaceStatus(): Promise<{ status: number }>;
  disconnect(): Promise<RedactedDriverState>;
  reconnect(): Promise<RedactedDriverState>;
  beginEvidenceMutation(): { status: "in-flight" };
  finishEvidenceMutation(): Promise<{
    status: "ambiguous" | "completed";
    error?: string;
    httpStatus?: number;
  }>;
  readStreamToEnd(): Promise<{ status: "aborted" | "completed"; error?: string; frames?: number }>;
  lookupReceipt(commandId: string): Promise<
    | {
        kind: "applied" | "pending" | "failed" | "not-found" | "ambiguous";
        commandIdDigest: string;
        operationKind?: string;
        reasonCode?: string;
      }
    | { kind: "error"; category: string; status?: number }
  >;
  rotateDeviceKey(): Promise<{ ok: true; newFingerprintDigest: string } | DriverOperationFailure>;
  ownDevice(): Promise<
    | {
        ok: true;
        deviceIdDigest: string;
        originDigest: string;
        credentialGeneration: number;
        state: string;
      }
    | DriverOperationFailure
  >;
  signOut(): Promise<RedactedDriverState>;
  revokeSelf(): Promise<RedactedDriverState>;
  clearStorage(): Promise<{ ok: true }>;
  storageState(): Promise<{ deviceKeyRecords: number }>;
}

declare global {
  interface Window {
    __evidenceA: EvidenceADriver;
    __evidenceAPendingMutation?: Promise<{
      status: "ambiguous" | "completed";
      error?: string;
      httpStatus?: number;
    }>;
  }
}

let baseUrl: string;
let pairingClient: RemotePairingClient;
let bridge: RemoteSessionBridge;
let ticket: { ticketId: string; ticketProof: string } | undefined;
let claim: RemotePairingClaim | undefined;
let approval: RemotePairingApproval | undefined;

async function digestHex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function redactState(): Promise<RedactedDriverState> {
  const state = bridge.getState();
  switch (state.kind) {
    case "idle":
      return { kind: "idle" };
    case "connecting":
    case "negotiating":
    case "authenticating":
    case "reconnecting":
    case "stale":
      return { kind: state.kind, hostIdDigest: await digestHex(state.hostId) };
    case "ready":
      return {
        kind: "ready",
        hostIdDigest: await digestHex(state.hostId),
        displayName: state.displayName,
      };
    case "incompatible":
    case "unauthorized":
    case "unavailable":
      return { kind: state.kind, reason: state.reason };
  }
}

async function waitForState(
  predicate: (state: RemoteSessionBridgeState) => boolean,
  timeoutMs: number,
  label: string,
): Promise<RemoteSessionBridgeState> {
  const { promise, resolve, reject } = Promise.withResolvers<RemoteSessionBridgeState>();
  const started = Date.now();
  const check = () => {
    const current = bridge.getState();
    if (predicate(current)) {
      resolve(current);
      return;
    }
    if (Date.now() - started > timeoutMs) {
      reject(new Error(`Timed out waiting for bridge state (${label}); state=${current.kind}`));
      return;
    }
    setTimeout(check, 50);
  };
  check();
  return promise;
}

async function classify(run: () => Promise<{ readonly ok: true }>): Promise<DriverOperationResult> {
  try {
    await run();
    return { ok: true };
  } catch (error) {
    if (isRemoteProductMutationFailure(error)) {
      return { ok: false, category: error.category };
    }
    return { ok: false, category: "unexpected" };
  }
}

function failureCategory(error: unknown): DriverOperationFailure {
  if (typeof error === "object" && error !== null && "category" in error) {
    const category = (error as { category?: unknown }).category;
    if (typeof category === "string") return { ok: false, category };
  }
  return { ok: false, category: "unexpected" };
}

window.__evidenceA = {
  async init() {
    const url = new URL(window.location.href);
    const hadFragment = url.hash.length > 0;
    window.history.replaceState(null, "", `${url.pathname}${url.search}`);
    const fragmentCleared = window.location.hash === "";
    baseUrl = window.location.origin;
    pairingClient = createRemotePairingClient({
      baseUrl,
      fetch: globalThis.fetch,
      webBuildVersion: WEB_BUILD_VERSION,
      deviceKeyStore: createDefaultDeviceKeyStore(),
    });
    bridge = createRemoteSessionBridge({
      fetch: globalThis.fetch,
      webBuildVersion: WEB_BUILD_VERSION,
    });
    return {
      ok: true,
      originDigest: await digestHex(baseUrl),
      fragmentCleared,
      hadFragment,
      deviceKeyStorage: typeof indexedDB === "undefined" ? "memory" : "indexeddb",
    };
  },

  async hello() {
    const hello = await pairingClient.requestHostHello();
    return {
      productId: hello.productId,
      hostIdDigest: await digestHex(hello.hostId),
      displayName: hello.displayName,
      hostKeyFingerprintDigest: await digestHex(hello.hostKeyFingerprint),
      originDigest: await digestHex(baseUrl),
    };
  },

  async pair(input) {
    const hello = await pairingClient.requestHostHello();
    ticket = { ticketId: input.ticketId, ticketProof: input.ticketProof };
    const claimed = await pairingClient.claimPairing({
      ticket,
      deviceLabel: input.deviceLabel,
      hostHello: hello,
    });
    claim = claimed;
    return {
      status: "claimed" as const,
      ticketIdDigest: await digestHex(claimed.ticketId),
      hostIdDigest: await digestHex(claimed.hostId),
      deviceLabel: claimed.deviceLabel,
      deviceKeyFingerprintDigest: await digestHex(claimed.deviceKeyFingerprint),
      originDigest: await digestHex(claimed.origin),
      sourceClass: claimed.sourceClass,
      claimedAt: claimed.claimedAt,
      expiresAt: claimed.expiresAt,
    };
  },

  async pollApproval() {
    if (claim === undefined || ticket === undefined) {
      throw new Error("pair() must run before pollApproval().");
    }
    const status = await pairingClient.pollPairingStatus({ ticket, claim });
    if (status.kind === "approved") {
      approval = status.approval;
      return {
        status: "approved" as const,
        deviceIdDigest: await digestHex(status.approval.deviceId),
        credentialGeneration: status.approval.credentialGeneration,
        originDigest: await digestHex(status.approval.origin),
      };
    }
    if (status.kind === "pending") return { status: "pending" as const };
    return { status: "failed" as const, category: status.category };
  },

  async connect() {
    if (approval === undefined)
      throw new Error("pollApproval() must report approved before connect().");
    bridge.connect(approval);
    await waitForState(
      (state) =>
        state.kind === "ready" || state.kind === "unauthorized" || state.kind === "unavailable",
      30_000,
      "connect",
    );
    return redactState();
  },

  async state() {
    return redactState();
  },

  runChatSurface: () => classify(() => exerciseRemoteChatSurface({ bridge })),
  runChatMutation: () => classify(() => exerciseRemoteChatMutation({ bridge })),
  runWorkSurface: () => classify(() => exerciseRemoteWorkSurface({ bridge })),
  runWorkMutation: () => classify(() => exerciseRemoteWorkMutation({ bridge })),
  runCodeSurface: () => classify(() => exerciseRemoteCodeSurface({ bridge })),
  runCodeMutation: () => classify(() => exerciseRemoteCodeMutation({ bridge })),
  runProviderSurface: () => classify(() => exerciseRemoteProviderSurface({ bridge })),
  runSettingsSurface: () => classify(() => exerciseRemoteSettingsSurface({ bridge })),

  async probeSurfaceStatus() {
    const connection = bridge.connection();
    if (connection === undefined) return { status: 0 };
    const response = await connection.authenticatedFetch({
      method: "GET",
      path: "/api/chat/bootstrap",
    });
    return { status: response.status };
  },

  async disconnect() {
    bridge.disconnect();
    return redactState();
  },

  async reconnect() {
    bridge.reconnect();
    await waitForState(
      (state) =>
        state.kind === "ready" || state.kind === "unauthorized" || state.kind === "unavailable",
      30_000,
      "reconnect",
    );
    return redactState();
  },

  beginEvidenceMutation() {
    const connection = bridge.connection();
    if (connection === undefined)
      throw new Error("connect() must run before beginEvidenceMutation().");
    window.__evidenceAPendingMutation = connection
      .authenticatedFetch({
        method: "POST",
        path: "/api/chat/evidence/mutation",
        body: JSON.stringify({ kind: "evidence-mutation", payload: "opaque-bounded-payload" }),
      })
      .then(
        (response) => ({ status: "completed" as const, httpStatus: response.status }),
        (error: unknown) => ({
          status: "ambiguous" as const,
          error: error instanceof Error ? error.name : String(error),
        }),
      );
    return { status: "in-flight" };
  },

  async finishEvidenceMutation() {
    const pending = window.__evidenceAPendingMutation;
    if (pending === undefined) throw new Error("beginEvidenceMutation() must run first.");
    return pending;
  },

  async readStreamToEnd() {
    const connection = bridge.connection();
    if (connection === undefined) throw new Error("connect() must run before readStreamToEnd().");
    try {
      const response = await connection.authenticatedFetch({
        method: "GET",
        path: "/api/chat/evidence/stream",
      });
      const reader = response.body?.getReader();
      if (reader === undefined) return { status: "completed" as const, frames: 0 };
      let frames = 0;
      for (;;) {
        const { done } = await reader.read();
        if (done) break;
        frames += 1;
      }
      return { status: "completed" as const, frames };
    } catch (error) {
      return {
        status: "aborted" as const,
        error: error instanceof Error ? error.name : String(error),
      };
    }
  },

  async lookupReceipt(commandId) {
    const connection = bridge.connection();
    if (connection === undefined) return { kind: "error", category: "offline" };
    const response = await connection.authenticatedFetch({
      method: "GET",
      path: `/api/chat/evidence/commands/${encodeURIComponent(commandId)}`,
    });
    if (!response.ok) {
      return { kind: "error", category: "rejected", status: response.status };
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: "error", category: "unavailable", status: response.status };
    }
    if (
      typeof body !== "object" ||
      body === null ||
      !("kind" in body) ||
      typeof body.kind !== "string" ||
      !("commandId" in body) ||
      typeof body.commandId !== "string"
    ) {
      return { kind: "error", category: "unavailable", status: response.status };
    }
    const kind = body.kind;
    const result: {
      kind: "applied" | "pending" | "failed" | "not-found" | "ambiguous";
      commandIdDigest: string;
      operationKind?: string;
      reasonCode?: string;
    } = {
      kind: kind as "applied" | "pending" | "failed" | "not-found" | "ambiguous",
      commandIdDigest: await digestHex(body.commandId),
    };
    if ("operationKind" in body && typeof body.operationKind === "string") {
      result.operationKind = body.operationKind;
    }
    if ("reasonCode" in body && typeof body.reasonCode === "string") {
      result.reasonCode = body.reasonCode;
    }
    return result;
  },

  async rotateDeviceKey() {
    const connection = bridge.connection();
    if (connection === undefined) return { ok: false, category: "offline" };
    const identity = connection.deviceIdentity();
    if (identity === undefined) return { ok: false, category: "offline" };
    const keyPair = (await crypto.subtle.generateKey(
      KEY_ALGORITHM,
      false,
      KEY_USAGES,
    )) as CryptoKeyPair;
    const newDevicePublicKey = await exportPublicKeyPem(keyPair.publicKey);
    const newDeviceKeyFingerprint = await publicKeyFingerprint(keyPair.publicKey);
    const payload = buildRemoteKeyRotationProofPayload({
      hostId: identity.hostId,
      deviceId: identity.deviceId,
      credentialGeneration: identity.credentialGeneration,
      newDeviceKeyFingerprint,
      newDevicePublicKey,
    });
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      keyPair.privateKey,
      new TextEncoder().encode(payload),
    );
    const newKeyProof = toBase64Url(new Uint8Array(signature));
    const response = await connection.authenticatedFetch({
      method: "POST",
      path: "/api/remote/auth/rotate-key",
      body: JSON.stringify({ newDeviceKeyFingerprint, newDevicePublicKey, newKeyProof }),
    });
    if (!response.ok) {
      return { ok: false, category: "rejected", status: response.status };
    }
    return { ok: true, newFingerprintDigest: await digestHex(newDeviceKeyFingerprint) };
  },

  async ownDevice() {
    try {
      const metadata = await fetchRemoteOwnDeviceMetadata({ bridge });
      return {
        ok: true,
        deviceIdDigest: await digestHex(metadata.deviceId),
        originDigest: await digestHex(metadata.origin),
        credentialGeneration: metadata.credentialGeneration,
        state: metadata.state,
      };
    } catch (error) {
      return failureCategory(error);
    }
  },

  async signOut() {
    try {
      await remoteSignOut({ bridge });
    } catch {
      // Sign-out failure is still evidence; the bridge may already be idle.
    }
    return redactState();
  },

  async revokeSelf() {
    try {
      await remoteRevokeSelf({ bridge });
    } catch {
      // Revoke-self failure is still evidence; the bridge may already be idle.
    }
    return redactState();
  },

  async clearStorage() {
    const databases = await indexedDB.databases();
    for (const database of databases) {
      const name = database.name ?? "";
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const outcome = await new Promise<"deleted" | "blocked" | "error">((resolve) => {
          const request = indexedDB.deleteDatabase(name);
          request.onsuccess = () => resolve("deleted");
          request.onblocked = () => resolve("blocked");
          request.onerror = () => resolve("error");
        });
        if (outcome === "deleted") break;
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 300));
      }
    }
    return { ok: true };
  },

  async storageState() {
    let deviceKeyRecords = 0;
    try {
      deviceKeyRecords = await new Promise<number>((resolve) => {
        const request = indexedDB.open(DEVICE_KEY_DB_NAME, 1);
        request.onsuccess = () => {
          const db = request.result;
          try {
            const countRequest = db.transaction("keys", "readonly").objectStore("keys").count();
            countRequest.onsuccess = () => resolve(countRequest.result);
            countRequest.onerror = () => resolve(0);
          } catch {
            resolve(0);
          }
        };
        request.onerror = () => resolve(0);
      });
    } catch {
      deviceKeyRecords = 0;
    }
    return { deviceKeyRecords };
  },
};
