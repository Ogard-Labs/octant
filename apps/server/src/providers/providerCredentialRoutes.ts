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
// The key is never logged, journaled, or returned. The routes answer only
// `stored`, `missing`, `removed`, or a typed refusal. Each change to the store
// is journaled as a request before the store is touched and as an outcome
// after (never the key); a host that stops in between settles the request at
// its next start (see providerKeyJournal).

import { createHash, timingSafeEqual } from "node:crypto";
import type { ProviderInstance, ProviderInstanceId, WindowId } from "@octant/contracts";
import { listApiKeys } from "@octant/host-runtime";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";
import type { ProviderCredentialStore } from "./credentialBrokerClient";
import type { ProviderKeyChangeRecorder, ProviderKeyJournal } from "./providerKeyJournal";

const ROUTES = {
  status: "/api/desktop/provider-credentials/status",
  set: "/api/desktop/provider-credentials/set",
  remove: "/api/desktop/provider-credentials/remove",
  removeProvider: "/api/desktop/provider-credentials/remove-provider",
} as const;

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

    if (
      options.desktopBridgeSecret === undefined ||
      !isLoopbackHostname(url.hostname) ||
      request.headers.has("origin") ||
      !secretsEqual(
        options.desktopBridgeSecret,
        request.headers.get("x-octant-desktop-secret") ?? "",
      )
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
    if (request.method !== "POST" || url.search !== "") return refuse("invalid");
    if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") {
      return refuse("invalid");
    }
    const body = await readJson(request);
    if (body.kind !== "ok") return refuse(body.kind);
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
        return answer("stored", target);
      } catch {
        return refuse("credential-store-unavailable");
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
function resolveInstance(
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
function usesStoredKey(instance: ProviderInstance): boolean {
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
  "credential-store-unavailable": "The host credential store is unavailable.",
};

function refuse(category: ProviderCredentialRefusal): Response {
  return Response.json(
    { category, message: REFUSAL_MESSAGE[category] },
    { status: REFUSAL_STATUS[category] },
  );
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

function secretsEqual(expected: string, actual: string): boolean {
  const left = createHash("sha256").update(expected, "utf8").digest();
  const right = createHash("sha256").update(actual, "utf8").digest();
  return timingSafeEqual(left, right);
}
