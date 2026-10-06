/**
 * The in-tree replica store for an S3-compatible bucket the person configured.
 *
 * It speaks the replica-store port with the same vocabulary as the folder
 * store: `list`, `get`, and `putIfAbsent`, where a publish lands only when the
 * key is absent. It does not replace a key, and it does not delete one.
 *
 * The endpoint, region, bucket, prefix, and addressing style come from
 * settings. The access key and secret come from the host credential store
 * (macOS Keychain or freedesktop Secret Service) through the same
 * {@link CredentialStore} the provider credentials use; they are held only in
 * memory for the duration of a request and never written to a log or journal.
 *
 * A conditional create (`If-None-Match: *`) is how a publish stays write-once.
 * A provider that does not honour it is configured with `conditionalWrites:
 * false`, which falls back to HEAD-then-PUT.
 *
 * Every request goes to the configured endpoint and nowhere else, and only
 * while sync is on. A plaintext endpoint is refused and no credential is sent
 * on it. A failure is one of the typed reasons below; a throttled or
 * unreachable answer is retried a bounded number of times with backoff, while
 * a rejected credential or a missing object is not retried.
 */

import { createHash, createHmac, randomUUID } from "node:crypto";
import {
  REPLICA_STORE_CONTRIBUTION_KIND,
  type ReplicaStore,
  type ReplicaStoreGetResult,
  type ReplicaStoreListResult,
  type ReplicaStorePutResult,
  type ReplicaStoreStatus,
} from "@octant/plugin-api/replica-store";
import { callOfferedReplicaStore } from "@octant/plugin-host/replica-store";
import type { CredentialStore } from "@octant/host-runtime";

/** Path-style (`endpoint/bucket/key`) or virtual-host (`bucket.endpoint/key`). */
export type S3AddressingStyle = "path" | "virtual-host";

export interface S3ReplicaStoreSettings {
  /** Base URL of the S3-compatible endpoint. Only `https:` is accepted. */
  readonly endpoint: string;
  /** Region used in the request signature's credential scope. */
  readonly region: string;
  readonly bucket: string;
  /** Optional key prefix under the bucket; normalized to end with `/`. */
  readonly prefix?: string;
  readonly addressing: S3AddressingStyle;
}

/** Why a request did not produce a usable answer. */
export type S3StoreFailure = "unauthorized" | "not-found" | "throttled" | "unreachable";

export type S3ConnectionTestResult =
  | { readonly status: "reachable" }
  | { readonly status: "not-connected" }
  | { readonly status: "failed"; readonly reason: S3StoreFailure };

export interface S3TransportRequest {
  readonly url: string;
  readonly method: "GET" | "HEAD" | "PUT";
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: Uint8Array;
}

export interface S3TransportResponse {
  readonly status: number;
  readonly body: Uint8Array;
}

/**
 * The one door to the network. Production uses {@link createFetchS3Transport};
 * tests inject a recorded fake so no request leaves the machine.
 */
export type S3Transport = (request: S3TransportRequest) => Promise<S3TransportResponse>;

/**
 * The port plus one store-specific surface: the Test connection probe.
 *
 * Credentials can fail in ways the port's coarse `not-connected`/`refused`
 * results cannot name, so the probe reports the typed reason directly. It
 * writes one probe object and deletes nothing.
 */
export interface S3ReplicaStore extends ReplicaStore {
  readonly testConnection: () => Promise<S3ConnectionTestResult>;
}

export interface OpenS3ReplicaStoreInput {
  readonly settings: S3ReplicaStoreSettings;
  /** Instance id of the host credential-store entry holding the key pair. */
  readonly credentialRef: string;
  readonly credentialStore: CredentialStore;
  /** Sync off means no store call at all. */
  readonly syncOn: boolean;
  readonly installed: boolean;
  readonly enabled: boolean;
  /** `false` for a provider that does not enforce `If-None-Match`. Default `true`. */
  readonly conditionalWrites?: boolean;
  readonly transport?: S3Transport;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly maxAttempts?: number;
  readonly baseBackoffMs?: number;
}

export type OpenS3ReplicaStoreResult =
  | { readonly status: "withheld"; readonly reason: "not-installed" | "disabled" }
  | { readonly status: "offered"; readonly store: S3ReplicaStore };

/**
 * Probe objects live here, under the configured prefix. A port key cannot
 * start a segment with `.`, so a probe can never collide with an entry, and
 * `list` skips it the way the folder store skips its own write temp files.
 */
export const S3_PROBE_KEY_PREFIX = ".octant-probe/";

const S3_LIST_PAGE_SIZE = 1_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_BACKOFF_MS = 100;
const MAX_KEY_LENGTH = 1_024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface S3Credentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

interface Target {
  readonly url: string;
  /** Host header value the signature covers; equals the URL host. */
  readonly host: string;
  /** Canonical URI: each segment encoded, slashes preserved. */
  readonly path: string;
  readonly query: ReadonlyArray<readonly [string, string]>;
}

type Prepared =
  | {
      readonly status: "ready";
      readonly credentials: S3Credentials;
      readonly endpointHost: string;
      readonly prefix: string;
    }
  | { readonly status: "not-connected" }
  | { readonly status: "refused" };

type SendOutcome =
  | { readonly status: "answered"; readonly response: S3TransportResponse }
  | { readonly status: "failed"; readonly reason: S3StoreFailure };

/**
 * Open the bucket store, or withhold it.
 *
 * A disabled or uninstalled store is not constructed and not called, matching
 * the folder store. Nothing here inspects the endpoint on that path.
 */
export function openS3ReplicaStore(input: OpenS3ReplicaStoreInput): OpenS3ReplicaStoreResult {
  const opened = callOfferedReplicaStore(
    { installed: input.installed, enabled: input.enabled },
    () => createS3ReplicaStore(input),
  );
  if ("reason" in opened) return opened;
  return { status: "offered", store: opened };
}

export function createS3ReplicaStore(input: OpenS3ReplicaStoreInput): S3ReplicaStore {
  const transport = input.transport ?? createFetchS3Transport();
  const now = input.now ?? (() => Date.now());
  const sleep = input.sleep ?? defaultSleep;
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const baseBackoffMs = input.baseBackoffMs ?? DEFAULT_BASE_BACKOFF_MS;
  const conditionalWrites = input.conditionalWrites ?? true;
  const { settings } = input;

  async function resolveCredentials(): Promise<S3Credentials | undefined> {
    let stored: string;
    try {
      stored = await input.credentialStore.resolve(input.credentialRef.toLowerCase());
    } catch {
      // A locked or absent secret store is reach, not authority: the store
      // cannot be used now, but nothing about the configuration is refused.
      return undefined;
    }
    return parseCredentialBlob(stored);
  }

  async function prepare(): Promise<Prepared> {
    if (!input.syncOn) return { status: "not-connected" };
    const endpoint = parseEndpoint(settings.endpoint);
    if (endpoint.status === "refused") return { status: "refused" };
    if (!UUID_PATTERN.test(input.credentialRef.toLowerCase())) return { status: "refused" };
    if (settings.region.trim().length === 0) return { status: "refused" };
    if (!bucketAllowed(settings.bucket, settings.addressing)) return { status: "refused" };
    const prefix = normalizePrefix(settings.prefix);
    if (prefix === undefined) return { status: "refused" };
    const credentials = await resolveCredentials();
    if (credentials === undefined) return { status: "not-connected" };
    return { status: "ready", credentials, endpointHost: endpoint.host, prefix };
  }

  async function send(
    prepared: Extract<Prepared, { status: "ready" }>,
    method: "GET" | "HEAD" | "PUT",
    target: Target,
    body: Uint8Array | undefined,
    extraHeaders: Readonly<Record<string, string>> = {},
  ): Promise<SendOutcome> {
    const payload = body ?? new Uint8Array();
    const headers = signedHeadersFor(
      prepared.credentials,
      settings.region,
      method,
      target,
      payload,
      now(),
      extraHeaders,
    );
    let lastFailure: S3StoreFailure = "unreachable";
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response: S3TransportResponse | undefined;
      try {
        response = await transport({
          url: target.url,
          method,
          headers,
          ...(body === undefined ? {} : { body }),
        });
      } catch {
        response = undefined;
      }
      if (response !== undefined) {
        const verdict = classifyStatus(response.status);
        if (verdict === undefined) return { status: "answered", response };
        lastFailure = verdict.reason;
        if (!verdict.transient || attempt >= maxAttempts) {
          return { status: "failed", reason: verdict.reason };
        }
      } else if (attempt >= maxAttempts) {
        return { status: "failed", reason: "unreachable" };
      }
      await sleep(baseBackoffMs * 2 ** (attempt - 1));
    }
    return { status: "failed", reason: lastFailure };
  }

  return {
    kind: REPLICA_STORE_CONTRIBUTION_KIND,

    async status(): Promise<ReplicaStoreStatus> {
      const prepared = await prepare();
      if (prepared.status === "ready") return "ready";
      if (prepared.status === "refused") return "refused";
      return "not-connected";
    },

    async list(afterCursor?: string): Promise<ReplicaStoreListResult> {
      const prepared = await prepare();
      // The port's list refusal names the folder store's outside-home case; an
      // S3 refusal (plaintext endpoint, malformed settings) has no slot there.
      // `status()` and `testConnection()` carry the precise reason.
      if (prepared.status !== "ready") return { status: "not-connected" };
      const query: Array<readonly [string, string]> = [
        ["list-type", "2"],
        ["max-keys", String(S3_LIST_PAGE_SIZE)],
      ];
      if (prepared.prefix.length > 0) query.push(["prefix", prepared.prefix]);
      if (afterCursor !== undefined && afterCursor.length > 0) {
        query.push(["continuation-token", afterCursor]);
      }
      const target = buildTarget(
        settings.addressing,
        settings.bucket,
        [],
        query,
        prepared.endpointHost,
      );
      const outcome = await send(prepared, "GET", target, undefined);
      if (outcome.status === "failed" || outcome.response.status !== 200) {
        return { status: "not-connected" };
      }
      const parsed = parseListResponse(new TextDecoder().decode(outcome.response.body));
      const probePrefix = `${prepared.prefix}${S3_PROBE_KEY_PREFIX}`;
      const entries: Array<{ key: string }> = [];
      for (const raw of parsed.keys) {
        if (raw.startsWith(probePrefix)) continue;
        if (!raw.startsWith(prepared.prefix)) continue;
        entries.push({ key: raw.slice(prepared.prefix.length) });
      }
      return {
        status: "ready",
        entries,
        // A bucket has no sync-client placeholders or conflict copies; the
        // only non-entry keys are our own probes, which are skipped above.
        reports: [],
        ...(parsed.nextToken === undefined ? {} : { nextCursor: parsed.nextToken }),
      };
    },

    async get(key: string): Promise<ReplicaStoreGetResult> {
      if (!validObjectKey(key)) return { status: "refused", reason: "key-refused" };
      const prepared = await prepare();
      if (prepared.status !== "ready") return { status: "not-connected" };
      const target = buildTarget(
        settings.addressing,
        settings.bucket,
        objectSegments(`${prepared.prefix}${key}`),
        [],
        prepared.endpointHost,
      );
      const outcome = await send(prepared, "GET", target, undefined);
      if (outcome.status === "failed") return { status: "not-connected" };
      if (outcome.response.status === 404) return { status: "missing" };
      if (outcome.response.status !== 200) return { status: "not-connected" };
      return { status: "ready", bytes: outcome.response.body };
    },

    async putIfAbsent(key: string, bytes: Uint8Array): Promise<ReplicaStorePutResult> {
      const snapshot = new Uint8Array(bytes);
      if (!validObjectKey(key)) return { status: "refused", reason: "key-refused" };
      const prepared = await prepare();
      if (prepared.status !== "ready") return { status: "not-connected" };
      const target = buildTarget(
        settings.addressing,
        settings.bucket,
        objectSegments(`${prepared.prefix}${key}`),
        [],
        prepared.endpointHost,
      );
      if (!conditionalWrites) {
        // A provider without a conditional create cannot be asked to leave the
        // key untouched. HEAD first, then PUT only when the key is absent. This
        // can race, and the last write wins — harmless here because every key
        // is unique to one host's instance and sequence, so no two hosts ever
        // write the same key and there is nothing to lose.
        const head = await send(prepared, "HEAD", target, undefined);
        if (head.status === "failed") return { status: "refused", reason: "write-failed" };
        if (head.response.status === 200) return { status: "already-exists" };
        if (head.response.status !== 404) return { status: "refused", reason: "write-failed" };
        const outcome = await send(prepared, "PUT", target, snapshot);
        if (outcome.status === "failed") return { status: "refused", reason: "write-failed" };
        const status = outcome.response.status;
        if (status === 200 || status === 201) return { status: "stored" };
        if (status === 409 || status === 412) return { status: "already-exists" };
        return { status: "refused", reason: "write-failed" };
      }
      const outcome = await send(prepared, "PUT", target, snapshot, { "if-none-match": "*" });
      if (outcome.status === "failed") return { status: "refused", reason: "write-failed" };
      const status = outcome.response.status;
      if (status === 200 || status === 201) return { status: "stored" };
      if (status === 409 || status === 412) return { status: "already-exists" };
      return { status: "refused", reason: "write-failed" };
    },

    async testConnection(): Promise<S3ConnectionTestResult> {
      const prepared = await prepare();
      if (prepared.status !== "ready") return { status: "not-connected" };
      // A write-once probe proves authentication and write access. It is never
      // deleted: the probe namespace is skipped by `list`, so nothing has to be
      // cleaned up for the log to stay readable.
      const probeKey = `${prepared.prefix}${S3_PROBE_KEY_PREFIX}${randomUUID()}`;
      const target = buildTarget(
        settings.addressing,
        settings.bucket,
        objectSegments(probeKey),
        [],
        prepared.endpointHost,
      );
      const headers = conditionalWrites ? { "if-none-match": "*" } : {};
      const outcome = await send(prepared, "PUT", target, new Uint8Array(), headers);
      if (outcome.status === "failed") return { status: "failed", reason: outcome.reason };
      const status = outcome.response.status;
      if (status === 200 || status === 201 || status === 409 || status === 412) {
        return { status: "reachable" };
      }
      return { status: "failed", reason: failureReason(status) };
    },
  };
}

/**
 * The production transport: the global `fetch`, with redirects turned into
 * errors so a redirect can never carry the signed request to another host.
 */
export function createFetchS3Transport(fetchImpl: typeof fetch = fetch): S3Transport {
  return async (request) => {
    const response = await fetchImpl(request.url, {
      method: request.method,
      headers: { ...request.headers },
      redirect: "error",
      ...(request.body === undefined ? {} : { body: Buffer.from(request.body) }),
    });
    return { status: response.status, body: new Uint8Array(await response.arrayBuffer()) };
  };
}

interface ParsedEndpoint {
  readonly status: "ready";
  readonly host: string;
}

function parseEndpoint(endpoint: string): ParsedEndpoint | { readonly status: "refused" } {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return { status: "refused" };
  }
  // Only authenticated TLS. A plaintext endpoint would expose the credential
  // on the wire, so it is refused before any request is built.
  if (url.protocol !== "https:") return { status: "refused" };
  if (url.host.length === 0) return { status: "refused" };
  // The addressing model is host-based; a configured base path would be
  // silently dropped from every request, so it is refused rather than ignored.
  if (url.pathname !== "/" && url.pathname !== "") return { status: "refused" };
  return { status: "ready", host: url.host };
}

function buildTarget(
  addressing: S3AddressingStyle,
  bucket: string,
  segments: ReadonlyArray<string>,
  query: ReadonlyArray<readonly [string, string]>,
  endpointHost: string,
): Target {
  const pathStyle = addressing === "path";
  const base = pathStyle ? [bucket, ...segments] : segments;
  const host = pathStyle ? endpointHost : `${bucket}.${endpointHost}`;
  const path =
    base.length === 0 ? "/" : `/${base.map((segment) => uriEncode(segment, true)).join("/")}`;
  const encodedQuery = canonicalQuery(query);
  const url = `https://${host}${path}${encodedQuery.length === 0 ? "" : `?${encodedQuery}`}`;
  return { url, host, path, query };
}

function objectSegments(objectKey: string): ReadonlyArray<string> {
  return objectKey.split("/").filter((segment) => segment.length > 0);
}

function bucketAllowed(bucket: string, addressing: S3AddressingStyle): boolean {
  if (bucket.length === 0 || bucket.length > 63) return false;
  if (
    bucket.includes("/") ||
    bucket.includes("\\") ||
    bucket.includes(" ") ||
    bucket.includes("..")
  ) {
    return false;
  }
  // A virtual-host bucket becomes a DNS label, so it must be DNS-safe. A
  // path-style bucket is only a path segment and may be looser.
  if (addressing === "virtual-host") return /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket);
  return true;
}

/** Normalize a configured prefix to `a/b/`, or refuse a malformed one. */
function normalizePrefix(prefix: string | undefined): string | undefined {
  if (prefix === undefined) return "";
  const trimmed = prefix.replace(/^\/+/, "").replace(/\/+$/, "");
  if (trimmed.length === 0) return "";
  const segments = trimmed.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    return undefined;
  }
  return `${trimmed}/`;
}

/**
 * A key is a relative path under the prefix. Anything that could leave the
 * prefix, or that is one of our own probe names, is refused before a request.
 */
function validObjectKey(key: string): boolean {
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) return false;
  if (key.startsWith("/") || key.includes("\\") || key.includes("\0")) return false;
  return key
    .split("/")
    .every(
      (segment) =>
        segment.length > 0 && segment !== "." && segment !== ".." && !segment.startsWith("."),
    );
}

/**
 * Read the key pair out of the credential-store entry.
 *
 * The host credential store holds one opaque string per id, so an S3 store
 * keeps its pair as `{"accessKeyId":...,"secretAccessKey":...}` under its own
 * credential id. A blob that is not exactly that shape is treated as no
 * credential rather than guessed at.
 */
function parseCredentialBlob(stored: string): S3Credentials | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 2 || !keys.includes("accessKeyId") || !keys.includes("secretAccessKey")) {
    return undefined;
  }
  const accessKeyId = record["accessKeyId"];
  const secretAccessKey = record["secretAccessKey"];
  if (typeof accessKeyId !== "string" || accessKeyId.length === 0) return undefined;
  if (typeof secretAccessKey !== "string" || secretAccessKey.length === 0) return undefined;
  return { accessKeyId, secretAccessKey };
}

/** `undefined` for a status the caller interprets (2xx, 404, 409, 412). */
function classifyStatus(
  status: number,
): { readonly reason: S3StoreFailure; readonly transient: boolean } | undefined {
  if (status >= 200 && status < 300) return undefined;
  if (status === 404) return undefined;
  if (status === 409 || status === 412) return undefined;
  if (status === 401 || status === 403) return { reason: "unauthorized", transient: false };
  if (status === 429 || status === 503) return { reason: "throttled", transient: true };
  if (status === 408 || status === 500 || status === 502 || status === 504) {
    return { reason: "unreachable", transient: true };
  }
  return { reason: "unreachable", transient: false };
}

function failureReason(status: number): S3StoreFailure {
  const verdict = classifyStatus(status);
  if (verdict !== undefined) return verdict.reason;
  if (status === 404) return "not-found";
  return "unreachable";
}

function signedHeadersFor(
  credentials: S3Credentials,
  region: string,
  method: "GET" | "HEAD" | "PUT",
  target: Target,
  payload: Uint8Array,
  timestamp: number,
  extra: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  const { long, short } = amzDate(timestamp);
  const payloadHash = sha256Hex(payload);
  const signed: ReadonlyArray<readonly [string, string]> = [
    ["host", target.host],
    ["x-amz-content-sha256", payloadHash],
    ["x-amz-date", long],
  ];
  const canonicalHeaders = signed.map(([name, value]) => `${name}:${value}\n`).join("");
  const signedHeaderNames = signed.map(([name]) => name).join(";");
  const canonicalRequest = [
    method,
    target.path,
    canonicalQuery(target.query),
    canonicalHeaders,
    signedHeaderNames,
    payloadHash,
  ].join("\n");
  const scope = `${short}/${region}/s3/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", long, scope, sha256HexText(canonicalRequest)].join(
    "\n",
  );
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${credentials.secretAccessKey}`, short), region), "s3"),
    "aws4_request",
  );
  const signature = createHmac("sha256", signingKey).update(stringToSign, "utf8").digest("hex");
  const authorization =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaderNames}, Signature=${signature}`;
  return {
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": long,
    ...extra,
    authorization,
  };
}

function canonicalQuery(query: ReadonlyArray<readonly [string, string]>): string {
  return query
    .map(([name, value]) => [uriEncode(name, true), uriEncode(value, true)] as const)
    .sort((left, right) =>
      left[0] < right[0]
        ? -1
        : left[0] > right[0]
          ? 1
          : left[1] < right[1]
            ? -1
            : left[1] > right[1]
              ? 1
              : 0,
    )
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function amzDate(timestamp: number): { readonly long: string; readonly short: string } {
  const long = new Date(timestamp)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  return { long, short: long.slice(0, 8) };
}

/** RFC 3986 encoding, leaving `A-Za-z0-9_.~-` (and optionally `/`) alone. */
function uriEncode(value: string, encodeSlash: boolean): string {
  let encoded = "";
  for (const byte of new TextEncoder().encode(value)) {
    const character = String.fromCharCode(byte);
    if (/[A-Za-z0-9_.~-]/.test(character) && (encodeSlash || character !== "/")) {
      encoded += character;
    } else {
      encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return encoded;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256HexText(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function hmac(key: string | Uint8Array, data: string): Uint8Array {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

interface ParsedList {
  readonly keys: ReadonlyArray<string>;
  readonly nextToken?: string;
}

/**
 * Read the keys and the continuation token out of a ListObjectsV2 body.
 *
 * Only the two fields the store needs are read; a full XML parser is not worth
 * a dependency for a response this store asked for and can shape.
 */
function parseListResponse(xml: string): ParsedList {
  const keys: string[] = [];
  for (const match of xml.matchAll(/<Key>([^<]*)<\/Key>/g)) {
    const value = match[1];
    if (value !== undefined) keys.push(decodeXmlText(value));
  }
  const next = /<NextContinuationToken>([^<]*)<\/NextContinuationToken>/.exec(xml)?.[1];
  return {
    keys,
    ...(next === undefined || next.length === 0 ? {} : { nextToken: decodeXmlText(next) }),
  };
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
