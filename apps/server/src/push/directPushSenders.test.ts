// Verifies direct APNs (HTTP/2) and FCM (HTTPS) sending from any host:
// alert payloads, APNs liveactivity push type and topic, FCM data-only alert
// and live-status payloads (without collapse_key), and fixed outbound origins
// so no gateway or credential-supplied token_uri is ever contacted.

import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import {
  createServer as createHttp2Server,
  type Http2Server,
  type ServerHttp2Stream,
} from "node:http2";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { decodeStableHostId, type UtcTimestamp } from "@octant/contracts";
import {
  buildLiveStatusPushMessage,
  buildPushAlert,
} from "@octant/domain/push-notification-policy";
import { createDirectPushSender, DIRECT_PUSH_ORIGINS } from "./directPushSenders";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const exportPem = (key: KeyObject) => String(key.export({ type: "pkcs8", format: "pem" }));
const applePem = exportPem(generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey);
const googlePem = exportPem(generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey);

const hostId = decodeStableHostId("11111111-1111-4111-8111-111111111111");
const threadId = "00000000-0000-4000-8000-000000000001";
const occurredAt = "2026-11-28T12:00:00.000Z" as UtcTimestamp;
const staleAt = "2026-11-28T12:30:00.000Z" as UtcTimestamp;

async function startFakeApns(status = 200) {
  const requests: Array<{
    readonly path: string;
    readonly headers: Record<string, string | string[] | undefined>;
    readonly body: Record<string, unknown>;
  }> = [];
  const server: Http2Server = createHttp2Server();
  server.on("stream", (stream: ServerHttp2Stream, headers) => {
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk));
    stream.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      requests.push({
        path: String(headers[":path"] ?? ""),
        headers: headers as Record<string, string | string[] | undefined>,
        body,
      });
      stream.respond({ ":status": status });
      stream.end(status === 200 ? "" : JSON.stringify({ reason: "Unregistered" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, requests };
}

async function startFakeHttpServer(
  respond: (request: IncomingMessage, body: string) => { status: number; body: unknown },
) {
  const requests: Array<{
    readonly url: string;
    readonly headers: IncomingMessage["headers"];
    readonly body: string;
  }> = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({ url: req.url ?? "", headers: req.headers, body });
      const answer = respond(req, body);
      res.writeHead(answer.status, { "content-type": "application/json" });
      res.end(JSON.stringify(answer.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, requests };
}

describe("direct APNs and FCM push sending", () => {
  it("fixes production outbound origins to Apple and Google with no gateway origin", () => {
    expect(DIRECT_PUSH_ORIGINS).toEqual({
      apnsProduction: "https://api.push.apple.com",
      apnsDevelopment: "https://api.sandbox.push.apple.com",
      googleTokenService: "https://oauth2.googleapis.com",
      fcm: "https://fcm.googleapis.com",
    });
  });

  it("sends v2 alerts and liveactivity updates directly over HTTP/2 to APNs", async () => {
    const apns = await startFakeApns(200);
    const sender = createDirectPushSender({
      credentials: {
        apple: async () => ({
          keyId: "ABCDE12345",
          teamId: "TEAM123456",
          bundleId: "app.octant.mobile",
          privateKey: applePem,
        }),
        google: async () => undefined,
      },
      environment: () => "production",
      now: () => Date.parse(occurredAt),
      origins: { apnsProduction: apns.origin },
    });

    const alert = buildPushAlert({
      source: "thread",
      kind: "approval-needed",
      hostId,
      threadId,
      mode: "code",
      computerLabel: "Studio Mac",
      threadTitles: false,
      collapseId: "q2HnS1wZcV0k3fA8uYt7Rg",
      sequence: 1,
      occurredAt,
      heldSecrets: { status: "ready", values: [] },
    });
    expect(await sender.send({ platform: "ios", token: "a".repeat(64), message: alert })).toBe(
      "accepted",
    );

    const live = buildLiveStatusPushMessage({
      event: "update",
      hostId,
      computerLabel: "Studio Mac",
      sequence: 4,
      occurredAt,
      staleAt,
      counts: { needsYou: 1, failed: 0, working: 1, done: 0 },
      rows: [
        {
          threadId,
          mode: "code",
          status: "approval-needed",
          updatedAt: occurredAt,
          title: "Fix release",
        },
      ],
      threadTitles: false,
      heldSecrets: { status: "ready", values: [] },
    });
    expect(await sender.send({ platform: "ios", token: "b".repeat(64), message: live })).toBe(
      "accepted",
    );

    expect(apns.requests).toHaveLength(2);
    expect(apns.requests[0]?.headers["apns-push-type"]).toBe("alert");
    expect(apns.requests[0]?.headers["apns-topic"]).toBe("app.octant.mobile");
    expect(apns.requests[0]?.headers["apns-collapse-id"]).toBe("q2HnS1wZcV0k3fA8uYt7Rg");
    expect(apns.requests[0]?.body).toMatchObject({
      aps: {
        alert: { title: "Approval needed", body: "On Studio Mac" },
        "thread-id": hostId,
        "mutable-content": 1,
      },
      octant: { v: 2, kind: "approval-needed", hostId, threadId, mode: "code" },
    });

    expect(apns.requests[1]?.headers["apns-push-type"]).toBe("liveactivity");
    expect(apns.requests[1]?.headers["apns-topic"]).toBe(
      "app.octant.mobile.push-type.liveactivity",
    );
    expect(apns.requests[1]?.body).toMatchObject({
      aps: {
        event: "update",
        "stale-date": Math.floor(Date.parse(staleAt) / 1_000),
        "content-state": {
          name: "AgentActivity",
          props: {
            v: 1,
            hostId,
            computerName: "Studio Mac",
            sequence: 4,
            counts: { needsYou: 1, failed: 0, working: 1, done: 0 },
          },
        },
      },
    });
  });

  it("sends data-only v2 alerts with collapse_key and live-status without collapse_key directly to FCM", async () => {
    const oauth = await startFakeHttpServer(() => ({
      status: 200,
      body: { access_token: "google-access-token", expires_in: 3600 },
    }));
    const fcm = await startFakeHttpServer(() => ({
      status: 200,
      body: { name: "projects/demo-project/messages/1" },
    }));
    const sender = createDirectPushSender({
      credentials: {
        apple: async () => undefined,
        google: async () => ({
          projectId: "demo-project",
          clientEmail: "push@demo-project.iam.gserviceaccount.com",
          privateKey: googlePem,
        }),
      },
      environment: () => "production",
      now: () => Date.parse(occurredAt),
      origins: { googleTokenService: oauth.origin, fcm: fcm.origin },
    });

    const alert = buildPushAlert({
      source: "thread",
      kind: "waiting",
      hostId,
      threadId,
      mode: "work",
      computerLabel: "Studio Mac",
      threadTitles: false,
      collapseId: "q2HnS1wZcV0k3fA8uYt7Rg",
      sequence: 1,
      occurredAt,
      heldSecrets: { status: "ready", values: [] },
    });
    expect(await sender.send({ platform: "android", token: "fcm-tok-1", message: alert })).toBe(
      "accepted",
    );

    const live = buildLiveStatusPushMessage({
      event: "update",
      hostId,
      computerLabel: "Studio Mac",
      sequence: 2,
      occurredAt,
      staleAt,
      counts: { needsYou: 0, failed: 0, working: 1, done: 0 },
      rows: [],
      threadTitles: false,
      heldSecrets: { status: "ready", values: [] },
    });
    expect(await sender.send({ platform: "android", token: "fcm-tok-1", message: live })).toBe(
      "accepted",
    );

    expect(oauth.requests).toHaveLength(1);
    expect(fcm.requests).toHaveLength(2);

    const alertBody = JSON.parse(fcm.requests[0]?.body ?? "{}") as {
      message: {
        android: { collapse_key?: string; priority: string };
        data: Record<string, string>;
      };
    };
    expect(alertBody.message.android.collapse_key).toBe("q2HnS1wZcV0k3fA8uYt7Rg");
    expect(alertBody.message.android.priority).toBe("HIGH");
    expect(alertBody.message.data).toEqual({
      v: "2",
      kind: "waiting",
      hostId,
      threadId,
      mode: "work",
      title: "Waiting for you",
      body: "On Studio Mac",
    });

    const liveBody = JSON.parse(fcm.requests[1]?.body ?? "{}") as {
      message: { android: { collapse_key?: string }; data: Record<string, string> };
    };
    expect(liveBody.message.android.collapse_key).toBeUndefined();
    expect(liveBody.message.data.v).toBe("2");
    expect(liveBody.message.data.type).toBe("live-status");
  });
});
