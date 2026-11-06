// Host-local provider key routes for a host without the desktop app.
//
// The desktop saves an endpoint's key over native IPC from its own renderer.
// A headless host has no such window, so the host-local `octant provider key`
// command sends the key here instead. These routes take a key only from a
// process that holds the desktop bridge secret, which lives in the owner-only
// runtime directory: they refuse a request without it, one that carries an
// `Origin` header (every browser page sends one), one addressed to a
// non-loopback host, and one without a registered window capability. The
// private listener never forwards `/api/desktop`, so a paired device cannot
// reach them at all. A browser on the host itself holds a local session but
// never the bridge secret, so it is refused too: the host cannot tell who is
// behind a loopback connection, and the secret binds the caller to the host's
// OS user.
//
// A native Octant Nightly main reaches the status, set, remove and key-pool
// routes with its own window's capability and main-only token instead of the
// secret (see desktopBrokerAdmission). Removing a provider stays secret-only.
//
// The key is never logged, journaled, or returned. The routes answer only
// `stored`, `missing`, `removed`, a pool's labels, or a typed refusal. Each change to the store
// is journaled as a request before the store is touched and as an outcome
// after (never the key); a host that stops in between settles the request at
// its next start (see providerKeyJournal).

import { createHash, timingSafeEqual } from "node:crypto";
import type { ProviderInstance, ProviderInstanceId, WindowId } from "@octant/contracts";
import {
  addApiKey,
  ApiKeyPoolError,
  credentialStoreFailureCauseOf,
  listApiKeys,
  moveApiKey,
  removeApiKey,
  renameApiKey,
  replaceApiKeySecret,
  setActiveApiKey,
  type CredentialStoreFailureCause,
} from "@octant/host-runtime";
import { admitDesktopBroker, admitsWindow } from "../desktopBrokerAdmission";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type { ProviderCredentialStore, ProviderKeyReference } from "./credentialBrokerClient";
import type { ProviderKeyChangeRecorder, ProviderKeyJournal } from "./providerKeyJournal";

const ROUTES = {
  status: "/api/desktop/provider-credentials/status",
  set: "/api/desktop/provider-credentials/set",
  remove: "/api/desktop/provider-credentials/remove",
  removeProvider: "/api/desktop/provider-credentials/remove-provider",
  keysList: "/api/desktop/provider-credentials/keys/list",
  keysAdd: "/api/desktop/provider-credentials/keys/add",
  keysRename: "/api/desktop/provider-credentials/keys/rename",
  keysReplace: "/api/desktop/provider-credentials/keys/replace",
  keysRemove: "/api/desktop/provider-credentials/keys/remove",
  keysSetActive: "/api/desktop/provider-credentials/keys/set-active",
  keysMove: "/api/desktop/provider-credentials/keys/move",
} as const;

/** The key-pool routes Settings uses to edit several keys for one provider. */
export const PROVIDER_API_KEY_ROUTES: ReadonlyArray<string> = [
  ROUTES.keysList,
  ROUTES.keysAdd,
  ROUTES.keysRename,
  ROUTES.keysReplace,
  ROUTES.keysRemove,
  ROUTES.keysSetActive,
  ROUTES.keysMove,
];

type Route = (typeof ROUTES)[keyof typeof ROUTES];

/** The broker's own bound; a larger value is refused before it is sent. */
export const MAX_PROVIDER_KEY_BYTES = 12 * 1_024;
const MAX_BODY_BYTES = MAX_PROVIDER_KEY_BYTES + 4 * 1_024;
const MAX_INSTANCE_REFERENCE_LENGTH = 256;

export type ProviderCredentialRefusal =
  | "unauthorized"
  | "invalid"
  | "too-large"
  | "not-found"
  | "ambiguous"
  | "no-stored-key-authentication"
  | "already-stored"
  | "several-keys"
  | "changed"
  | "provider-refused"
  | "provider-removed-key-kept"
  | "journal-unavailable"
  | "linked-secret"
  | "credential-store-unavailable";

const REFUSAL_STATUS: Readonly<Record<ProviderCredentialRefusal, number>> = {
  unauthorized: 401,
  invalid: 400,
  "too-large": 413,
  "not-found": 404,
  ambiguous: 409,
  "no-stored-key-authentication": 409,
  "already-stored": 409,
  "several-keys": 409,
  changed: 409,
  "provider-refused": 409,
  "provider-removed-key-kept": 503,
  "journal-unavailable": 503,
  "linked-secret": 409,
  "credential-store-unavailable": 503,
};

export interface ProviderCredentialRouteOptions {
  readonly desktopBridgeSecret: string | undefined;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly readProviderInstances: () => ReadonlyArray<ProviderInstance>;
  /** Removed instances whose key may still be stored; clearing one is never a widening. */
  readonly readRemovedProviderInstanceIds: () => ReadonlyArray<string>;
  /**
   * The host credential store, or undefined when the server started without a
   * credential broker (no Secret Service, or a macOS host without the desktop).
   */
  readonly credentials:
    | {
        /** Writes and clears through the key pool, so a new key starts with no cooldown. */
        readonly store: Pick<ProviderCredentialStore, "has" | "set" | "delete">;
        /** The stored value as it is, so a pool of several keys is seen as one. */
        readonly readStored: (providerInstanceId: string) => Promise<string>;
      }
    | undefined;
  readonly journal: ProviderKeyJournal;
  /**
   * Whether the instance's stored key is a pointer into a linked secret store.
   * A pointer changes only through the journaled secret-store routes, so these
   * routes never overwrite or clear one. Without it, nothing is linked.
   */
  readonly readKeyReference?: (providerInstanceId: string) => Promise<ProviderKeyReference>;
  /**
   * Checks the provider again after its key changed. The observed state is
   * cached from the last check, so without this a key stored from the command
   * line reads Needs key until the host restarts.
   */
  readonly reprobe: (windowId: WindowId, instance: ProviderInstance) => Promise<void>;
  /**
   * Removes the provider through the same service Settings uses, so its own
   * refusals (an active session, the implicit owner of an account) apply.
   */
  readonly removeProvider: (
    windowId: WindowId,
    instance: ProviderInstance,
  ) => Promise<
    { readonly kind: "removed" } | { readonly kind: "refused"; readonly message: string }
  >;
  readonly now?: () => number;
}

export function createProviderCredentialRouteHandler(
  options: ProviderCredentialRouteOptions,
): (request: Request) => Promise<Response | undefined> {
  const now = options.now ?? Date.now;
  // One change at a time: a `set` reads the instance, stores, and reads it
  // again, and no other key change from these routes can run in between.
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queue.then(task);
    queue = run.catch(() => undefined);
    return run;
  };

  return async (request) => {
    const url = new URL(request.url);
    if (!Object.values(ROUTES).includes(url.pathname as Route)) return undefined;
    const route = url.pathname as Route;

    const admission = admitDesktopBroker({
      request,
      desktopBridgeSecret: options.desktopBridgeSecret,
      windowAuthorityStore: options.windowAuthorityStore,
      now: now(),
    });
    if (
      options.desktopBridgeSecret === undefined ||
      !isLoopbackHostname(url.hostname) ||
      admission.status !== "admitted"
    ) {
      return refuse("unauthorized");
    }
    let windowId: WindowId;
    try {
      windowId = options.windowAuthorityStore.authenticate(
        request.headers.get("x-octant-window-capability") ?? "",
        now(),
      );
    } catch (error) {
      if (error instanceof WindowAuthorityError) return refuse("unauthorized");
      throw error;
    }
    if (!admitsWindow(admission, windowId)) return refuse("unauthorized");
    if (request.method !== "POST" || url.search !== "") return refuse("invalid");
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
      return refuse("invalid");
    }
    const body = await readJson(request);
    if (body.kind !== "ok") return refuse(body.kind);
    const credentialsForPool = options.credentials;
    if (PROVIDER_API_KEY_ROUTES.includes(route)) {
      const keyRequest = decodeKeyRequest(route, body.value);
      if (keyRequest === undefined) return refuse("invalid");
      if (keyRequest === "too-large") return refuse("too-large");
      if (credentialsForPool === undefined) return refuse("credential-store-unavailable");
      return serialized(() => changeApiKeys(keyRequest, windowId, credentialsForPool, options));
    }
    const decoded = decodeRequest(route, body.value);
    if (decoded === undefined) return refuse("invalid");
    if (decoded.kind === "too-large") return refuse("too-large");

    const credentials = options.credentials;
    if (credentials === undefined) return refuse("credential-store-unavailable");

    return serialized(async () => {
      const target = resolveInstance(
        decoded.instance,
        options.readProviderInstances(),
        route === ROUTES.remove ? options.readRemovedProviderInstanceIds() : [],
      );
      if (target.kind === "not-found") return refuse("not-found");
      if (target.kind === "ambiguous") {
        return Response.json(
          {
            category: "ambiguous",
            message: "More than one provider has that name. Use one of these ids.",
            candidates: target.candidates,
          },
          { status: REFUSAL_STATUS.ambiguous },
        );
      }
      const { id } = target;
      if (route === ROUTES.set || (route === ROUTES.remove && target.kind === "existing")) {
        const reference = await readKeyReference(options, id);
        if (reference.status === "linked") return refuse("linked-secret");
        if (reference.status === "unavailable")
          return refuse("credential-store-unavailable", reference.cause);
      }
      const begin = (
        action: "set" | "remove" | "remove-with-provider",
      ): ProviderKeyChangeRecorder | undefined => {
        try {
          return options.journal.request({
            instanceId: id as ProviderInstanceId,
            action,
            instanceVersion: target.kind === "existing" ? target.instance.version : 0,
            windowId,
          });
        } catch {
          return undefined;
        }
      };
      try {
        if (route === ROUTES.removeProvider) {
          if (target.kind !== "existing") return refuse("not-found");
          // Provider first, then key: a failure between the two leaves a key
          // for no instance, which the request settles at the next start and
          // `key remove <id>` clears now, and never an instance without its key.
          const recorder = begin("remove-with-provider");
          if (recorder === undefined) return refuse("journal-unavailable");
          const removal = await options.removeProvider(windowId, target.instance);
          // A refusal after the removal was journaled (a later cleanup step
          // failed) still removed the provider, so the projection decides.
          const stillConfigured = options
            .readProviderInstances()
            .some((instance) => String(instance.id) === id);
          if (removal.kind === "refused" && stillConfigured) {
            recorder.fail("abandoned");
            return Response.json(
              { category: "provider-refused", message: removal.message },
              { status: REFUSAL_STATUS["provider-refused"] },
            );
          }
          try {
            await credentials.store.delete(id);
          } catch {
            return Response.json(
              {
                category: "provider-removed-key-kept",
                message: REFUSAL_MESSAGE["provider-removed-key-kept"],
                instanceId: id,
              },
              { status: REFUSAL_STATUS["provider-removed-key-kept"] },
            );
          }
          recorder.complete("removed");
          return answer("removed", target);
        }
        if (route === ROUTES.remove) {
          const recorder = begin("remove");
          if (recorder === undefined) return refuse("journal-unavailable");
          // A store error does not say whether the delete committed, so the
          // request stays unsettled and the next start clears the key again.
          await credentials.store.delete(id);
          recorder.complete("removed");
          if (target.kind === "existing")
            void options.reprobe(windowId, target.instance).catch(() => undefined);
          return answer("removed", target);
        }
        if (target.kind === "existing" && !usesStoredKey(target.instance)) {
          return refuse("no-stored-key-authentication");
        }
        if (route === ROUTES.status) {
          return answer((await credentials.store.has(id)) ? "stored" : "missing", target);
        }
        if (decoded.kind !== "set" || target.kind !== "existing") return refuse("invalid");
        if (await credentials.store.has(id)) {
          if (!decoded.replace) return refuse("already-stored");
          // Replacing a pool with one key would drop keys the person cannot see
          // from here, so the command asks for an explicit remove first.
          if (listApiKeys(await credentials.readStored(id)).length > 1) {
            return refuse("several-keys");
          }
        }
        const recorder = begin("set");
        if (recorder === undefined) return refuse("journal-unavailable");
        // A store error (a lost or malformed answer) does not say whether the
        // write committed, so the request stays unsettled and the next start
        // checks the key against its instance.
        await credentials.store.set(id, decoded.credential);
        // Settings can remove or reconfigure the instance while the key is
        // being written. A removal would leave a key for no instance, and a new
        // base URL or authentication would send a key entered for the old
        // endpoint to the new one, because the service clears the old key
        // before it commits the change. Any version change clears the key.
        const current = options
          .readProviderInstances()
          .find((instance) => String(instance.id) === id);
        if (current === undefined || current.version !== target.instance.version) {
          await credentials.store.delete(id);
          recorder.complete("cleared-after-change");
          return refuse(current === undefined ? "not-found" : "changed");
        }
        recorder.complete("stored");
        void options.reprobe(windowId, current).catch(() => undefined);
        return answer("stored", target);
      } catch (error) {
        return refuse("credential-store-unavailable", storeCauseOf(error));
      }
    });
  };
}

type DecodedRequest =
  | { readonly kind: "status" | "remove" | "remove-provider"; readonly instance: string }
  | {
      readonly kind: "set";
      readonly instance: string;
      readonly credential: string;
      readonly replace: boolean;
    }
  | { readonly kind: "too-large" };

function decodeRequest(route: Route, value: unknown): DecodedRequest | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const instance = record.instance;
  if (
    typeof instance !== "string" ||
    instance.length === 0 ||
    instance.length > MAX_INSTANCE_REFERENCE_LENGTH
  ) {
    return undefined;
  }
  if (route !== ROUTES.set) {
    if (keys.length !== 1) return undefined;
    return {
      kind:
        route === ROUTES.status
          ? "status"
          : route === ROUTES.removeProvider
            ? "remove-provider"
            : "remove",
      instance,
    };
  }
  if (keys.join(",") !== "credential,instance,replace") return undefined;
  const { credential, replace } = record;
  if (typeof credential !== "string" || typeof replace !== "boolean") return undefined;
  if (credential.trim().length === 0) return undefined;
  if (Buffer.byteLength(credential, "utf8") > MAX_PROVIDER_KEY_BYTES) return { kind: "too-large" };
  return { kind: "set", instance, credential, replace };
}

type ResolvedInstance =
  | {
      readonly kind: "existing";
      readonly id: string;
      readonly displayName: string;
      readonly instance: ProviderInstance;
    }
  | { readonly kind: "removed"; readonly id: string; readonly displayName: null }
  | { readonly kind: "not-found" }
  | {
      readonly kind: "ambiguous";
      readonly candidates: ReadonlyArray<{ readonly id: string; readonly displayName: string }>;
    };

/** An instance id, or an exact display name that names exactly one instance. */
export function resolveInstance(
  reference: string,
  instances: ReadonlyArray<ProviderInstance>,
  removedIds: ReadonlyArray<string>,
): ResolvedInstance {
  const lowered = reference.toLowerCase();
  const byId = instances.find((instance) => String(instance.id) === lowered);
  if (byId !== undefined) {
    return { kind: "existing", id: String(byId.id), displayName: byId.displayName, instance: byId };
  }
  const named = instances.filter((instance) => instance.displayName === reference);
  const [only] = named;
  if (only !== undefined && named.length === 1) {
    return { kind: "existing", id: String(only.id), displayName: only.displayName, instance: only };
  }
  if (named.length > 1) {
    return {
      kind: "ambiguous",
      candidates: named.map((instance) => ({
        id: String(instance.id),
        displayName: instance.displayName,
      })),
    };
  }
  if (removedIds.some((id) => id === lowered)) {
    return { kind: "removed", id: lowered, displayName: null };
  }
  return { kind: "not-found" };
}

/** Only an instance that sends an API key or bearer token has a key to store. */
export function usesStoredKey(instance: ProviderInstance): boolean {
  const configuration: object = instance.configuration;
  if (!("authentication" in configuration)) return false;
  return configuration.authentication === "api-key" || configuration.authentication === "bearer";
}

function answer(
  outcome: "stored" | "missing" | "removed",
  target: { readonly id: string; readonly displayName: string | null },
): Response {
  return Response.json({ outcome, instanceId: target.id, displayName: target.displayName });
}

const REFUSAL_MESSAGE: Readonly<Record<ProviderCredentialRefusal, string>> = {
  unauthorized: "Provider keys can be changed only by the host-local octant command.",
  invalid: "The provider key request is invalid.",
  "too-large": "The key is larger than the credential store accepts.",
  "not-found": "No provider has that id or name.",
  ambiguous: "More than one provider has that name.",
  "no-stored-key-authentication": "That provider does not use an API key or bearer token.",
  "already-stored": "That provider already has a stored key.",
  "several-keys": "That provider holds several keys.",
  changed: "That provider changed while the key was being saved, so the key was not kept.",
  "provider-refused": "The provider could not be removed.",
  "provider-removed-key-kept":
    "The provider was removed, but its stored key could not be cleared yet.",
  "journal-unavailable": "The change could not be recorded, so nothing was changed.",
  "linked-secret":
    "This provider's key comes from a linked secret store. Remove the link in Settings first.",
  "credential-store-unavailable": "The host credential store is unavailable.",
};

/** The keyring's own reason, when the store said why it refused. */
function storeCauseOf(error: unknown): CredentialStoreFailureCause | undefined {
  const cause =
    typeof error === "object" && error !== null ? (error as { cause?: unknown }).cause : undefined;
  return credentialStoreFailureCauseOf(cause);
}

function refuse(
  category: ProviderCredentialRefusal,
  cause?: CredentialStoreFailureCause,
): Response {
  return Response.json(
    { category, message: REFUSAL_MESSAGE[category], ...(cause === undefined ? {} : { cause }) },
    { status: REFUSAL_STATUS[category] },
  );
}

async function readKeyReference(
  options: Pick<ProviderCredentialRouteOptions, "readKeyReference">,
  id: string,
): Promise<ProviderKeyReference> {
  if (options.readKeyReference === undefined) return { status: "none" };
  try {
    return await options.readKeyReference(id);
  } catch (error) {
    const cause = storeCauseOf(error);
    return cause === undefined ? { status: "unavailable" } : { status: "unavailable", cause };
  }
}

type KeyRequest =
  | { readonly kind: "list"; readonly instance: string }
  | {
      readonly kind: "add";
      readonly instance: string;
      readonly credential: string;
      readonly label: string | undefined;
    }
  | {
      readonly kind: "rename";
      readonly instance: string;
      readonly keyId: string;
      readonly label: string;
    }
  | {
      readonly kind: "replace";
      readonly instance: string;
      readonly keyId: string;
      readonly credential: string;
    }
  | { readonly kind: "remove" | "set-active"; readonly instance: string; readonly keyId: string }
  | {
      readonly kind: "move";
      readonly instance: string;
      readonly keyId: string;
      readonly direction: "up" | "down";
    };

const KEY_ID = /^(default|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function decodeKeyRequest(route: Route, value: unknown): KeyRequest | "too-large" | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  const { instance, keyId, label, credential, direction } = record;
  if (
    typeof instance !== "string" ||
    instance.length === 0 ||
    instance.length > MAX_INSTANCE_REFERENCE_LENGTH
  )
    return undefined;
  // As for `set`, a key over the broker's bound is refused as too large.
  if (
    (route === ROUTES.keysAdd || route === ROUTES.keysReplace) &&
    typeof credential === "string" &&
    Buffer.byteLength(credential, "utf8") > MAX_PROVIDER_KEY_BYTES
  )
    return "too-large";
  const validKeyId = typeof keyId === "string" && KEY_ID.test(keyId) ? keyId : undefined;
  const validCredential =
    typeof credential === "string" &&
    credential.trim().length > 0 &&
    Buffer.byteLength(credential, "utf8") <= MAX_PROVIDER_KEY_BYTES
      ? credential
      : undefined;
  switch (route) {
    case ROUTES.keysList:
      return keys === "instance" ? { kind: "list", instance } : undefined;
    case ROUTES.keysAdd:
      if (validCredential === undefined) return undefined;
      if (keys === "credential,instance")
        return { kind: "add", instance, credential: validCredential, label: undefined };
      return keys === "credential,instance,label" && typeof label === "string"
        ? { kind: "add", instance, credential: validCredential, label }
        : undefined;
    case ROUTES.keysRename:
      return keys === "instance,keyId,label" &&
        validKeyId !== undefined &&
        typeof label === "string"
        ? { kind: "rename", instance, keyId: validKeyId, label }
        : undefined;
    case ROUTES.keysReplace:
      return keys === "credential,instance,keyId" &&
        validKeyId !== undefined &&
        validCredential !== undefined
        ? { kind: "replace", instance, keyId: validKeyId, credential: validCredential }
        : undefined;
    case ROUTES.keysRemove:
    case ROUTES.keysSetActive:
      return keys === "instance,keyId" && validKeyId !== undefined
        ? {
            kind: route === ROUTES.keysRemove ? "remove" : "set-active",
            instance,
            keyId: validKeyId,
          }
        : undefined;
    case ROUTES.keysMove:
      return keys === "direction,instance,keyId" &&
        validKeyId !== undefined &&
        (direction === "up" || direction === "down")
        ? { kind: "move", instance, keyId: validKeyId, direction }
        : undefined;
    default:
      return undefined;
  }
}

/**
 * One change to a provider's key pool, as Octant's Settings makes it against
 * its own credential store: a list answers labels only, and a change answers
 * nothing but the new key's label. Each write is journaled before the store is
 * touched, a linked pointer is never replaced, and a key that arrived while the
 * provider was reconfigured is cleared again.
 */
async function changeApiKeys(
  request: KeyRequest,
  windowId: WindowId,
  credentials: NonNullable<ProviderCredentialRouteOptions["credentials"]>,
  options: ProviderCredentialRouteOptions,
): Promise<Response> {
  const target = resolveInstance(request.instance, options.readProviderInstances(), []);
  if (target.kind !== "existing")
    return refuse(target.kind === "ambiguous" ? "ambiguous" : "not-found");
  if (!usesStoredKey(target.instance)) return refuse("no-stored-key-authentication");
  const { id } = target;
  try {
    // Decided before the stored value is read: reading a linked key follows
    // the pointer into the linked store, which may ask the person to unlock it.
    const reference = await readKeyReference(options, id);
    if (reference.status === "unavailable")
      return refuse("credential-store-unavailable", reference.cause);
    if (reference.status === "linked")
      return request.kind === "list" ? Response.json({ keys: [] }) : refuse("linked-secret");
    const stored = (await credentials.store.has(id)) ? await credentials.readStored(id) : undefined;
    if (request.kind === "list") {
      return Response.json({ keys: stored === undefined ? [] : listApiKeys(stored) });
    }
    let next: string | undefined;
    let added: ReturnType<typeof addApiKey>["key"] | undefined;
    if (request.kind === "add") {
      const result = addApiKey(stored, { secret: request.credential, label: request.label });
      next = result.stored;
      added = result.key;
    } else {
      if (stored === undefined) throw new ApiKeyPoolError("unknown-key");
      next =
        request.kind === "rename"
          ? renameApiKey(stored, request.keyId, request.label)
          : request.kind === "replace"
            ? replaceApiKeySecret(stored, request.keyId, request.credential)
            : request.kind === "set-active"
              ? setActiveApiKey(stored, request.keyId)
              : request.kind === "move"
                ? moveApiKey(stored, request.keyId, request.direction)
                : removeApiKey(stored, request.keyId);
    }
    let recorder: ProviderKeyChangeRecorder;
    try {
      recorder = options.journal.request({
        instanceId: id as ProviderInstanceId,
        action: next === undefined ? "remove" : "set",
        instanceVersion: target.instance.version,
        windowId,
      });
    } catch {
      return refuse("journal-unavailable");
    }
    if (next === undefined) {
      await credentials.store.delete(id);
      recorder.complete("removed");
    } else {
      await credentials.store.set(id, next);
      // As for `set`: a key entered for the old endpoint never stays with a
      // provider that was removed or reconfigured while it was written.
      const current = options
        .readProviderInstances()
        .find((instance) => String(instance.id) === id);
      if (current === undefined || current.version !== target.instance.version) {
        await credentials.store.delete(id);
        recorder.complete("cleared-after-change");
        return refuse(current === undefined ? "not-found" : "changed");
      }
      recorder.complete("stored");
    }
    void options.reprobe(windowId, target.instance).catch(() => undefined);
    return Response.json(added === undefined ? { outcome: "changed" } : { key: added });
  } catch (error) {
    if (error instanceof ApiKeyPoolError) {
      return Response.json(
        { category: "api-key-pool", reason: error.reason, message: error.message },
        { status: 409 },
      );
    }
    return refuse("credential-store-unavailable", storeCauseOf(error));
  }
}

async function readJson(
  request: Request,
): Promise<
  { readonly kind: "ok"; readonly value: unknown } | { readonly kind: "invalid" | "too-large" }
> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return { kind: "too-large" };
  let text: string;
  try {
    text = await request.text();
  } catch {
    return { kind: "invalid" };
  }
  if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return { kind: "too-large" };
  try {
    return { kind: "ok", value: JSON.parse(text) };
  } catch {
    return { kind: "invalid" };
  }
}

export function secretsEqual(expected: string, actual: string): boolean {
  const left = createHash("sha256").update(expected, "utf8").digest();
  const right = createHash("sha256").update(actual, "utf8").digest();
  return timingSafeEqual(left, right);
}
