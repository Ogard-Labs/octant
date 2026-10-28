import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REMOTE_PUSH_DELIVERY_HEADERS,
  REMOTE_PUSH_GATEWAY_DEFAULT_URL,
  decodeRemotePushDeliveryRequestV1,
  decodeRemotePushEnvelopeV1,
  remotePushDeliverySigningText,
  type RemotePushEnvelopeV1,
} from "@octant/contracts/remote-push-notifications";
import { afterEach, describe, expect, it } from "vitest";
import { createGatewayPushDeliveryTransport } from "./gatewayPushDeliveryTransport";
import { PUSH_GATEWAY_SETTING_FILE, createPushGatewaySetting } from "./pushGatewaySetting";
import type { HostSigningPort } from "./remoteProtocolService";

const capability = `v1.k1.${"A".repeat(64)}`;
const envelope: RemotePushEnvelopeV1 = decodeRemotePushEnvelopeV1({
  alert: { title: "Octant", body: "A paired computer has an update" },
  collapseId: "B".repeat(22),
  urgency: "high",
  sealed: { encapsulatedKey: "C".repeat(43), ciphertext: "D".repeat(64) },
});
const destination = { deviceId: "device-1", platform: "ios" as const, token: capability };

function hostSigning(): HostSigningPort {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const der = publicKey.export({ format: "der", type: "spki" });
  return {
    hostKeyFingerprint: createHash("sha256").update(der).digest("hex"),
    hostPublicKey: der.toString("base64url"),
    signHostPayload: (payload) =>
      sign("sha256", Buffer.from(payload), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString(
        "base64url",
      ),
  };
}

interface Received {
  readonly path: string | undefined;
  readonly headers: IncomingMessage["headers"];
  readonly body: string;
}

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((done) => server.close(() => done()))),
  );
});

/** A local stand-in gateway answering every delivery with one status and body. */
async function localGateway(answer: { readonly status: number; readonly body?: unknown }) {
  const received: Received[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      received.push({
        path: request.url,
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(answer.status, { "content-type": "application/json" });
      response.end(JSON.stringify(answer.body ?? {}));
    });
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, received };
}

describe("gateway push delivery", () => {
  it("sends the capability and sealed envelope, signed by the paired host key, to the configured gateway", async () => {
    const gateway = await localGateway({ status: 202, body: { result: "delivered" } });
    const signing = hostSigning();
    const transport = createGatewayPushDeliveryTransport({
      settings: () => ({ enabled: true, gatewayUrl: gateway.url }),
      signing: () => signing,
      clock: () => new Date("2026-10-28T12:00:00.000Z"),
    });

    expect(transport.providerDelivery()).toBe("available");
    await expect(transport.send({ destination, envelope })).resolves.toEqual({
      kind: "delivered",
    });

    const [request] = gateway.received;
    expect(request?.path).toBe("/v1/deliveries");
    const body = request?.body ?? "";
    expect(decodeRemotePushDeliveryRequestV1(JSON.parse(body))).toEqual({ capability, envelope });
    const timestamp = String(request?.headers[REMOTE_PUSH_DELIVERY_HEADERS.timestamp]);
    expect(timestamp).toBe("2026-10-28T12:00:00.000Z");
    const hostKey = String(request?.headers[REMOTE_PUSH_DELIVERY_HEADERS.hostKey]);
    expect(createHash("sha256").update(Buffer.from(hostKey, "base64url")).digest("hex")).toBe(
      signing.hostKeyFingerprint,
    );
    const signed = remotePushDeliverySigningText({
      timestamp,
      bodySha256: createHash("sha256").update(body).digest("base64url"),
    });
    expect(
      verify(
        "sha256",
        Buffer.from(signed),
        {
          key: createPublicKey({
            key: Buffer.from(hostKey, "base64url"),
            format: "der",
            type: "spki",
          }),
          dsaEncoding: "ieee-p1363",
        },
        Buffer.from(String(request?.headers[REMOTE_PUSH_DELIVERY_HEADERS.signature]), "base64url"),
      ),
    ).toBe(true);
    // Nothing that names the host, a thread, or a person rides along.
    expect(Object.keys(JSON.parse(body)).sort()).toEqual(["capability", "envelope"]);
  });

  it("reaches no gateway and reports delivery unavailable while the setting is off", async () => {
    const gateway = await localGateway({ status: 202 });
    const transport = createGatewayPushDeliveryTransport({
      settings: () => ({ enabled: false, gatewayUrl: gateway.url }),
      signing: hostSigning,
    });

    expect(transport.providerDelivery()).toBe("unavailable");
    await expect(transport.send({ destination, envelope })).resolves.toEqual({
      kind: "failed",
      retryable: false,
      category: "provider-unavailable",
    });
    expect(gateway.received).toHaveLength(0);
  });

  it.each([
    [410, { code: "destination-gone" }, { kind: "destination-gone" }],
    [
      421,
      { code: "capability-not-issued-here" },
      { kind: "failed", retryable: false, category: "gateway-mismatch" },
    ],
    [
      429,
      { code: "rate-limited" },
      { kind: "failed", retryable: true, category: "gateway-rate-limited" },
    ],
    [
      403,
      { code: "host-key-mismatch" },
      { kind: "failed", retryable: false, category: "gateway-refused" },
    ],
    [
      502,
      { code: "platform-failed" },
      { kind: "failed", retryable: true, category: "gateway-failed" },
    ],
  ] as const)(
    "reads a gateway answer of %i as the host outcome it means",
    async (status, body, outcome) => {
      const gateway = await localGateway({ status, body });
      const transport = createGatewayPushDeliveryTransport({
        settings: () => ({ enabled: true, gatewayUrl: gateway.url }),
        signing: hostSigning,
      });
      await expect(transport.send({ destination, envelope })).resolves.toEqual(outcome);
    },
  );

  it("does not follow a gateway's redirect with the signed request", async () => {
    const gateway = await localGateway({ status: 307 });
    const transport = createGatewayPushDeliveryTransport({
      settings: () => ({ enabled: true, gatewayUrl: gateway.url }),
      signing: hostSigning,
    });
    await expect(transport.send({ destination, envelope })).resolves.toEqual({
      kind: "failed",
      retryable: true,
      category: "gateway-failed",
    });
    expect(gateway.received).toHaveLength(1);
  });

  it("fails without sending when the host has no listener identity to sign with", async () => {
    const gateway = await localGateway({ status: 202 });
    const transport = createGatewayPushDeliveryTransport({
      settings: () => ({ enabled: true, gatewayUrl: gateway.url }),
      signing: () => undefined,
    });
    await expect(transport.send({ destination, envelope })).resolves.toEqual({
      kind: "failed",
      retryable: false,
      category: "host-identity-unavailable",
    });
    expect(gateway.received).toHaveLength(0);
  });

  it("reports an unreachable gateway as a retryable failure", async () => {
    const transport = createGatewayPushDeliveryTransport({
      settings: () => ({ enabled: true, gatewayUrl: "http://127.0.0.1:9" }),
      signing: hostSigning,
    });
    await expect(transport.send({ destination, envelope })).resolves.toEqual({
      kind: "failed",
      retryable: true,
      category: "gateway-unreachable",
    });
  });
});

describe("push gateway setting", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true });
  });
  const dataDirectory = () => {
    const directory = mkdtempSync(join(tmpdir(), "octant-push-gateway-"));
    directories.push(directory);
    return directory;
  };

  it("starts off, pointed at the Octant gateway", () => {
    expect(createPushGatewaySetting(dataDirectory()).current()).toEqual({
      kind: "remote-push-gateway-settings",
      enabled: false,
      gatewayUrl: REMOTE_PUSH_GATEWAY_DEFAULT_URL,
      version: 0,
    });
  });

  it("keeps a change across a restart in an owner-only file", () => {
    const directory = dataDirectory();
    const change = createPushGatewaySetting(directory).change({
      enabled: true,
      gatewayUrl: "https://push.example.test",
      expectedVersion: 0,
    });
    expect(change.kind).toBe("changed");
    expect(createPushGatewaySetting(directory).current()).toEqual({
      kind: "remote-push-gateway-settings",
      enabled: true,
      gatewayUrl: "https://push.example.test",
      version: 1,
    });
    expect(statSync(join(directory, PUSH_GATEWAY_SETTING_FILE)).mode & 0o777).toBe(0o600);
  });

  it("refuses a change made from a stale read", () => {
    const setting = createPushGatewaySetting(dataDirectory());
    setting.change({
      enabled: true,
      gatewayUrl: REMOTE_PUSH_GATEWAY_DEFAULT_URL,
      expectedVersion: 0,
    });
    const stale = setting.change({
      enabled: false,
      gatewayUrl: REMOTE_PUSH_GATEWAY_DEFAULT_URL,
      expectedVersion: 0,
    });
    expect(stale.kind).toBe("stale-version");
    expect(setting.current().enabled).toBe(true);
  });
});
