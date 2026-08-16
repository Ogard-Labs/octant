import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { CredentialStore } from "./credentialStore";
import { CredentialPurgeFailure, type CredentialPurgeStore } from "./keychainCredentialStore";

// A purge request may carry the bounded set of 128 canonical UUIDs accepted by
// the native helper. Keep the broker limit aligned with that helper protocol;
// the exact JSON shape and item bound below still prevent this loopback service
// from becoming a general large-body endpoint.
const BODY_LIMIT = 16 * 1_024;
const TOKEN_HEADER = "x-octant-credential-broker-token";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROUTES = new Set(["/v1/credentials/has", "/v1/credentials/resolve", "/v1/credentials/purge"]);
const PURGE_FAILURE_STATUS: Readonly<Record<CredentialPurgeFailure["category"], number>> = {
  locked: 423,
  unavailable: 503,
  indeterminate: 500,
  failed: 500,
};

export interface CredentialBroker {
  readonly url: string;
  readonly token: string;
  readonly close: () => Promise<void>;
  readonly fetchForTest: (request: Request, peerAddress?: string) => Promise<Response>;
}

export async function startCredentialBroker(
  store: CredentialStore,
  purgeStore?: CredentialPurgeStore,
): Promise<CredentialBroker> {
  const token = randomBytes(32).toString("base64url");
  let brokerUrl: string | undefined;
  const server = createServer((incoming, outgoing) => {
    void handleIncoming(incoming, brokerUrl, token, store, purgeStore).then(
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
    closing = new Promise<void>((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close((error) => (error === undefined ? resolve() : reject(error)));
      server.closeAllConnections();
    });
    return closing;
  };

  return Object.freeze({
    url: brokerUrl,
    token,
    close,
    fetchForTest: (request: Request, peerAddress = "127.0.0.1") =>
      handleBrokerRequest(request, peerAddress, token, store, purgeStore),
  });
}

async function handleIncoming(
  incoming: IncomingMessage,
  brokerUrl: string | undefined,
  token: string,
  store: CredentialStore,
  purgeStore: CredentialPurgeStore | undefined,
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

  const decoded = await readJson(request);
  if (decoded.kind === "too-large") return failure("too-large", 413);
  if (decoded.kind === "invalid") return failure("invalid-request", 400);

  try {
    if (url.pathname === "/v1/credentials/has") {
      return Response.json({ present: await store.has(decoded.providerInstanceId) });
    }
    return Response.json({ credential: await store.resolve(decoded.providerInstanceId) });
  } catch {
    return failure("credential-operation-failed", 503);
  }
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

async function readJson(
  request: Request,
): Promise<
  { kind: "ok"; providerInstanceId: string } | { kind: "invalid" } | { kind: "too-large" }
> {
  const declared = request.headers.get("content-length");
  if (declared !== null && /^\d+$/.test(declared) && BigInt(declared) > BigInt(BODY_LIMIT)) {
    return { kind: "too-large" };
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > BODY_LIMIT) return { kind: "too-large" };
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!isRecord(value) || Object.keys(value).length !== 1) return { kind: "invalid" };
    if (
      typeof value.providerInstanceId !== "string" ||
      !UUID_PATTERN.test(value.providerInstanceId)
    ) {
      return { kind: "invalid" };
    }
    return { kind: "ok", providerInstanceId: value.providerInstanceId };
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
