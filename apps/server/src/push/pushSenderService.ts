// Direct push sender configuration on ANY Octant host (not only a hub): its
// enable switch, the Apple environment, and the signing account's Apple and
// Google credentials. Everything here is a person's act in a local window on
// this host (`/api/desktop/push-sender*`).
//
// The switch and Apple environment live in `remote/push-sender-setting.json`
// (owner-only 0600, off by default). The credentials live in the host
// credential store under the same `DIRECT_PUSH_CREDENTIAL_REFS` a hub used, so
// existing hubs keep their stored credentials without re-entry. Credentials are
// never journaled, logged, or returned: status says `stored` or `not-stored`,
// and the journal records `host.push-sender-changed@1`.

import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Schema } from "effect";
import {
  HOST_PUSH_SENDER_EVENT_NAMES,
  HubDirectPushEnvironment,
  decodeHostPushSenderChangedV1,
  type AuditActingPrincipal,
  type HostPushSenderChangeKind,
  type HubDirectPushCredentialRequest,
  type HubDirectPushStatus,
  type RemotePushPlatform,
  type RemotePushStatusV1,
} from "@octant/contracts";
import type { Journal } from "../persistence/journal";
import type { ProviderCredentialStore } from "../providers/credentialBrokerClient";
import { writeOwnerOnly } from "../remote/selfMadeListenerCertificate";
import {
  googleCredentialFromServiceAccount,
  isAppleSigningKey,
  parseAppleCredential,
  parseGoogleCredential,
  type DirectPushCredentialSource,
} from "./directPushSenders";

/** The setting file's path under the data directory; data removal names it too. */
export const PUSH_SENDER_SETTING_FILE = join("remote", "push-sender-setting.json");

/** Single host-wide journal aggregate for push-sender configuration changes. */
export const PUSH_SENDER_AGGREGATE_TYPE = "host-push-sender";
const PUSH_SENDER_AGGREGATE_ID = "00000000-0000-4000-8000-0000000000d1";

/**
 * The credential store entries this feature owns. Kept identical to the former
 * hub-only refs so an existing hub's stored Apple/Google credentials carry over.
 */
export const DIRECT_PUSH_CREDENTIAL_REFS = {
  apple: "0e7a51c4-2b9d-4f0e-8a63-5c1d9b7e3f12",
  google: "7d3c88a1-6e4f-4b52-9f0a-1a2b3c4d5e6f",
} as const;

export type PushSenderChangeOutcome =
  | { readonly status: "changed" }
  | {
      readonly status: "refused";
      readonly kind: "invalid-credential" | "credential-store-unavailable" | "settings-unavailable";
    };

export interface PushSenderSetting {
  readonly enabled: boolean;
  readonly environment: HubDirectPushEnvironment;
}

const StoredPushSenderSetting = Schema.Struct({
  enabled: Schema.Boolean,
  environment: HubDirectPushEnvironment,
}).annotations({ parseOptions: { onExcessProperty: "error" } });
const decodeStoredPushSenderSetting = Schema.decodeUnknownSync(
  Schema.parseJson(StoredPushSenderSetting),
);

const DEFAULT_SETTING: PushSenderSetting = {
  enabled: false,
  environment: "production",
};

export interface PushSenderServiceOptions {
  readonly dataDirectory: string;
  /** The credential store's push namespace, or undefined when this host has none. */
  readonly credentials: ProviderCredentialStore | undefined;
  readonly journal?: Pick<Journal, "append" | "aggregateVersions">;
  readonly uuid?: () => string;
  readonly clock?: () => string;
  readonly hostActorId?: string;
  /** Optional legacy hub-state directPush setting carried over when the new setting file is absent. */
  readonly legacySetting?: () => PushSenderSetting | undefined;
  /** Notified whenever a credential is stored or removed so the secret-check cache refreshes. */
  readonly onCredentialChanged?: () => void;
}

export class PushSenderService {
  readonly #directory: string;
  readonly #path: string;
  readonly #credentials: ProviderCredentialStore | undefined;
  readonly #journal: PushSenderServiceOptions["journal"];
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #hostActorId: string;
  readonly #onCredentialChanged: (() => void) | undefined;
  #setting: PushSenderSetting;
  #storedPlatforms: { ios: boolean; android: boolean } = { ios: false, android: false };

  constructor(options: PushSenderServiceOptions) {
    this.#directory = join(options.dataDirectory, "remote");
    this.#path = join(options.dataDirectory, PUSH_SENDER_SETTING_FILE);
    this.#credentials = options.credentials;
    this.#journal = options.journal;
    this.#uuid = options.uuid ?? (() => crypto.randomUUID());
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#hostActorId = options.hostActorId ?? "local-user";
    this.#onCredentialChanged = options.onCredentialChanged;
    this.#setting = loadSetting(this.#path) ?? options.legacySetting?.() ?? DEFAULT_SETTING;
  }

  /** Refreshes the cached platform-credential presence flags from the credential store. */
  async refreshCredentialPresence(): Promise<void> {
    const [ios, android] = await Promise.all([
      this.#held(DIRECT_PUSH_CREDENTIAL_REFS.apple),
      this.#held(DIRECT_PUSH_CREDENTIAL_REFS.google),
    ]);
    this.#storedPlatforms = { ios, android };
  }

  enabled(): boolean {
    return this.#setting.enabled;
  }

  environment(): HubDirectPushEnvironment {
    return this.#setting.environment;
  }

  /**
   * Synchronous best-known credential presence for `providerDelivery()`.
   * Always updated on startup (`refreshCredentialPresence`), `status()`,
   * `storeCredential()`, and `removeCredential()`.
   */
  hasAnyCredentialSync(): boolean {
    return this.#storedPlatforms.ios || this.#storedPlatforms.android;
  }

  async status(): Promise<HubDirectPushStatus> {
    await this.refreshCredentialPresence();
    return {
      enabled: this.#setting.enabled,
      environment: this.#setting.environment,
      ios: this.#storedPlatforms.ios ? "stored" : "not-stored",
      android: this.#storedPlatforms.android ? "stored" : "not-stored",
    };
  }

  /**
   * Honest availability for `GET /api/remote/auth/push-token`.
   * If this host is a spoke whose hub grant ticks Push, the hub sends for it.
   * Otherwise this host sends directly only when switched on and holding at
   * least one platform credential.
   */
  async pushStatusForPhone(spokePushGranted: boolean): Promise<RemotePushStatusV1> {
    if (spokePushGranted) {
      return { status: "available" };
    }
    if (!this.#setting.enabled) {
      return { status: "unavailable", reason: "off" };
    }
    await this.refreshCredentialPresence();
    if (!this.#storedPlatforms.ios && !this.#storedPlatforms.android) {
      return { status: "unavailable", reason: "no-credentials" };
    }
    return {
      status: "available",
      platforms: {
        ios: this.#storedPlatforms.ios,
        android: this.#storedPlatforms.android,
      },
    };
  }

  setEnabled(enabled: boolean, principal: AuditActingPrincipal): PushSenderChangeOutcome {
    const next: PushSenderSetting = { enabled, environment: this.#setting.environment };
    if (!this.#save(next)) return { status: "refused", kind: "settings-unavailable" };
    this.#setting = next;
    this.#journalChange("switch-changed", undefined, principal);
    return { status: "changed" };
  }

  setEnvironment(
    environment: HubDirectPushEnvironment,
    principal: AuditActingPrincipal,
  ): PushSenderChangeOutcome {
    const next: PushSenderSetting = { enabled: this.#setting.enabled, environment };
    if (!this.#save(next)) return { status: "refused", kind: "settings-unavailable" };
    this.#setting = next;
    this.#journalChange("environment-changed", undefined, principal);
    return { status: "changed" };
  }

  /** Stores a platform's credential, replacing the one held. Nothing is kept of a credential that does not parse. */
  async storeCredential(
    request: HubDirectPushCredentialRequest,
    principal: AuditActingPrincipal,
  ): Promise<PushSenderChangeOutcome> {
    const store = this.#credentials;
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
    this.#storedPlatforms = {
      ...this.#storedPlatforms,
      [request.platform]: true,
    };
    this.#onCredentialChanged?.();
    this.#journalChange("credential-changed", request.platform, principal);
    return { status: "changed" };
  }

  async removeCredential(
    platform: RemotePushPlatform,
    principal: AuditActingPrincipal,
  ): Promise<PushSenderChangeOutcome> {
    const store = this.#credentials;
    if (store === undefined) return { status: "refused", kind: "credential-store-unavailable" };
    try {
      await store.delete(
        platform === "ios" ? DIRECT_PUSH_CREDENTIAL_REFS.apple : DIRECT_PUSH_CREDENTIAL_REFS.google,
      );
    } catch {
      return { status: "refused", kind: "credential-store-unavailable" };
    }
    this.#storedPlatforms = {
      ...this.#storedPlatforms,
      [platform]: false,
    };
    this.#onCredentialChanged?.();
    this.#journalChange("credential-removed", platform, principal);
    return { status: "changed" };
  }

  /** The credentials the senders sign with, read from the store at each send. */
  credentialSource(): DirectPushCredentialSource {
    const store = this.#credentials;
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
    const held = await this.#held(
      platform === "ios" ? DIRECT_PUSH_CREDENTIAL_REFS.apple : DIRECT_PUSH_CREDENTIAL_REFS.google,
    );
    this.#storedPlatforms = { ...this.#storedPlatforms, [platform]: held };
    return held;
  }

  async #held(ref: string): Promise<boolean> {
    const store = this.#credentials;
    if (store === undefined) return false;
    try {
      return await store.has(ref);
    } catch {
      return false;
    }
  }

  #save(next: PushSenderSetting): boolean {
    try {
      mkdirSync(this.#directory, { recursive: true, mode: 0o700 });
      chmodSync(this.#directory, 0o700);
      writeOwnerOnly(this.#path, JSON.stringify(next));
      return true;
    } catch {
      return false;
    }
  }

  #journalChange(
    change: HostPushSenderChangeKind,
    platform: RemotePushPlatform | undefined,
    principal: AuditActingPrincipal,
  ): void {
    if (this.#journal === undefined) return;
    const occurredAt = this.#clock();
    const id = this.#uuid();
    const head = this.#journal
      .aggregateVersions(PUSH_SENDER_AGGREGATE_TYPE)
      .find((entry) => entry.aggregateId === PUSH_SENDER_AGGREGATE_ID);
    const payload = decodeHostPushSenderChangedV1({
      change,
      ...(platform === undefined ? {} : { platform }),
      recordedAt: occurredAt,
    });
    const actor =
      principal.kind === "local-window"
        ? { kind: "local-user" as const, actorId: this.#hostActorId }
        : { kind: "system" as const, actorId: this.#hostActorId };
    try {
      this.#journal.append({
        aggregate: {
          aggregateType: PUSH_SENDER_AGGREGATE_TYPE,
          aggregateId: PUSH_SENDER_AGGREGATE_ID,
        },
        expectedVersion: head?.aggregateVersion ?? 0,
        events: [
          {
            eventId: id,
            eventName: HOST_PUSH_SENDER_EVENT_NAMES.changed,
            eventVersion: 1,
            correlationId: id,
            actor,
            occurredAt,
            payload,
          },
        ],
      });
    } catch {
      // Journal write failure never exposes a credential or crashes a settings save.
    }
  }
}

function loadSetting(path: string): PushSenderSetting | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  try {
    return decodeStoredPushSenderSetting(text);
  } catch {
    return undefined;
  }
}
