import type { NightlyHostFeature, NightlyWindowBootstrap } from "@octant/contracts/nightly-browser";
import { keyringAdvice } from "@octant/domain/keyring-advice";
import {
  DESKTOP_IPC_CHANNELS,
  KEYRING_ADVICE_MARKER,
  MAX_PROVIDER_CREDENTIAL_BYTES,
  PROVIDER_INSTANCE_ID_PATTERN,
} from "./ipcChannels";
import { NEEDS_NEWER_OCTANT } from "./nightlyClientChannels";
import type { NativeMainAuthority } from "./nightlyNativeMainAuthority";

const LINKED_REFERENCE_MESSAGE =
  "This provider's key comes from a linked secret store. Remove the link in Settings first.";
const INVALID_KEY_REQUEST = "Octant rejected an invalid API key request.";
const INVALID_CREDENTIAL_REQUEST = "Octant rejected an invalid credential request.";
const KEY_ID = /^(default|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

interface ApiKeySummary {
  readonly id: string;
  readonly label: string;
  readonly active: boolean;
}

export interface NightlyProviderCredentialOptions {
  readonly register: (
    channel: string,
    handler: (event: Electron.IpcMainInvokeEvent, ...values: unknown[]) => unknown,
  ) => void;
  readonly bootstrap: (webContentsId: number) => NightlyWindowBootstrap | undefined;
  readonly nativeMain: NativeMainAuthority;
  /** Nightly main's own Node transport, which keeps the main-only token. */
  readonly fetch: typeof globalThis.fetch;
}

/**
 * Nightly's provider key and API key pool channels. The keys live in the
 * matching Octant's credential store, so every read and change goes to its
 * host, which journals each change and refuses to replace a linked secret.
 * The renderer sees what it sees in Octant: a status, labels, the new key's
 * label, or one of the same refusal sentences.
 */
export function installNightlyProviderCredentials(options: NightlyProviderCredentialOptions): void {
  const post = async (
    event: Electron.IpcMainInvokeEvent,
    feature: NightlyHostFeature,
    path: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly status: number; readonly value: unknown }> => {
    const id = event.sender.id;
    const bootstrap = options.bootstrap(id);
    const headers = options.nativeMain.headers(id);
    if (bootstrap === undefined || headers === undefined || !options.nativeMain.supports(id, feature))
      throw new Error(NEEDS_NEWER_OCTANT);
    const response = await options.fetch(
      new URL(`/api/desktop/provider-credentials/${path}`, bootstrap.hostOrigin),
      {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
      },
    );
    let value: unknown;
    try {
      value = await response.json();
    } catch {
      value = undefined;
    }
    return { status: response.status, value };
  };
  const { register } = options;
  register(DESKTOP_IPC_CHANNELS.providerCredentialStatus, async (event, instanceId) => {
    const instance = validateInstanceId(instanceId);
    const answer = await post(event, "provider-credentials", "status", { instance }).catch(
      (error: unknown) => {
        if (error instanceof Error && error.message === NEEDS_NEWER_OCTANT) throw error;
        return undefined;
      },
    );
    if (answer === undefined) return "unavailable";
    const outcome = field(answer.value, "outcome");
    if (answer.status === 200 && (outcome === "stored" || outcome === "missing")) return outcome;
    // A provider that does not send a key has none to store, as Octant reads it.
    return field(answer.value, "category") === "no-stored-key-authentication"
      ? "missing"
      : "unavailable";
  });
  register(DESKTOP_IPC_CHANNELS.setProviderCredential, async (event, instanceId, credential) => {
    const instance = validateInstanceId(instanceId);
    const value = validateCredential(credential);
    await change(
      post(event, "provider-credentials", "set", { instance, credential: value, replace: true }),
      "Octant could not store the provider credential.",
    );
  });
  register(DESKTOP_IPC_CHANNELS.clearProviderCredential, async (event, instanceId) => {
    const instance = validateInstanceId(instanceId);
    await change(
      post(event, "provider-credentials", "remove", { instance }),
      "Octant could not clear the provider credential.",
    );
  });
  const keys = (event: Electron.IpcMainInvokeEvent, path: string, body: Record<string, unknown>) =>
    poolChange(post(event, "provider-api-keys", `keys/${path}`, body));
  register(DESKTOP_IPC_CHANNELS.listProviderApiKeys, async (event, instanceId) => {
    const value = await keys(event, "list", { instance: validateInstanceId(instanceId) });
    const list = field(value, "keys");
    if (!Array.isArray(list) || !list.every(isApiKeySummary))
      throw new Error("Octant could not update the provider API keys.");
    return list.map(({ id, label, active }) => ({ id, label, active }));
  });
  register(DESKTOP_IPC_CHANNELS.addProviderApiKey, async (event, instanceId, credential, label) => {
    const value = await keys(event, "add", {
      instance: validateInstanceId(instanceId),
      credential: validateCredential(credential),
      ...(label === undefined ? {} : { label: validateLabel(label) }),
    });
    const key = field(value, "key");
    if (!isApiKeySummary(key)) throw new Error("Octant could not update the provider API keys.");
    return { id: key.id, label: key.label, active: key.active };
  });
  register(DESKTOP_IPC_CHANNELS.renameProviderApiKey, async (event, instanceId, keyId, label) => {
    await keys(event, "rename", {
      instance: validateInstanceId(instanceId),
      keyId: validateKeyId(keyId),
      label: validateLabel(label),
    });
  });
  register(
    DESKTOP_IPC_CHANNELS.replaceProviderApiKey,
    async (event, instanceId, keyId, credential) => {
      await keys(event, "replace", {
        instance: validateInstanceId(instanceId),
        keyId: validateKeyId(keyId),
        credential: validateCredential(credential),
      });
    },
  );
  register(DESKTOP_IPC_CHANNELS.removeProviderApiKey, async (event, instanceId, keyId) => {
    await keys(event, "remove", {
      instance: validateInstanceId(instanceId),
      keyId: validateKeyId(keyId),
    });
  });
  register(DESKTOP_IPC_CHANNELS.setActiveProviderApiKey, async (event, instanceId, keyId) => {
    await keys(event, "set-active", {
      instance: validateInstanceId(instanceId),
      keyId: validateKeyId(keyId),
    });
  });
  register(DESKTOP_IPC_CHANNELS.moveProviderApiKey, async (event, instanceId, keyId, direction) => {
    if (direction !== "up" && direction !== "down") throw new Error(INVALID_KEY_REQUEST);
    await keys(event, "move", {
      instance: validateInstanceId(instanceId),
      keyId: validateKeyId(keyId),
      direction,
    });
  });
}

/** A single-key change answers nothing, or the same sentences Octant's main uses. */
async function change(
  pending: Promise<{ readonly status: number; readonly value: unknown }>,
  failure: string,
): Promise<void> {
  const answer = await pending.catch((error: unknown) => {
    if (error instanceof Error && error.message === NEEDS_NEWER_OCTANT) throw error;
    throw new Error(failure);
  });
  if (answer.status === 200) return;
  if (field(answer.value, "category") === "linked-secret")
    throw new Error(LINKED_REFERENCE_MESSAGE);
  throw new Error(failure);
}

/** A pool change answers its value, or the pool's, the link's or the keyring's sentence. */
async function poolChange(
  pending: Promise<{ readonly status: number; readonly value: unknown }>,
): Promise<unknown> {
  const generic = "Octant could not update the provider API keys.";
  const answer = await pending.catch((error: unknown) => {
    if (error instanceof Error && error.message === NEEDS_NEWER_OCTANT) throw error;
    throw new Error(generic);
  });
  if (answer.status === 200) return answer.value;
  const category = field(answer.value, "category");
  const message = field(answer.value, "message");
  if (category === "api-key-pool" && typeof message === "string") throw new Error(message);
  if (category === "linked-secret") throw new Error(LINKED_REFERENCE_MESSAGE);
  if (category === "credential-store-unavailable") {
    const cause = field(answer.value, "cause");
    const advice = keyringAdvice({
      category: "unavailable",
      ...(typeof cause === "string" ? { cause } : {}),
    });
    if (advice !== undefined) throw new Error(`${KEYRING_ADVICE_MARKER}${advice}`);
  }
  throw new Error(generic);
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

function isApiKeySummary(value: unknown): value is ApiKeySummary {
  return (
    typeof field(value, "id") === "string" &&
    typeof field(value, "label") === "string" &&
    typeof field(value, "active") === "boolean"
  );
}

function validateInstanceId(value: unknown): string {
  if (typeof value !== "string" || !PROVIDER_INSTANCE_ID_PATTERN.test(value))
    throw new Error(INVALID_CREDENTIAL_REQUEST);
  return value;
}

function validateCredential(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > MAX_PROVIDER_CREDENTIAL_BYTES
  )
    throw new Error(INVALID_CREDENTIAL_REQUEST);
  return value;
}

function validateKeyId(value: unknown): string {
  if (typeof value !== "string" || !KEY_ID.test(value)) throw new Error(INVALID_KEY_REQUEST);
  return value;
}

function validateLabel(value: unknown): string {
  if (typeof value !== "string") throw new Error(INVALID_KEY_REQUEST);
  return value;
}
