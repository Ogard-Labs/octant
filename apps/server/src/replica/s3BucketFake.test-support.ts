/**
 * A recorded fake of an S3-compatible bucket for tests.
 *
 * No S3-compatible test server ships in this repository's dev tooling, so
 * stores are exercised through this fake, which enforces the S3 semantics the
 * store depends on: the ListObjectsV2 response shape, object reads, and the
 * conditional create (`If-None-Match: *`) a second PUT cannot override. It
 * makes no network call.
 */

import type { S3Transport, S3TransportRequest, S3TransportResponse } from "./s3ReplicaStore";

export function response(status: number, body = ""): S3TransportResponse {
  return { status, body: new TextEncoder().encode(body) };
}

export interface BucketFake {
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
export function bucketFake(bucket: string): BucketFake {
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
      url.pathname.replace(/^\//, "").replace(new RegExp(`^${bucket}/`), ""),
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

