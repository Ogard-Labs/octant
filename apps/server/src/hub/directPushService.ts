// A hub that sends notifications directly: its switch, the Apple environment,
// and the person's Apple and Google credentials. Everything here is a person's
// act in a window on the hub; the gateway it feeds (`directPushGateway.ts`)
// answers a phone and a spoke but changes none of this.
//
// The credentials go to the host credential store, in a namespace of their own,
// and come out only to sign a platform request. They are never journaled,
// logged, or returned: status says `stored` or `not-stored`, and the journal
// says which platform changed.

import { randomBytes } from "node:crypto";
import {
  type AuditActingPrincipal,
  type HubDirectPushCredentialRequest,
  type HubDirectPushEnvironment,
  type HubDirectPushStatus,
  type HubMembershipChangedPayload,
  type RemotePushPlatform,
} from "@octant/contracts";
import type { ProviderCredentialStore } from "../providers/credentialBrokerClient";
import {
  googleCredentialFromServiceAccount,
  isAppleSigningKey,
  parseAppleCredential,
  parseGoogleCredential,
  type DirectPushCredentialSource,
} from "./directPushSenders";
import type { HubStatePort } from "./hubStateStore";

/** The credential store entries this feature owns. */
export const DIRECT_PUSH_CREDENTIAL_REFS = {
  apple: "0e7a51c4-2b9d-4f0e-8a63-5c1d9b7e3f12",
  google: "7d3c88a1-6e4f-4b52-9f0a-1a2b3c4d5e6f",
  sealingKey: "b25f90e6-1c7a-4d38-a4e9-8f6d2c0b7a31",
} as const;

export type DirectPushChangeOutcome =
  | { readonly status: "changed" }
  | {
      readonly status: "refused";
      readonly kind: "hub-role-off" | "invalid-credential" | "credential-store-unavailable";
    };

export interface DirectPushServiceOptions {
  readonly state: HubStatePort;
  /** The credential store's push namespace, or undefined when this host has none. */
  readonly credentials: ProviderCredentialStore | undefined;
  readonly record: (change: HubMembershipChangedPayload) => void;
}

export class DirectPushService {
  readonly #options: DirectPushServiceOptions;
  #sealingKey: Promise<Buffer | undefined> | undefined;

  constructor(options: DirectPushServiceOptions) {
    this.#options = options;
  }

  /**
   * Whether the gateway answers. It needs the hub role on as well, so a host
   * that stopped being a hub stops sending for anyone.
   */
  enabled(): boolean {
    const hub = this.#options.state.load().hub;
    return hub?.enabled === true && hub.directPush?.enabled === true;
  }

  environment(): HubDirectPushEnvironment {
    return this.#options.state.load().hub?.directPush?.environment ?? "production";
  }

  async status(): Promise<HubDirectPushStatus> {
    return {
      enabled: this.enabled(),
      environment: this.environment(),
      ios: (await this.#held(DIRECT_PUSH_CREDENTIAL_REFS.apple)) ? "stored" : "not-stored",
      android: (await this.#held(DIRECT_PUSH_CREDENTIAL_REFS.google)) ? "stored" : "not-stored",
    };
  }

  setEnabled(enabled: boolean, principal: AuditActingPrincipal): DirectPushChangeOutcome {
    const state = this.#options.state.load();
    const hub = state.hub;
    if (hub?.enabled !== true) return { status: "refused", kind: "hub-role-off" };
    this.#options.state.save({
      ...state,
      hub: { ...hub, directPush: { enabled, environment: this.environment() } },
    });
    this.#options.record({ change: "direct-push-switch-changed", actingPrincipal: principal });
    return { status: "changed" };
  }

  setEnvironment(
    environment: HubDirectPushEnvironment,
    principal: AuditActingPrincipal,
  ): DirectPushChangeOutcome {
    const state = this.#options.state.load();
    const hub = state.hub;
    if (hub?.enabled !== true) return { status: "refused", kind: "hub-role-off" };
    this.#options.state.save({
      ...state,
      hub: { ...hub, directPush: { enabled: hub.directPush?.enabled === true, environment } },
    });
    this.#options.record({
      change: "direct-push-environment-changed",
      actingPrincipal: principal,
    });
    return { status: "changed" };
  }

  /** Stores a platform's credential, replacing the one held. Nothing is kept of a credential that does not parse. */
  async storeCredential(
    request: HubDirectPushCredentialRequest,
    principal: AuditActingPrincipal,
  ): Promise<DirectPushChangeOutcome> {
    const store = this.#options.credentials;
    if (store === undefined) return { status: "refused", kind: "credential-store-unavailable" };
    let ref: string;
    let stored: string;
    if (request.platform === "ios") {
      const privateKey = request.privateKey.trim();
      if (!isAppleSigningKey(privateKey)) return { status: "refused", kind: "invalid-credential" };
      ref = DIRECT_PUSH_CREDENTIAL_REFS.apple;
      stored = JSON.stringify({
        keyId: request.keyId,
        teamId: request.teamId,
        bundleId: request.bundleId,
        privateKey: `${privateKey}\n`,
      });
    } else {
      const google = googleCredentialFromServiceAccount(request.serviceAccount);
      if (google === undefined) return { status: "refused", kind: "invalid-credential" };
      ref = DIRECT_PUSH_CREDENTIAL_REFS.google;
      stored = JSON.stringify(google);
    }
    try {
      await store.set(ref, stored);
    } catch {
      return { status: "refused", kind: "credential-store-unavailable" };
    }
    this.#options.record({
      change: "direct-push-credential-changed",
      actingPrincipal: principal,
      pushPlatform: request.platform,
    });
    return { status: "changed" };
  }

  async removeCredential(
    platform: RemotePushPlatform,
    principal: AuditActingPrincipal,
  ): Promise<DirectPushChangeOutcome> {
    const store = this.#options.credentials;
    if (store === undefined) return { status: "refused", kind: "credential-store-unavailable" };
    try {
      await store.delete(
        platform === "ios" ? DIRECT_PUSH_CREDENTIAL_REFS.apple : DIRECT_PUSH_CREDENTIAL_REFS.google,
      );
    } catch {
      return { status: "refused", kind: "credential-store-unavailable" };
    }
    this.#options.record({
      change: "direct-push-credential-changed",
      actingPrincipal: principal,
      pushPlatform: platform,
    });
    return { status: "changed" };
  }

  /** The credentials the senders sign with, read from the store at each send. */
  credentialSource(): DirectPushCredentialSource {
    const store = this.#options.credentials;
    const read = async (ref: string): Promise<string | undefined> => {
      if (store === undefined) return undefined;
      try {
        return (await store.has(ref)) ? await store.resolve(ref) : undefined;
      } catch {
        return undefined;
      }
    };
    return {
      apple: async () => {
        const text = await read(DIRECT_PUSH_CREDENTIAL_REFS.apple);
        return text === undefined ? undefined : parseAppleCredential(text);
      },
      google: async () => {
        const text = await read(DIRECT_PUSH_CREDENTIAL_REFS.google);
        return text === undefined ? undefined : parseGoogleCredential(text);
      },
    };
  }

  async holdsCredential(platform: RemotePushPlatform): Promise<boolean> {
    return this.#held(
      platform === "ios" ? DIRECT_PUSH_CREDENTIAL_REFS.apple : DIRECT_PUSH_CREDENTIAL_REFS.google,
    );
  }

  /**
   * The key capabilities are sealed under, made the first time one is needed.
   * Removing a platform credential leaves it, so capabilities already given to
   * phones keep opening.
   */
  sealingKey(): Promise<Buffer | undefined> {
    this.#sealingKey ??= this.#loadSealingKey().then((key) => {
      // A store that failed once is asked again next time, not remembered as empty.
      if (key === undefined) this.#sealingKey = undefined;
      return key;
    });
    return this.#sealingKey;
  }

  async #loadSealingKey(): Promise<Buffer | undefined> {
    const store = this.#options.credentials;
    if (store === undefined) return undefined;
    try {
      const ref = DIRECT_PUSH_CREDENTIAL_REFS.sealingKey;
      if (!(await store.has(ref))) await store.set(ref, randomBytes(32).toString("base64url"));
      const key = Buffer.from(await store.resolve(ref), "base64url");
      return key.length === 32 ? key : undefined;
    } catch {
      return undefined;
    }
  }

  async #held(ref: string): Promise<boolean> {
    const store = this.#options.credentials;
    if (store === undefined) return false;
    try {
      return await store.has(ref);
    } catch {
      return false;
    }
  }
}
