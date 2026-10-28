// Host-local routes for the App Store Connect API key a person enters to
// distribute their own app (docs/design/apple-devices.md § Distribution).
//
// The key is entered on the same terms as a provider key: from the desktop
// app's own window, whose main process forwards the request with the desktop
// bridge secret and that window's capability, or from the host-local `octant`
// CLI, which reads the bridge secret from the owner-only runtime directory. A
// request without the secret, with an `Origin` header (every browser page
// sends one), addressed to a non-loopback host, or without a registered
// window capability is refused before its body is read. The private listener
// never forwards `/api/desktop`, so a paired device cannot reach these routes.
//
// The key goes to the broker's own App Store Connect namespace, which has no
// resolve route. It is never logged, journaled, or returned: the routes answer
// only `stored`, `missing`, `removed`, or a typed refusal.

import { createPrivateKey } from "node:crypto";
import type { ProviderCredentialStore } from "../providers/credentialBrokerClient";
import { secretsEqual } from "../providers/providerCredentialRoutes";
import { isLoopbackHostname } from "../shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "../windowAuthorityStore";

const ROUTES = {
  status: "/api/desktop/app-store-connect-key/status",
  set: "/api/desktop/app-store-connect-key/set",
  remove: "/api/desktop/app-store-connect-key/remove",
} as const;

type Route = (typeof ROUTES)[keyof typeof ROUTES];

/**
 * The one broker entry that holds this host's key. A host keeps one App Store
 * Connect key; entering another replaces it only when the person asks to.
 */
export const APP_STORE_CONNECT_KEY_REF = "4c0f6a52-5b0e-4d8e-9a43-2f3f0a9d7c61";

/** A `.p8` key is a few hundred bytes; anything this large is not one. */
const MAX_PRIVATE_KEY_BYTES = 4 * 1_024;
const MAX_BODY_BYTES = MAX_PRIVATE_KEY_BYTES + 1_024;
const ISSUER_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_ID = /^[A-Z0-9]{10}$/;

export type AppStoreConnectKeyRefusal =
  | "unauthorized"
  | "invalid"
  | "too-large"
  | "invalid-key"
  | "unsupported-host"
  | "distribution-not-enabled"
  | "already-stored"
  | "credential-store-unavailable";

const REFUSAL_STATUS: Readonly<Record<AppStoreConnectKeyRefusal, number>> = {
  unauthorized: 401,
  invalid: 400,
  "too-large": 413,
  "invalid-key": 400,
  "unsupported-host": 409,
  "distribution-not-enabled": 409,
  "already-stored": 409,
  "credential-store-unavailable": 503,
};

const REFUSAL_MESSAGE: Readonly<Record<AppStoreConnectKeyRefusal, string>> = {
  unauthorized:
    "The App Store Connect key can be changed only from the Octant desktop app or the host-local octant command.",
  invalid: "The App Store Connect key request is invalid.",
  "too-large": "That is larger than an App Store Connect key.",
  "invalid-key":
    "Enter the issuer ID, the 10-character key ID, and the private key from the .p8 file App Store Connect gave you.",
  "unsupported-host": "Distributing an app to App Store Connect needs a Mac host.",
  "distribution-not-enabled": "Uploading, submitting, and releasing are not available.",
  "already-stored": "This host already has an App Store Connect key.",
  "credential-store-unavailable": "The host credential store is unavailable.",
};

export interface AppStoreConnectKeyRouteOptions {
  readonly desktopBridgeSecret: string | undefined;
  readonly windowAuthorityStore: WindowAuthorityStore;
  /** Only a macOS host distributes; nothing stands in for one. */
  readonly macos: boolean;
  /** Whether the Current Release Boundary admits distribution. */
  readonly distributionEnabled: boolean;
  /** The broker's App Store Connect namespace, or undefined when the host has no broker for it. */
  readonly keys: Pick<ProviderCredentialStore, "has" | "set" | "delete"> | undefined;
  readonly now?: () => number;
}

type KeyRequest =
  | { readonly kind: "status" | "remove" }
  | { readonly kind: "set"; readonly stored: string; readonly replace: boolean };

type DecodedRequest =
  | KeyRequest
  | { readonly kind: "invalid" }
  | { readonly kind: "invalid-key" }
  | { readonly kind: "too-large" };

export function createAppStoreConnectKeyRouteHandler(
  options: AppStoreConnectKeyRouteOptions,
): (request: Request) => Promise<Response | undefined> {
  const now = options.now ?? Date.now;
  // One change at a time, so a `set` that checks for a stored key and then
  // writes cannot interleave with another.
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
    try {
      options.windowAuthorityStore.authenticate(
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
    const decoded = decodeRequest(route, await readJson(request));
    if (
      decoded.kind === "invalid" ||
      decoded.kind === "invalid-key" ||
      decoded.kind === "too-large"
    ) {
      return refuse(decoded.kind);
    }
    const change: KeyRequest = decoded;

    // Removing a key stays open whatever the host and boundary say, so a key
    // entered earlier can always be taken out of the store.
    if (change.kind !== "remove") {
      if (!options.macos) return refuse("unsupported-host");
      if (!options.distributionEnabled) return refuse("distribution-not-enabled");
    }
    const keys = options.keys;
    if (keys === undefined) return refuse("credential-store-unavailable");

    return serialized(async () => {
      try {
        if (change.kind === "remove") {
          await keys.delete(APP_STORE_CONNECT_KEY_REF);
          return answer("removed");
        }
        const present = await keys.has(APP_STORE_CONNECT_KEY_REF);
        if (change.kind !== "set") return answer(present ? "stored" : "missing");
        if (present && !change.replace) return refuse("already-stored");
        await keys.set(APP_STORE_CONNECT_KEY_REF, change.stored);
        return answer("stored");
      } catch {
        return refuse("credential-store-unavailable");
      }
    });
  };
}

function decodeRequest(
  route: Route,
  body:
    | { readonly kind: "ok"; readonly value: unknown }
    | { readonly kind: "invalid" | "too-large" },
): DecodedRequest {
  if (body.kind !== "ok")
    return body.kind === "invalid" ? { kind: "invalid" } : { kind: "too-large" };
  const value = body.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "invalid" };
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");
  if (route !== ROUTES.set) {
    if (keys !== "") return { kind: "invalid" };
    return { kind: route === ROUTES.status ? "status" : "remove" };
  }
  if (keys !== "issuerId,keyId,privateKey,replace") return { kind: "invalid" };
  const { issuerId, keyId, privateKey, replace } = record;
  if (
    typeof issuerId !== "string" ||
    typeof keyId !== "string" ||
    typeof privateKey !== "string" ||
    typeof replace !== "boolean"
  ) {
    return { kind: "invalid" };
  }
  if (Buffer.byteLength(privateKey, "utf8") > MAX_PRIVATE_KEY_BYTES) return { kind: "too-large" };
  const issuer = issuerId.trim().toLowerCase();
  const key = keyId.trim().toUpperCase();
  const pem = privateKey.trim();
  if (!ISSUER_ID.test(issuer) || !KEY_ID.test(key) || !isAppStoreConnectPrivateKey(pem)) {
    return { kind: "invalid-key" };
  }
  return {
    kind: "set",
    stored: JSON.stringify({ version: 1, issuerId: issuer, keyId: key, privateKey: `${pem}\n` }),
    replace,
  };
}

/** App Store Connect issues ES256 keys: a PKCS #8 P-256 private key in PEM. */
function isAppStoreConnectPrivateKey(pem: string): boolean {
  if (!pem.startsWith("-----BEGIN PRIVATE KEY-----")) return false;
  try {
    const key = createPrivateKey({ key: pem, format: "pem" });
    return key.asymmetricKeyType === "ec" && key.asymmetricKeyDetails?.namedCurve === "prime256v1";
  } catch {
    return false;
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

function answer(outcome: "stored" | "missing" | "removed"): Response {
  return Response.json({ outcome });
}

function refuse(category: AppStoreConnectKeyRefusal): Response {
  return Response.json(
    { category, message: REFUSAL_MESSAGE[category] },
    { status: REFUSAL_STATUS[category] },
  );
}
