import { decodeHostHelloV1, type StableHostId } from "@octant/contracts/remote-access";
import {
  createDefaultDeviceKeyStore,
  type RemoteDeviceKeyPair,
  type RemoteDeviceKeyStore,
  type RemotePairingApproval,
} from "./remotePairingClient";
import { bindFetchPort } from "./bindFetchPort";
import { createPairingDeviceKeyAdapter } from "./pairingDeviceKeyAdapter";
import {
  createRemoteConnection,
  RemoteConnectionError,
  type RemoteConnection,
  type RemoteConnectionState,
} from "./remoteConnection";

export type RemoteSessionBridgeState =
  | { readonly kind: "idle" }
  | { readonly kind: "connecting"; readonly hostId: string; readonly displayName: string }
  | { readonly kind: "negotiating"; readonly hostId: string; readonly displayName: string }
  | { readonly kind: "authenticating"; readonly hostId: string; readonly displayName: string }
  | { readonly kind: "ready"; readonly hostId: string; readonly displayName: string }
  | { readonly kind: "stale"; readonly hostId: string; readonly displayName: string }
  | { readonly kind: "reconnecting"; readonly hostId: string; readonly displayName: string }
  | {
      readonly kind: "incompatible";
      readonly reason: string;
      readonly hostId?: string;
      readonly displayName?: string;
    }
  | {
      readonly kind: "unauthorized";
      readonly reason: string;
      readonly reasonCode?: "expired" | "revoked" | "lost-key" | "host-changed";
      readonly hostId?: string;
      readonly displayName?: string;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: string;
      readonly hostId?: string;
      readonly displayName?: string;
    };

export interface RemoteSessionBridgeOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly webBuildVersion?: string;
  readonly deviceKeyStore?: RemoteDeviceKeyStore;
}

/**
 * A replacement device key that exists locally but that the host has not
 * accepted yet.
 *
 * Rotation is irreversible on the host, so the replacement key is written to
 * origin-scoped storage *before* the host is asked to accept it: a storage
 * failure must be discovered while the old registration is still the valid one.
 * The staged record deliberately carries no approved metadata, so
 * `findByOrigin` keeps resolving the old registration until `adopt` runs — an
 * abandoned staging leaves the device authenticating exactly as before.
 *
 * The staged private key never leaves the store; callers prove possession
 * through `sign`.
 */
export interface StagedDeviceKeyRotation {
  readonly publicKeyPem: string;
  readonly fingerprint: string;
  /** Sign a rotation transcript with the staged key (base64url ieee-p1363). */
  readonly sign: (payload: string) => Promise<string>;
  /**
   * Make the staged key this device's registration after the host accepted it.
   * The caller supplies the generation the host advanced to, because only the
   * caller saw the host's answer.
   */
  readonly adopt: (input: { readonly credentialGeneration: number }) => Promise<void>;
  /** Drop the staged key when the host did not accept it. */
  readonly discard: () => Promise<void>;
}

export interface RemoteSessionBridge {
  readonly getState: () => RemoteSessionBridgeState;
  readonly subscribe: (listener: (state: RemoteSessionBridgeState) => void) => () => void;
  readonly connect: (approval: RemotePairingApproval) => void;
  /** Rehydrate a paired device from origin-scoped IndexedDB metadata. */
  readonly resume: (origin: string) => void;
  /** Remove the persisted device registration after an authenticated self-revoke. */
  readonly forgetDeviceKey: () => Promise<void>;
  /**
   * Generate and stage a replacement device key for an authenticated key
   * rotation. The bridge owns the key store and the active key id, so it is the
   * only place that can swap a registration without losing the device.
   */
  readonly stageDeviceKeyRotation: () => Promise<StagedDeviceKeyRotation>;
  readonly reconnect: () => void;
  readonly disconnect: () => void;
  readonly connection: () => RemoteConnection | undefined;
}

const KEY_ALGORITHM: EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };
const KEY_USAGES: KeyUsage[] = ["sign", "verify"];

const DEFAULT_WEB_BUILD_VERSION = "0.1.0";

export function createRemoteSessionBridge(
  options: RemoteSessionBridgeOptions = {},
): RemoteSessionBridge {
  const fetch = bindFetchPort(options.fetch ?? globalThis.fetch);
  const webBuildVersion = options.webBuildVersion ?? DEFAULT_WEB_BUILD_VERSION;
  const deviceKeyStore = options.deviceKeyStore ?? createDefaultDeviceKeyStore();

  let state: RemoteSessionBridgeState = { kind: "idle" };
  let activeConnection: RemoteConnection | undefined;
  let activeDeviceKeyId: string | undefined;
  // Origin-scoped facts a staged rotation must reuse verbatim: a replacement
  // key belongs to the same origin, host, and device or it is a different
  // registration entirely.
  let activeRegistration:
    | {
        readonly origin: string;
        readonly hostId: StableHostId;
        readonly deviceId: string;
      }
    | undefined;
  let hostFacts:
    | { readonly hostId: string; readonly displayName: string; readonly hostKeyFingerprint: string }
    | undefined;
  const listeners = new Set<(state: RemoteSessionBridgeState) => void>();

  const emit = (next: RemoteSessionBridgeState) => {
    state = next;
    for (const listener of listeners) {
      listener(next);
    }
  };

  const factsFromHello = (hello: {
    hostId: string;
    displayName: string;
    hostKeyFingerprint: string;
  }) => ({
    hostId: hello.hostId,
    displayName: hello.displayName,
    hostKeyFingerprint: hello.hostKeyFingerprint,
  });

  const mapConnectionState = (
    connectionState: RemoteConnectionState,
    facts: { hostId: string; displayName: string },
  ): RemoteSessionBridgeState => {
    switch (connectionState) {
      case "connecting":
        return { kind: "connecting", ...facts };
      case "negotiating":
        return { kind: "negotiating", ...facts };
      case "authenticating":
        return { kind: "authenticating", ...facts };
      case "ready":
        return { kind: "ready", ...facts };
      case "stale":
        return { kind: "stale", ...facts };
      case "reconnecting":
        return { kind: "reconnecting", ...facts };
      case "incompatible":
        return { kind: "incompatible", reason: "Remote protocol is incompatible.", ...facts };
      case "unauthorized":
        return { kind: "unauthorized", reason: "Remote device is not authorized.", ...facts };
      case "unavailable":
        return { kind: "unavailable", reason: "Remote host is unavailable.", ...facts };
      case "disconnected":
        return { kind: "idle" };
    }
  };

  const failFromError = (
    error: unknown,
    facts?: { hostId: string; displayName: string },
  ): RemoteSessionBridgeState => {
    if (error instanceof RemoteConnectionError) {
      const partial = facts === undefined ? {} : facts;
      switch (error.category) {
        case "incompatible":
          return { kind: "incompatible", reason: error.message, ...partial };
        case "unauthorized":
          return {
            kind: "unauthorized",
            reason: error.message,
            ...(error.reasonCode === undefined ? {} : { reasonCode: error.reasonCode }),
            ...partial,
          };
        case "host-changed":
          return {
            kind: "unauthorized",
            reason: error.message,
            reasonCode: "host-changed",
            ...partial,
          };
        case "unavailable":
          return { kind: "unavailable", reason: error.message, ...partial };
        default:
          return { kind: "unavailable", reason: error.message, ...partial };
      }
    }
    const partial = facts === undefined ? {} : facts;
    return { kind: "unavailable", reason: "Remote host is unavailable.", ...partial };
  };

  const establishConnection = async (
    approval: RemotePairingApproval,
    expectedIdentity?: { readonly hostId: string; readonly hostKeyFingerprint: string },
  ): Promise<void> => {
    const helloResponse = await fetch(new URL("/api/remote/hello", approval.origin).toString(), {
      method: "GET",
    });
    if (!helloResponse.ok) {
      throw new RemoteConnectionError("unavailable", "Remote host hello failed.");
    }
    const hello = decodeHostHelloV1(await helloResponse.json());
    if (
      expectedIdentity !== undefined &&
      (hello.hostId !== expectedIdentity.hostId ||
        hello.hostKeyFingerprint !== expectedIdentity.hostKeyFingerprint)
    ) {
      throw new RemoteConnectionError(
        "host-changed",
        "Host identity or key fingerprint changed at the same endpoint.",
      );
    }
    const facts = factsFromHello(hello);
    hostFacts = facts;

    const deviceKey = createPairingDeviceKeyAdapter(deviceKeyStore, approval.deviceKeyId);
    const connection = createRemoteConnection({
      origin: approval.origin,
      webBuildVersion,
      fetch,
      deviceKey,
      knownDevice: {
        hostId: facts.hostId,
        deviceId: approval.deviceId,
        credentialGeneration: approval.credentialGeneration,
        hostKeyFingerprint: facts.hostKeyFingerprint,
      },
    });

    connection.onStateChange((connectionState) => {
      if (connectionState === "disconnected") return;
      emit(mapConnectionState(connectionState, facts));
    });

    activeConnection = connection;
    emit(mapConnectionState(connection.state(), facts));
    await connection.connect();
    emit(mapConnectionState(connection.state(), facts));
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    connect: (approval) => {
      activeDeviceKeyId = approval.deviceKeyId;
      activeRegistration = {
        origin: approval.origin,
        hostId: approval.hostId,
        deviceId: approval.deviceId,
      };
      emit({
        kind: "connecting",
        hostId: approval.hostId,
        displayName: "This Mac",
      });
      void establishConnection(approval).catch((error) => {
        activeConnection = undefined;
        if (error instanceof RemoteConnectionError && shouldRemoveDeviceKey(error)) {
          void deviceKeyStore.remove(approval.deviceKeyId).catch(() => undefined);
        }
        emit(failFromError(error, hostFacts));
      });
    },
    resume: (origin) => {
      void (async () => {
        let metadata: Awaited<ReturnType<RemoteDeviceKeyStore["findByOrigin"]>>;
        try {
          metadata = await deviceKeyStore.findByOrigin(origin);
        } catch {
          emit({
            kind: "unavailable",
            reason: "Remote device storage is temporarily unavailable.",
          });
          return;
        }
        if (metadata === undefined) {
          emit({ kind: "idle" });
          return;
        }
        let keyPair: Awaited<ReturnType<RemoteDeviceKeyStore["get"]>>;
        try {
          keyPair = await deviceKeyStore.get(metadata.keyId);
        } catch {
          emit({
            kind: "unavailable",
            reason: "Remote device storage is temporarily unavailable.",
            hostId: metadata.hostId,
          });
          return;
        }
        if (keyPair === undefined) {
          await deviceKeyStore.remove(metadata.keyId).catch(() => undefined);
          emit({
            kind: "unauthorized",
            reason: "This browser lost its device key; pair this browser again.",
            reasonCode: "lost-key",
            hostId: metadata.hostId,
          });
          return;
        }
        activeDeviceKeyId = metadata.keyId;
        activeRegistration = {
          origin: metadata.origin,
          hostId: metadata.hostId,
          deviceId: metadata.deviceId,
        };
        emit({ kind: "connecting", hostId: metadata.hostId, displayName: "This Mac" });
        try {
          await establishConnection(
            {
              ticketId: "00000000-0000-4000-8000-000000000000",
              hostId: metadata.hostId,
              deviceId: metadata.deviceId,
              credentialGeneration: metadata.credentialGeneration,
              deviceKeyId: metadata.keyId,
              origin: metadata.origin,
            },
            metadata,
          );
        } catch (error) {
          if (error instanceof RemoteConnectionError && shouldRemoveDeviceKey(error)) {
            await deviceKeyStore.remove(metadata.keyId).catch(() => undefined);
          }
          throw error;
        }
      })().catch((error) => {
        activeConnection = undefined;
        emit(failFromError(error, hostFacts));
      });
    },
    reconnect: () => {
      const connection = activeConnection;
      const facts = hostFacts;
      if (connection === undefined || facts === undefined) {
        emit({
          kind: "unauthorized",
          reason: "No remote session to reconnect.",
        });
        return;
      }
      emit({ kind: "reconnecting", ...facts });
      void connection.reconnect().then(
        () => emit(mapConnectionState(connection.state(), facts)),
        (error) => {
          activeConnection = undefined;
          emit(failFromError(error, facts));
        },
      );
    },
    forgetDeviceKey: async () => {
      const keyId = activeDeviceKeyId;
      if (keyId === undefined) return;
      await deviceKeyStore.remove(keyId);
      activeDeviceKeyId = undefined;
      activeRegistration = undefined;
    },
    stageDeviceKeyRotation: async () => {
      const supersededKeyId = activeDeviceKeyId;
      const registration = activeRegistration;
      const facts = hostFacts;
      if (supersededKeyId === undefined || registration === undefined || facts === undefined) {
        throw new Error("No paired device registration is available to rotate.");
      }
      // Platform stores that persist PKCS8 outside WebCrypto need extractable
      // private keys; browser IndexedDB stores keep them non-extractable.
      const extractable = deviceKeyStore.requiresExtractablePrivateKeys === true;
      const keyPair = (await crypto.subtle.generateKey(
        KEY_ALGORITHM,
        extractable,
        KEY_USAGES,
      )) as RemoteDeviceKeyPair;
      const stagedKeyId = await deviceKeyStore.set(keyPair, registration);
      const stagedKey = createPairingDeviceKeyAdapter(deviceKeyStore, stagedKeyId);
      let derived: Awaited<ReturnType<typeof stagedKey.loadOrCreate>>;
      try {
        derived = await stagedKey.loadOrCreate();
      } catch (error) {
        await deviceKeyStore.remove(stagedKeyId).catch(() => undefined);
        throw error;
      }
      return {
        publicKeyPem: derived.publicKeyPem,
        fingerprint: derived.fingerprint,
        sign: (payload) => stagedKey.sign(payload),
        adopt: async ({ credentialGeneration }) => {
          await deviceKeyStore.updateMetadata(stagedKeyId, {
            deviceId: registration.deviceId,
            credentialGeneration,
            hostKeyFingerprint: facts.hostKeyFingerprint,
          });
          activeDeviceKeyId = stagedKeyId;
          // Only now is the superseded record redundant. Removing it earlier
          // would leave the origin with no resolvable registration if the
          // metadata write failed, and its failure here is not worth losing a
          // rotation the host already committed.
          await deviceKeyStore.remove(supersededKeyId).catch(() => undefined);
        },
        discard: async () => {
          await deviceKeyStore.remove(stagedKeyId);
        },
      };
    },
    disconnect: () => {
      if (activeConnection !== undefined) {
        activeConnection.disconnect();
        activeConnection = undefined;
      }
      hostFacts = undefined;
      activeRegistration = undefined;
      emit({ kind: "idle" });
    },
    connection: () => activeConnection,
  };
}

function shouldRemoveDeviceKey(error: RemoteConnectionError): boolean {
  if (error.category === "host-changed") return true;
  // A generic 401 may be a transient/ambiguous session rejection (for example
  // a browser waking after a challenge expired). Retain the key so resume can
  // retry; only explicit lifecycle reasons are terminal for this device.
  return error.category === "unauthorized" && error.reasonCode !== undefined;
}
