import { describe, expect, it } from "vitest";
import { CredentialStoreFailure, type CredentialStore } from "@octant/host-runtime";
import {
  S3_PROBE_KEY_PREFIX,
  openS3ReplicaStore,
  type OpenS3ReplicaStoreInput,
  type S3ReplicaStore,
  type S3ReplicaStoreSettings,
  type S3Transport,
  type S3TransportRequest,
  type S3TransportResponse,
} from "./s3ReplicaStore";

// No S3-compatible test server ships in this repository's dev tooling, so the
// store is exercised through a recorded fake that enforces the S3 semantics it
// depends on: the list response shape, object reads, and — the one this store's
// write-once promise rests on — a conditional create that a second PUT cannot
// override.

const ENDPOINT = "https://s3.example.test";
const BUCKET = "octant-replica";
const CREDENTIAL_REF = "22222222-2222-4222-8222-222222222222";

function response(status: number, body = ""): S3TransportResponse {
  return { status, body: new TextEncoder().encode(body) };
}

function credentialStore(blob: string | undefined): CredentialStore {
  return {
    async set() {},
    async has() {
      return blob !== undefined;
    },
    async resolve() {
      if (blob === undefined) throw new CredentialStoreFailure("missing");
      return blob;
    },
    async delete() {},
  };
}

function credentialBlob(): string {
  return JSON.stringify({ accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret-example" });
}

function settings(overrides: Partial<S3ReplicaStoreSettings> = {}): S3ReplicaStoreSettings {
  return {
    endpoint: ENDPOINT,
    region: "us-east-1",
    bucket: BUCKET,
    addressing: "path",
    ...overrides,
  };
}

interface BucketFake {
  readonly objects: Map<string, Uint8Array>;
  readonly requests: S3TransportRequest[];
  override: ((request: S3TransportRequest) => S3TransportResponse | undefined) | undefined;
  readonly transport: S3Transport;
}

/**
 * A minimal in-memory bucket. PUT honours `If-None-Match: *`, HEAD and GET
 * report presence, and list answers with the ListObjectsV2 shape the store
 * parses. A test can force one response with `override`.
 */
function bucketFake(): BucketFake {
  const objects = new Map<string, Uint8Array>();
  const requests: S3TransportRequest[] = [];
  const forced: {
    override: ((request: S3TransportRequest) => S3TransportResponse | undefined) | undefined;
  } = {
    override: undefined,
  };
  const transport: S3Transport = async (request) => {
    requests.push(request);
    const override = forced.override?.(request);
    if (override !== undefined) return override;
    const url = new URL(request.url);
    const prefix = url.searchParams.get("prefix") ?? "";
    if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      const contents = keys.map((key) => `<Contents><Key>${key}</Key></Contents>`).join("");
      return response(
        200,
        `<ListBucketResult>${contents}<IsTruncated>false</IsTruncated></ListBucketResult>`,
      );
    }
    const key = decodeURIComponent(
      url.pathname.replace(/^\//, "").replace(new RegExp(`^${BUCKET}/`), ""),
    );
    if (request.method === "HEAD") return response(objects.has(key) ? 200 : 404);
    if (request.method === "GET") {
      const stored = objects.get(key);
      return stored === undefined ? response(404) : { status: 200, body: stored };
    }
    if (request.headers["if-none-match"] === "*" && objects.has(key)) return response(412);
    objects.set(key, request.body ?? new Uint8Array());
    return response(200);
  };
  return {
    objects,
    requests,
    get override() {
      return forced.override;
    },
    set override(next) {
      forced.override = next;
    },
    transport,
  };
}

const unreachableTransport: S3Transport = async () => {
  throw new Error("Tests never reach the network.");
};

function offeredStore(overrides: Partial<OpenS3ReplicaStoreInput> = {}): S3ReplicaStore {
  const opened = openS3ReplicaStore({
    settings: settings(),
    credentialRef: CREDENTIAL_REF,
    credentialStore: credentialStore(credentialBlob()),
    syncOn: true,
    installed: true,
    enabled: true,
    transport: unreachableTransport,
    sleep: async () => {},
    ...overrides,
  });
  if (opened.status !== "offered") throw new Error("Store was not offered.");
  return opened.store;
}

const KEY = "11111111-1111-4111-8111-111111111111/1.json";

describe("S3 replica store", () => {
  it("publishes a key only when the object is absent and leaves the original bytes", async () => {
    const bucket = bucketFake();
    const store = offeredStore({ transport: bucket.transport });
    const original = new TextEncoder().encode("original");
    expect(await store.putIfAbsent(KEY, original)).toEqual({ status: "stored" });

    const replacement = new TextEncoder().encode("replacement");
    expect(await store.putIfAbsent(KEY, replacement)).toEqual({ status: "already-exists" });

    expect(bucket.objects.get(KEY)).toEqual(original);
    expect(await store.get(KEY)).toEqual({ status: "ready", bytes: original });
    const publish = bucket.requests.find((request) => request.method === "PUT");
    expect(publish?.headers["if-none-match"]).toBe("*");
  });

  it("asks the bucket to leave an existing key untouched with a conditional create", async () => {
    const bucket = bucketFake();
    const store = offeredStore({ transport: bucket.transport });
    await store.putIfAbsent(KEY, new TextEncoder().encode("kept"));
    const conditional = bucket.requests.filter(
      (request) => request.method === "PUT" && request.headers["if-none-match"] === "*",
    );
    expect(conditional).toHaveLength(1);
  });

  it("falls back to a head-then-put when the provider has no conditional create", async () => {
    const bucket = bucketFake();
    const store = offeredStore({ transport: bucket.transport, conditionalWrites: false });
    expect(await store.putIfAbsent(KEY, new TextEncoder().encode("kept"))).toEqual({
      status: "stored",
    });
    expect(bucket.requests.map((request) => request.method)).toEqual(["HEAD", "PUT"]);
    expect(bucket.requests[1]?.headers["if-none-match"]).toBeUndefined();

    const before = bucket.requests.length;
    expect(await store.putIfAbsent(KEY, new TextEncoder().encode("no"))).toEqual({
      status: "already-exists",
    });
    expect(bucket.requests.slice(before).map((request) => request.method)).toEqual(["HEAD"]);
    expect(bucket.objects.get(KEY)).toEqual(new TextEncoder().encode("kept"));
  });

  it("signs the request with the access key from the host credential store", async () => {
    const bucket = bucketFake();
    const store = offeredStore({ transport: bucket.transport });
    await store.get(KEY);
    const authorization = bucket.requests[0]?.headers["authorization"] ?? "";
    expect(authorization.startsWith("AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/")).toBe(true);
    expect(authorization).toContain("SignedHeaders=host;x-amz-content-sha256;x-amz-date");
    expect(authorization).toContain("Signature=");
  });

  it("signs a request exactly as SigV4 defines it", async () => {
    // The expected header was computed independently with the AWS Signature
    // Version 4 algorithm for this method, host, path, credentials, and time,
    // so a change to the signer that no longer matches AWS fails here.
    const bucket = bucketFake();
    const store = offeredStore({
      transport: bucket.transport,
      settings: settings({ endpoint: "https://s3.us-east-1.amazonaws.com", region: "us-east-1" }),
      now: () => Date.UTC(2026, 9, 6, 9, 0, 0),
    });
    await store.get(KEY);
    const request = bucket.requests[0];
    expect(request).toBeDefined();
    if (request === undefined) return;
    expect(request.headers["authorization"]).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20261006/us-east-1/s3/aws4_request, " +
        "SignedHeaders=host;x-amz-content-sha256;x-amz-date, " +
        "Signature=231e7f4f75a6fcd9855be4f1d516dd3b96262272b2fbcc6ee067aca6139517b8",
    );
  });

  it("sends every request to the configured endpoint and nowhere else", async () => {
    const bucket = bucketFake();
    const store = offeredStore({ transport: bucket.transport });
    await store.putIfAbsent(KEY, new TextEncoder().encode("kept"));
    await store.get(KEY);
    await store.list();
    expect(bucket.requests.length).toBeGreaterThan(0);
    for (const request of bucket.requests) {
      expect(new URL(request.url).origin).toBe(ENDPOINT);
    }
  });

  it("addresses a virtual-host bucket as a subdomain of the configured endpoint", async () => {
    const bucket = bucketFake();
    const store = offeredStore({
      transport: bucket.transport,
      settings: settings({ addressing: "virtual-host" }),
    });
    await store.get(KEY);
    const request = bucket.requests[0];
    expect(request).toBeDefined();
    if (request === undefined) return;
    const url = new URL(request.url);
    expect(url.host).toBe(`octant-replica.s3.example.test`);
    expect(url.origin).toBe(`https://octant-replica.s3.example.test`);
  });

  it("stores and reads a key under the configured prefix", async () => {
    const bucket = bucketFake();
    const store = offeredStore({
      transport: bucket.transport,
      settings: settings({ prefix: "log" }),
    });
    const bytes = new TextEncoder().encode("prefixed");
    expect(await store.putIfAbsent(KEY, bytes)).toEqual({ status: "stored" });
    expect(bucket.objects.has(`log/${KEY}`)).toBe(true);
    expect(await store.get(KEY)).toEqual({ status: "ready", bytes });
  });

  it("reports a rejected credential as unauthorized instead of waiting", async () => {
    const bucket = bucketFake();
    bucket.override = () => response(403);
    const store = offeredStore({ transport: bucket.transport });
    expect(await store.testConnection()).toEqual({ status: "failed", reason: "unauthorized" });
    expect(bucket.requests).toHaveLength(1);
  });

  it("retries a throttled answer with backoff and stops at the bounded attempt count", async () => {
    const bucket = bucketFake();
    bucket.override = () => response(429);
    const delays: number[] = [];
    const store = offeredStore({
      transport: bucket.transport,
      maxAttempts: 3,
      baseBackoffMs: 100,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    expect(await store.testConnection()).toEqual({ status: "failed", reason: "throttled" });
    expect(bucket.requests).toHaveLength(3);
    expect(delays).toEqual([100, 200]);
  });

  it("succeeds once a throttled answer clears", async () => {
    const bucket = bucketFake();
    let calls = 0;
    bucket.override = () => (calls++ === 0 ? response(429) : undefined);
    const store = offeredStore({ transport: bucket.transport });
    expect(await store.testConnection()).toEqual({ status: "reachable" });
    expect(bucket.requests).toHaveLength(2);
  });

  it("treats a lost connection as unreachable and retries it", async () => {
    const bucket = bucketFake();
    let calls = 0;
    const store = offeredStore({
      transport: async (request) => {
        bucket.requests.push(request);
        calls += 1;
        if (calls < 2) throw new Error("connection reset");
        return response(503);
      },
      maxAttempts: 2,
    });
    expect(await store.testConnection()).toEqual({ status: "failed", reason: "throttled" });
    expect(calls).toBe(2);
  });

  it("does not retry a missing object", async () => {
    const bucket = bucketFake();
    const store = offeredStore({ transport: bucket.transport });
    expect(await store.get("11111111-1111-4111-8111-111111111111/absent.json")).toEqual({
      status: "missing",
    });
    expect(bucket.requests).toHaveLength(1);
  });

  it("lists the keys under the prefix and strips it from each entry", async () => {
    const bucket = bucketFake();
    const store = offeredStore({
      transport: bucket.transport,
      settings: settings({ prefix: "log" }),
    });
    await store.putIfAbsent("a/1.json", new TextEncoder().encode("a"));
    await store.putIfAbsent("b/1.json", new TextEncoder().encode("b"));
    const listed = await store.list();
    expect(listed).toEqual({
      status: "ready",
      entries: [{ key: "a/1.json" }, { key: "b/1.json" }],
      reports: [],
    });
  });

  it("follows a continuation token to the next page", async () => {
    const bucket = bucketFake();
    bucket.override = (request) => {
      const token = new URL(request.url).searchParams.get("continuation-token");
      if (token === null) {
        return response(
          200,
          `<ListBucketResult><Contents><Key>id/1.json</Key></Contents><IsTruncated>true</IsTruncated><NextContinuationToken>TOKEN-1</NextContinuationToken></ListBucketResult>`,
        );
      }
      return response(
        200,
        `<ListBucketResult><Contents><Key>id/2.json</Key></Contents><IsTruncated>false</IsTruncated></ListBucketResult>`,
      );
    };
    const store = offeredStore({ transport: bucket.transport });
    expect(await store.list()).toEqual({
      status: "ready",
      entries: [{ key: "id/1.json" }],
      reports: [],
      nextCursor: "TOKEN-1",
    });
    expect(await store.list("TOKEN-1")).toEqual({
      status: "ready",
      entries: [{ key: "id/2.json" }],
      reports: [],
    });
    const second = bucket.requests[1];
    expect(second).toBeDefined();
    if (second === undefined) return;
    expect(new URL(second.url).searchParams.get("continuation-token")).toBe("TOKEN-1");
  });

  it("writes one connection probe and does not list it as an entry", async () => {
    const bucket = bucketFake();
    const store = offeredStore({ transport: bucket.transport });
    expect(await store.testConnection()).toEqual({ status: "reachable" });
    expect([...bucket.objects.keys()].some((key) => key.includes(S3_PROBE_KEY_PREFIX))).toBe(true);
    expect(bucket.requests.every((request) => request.method === "PUT")).toBe(true);
    expect(await store.list()).toEqual({ status: "ready", entries: [], reports: [] });
  });

  it("makes no request at all while sync is off", async () => {
    const bucket = bucketFake();
    const store = offeredStore({ transport: bucket.transport, syncOn: false });
    expect(await store.status()).toBe("not-connected");
    expect(await store.list()).toEqual({ status: "not-connected" });
    expect(await store.get(KEY)).toEqual({ status: "not-connected" });
    expect(await store.putIfAbsent(KEY, new Uint8Array([1]))).toEqual({ status: "not-connected" });
    expect(await store.testConnection()).toEqual({ status: "not-connected" });
    expect(bucket.requests).toHaveLength(0);
  });

  it("refuses a plaintext endpoint and never sends the credential", async () => {
    const bucket = bucketFake();
    const store = offeredStore({
      transport: bucket.transport,
      settings: settings({ endpoint: "http://s3.example.test" }),
    });
    expect(await store.status()).toBe("refused");
    expect(await store.testConnection()).toEqual({ status: "not-connected" });
    expect(bucket.requests).toHaveLength(0);
  });

  it("refuses an endpoint that carries a base path rather than dropping it", async () => {
    const bucket = bucketFake();
    const store = offeredStore({
      transport: bucket.transport,
      settings: settings({ endpoint: "https://s3.example.test/tenant" }),
    });
    expect(await store.status()).toBe("refused");
    expect(await store.testConnection()).toEqual({ status: "not-connected" });
    expect(bucket.requests).toHaveLength(0);
  });

  it("reports a rejected credential as a write failure on publish", async () => {
    const bucket = bucketFake();
    bucket.override = () => response(403);
    const store = offeredStore({ transport: bucket.transport });
    expect(await store.putIfAbsent(KEY, new Uint8Array([1]))).toEqual({
      status: "refused",
      reason: "write-failed",
    });
  });

  it("refuses a key that could leave the prefix", async () => {
    const bucket = bucketFake();
    const store = offeredStore({ transport: bucket.transport });
    expect(await store.putIfAbsent("../escape.json", new Uint8Array([1]))).toEqual({
      status: "refused",
      reason: "key-refused",
    });
    expect(await store.get("id/../../escape.json")).toEqual({
      status: "refused",
      reason: "key-refused",
    });
    expect(bucket.requests).toHaveLength(0);
  });

  it("does not offer or call a store that is not installed or not enabled", async () => {
    const base = {
      settings: settings(),
      credentialRef: CREDENTIAL_REF,
      credentialStore: credentialStore(credentialBlob()),
      syncOn: true,
      installed: true,
      enabled: true,
      transport: bucketFake().transport,
    };
    expect(openS3ReplicaStore({ ...base, installed: false })).toEqual({
      status: "withheld",
      reason: "not-installed",
    });
    expect(openS3ReplicaStore({ ...base, enabled: false })).toEqual({
      status: "withheld",
      reason: "disabled",
    });
  });

  it("stays not connected when the credential store has no entry", async () => {
    const bucket = bucketFake();
    const store = offeredStore({
      transport: bucket.transport,
      credentialStore: credentialStore(undefined),
    });
    expect(await store.status()).toBe("not-connected");
    expect(await store.testConnection()).toEqual({ status: "not-connected" });
    expect(bucket.requests).toHaveLength(0);
  });

  it("reports ready when the store is configured and sync is on", async () => {
    const bucket = bucketFake();
    const store = offeredStore({ transport: bucket.transport });
    expect(await store.status()).toBe("ready");
  });
});
