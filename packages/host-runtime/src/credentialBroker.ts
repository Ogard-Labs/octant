import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import {
  CredentialPurgeFailure,
  CredentialStoreFailure,
  type CredentialPurgeStore,
  type CredentialStore,
} from "./credentialStore";
import {
  createCloudIamRuntime,
  handleCloudIamBrokerRoute,
  isCloudIamGrantMaterial,
  type CloudIamRuntime,
} from "./cloudIam";
import {
  decodeLinkedSecretPointer,
  encodeLinkedSecretPointer,
  isLinkedSecretMaterial,
  isLinkedSecretStoreKind,
  type LinkedSecretStores,
} from "./linkedSecretStores";
import {
  createAwsCliSessions,
  handleAwsCliBrokerRoute,
  type AwsCliSessions,
} from "./awsCliSessions";
import {
  createHostOAuthRuntime,
  handleHostOAuthBrokerRoute,
  isHostOAuthGrantMaterial,
  type HostOAuthRuntime,
} from "./hostOAuth";

// A purge request may carry the bounded set of 128 canonical UUIDs accepted by
// the native helper. Keep the broker limit aligned with that helper protocol;
// the exact JSON shape and item bound below still prevent this loopback service
// from becoming a general large-body endpoint.
const BODY_LIMIT = 16 * 1_024;
const TOKEN_HEADER = "x-octant-credential-broker-token";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROUTES = new Set([
  "/v1/credentials/has",
  "/v1/credentials/resolve",
  "/v1/credentials/set",
  "/v1/credentials/delete",
  "/v1/credentials/purge",
  "/v1/replica-device-keys/has",
  "/v1/replica-device-keys/resolve",
  "/v1/replica-device-keys/set",
  "/v1/replica-device-keys/delete",
  "/v1/replica-store-credentials/has",
  "/v1/replica-store-credentials/resolve",
  "/v1/replica-store-credentials/set",
  "/v1/replica-store-credentials/delete",
  "/v1/canvas-public-share-secrets/has",
  "/v1/canvas-public-share-secrets/resolve",
  "/v1/canvas-public-share-secrets/set",
  "/v1/canvas-public-share-secrets/delete",
  "/v1/mcp-server-credentials/has",
  "/v1/mcp-server-credentials/resolve",
  "/v1/mcp-server-credentials/set",
  "/v1/mcp-server-credentials/delete",
  "/v1/desktop-provider-credentials/has",
  "/v1/desktop-provider-credentials/resolve",
  "/v1/desktop-provider-credentials/set",
  "/v1/desktop-provider-credentials/delete",
  "/v1/push-platform-credentials/has",
  "/v1/push-platform-credentials/resolve",
  "/v1/push-platform-credentials/set",
  "/v1/push-platform-credentials/delete",
  "/v1/secret-stores/status",
  "/v1/secret-stores/link",
  "/v1/secret-stores/unlink",
  "/v1/secret-stores/check",
  "/v1/secret-stores/point",
  "/v1/secret-stores/reference",
  "/v1/secret-stores/clear",
  "/v1/secret-stores/restore",
  "/v1/cloud-cli/aws/reference",
  "/v1/cloud-cli/aws/point",
  "/v1/cloud-cli/aws/restore",
  "/v1/cloud-cli/aws/clear",
  "/v1/cloud-cli/aws/session",
  "/v1/oauth/begin",
  "/v1/oauth/status",
  "/v1/oauth/refresh",
  "/v1/oauth/access",
  "/v1/oauth/revoke",
  "/v1/cloud-iam/begin",
  "/v1/cloud-iam/status",
  "/v1/cloud-iam/sign",
  "/v1/cloud-iam/revoke",
]);
const SECRET_STORE_PREFIX = "/v1/secret-stores/";
const AWS_CLI_PREFIX = "/v1/cloud-cli/aws/";
const REPLICA_DEVICE_KEY_PREFIX = "/v1/replica-device-keys/";
const REPLICA_STORE_CREDENTIAL_PREFIX = "/v1/replica-store-credentials/";
const CANVAS_PUBLIC_SHARE_SECRET_PREFIX = "/v1/canvas-public-share-secrets/";
const MCP_SERVER_CREDENTIAL_PREFIX = "/v1/mcp-server-credentials/";
const DESKTOP_PROVIDER_CREDENTIAL_PREFIX = "/v1/desktop-provider-credentials/";
const PUSH_PLATFORM_CREDENTIAL_PREFIX = "/v1/push-platform-credentials/";
type NamespacedIdField = "instanceId" | "credentialRef" | "secretId";
const MAX_CREDENTIAL_BYTES = 12 * 1_024;
const PURGE_FAILURE_STATUS: Readonly<Record<CredentialPurgeFailure["category"], number>> = {
  locked: 423,
  unavailable: 503,
  indeterminate: 500,
  failed: 500,
};

interface LinkedBrokerStores {
  readonly stores: LinkedSecretStores;
  readonly awsCli: AwsCliSessions;
}

export interface CredentialBroker {
  readonly url: string;
  readonly token: string;
  readonly close: () => Promise<void>;
  readonly fetchForTest: (request: Request, peerAddress?: string) => Promise<Response>;
}

export async function startCredentialBroker(
  store: CredentialStore,
  purgeStore?: CredentialPurgeStore,
  oauth?: {
    readonly fetch?: typeof fetch;
    readonly now?: () => number;
    readonly timeoutMs?: number;
    readonly sleep?: (ms: number) => Promise<void>;
  },
  /**
   * Replica device signing keys, in their own credential namespace. They are
   * served only on `/v1/replica-device-keys/*`; the provider routes reach a
   * different store, so a provider instance with the same UUID can never
   * read, replace, or delete one.
   */
  replicaDeviceKeys?: CredentialStore,
  /**
   * The access key pairs of sync buckets, in a credential namespace of their
   * own. They are served only on `/v1/replica-store-credentials/*`, keyed by
   * the settings' credential reference, so neither a provider instance nor a
   * replica device key with the same UUID can reach one. Unlike a device key,
   * a key pair can be replaced when a person enters a new one.
   */
  replicaStoreCredentials?: CredentialStore,
  /**
   * Public links' owner secrets, served only on
   * `/v1/canvas-public-share-secrets/*` and keyed by the link's credential
   * reference, so no provider, device key, or sync key can reach one.
   */
  canvasPublicShareSecrets?: CredentialStore,
  /**
   * The secret values a person gives an MCP server they added by hand (a
   * header, an environment variable), in a credential namespace of their own.
   * They are served only on `/v1/mcp-server-credentials/*`, keyed by the secret id
   * the package references, so no provider instance, device key, or bucket
   * key pair with the same UUID can reach one.
   */
  mcpServerCredentials?: CredentialStore,
  /**
   * The API keys a person gives a cloud desktop provider for a Project's
   * desktop recipe, in a credential namespace of their own. They are served
   * only on `/v1/desktop-provider-credentials/*`, keyed by the recipe's
   * credential reference, so no model provider, device key, or other secret
   * with the same UUID can reach one, and a desktop driver can reach no other.
   */
  desktopProviderCredentials?: CredentialStore,
  /**
   * The Apple and Google push credentials and the sealing key a hub that sends
   * notifications directly holds, in a credential namespace of their own. They
   * are served only on `/v1/push-platform-credentials/*`, so no provider,
   * device key, or other secret with the same UUID can reach one.
   */
  pushPlatformCredentials?: CredentialStore,
  /**
   * The external secret stores a person linked. A provider key or connector
   * credential may then hold a pointer to an item in one, and the resolve
   * routes of those two namespaces follow it at use. No other namespace can
   * hold a pointer, and no route returns one.
   */
  linkedSecretStores?: LinkedSecretStores,
): Promise<CredentialBroker> {
  const token = randomBytes(32).toString("base64url");
  const runtime = createHostOAuthRuntime({
    store,
    ...(oauth?.fetch === undefined ? {} : { fetch: oauth.fetch }),
    ...(oauth?.now === undefined ? {} : { now: oauth.now }),
    ...(oauth?.timeoutMs === undefined ? {} : { timeoutMs: oauth.timeoutMs }),
    ...(oauth?.sleep === undefined ? {} : { sleep: oauth.sleep }),
  });
  // The cloud signer shares the store, the network, and the clock with the
  // OAuth runner: a cloud grant is one more entry the raw resolve refuses.
  const cloudIam = createCloudIamRuntime({
    store,
    ...(oauth?.fetch === undefined ? {} : { fetch: oauth.fetch }),
    ...(oauth?.now === undefined ? {} : { now: oauth.now }),
    ...(oauth?.sleep === undefined ? {} : { sleep: oauth.sleep }),
  });
  // The AWS command line's sessions read the linked stores' items, so they
  // exist only where a store can be linked.
  const linked =
    linkedSecretStores === undefined
      ? undefined
      : {
          stores: linkedSecretStores,
          awsCli: createAwsCliSessions({
            linked: linkedSecretStores,
            ...(oauth?.fetch === undefined ? {} : { fetch: oauth.fetch }),
            ...(oauth?.now === undefined ? {} : { now: oauth.now }),
          }),
        };
  let brokerUrl: string | undefined;
  const server = createServer((incoming, outgoing) => {
    void handleIncoming(
      incoming,
      brokerUrl,
      token,
      store,
      purgeStore,
      runtime,
      cloudIam,
      replicaDeviceKeys,
      replicaStoreCredentials,
      canvasPublicShareSecrets,
      mcpServerCredentials,
      desktopProviderCredentials,
      pushPlatformCredentials,
      linked,
    ).then(
      ({ destroyIncoming, response }) => {
        const headers: Record<string, string> = {};
        response.headers.forEach((value, name) => {
          headers[name] = value;
        });
        outgoing.writeHead(response.status, headers);
        outgoing.end(Buffer.from(response.body), () => {
          if (destroyIncoming) incoming.destroy();
        });
      },
      () => {
        outgoing.writeHead(500, { "content-type": "application/json" });
        outgoing.end(JSON.stringify({ error: "credential-broker-unavailable" }));
      },
    );
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(0, "127.0.0.1");
  });

  const address = server.address() as AddressInfo | null;
  if (address === null) {
    server.close();
    throw new Error("Octant credential broker is unavailable.");
  }
  brokerUrl = `http://127.0.0.1:${address.port}/`;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing !== undefined) return closing;
    closing = (async () => {
      await runtime.close();
      await cloudIam.close();
      await new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeAllConnections();
      });
    })();
    return closing;
  };

  return Object.freeze({
    url: brokerUrl,
    token,
    close,
    fetchForTest: (request: Request, peerAddress = "127.0.0.1") =>
      handleBrokerRequest(
        request,
        peerAddress,
        token,
        store,
        purgeStore,
        runtime,
        cloudIam,
        replicaDeviceKeys,
        replicaStoreCredentials,
        canvasPublicShareSecrets,
        mcpServerCredentials,
        desktopProviderCredentials,
        pushPlatformCredentials,
        linked,
      ),
  });
}

async function handleIncoming(
  incoming: IncomingMessage,
  brokerUrl: string | undefined,
  token: string,
  store: CredentialStore,
  purgeStore: CredentialPurgeStore | undefined,
  runtime: HostOAuthRuntime,
  cloudIam: CloudIamRuntime,
  replicaDeviceKeys: CredentialStore | undefined,
  replicaStoreCredentials: CredentialStore | undefined,
  canvasPublicShareSecrets: CredentialStore | undefined,
  mcpServerCredentials: CredentialStore | undefined,
  desktopProviderCredentials: CredentialStore | undefined,
  pushPlatformCredentials: CredentialStore | undefined,
  linked: LinkedBrokerStores | undefined,
): Promise<{ destroyIncoming: boolean; response: ResponseData }> {
  if (brokerUrl === undefined) throw new Error("unavailable");
  const headers = requestHeaders(incoming.headers);
  if (!isAuthorized(incoming.socket.remoteAddress ?? "", headers, token)) {
    return {
      destroyIncoming: true,
      response: await responseData(failure("unauthorized", 401)),
    };
  }
  const body = await readIncomingBody(incoming);
  if (body.kind === "too-large") {
    return { destroyIncoming: true, response: await responseData(failure("too-large", 413)) };
  }
  const method = incoming.method ?? "GET";
  const request = new Request(new URL(incoming.url ?? "/", brokerUrl), {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body: Uint8Array.from(body.value) }),
  });
  return {
    destroyIncoming: false,
    response: await responseData(
      await handleBrokerRequest(
        request,
        incoming.socket.remoteAddress ?? "",
        token,
        store,
        purgeStore,
        runtime,
        cloudIam,
        replicaDeviceKeys,
        replicaStoreCredentials,
        canvasPublicShareSecrets,
        mcpServerCredentials,
        desktopProviderCredentials,
        pushPlatformCredentials,
        linked,
      ),
    ),
  };
}

async function handleBrokerRequest(
  request: Request,
  peerAddress: string,
  token: string,
  store: CredentialStore,
  purgeStore: CredentialPurgeStore | undefined,
  runtime: HostOAuthRuntime,
  cloudIam: CloudIamRuntime,
  replicaDeviceKeys: CredentialStore | undefined,
  replicaStoreCredentials: CredentialStore | undefined,
  canvasPublicShareSecrets: CredentialStore | undefined,
  mcpServerCredentials: CredentialStore | undefined,
  desktopProviderCredentials: CredentialStore | undefined,
  pushPlatformCredentials: CredentialStore | undefined,
  linked: LinkedBrokerStores | undefined,
): Promise<Response> {
  const url = new URL(request.url);
  if (!isAuthorized(peerAddress, request.headers, token)) {
    return failure("unauthorized", 401);
  }
  if (!ROUTES.has(url.pathname)) return failure("not-found", 404);
  if (request.method !== "POST") return failure("method-not-allowed", 405);
  if (url.search !== "") return failure("invalid-request", 400);
  if (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
    "application/json"
  ) {
    return failure("unsupported-media-type", 415);
  }

  if (url.pathname.startsWith("/v1/oauth/")) {
    return handleHostOAuthBrokerRoute(url.pathname, request, runtime);
  }

  if (url.pathname.startsWith("/v1/cloud-iam/")) {
    return handleCloudIamBrokerRoute(url.pathname, request, cloudIam);
  }

  if (url.pathname.startsWith(AWS_CLI_PREFIX)) {
    if (linked === undefined) return failure("not-found", 404);
    const body = await readJsonRecord(request);
    if (body.kind === "too-large") return failure("too-large", 413);
    if (body.kind === "invalid") return failure("invalid-request", 400);
    return handleAwsCliBrokerRoute(
      url.pathname.slice(AWS_CLI_PREFIX.length),
      body.value,
      linked.stores,
      linked.awsCli,
    );
  }

  if (url.pathname.startsWith(SECRET_STORE_PREFIX)) {
    if (linked === undefined) return failure("not-found", 404);
    return handleSecretStoreRoute(
      url.pathname.slice(SECRET_STORE_PREFIX.length),
      request,
      linked.stores,
      { provider: store, "mcp-server": mcpServerCredentials },
    );
  }

  if (url.pathname.startsWith(REPLICA_DEVICE_KEY_PREFIX)) {
    if (replicaDeviceKeys === undefined) return failure("not-found", 404);
    return handleNamespacedRoute(
      url.pathname.slice(REPLICA_DEVICE_KEY_PREFIX.length),
      "instanceId",
      request,
      replicaDeviceKeys,
    );
  }

  if (url.pathname.startsWith(REPLICA_STORE_CREDENTIAL_PREFIX)) {
    if (replicaStoreCredentials === undefined) return failure("not-found", 404);
    return handleNamespacedRoute(
      url.pathname.slice(REPLICA_STORE_CREDENTIAL_PREFIX.length),
      "credentialRef",
      request,
      replicaStoreCredentials,
    );
  }

  if (url.pathname.startsWith(CANVAS_PUBLIC_SHARE_SECRET_PREFIX)) {
    if (canvasPublicShareSecrets === undefined) return failure("not-found", 404);
    return handleNamespacedRoute(
      url.pathname.slice(CANVAS_PUBLIC_SHARE_SECRET_PREFIX.length),
      "credentialRef",
      request,
      canvasPublicShareSecrets,
    );
  }

  if (url.pathname.startsWith(MCP_SERVER_CREDENTIAL_PREFIX)) {
    if (mcpServerCredentials === undefined) return failure("not-found", 404);
    return handleNamespacedRoute(
      url.pathname.slice(MCP_SERVER_CREDENTIAL_PREFIX.length),
      "secretId",
      request,
      mcpServerCredentials,
      linked?.stores,
    );
  }

  if (url.pathname.startsWith(DESKTOP_PROVIDER_CREDENTIAL_PREFIX)) {
    if (desktopProviderCredentials === undefined) return failure("not-found", 404);
    return handleNamespacedRoute(
      url.pathname.slice(DESKTOP_PROVIDER_CREDENTIAL_PREFIX.length),
      "credentialRef",
      request,
      desktopProviderCredentials,
    );
  }

  if (url.pathname.startsWith(PUSH_PLATFORM_CREDENTIAL_PREFIX)) {
    if (pushPlatformCredentials === undefined) return failure("not-found", 404);
    return handleNamespacedRoute(
      url.pathname.slice(PUSH_PLATFORM_CREDENTIAL_PREFIX.length),
      "credentialRef",
      request,
      pushPlatformCredentials,
    );
  }

  if (url.pathname === "/v1/credentials/purge") {
    if (purgeStore === undefined) return failure("not-found", 404);
    const decoded = await readPurgeJson(request);
    if (decoded.kind === "too-large") return failure("too-large", 413);
    if (decoded.kind === "invalid") return failure("invalid-request", 400);
    try {
      const result = await purgeStore.purge({
        dryRun: decoded.dryRun,
        providerInstanceIds: decoded.providerInstanceIds,
        ...(decoded.hostIdentityFingerprint === undefined
          ? {}
          : { hostIdentityFingerprint: decoded.hostIdentityFingerprint }),
      });
      return Response.json(result);
    } catch (error) {
      if (error instanceof CredentialPurgeFailure) {
        return failure(error.category, PURGE_FAILURE_STATUS[error.category]);
      }
      return failure("failed", 500);
    }
  }

  if (url.pathname === "/v1/credentials/set") {
    const decoded = await readSetJson(request);
    if (decoded.kind === "too-large") return failure("too-large", 413);
    if (decoded.kind === "invalid") return failure("invalid-request", 400);
    // A pointer is written only by the secret-store routes, which check the
    // store is linked; a pasted value that looks like one is refused.
    if (isLinkedSecretMaterial(decoded.credential)) return failure("invalid-request", 400);
    try {
      await store.set(decoded.id, decoded.credential);
      return Response.json({ stored: true });
    } catch (error) {
      return credentialStoreFailure(error);
    }
  }

  const decoded = await readJson(request);
  if (decoded.kind === "too-large") return failure("too-large", 413);
  if (decoded.kind === "invalid") return failure("invalid-request", 400);

  try {
    if (url.pathname === "/v1/credentials/has") {
      return Response.json({ present: await store.has(decoded.id) });
    }
    if (url.pathname === "/v1/credentials/delete") {
      await store.delete(decoded.id);
      return Response.json({ deleted: true });
    }
    const credential = await store.resolve(decoded.id);
    if (isHostOAuthGrantMaterial(credential)) return failure("oauth-material", 403);
    // A cloud grant holds the portal session and the role's secret key; only
    // the signer may read it.
    if (isCloudIamGrantMaterial(credential)) return failure("cloud-iam-material", 403);
    if (isLinkedSecretMaterial(credential)) {
      return followLinkedSecret(credential, linked?.stores);
    }
    return Response.json({ credential });
  } catch (error) {
    return credentialStoreFailure(error);
  }
}

/**
 * A namespaced route reaches only its own store and names its own id field —
 * the replica instance for a device key, the settings' credential reference
 * for a sync bucket's key pair — never a provider instance.
 */
async function handleNamespacedRoute(
  operation: string,
  field: NamespacedIdField,
  request: Request,
  store: CredentialStore,
  linkedSecretStores?: LinkedSecretStores,
): Promise<Response> {
  if (operation === "set") {
    const decoded = await readSetJson(request, field);
    if (decoded.kind === "too-large") return failure("too-large", 413);
    if (decoded.kind === "invalid") return failure("invalid-request", 400);
    if (isLinkedSecretMaterial(decoded.credential)) return failure("invalid-request", 400);
    try {
      await store.set(decoded.id, decoded.credential);
      return Response.json({ stored: true });
    } catch (error) {
      return credentialStoreFailure(error);
    }
  }
  const decoded = await readJson(request, field);
  if (decoded.kind === "too-large") return failure("too-large", 413);
  if (decoded.kind === "invalid") return failure("invalid-request", 400);
  try {
    if (operation === "has") {
      return Response.json({ present: await store.has(decoded.id) });
    }
    if (operation === "delete") {
      await store.delete(decoded.id);
      return Response.json({ deleted: true });
    }
    const credential = await store.resolve(decoded.id);
    // Only the connector namespace passes its linked-store handle; in any other
    // namespace a pointer is just an opaque string that never resolves further.
    if (isLinkedSecretMaterial(credential)) {
      return followLinkedSecret(credential, linkedSecretStores);
    }
    return Response.json({ credential });
  } catch (error) {
    return credentialStoreFailure(error);
  }
}

/**
 * Fetches a linked item now and returns it to the caller that asked. Nothing
 * is kept: the value is not stored, cached, or logged here. A store that is
 * locked, gone, or unlinked answers with a typed cause and no value.
 */
async function followLinkedSecret(
  material: string,
  linkedSecretStores: LinkedSecretStores | undefined,
): Promise<Response> {
  const pointer = decodeLinkedSecretPointer(material);
  if (pointer === undefined || linkedSecretStores === undefined) {
    return Response.json(
      { error: "unavailable", cause: "linked-store-unavailable" },
      { status: 503 },
    );
  }
  const result = await linkedSecretStores.read(pointer.store, pointer.reference);
  switch (result.status) {
    case "read":
      return Response.json(
        { credential: result.value },
        { headers: { "cache-control": "no-store" } },
      );
    case "missing":
    case "invalid-reference":
      return Response.json({ error: "missing", cause: "linked-item-missing" }, { status: 404 });
    case "locked":
      return Response.json({ error: "unavailable", cause: "linked-store-locked" }, { status: 503 });
    case "not-linked":
      return Response.json(
        { error: "unavailable", cause: "linked-store-not-linked" },
        { status: 503 },
      );
    case "unavailable":
      return Response.json(
        { error: "unavailable", cause: "linked-store-unavailable" },
        { status: 503 },
      );
  }
}

type SecretStoreNamespace = "provider" | "mcp-server";

/**
 * The linked-store routes. They answer expected outcomes as `{ status }` with
 * HTTP 200 so a locked store is a value the caller handles; a malformed
 * request is a 400. Nothing here returns a fetched value: `check` only proves
 * an item resolves, and `reference` returns the pointer (a store name and an
 * item reference), never what it points at.
 */
async function handleSecretStoreRoute(
  operation: string,
  request: Request,
  linked: LinkedSecretStores,
  namespaces: Readonly<Record<SecretStoreNamespace, CredentialStore | undefined>>,
): Promise<Response> {
  const body = await readJsonRecord(request);
  if (body.kind === "too-large") return failure("too-large", 413);
  if (body.kind === "invalid") return failure("invalid-request", 400);
  const value = body.value;
  const keys = Object.keys(value).sort().join(",");
  const store = value.store;

  if (operation === "status") {
    if (keys !== "") return failure("invalid-request", 400);
    return Response.json({ stores: await linked.status() });
  }
  if (operation === "link" || operation === "unlink") {
    if (keys !== "store" || !isLinkedSecretStoreKind(store)) return failure("invalid-request", 400);
    if (operation === "unlink") {
      await linked.unlink(store);
      return Response.json({ status: "unlinked" });
    }
    return Response.json(await linked.link(store));
  }
  if (operation === "check") {
    if (keys !== "reference,store" || !isLinkedSecretStoreKind(store)) {
      return failure("invalid-request", 400);
    }
    if (typeof value.reference !== "string") return failure("invalid-request", 400);
    return Response.json(await linked.check(store, value.reference));
  }

  const namespace = value.namespace;
  const id = value.id;
  if (
    (namespace !== "provider" && namespace !== "mcp-server") ||
    typeof id !== "string" ||
    !UUID_PATTERN.test(id)
  ) {
    return failure("invalid-request", 400);
  }
  const target = namespaces[namespace];
  if (target === undefined) return failure("not-found", 404);

  try {
    if (operation === "point") {
      if (keys !== "id,namespace,reference,store" || !isLinkedSecretStoreKind(store)) {
        return failure("invalid-request", 400);
      }
      if (typeof value.reference !== "string") return failure("invalid-request", 400);
      const checked = await linked.check(store, value.reference);
      if (checked.status !== "found") return Response.json({ status: checked.status });
      // Pointing replaces a pointer, never a value the person stored: that
      // would destroy a key they cannot get back from here.
      if (await target.has(id)) {
        const current = await target.resolve(id);
        if (!isLinkedSecretMaterial(current)) {
          return Response.json({ status: "key-already-stored" });
        }
      }
      await target.set(id, encodeLinkedSecretPointer({ store, reference: value.reference }));
      return Response.json({ status: "pointed" });
    }
    if (operation === "restore") {
      // Puts back a pointer that was just replaced. Unlike `point` it does not
      // read the item: the earlier item may be gone or its store locked by now,
      // and the pointer is data, not a value. It still needs a linked store, a
      // valid reference, and a slot that holds a pointer or nothing, so it can
      // never overwrite a stored key.
      if (keys !== "id,namespace,reference,store" || !isLinkedSecretStoreKind(store)) {
        return failure("invalid-request", 400);
      }
      if (typeof value.reference !== "string") return failure("invalid-request", 400);
      if (!linked.isValidReference(store, value.reference)) {
        return Response.json({ status: "invalid-reference" });
      }
      if (!(await linked.isLinked(store))) return Response.json({ status: "not-linked" });
      if (await target.has(id)) {
        const current = await target.resolve(id);
        if (!isLinkedSecretMaterial(current)) {
          return Response.json({ status: "key-already-stored" });
        }
      }
      await target.set(id, encodeLinkedSecretPointer({ store, reference: value.reference }));
      return Response.json({ status: "pointed" });
    }
    if (operation === "reference" || operation === "clear") {
      if (keys !== "id,namespace") return failure("invalid-request", 400);
      if (!(await target.has(id))) return Response.json({ status: "none" });
      const pointer = decodeLinkedSecretPointer(await target.resolve(id));
      if (pointer === undefined) return Response.json({ status: "none" });
      if (operation === "clear") await target.delete(id);
      return Response.json({
        status: operation === "clear" ? "cleared" : "linked",
        store: pointer.store,
        reference: pointer.reference,
      });
    }
  } catch (error) {
    return credentialStoreFailure(error);
  }
  return failure("not-found", 404);
}

async function readJsonRecord(
  request: Request,
): Promise<
  { kind: "ok"; value: Record<string, unknown> } | { kind: "invalid" } | { kind: "too-large" }
> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && BigInt(declared) > BigInt(BODY_LIMIT)) {
    return { kind: "too-large" };
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > BODY_LIMIT) return { kind: "too-large" };
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return isRecord(value) ? { kind: "ok", value } : { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

function credentialStoreFailure(error: unknown): Response {
  if (error instanceof CredentialStoreFailure) {
    const status =
      error.category === "missing" ? 404 : error.category === "unavailable" ? 503 : 500;
    return error.cause === undefined
      ? failure(error.category, status)
      : Response.json({ error: error.category, cause: error.cause }, { status });
  }
  return failure("failed", 503);
}

function isAuthorized(peerAddress: string, headers: Headers, token: string): boolean {
  return (
    isLoopbackPeer(peerAddress) &&
    !headers.has("origin") &&
    tokensEqual(token, headers.get(TOKEN_HEADER) ?? "")
  );
}

function tokensEqual(expected: string, actual: string): boolean {
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const actualDigest = createHash("sha256").update(actual, "utf8").digest();
  return timingSafeEqual(expectedDigest, actualDigest);
}

function isLoopbackPeer(address: string): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

async function readSetJson(
  request: Request,
  field: "providerInstanceId" | NamespacedIdField = "providerInstanceId",
): Promise<
  { kind: "ok"; id: string; credential: string } | { kind: "invalid" } | { kind: "too-large" }
> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && BigInt(declared) > BigInt(BODY_LIMIT)) {
    return { kind: "too-large" };
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > BODY_LIMIT) return { kind: "too-large" };
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!isRecord(value) || Object.keys(value).length !== 2) return { kind: "invalid" };
    const id = value[field];
    if (
      typeof id !== "string" ||
      !UUID_PATTERN.test(id) ||
      typeof value.credential !== "string" ||
      value.credential.length === 0 ||
      Buffer.byteLength(value.credential, "utf8") > MAX_CREDENTIAL_BYTES
    ) {
      return { kind: "invalid" };
    }
    return { kind: "ok", id, credential: value.credential };
  } catch {
    return { kind: "invalid" };
  }
}

async function readJson(
  request: Request,
  field: "providerInstanceId" | NamespacedIdField = "providerInstanceId",
): Promise<{ kind: "ok"; id: string } | { kind: "invalid" } | { kind: "too-large" }> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && BigInt(declared) > BigInt(BODY_LIMIT)) {
    return { kind: "too-large" };
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > BODY_LIMIT) return { kind: "too-large" };
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!isRecord(value) || Object.keys(value).length !== 1) return { kind: "invalid" };
    const id = value[field];
    if (typeof id !== "string" || !UUID_PATTERN.test(id)) {
      return { kind: "invalid" };
    }
    return { kind: "ok", id };
  } catch {
    return { kind: "invalid" };
  }
}

async function readPurgeJson(request: Request): Promise<
  | {
      kind: "ok";
      dryRun: boolean;
      providerInstanceIds: readonly string[];
      hostIdentityFingerprint?: string;
    }
  | { kind: "invalid" }
  | { kind: "too-large" }
> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && BigInt(declared) > BigInt(BODY_LIMIT)) {
    return { kind: "too-large" };
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > BODY_LIMIT) return { kind: "too-large" };
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (
      !isRecord(value) ||
      Object.keys(value).some(
        (key) =>
          key !== "dryRun" && key !== "providerInstanceIds" && key !== "hostIdentityFingerprint",
      ) ||
      !Object.hasOwn(value, "dryRun") ||
      !Object.hasOwn(value, "providerInstanceIds")
    ) {
      return { kind: "invalid" };
    }
    if (typeof value.dryRun !== "boolean") return { kind: "invalid" };
    const providerInstanceIds = value.providerInstanceIds;
    if (
      !Array.isArray(providerInstanceIds) ||
      providerInstanceIds.length > 128 ||
      !providerInstanceIds.every(
        (providerInstanceId): providerInstanceId is string =>
          typeof providerInstanceId === "string" && UUID_PATTERN.test(providerInstanceId),
      ) ||
      new Set(providerInstanceIds).size !== providerInstanceIds.length
    ) {
      return { kind: "invalid" };
    }
    const hostIdentityFingerprint = value.hostIdentityFingerprint;
    if (
      hostIdentityFingerprint !== undefined &&
      hostIdentityFingerprint !== null &&
      (typeof hostIdentityFingerprint !== "string" ||
        !/^[0-9a-f]{64}$/.test(hostIdentityFingerprint))
    ) {
      return { kind: "invalid" };
    }
    return {
      kind: "ok",
      dryRun: value.dryRun,
      providerInstanceIds,
      ...(typeof hostIdentityFingerprint === "string" ? { hostIdentityFingerprint } : {}),
    };
  } catch {
    return { kind: "invalid" };
  }
}

function readIncomingBody(
  incoming: IncomingMessage,
): Promise<{ kind: "ok"; value: Buffer } | { kind: "too-large" }> {
  const declared = incoming.headers["content-length"];
  if (
    typeof declared === "string" &&
    /^\d+$/.test(declared) &&
    BigInt(declared) > BigInt(BODY_LIMIT)
  ) {
    incoming.pause();
    return Promise.resolve({ kind: "too-large" });
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const cleanup = () => {
      incoming.off("data", onData);
      incoming.off("end", onEnd);
      incoming.off("error", onError);
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > BODY_LIMIT) {
        cleanup();
        incoming.pause();
        resolve({ kind: "too-large" });
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      cleanup();
      resolve({ kind: "ok", value: Buffer.concat(chunks) });
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    incoming.on("data", onData);
    incoming.once("end", onEnd);
    incoming.once("error", onError);
  });
}

function requestHeaders(incoming: IncomingHttpHeaders): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(incoming)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.set(name, value);
    }
  }
  return headers;
}

function failure(error: string, status: number): Response {
  return Response.json({ error }, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ResponseData {
  readonly status: number;
  readonly headers: Headers;
  readonly body: ArrayBuffer;
}

async function responseData(response: Response): Promise<ResponseData> {
  return { status: response.status, headers: response.headers, body: await response.arrayBuffer() };
}
