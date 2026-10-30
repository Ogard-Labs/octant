// The gateway rules of a hub that sends notifications directly, against local
// stand-ins for Apple's push service (HTTP/2), Google's OAuth endpoint, and FCM.
// The sender is the real one; only the addresses it dials are swapped, which no
// setting or request can do.

import {
  createHash,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import { createServer as createHttpServer, type Server } from "node:http";
import {
  createServer as createHttp2Server,
  type Http2Server,
  type IncomingHttpHeaders,
  type ServerHttp2Stream,
} from "node:http2";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  decodeRemotePushEnvelopeV1,
  type HubDirectPushEnvironment,
  type RemotePushEnvelopeV1,
  type RemotePushPlatform,
} from "@octant/contracts";
import { remotePushDeliverySigningText } from "@octant/domain/push-notification-policy";
import { signGatewayDelivery } from "../remote/gatewayPushDeliveryTransport";
import type { HostSigningPort } from "../remote/remoteProtocolService";
import { createDirectPushGateway, type DirectPushGatewayAnswer } from "./directPushGateway";
import {
  DIRECT_PUSH_ORIGINS,
  createDirectPushSender,
  type AppleCredential,
  type GoogleCredential,
} from "./directPushSenders";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const envelope: RemotePushEnvelopeV1 = decodeRemotePushEnvelopeV1({
  alert: { title: "Octant", body: "A paired computer has an update" },
  collapseId: "B".repeat(22),
  urgency: "high",
  sealed: { encapsulatedKey: "C".repeat(43), ciphertext: "D".repeat(64) },
});

const appleKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const googleKey = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = (key: KeyObject) => String(key.export({ type: "pkcs8", format: "pem" }));
const apple: AppleCredential = {
  keyId: "ABCDE12345",
  teamId: "TEAM123456",
  bundleId: "com.example.octant",
  privateKey: pem(appleKey.privateKey),
};
const google: GoogleCredential = {
  clientEmail: "push@demo-project.iam.gserviceaccount.com",
  projectId: "demo-project",
  privateKey: pem(googleKey.privateKey),
};
const APPLE_TOKEN = "ab".repeat(32);

interface Recorded {
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

interface PlatformStandIns {
  readonly apns: {
    readonly seen: Recorded[];
    status: number;
    reason: string | undefined;
    hang: boolean;
  };
  readonly apnsSandbox: { readonly seen: Recorded[] };
  readonly oauth: { readonly seen: Recorded[]; status: number };
  readonly fcm: { readonly seen: Recorded[]; status: number; redirect: boolean };
  readonly redirected: { count: number };
  readonly origins: {
    readonly apnsProduction: string;
    readonly apnsDevelopment: string;
    readonly googleOAuth: string;
    readonly fcm: string;
  };
}

async function listenHttp(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function listenHttp2(server: Http2Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function apnsStandIn(state: {
  seen: Recorded[];
  status: number;
  reason: string | undefined;
  hang: boolean;
}) {
  const server = createHttp2Server();
  server.on("stream", (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
    let body = "";
    stream.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    stream.on("end", () => {
      state.seen.push({ headers: { ...headers, path: String(headers[":path"]) }, body });
      if (state.hang) return;
      stream.respond({ ":status": state.status });
      stream.end(state.reason === undefined ? "" : JSON.stringify({ reason: state.reason }));
    });
  });
  return server;
}

async function startPlatforms(): Promise<PlatformStandIns> {
  const apns = {
    seen: [] as Recorded[],
    status: 200,
    reason: undefined as string | undefined,
    hang: false,
  };
  const apnsSandbox = { seen: [] as Recorded[], status: 200, reason: undefined, hang: false };
  const oauth = { seen: [] as Recorded[], status: 200 };
  const fcm = { seen: [] as Recorded[], status: 200, redirect: false };
  const redirected = { count: 0 };
  const apnsProduction = await listenHttp2(apnsStandIn(apns));
  const apnsDevelopment = await listenHttp2(apnsStandIn(apnsSandbox));
  const googleServer = createHttpServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      const url = request.url ?? "";
      if (url === "/token") {
        oauth.seen.push({ headers: request.headers, body });
        response.writeHead(oauth.status, { "content-type": "application/json" });
        response.end(JSON.stringify({ access_token: "access-1", expires_in: 3600 }));
      } else if (url === "/elsewhere") {
        redirected.count += 1;
        response.writeHead(200).end();
      } else {
        fcm.seen.push({ headers: { ...request.headers, path: url }, body });
        if (fcm.redirect) {
          response.writeHead(302, { location: "/elsewhere" }).end();
        } else {
          response.writeHead(fcm.status).end("{}");
        }
      }
    });
  });
  const google = await listenHttp(googleServer);
  return {
    apns,
    apnsSandbox,
    oauth,
    fcm,
    redirected,
    origins: { apnsProduction, apnsDevelopment, googleOAuth: google, fcm: google },
  };
}

/** A phone's computer: the host key the phone pairs with and signs deliveries as the real transport does. */
function makeHost(): HostSigningPort {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const der = publicKey.export({ type: "spki", format: "der" });
  return {
    hostPublicKey: der.toString("base64url"),
    hostKeyFingerprint: createHash("sha256").update(der).digest("hex"),
    signHostPayload: (payload) =>
      sign("sha256", Buffer.from(payload), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString(
        "base64url",
      ),
  };
}

async function harness(options: { sealingKey?: Buffer; timeoutMs?: number } = {}) {
  const platforms = await startPlatforms();
  const clock = { t: Date.now() };
  const state = {
    enabled: true,
    environment: "production" as HubDirectPushEnvironment,
    apple: apple as AppleCredential | undefined,
    google: google as GoogleCredential | undefined,
  };
  const sender = createDirectPushSender({
    credentials: { apple: async () => state.apple, google: async () => state.google },
    environment: () => state.environment,
    now: () => clock.t,
    origins: platforms.origins,
    timeoutMs: options.timeoutMs ?? 2_000,
  });
  const key = options.sealingKey ?? randomBytes(32);
  const gateway = createDirectPushGateway({
    enabled: () => state.enabled,
    sealingKey: async () => key,
    holdsCredential: async (platform) =>
      platform === "ios" ? state.apple !== undefined : state.google !== undefined,
    sender,
    now: () => clock.t,
  });
  const host = makeHost();

  const capabilityFor = async (
    platform: RemotePushPlatform,
    token: string,
    client = "client-1",
  ) => {
    const answer = await gateway.issueCapability(
      JSON.stringify({ platform, token, hostKeyFingerprint: host.hostKeyFingerprint }),
      client,
    );
    if (!("capability" in answer)) throw new Error(`No capability: ${answer.status}`);
    return answer.capability;
  };
  const signed = (capability: string, signer: HostSigningPort = host, at = clock.t) => {
    const delivery = signGatewayDelivery({
      signing: signer,
      destination: { deviceId: "device-1", platform: "ios", token: capability },
      envelope,
      clock: () => new Date(at),
    });
    if (delivery === undefined) throw new Error("not signed");
    return delivery;
  };
  const deliver = (delivery: ReturnType<typeof signed>) =>
    gateway.deliver(delivery.body, {
      hostKey: delivery.hostKey,
      timestamp: delivery.timestamp,
      signature: delivery.signature,
    });
  return { platforms, clock, state, gateway, host, capabilityFor, signed, deliver, key };
}

const code = (answer: DirectPushGatewayAnswer) => ("code" in answer ? answer.code : undefined);

describe("a hub that sends notifications directly", () => {
  it("reaches only Apple's push service, Google's OAuth endpoint, and FCM", () => {
    expect(Object.values(DIRECT_PUSH_ORIGINS).sort()).toEqual([
      "https://api.push.apple.com",
      "https://api.sandbox.push.apple.com",
      "https://fcm.googleapis.com",
      "https://oauth2.googleapis.com",
    ]);
  });

  it("sends the placeholder alert and the sealed content to Apple, and nothing else", async () => {
    const h = await harness();
    const capability = await h.capabilityFor("ios", APPLE_TOKEN);

    const answer = await h.deliver(h.signed(capability));

    expect(answer.status).toBe(202);
    const request = h.platforms.apns.seen[0];
    expect(request?.headers.path).toBe(`/3/device/${APPLE_TOKEN}`);
    expect(request?.headers["apns-topic"]).toBe("com.example.octant");
    expect(request?.headers["apns-push-type"]).toBe("alert");
    expect(request?.headers["apns-priority"]).toBe("10");
    expect(request?.headers["apns-collapse-id"]).toBe("B".repeat(22));
    expect(JSON.parse(request?.body ?? "")).toEqual({
      aps: {
        alert: { title: "Octant", body: "A paired computer has an update" },
        "mutable-content": 1,
      },
      octant: { version: 1, encapsulatedKey: "C".repeat(43), ciphertext: "D".repeat(64) },
    });
    // The provider token is an ES256 JWT from the person's key, for their team and key id.
    const [header, claims, signature] = String(request?.headers.authorization).slice(7).split(".");
    expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString())).toEqual({
      alg: "ES256",
      kid: "ABCDE12345",
    });
    expect(JSON.parse(Buffer.from(claims ?? "", "base64url").toString()).iss).toBe("TEAM123456");
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${claims}`),
        { key: appleKey.publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature ?? "", "base64url"),
      ),
    ).toBe(true);
  });

  it("sends normal urgency to Apple at priority five", async () => {
    const h = await harness();
    const capability = await h.capabilityFor("ios", APPLE_TOKEN);
    const normal = { ...envelope, urgency: "normal" as const };
    const delivery = signGatewayDelivery({
      signing: h.host,
      destination: { deviceId: "device-1", platform: "ios", token: capability },
      envelope: normal,
      clock: () => new Date(h.clock.t),
    });
    if (delivery === undefined) throw new Error("not signed");

    await h.deliver(delivery);

    expect(h.platforms.apns.seen[0]?.headers["apns-priority"]).toBe("5");
  });

  it("sends to Apple's sandbox only when the build is marked development", async () => {
    const h = await harness();
    h.state.environment = "development";
    const capability = await h.capabilityFor("ios", APPLE_TOKEN);

    expect((await h.deliver(h.signed(capability))).status).toBe(202);

    expect(h.platforms.apnsSandbox.seen).toHaveLength(1);
    expect(h.platforms.apns.seen).toHaveLength(0);
  });

  it("sends a data-only message to FCM with a token minted from the service account", async () => {
    const h = await harness();
    const capability = await h.capabilityFor("android", "fcm-registration-token");

    const answer = await h.deliver(h.signed(capability));

    expect(answer.status).toBe(202);
    const form = new URLSearchParams(h.platforms.oauth.seen[0]?.body);
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const [header, claims, signature] = String(form.get("assertion")).split(".");
    expect(JSON.parse(Buffer.from(header ?? "", "base64url").toString()).alg).toBe("RS256");
    const parsedClaims = JSON.parse(Buffer.from(claims ?? "", "base64url").toString());
    expect(parsedClaims.iss).toBe(google.clientEmail);
    expect(parsedClaims.aud).toBe("https://oauth2.googleapis.com/token");
    expect(parsedClaims.scope).toBe("https://www.googleapis.com/auth/firebase.messaging");
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${claims}`),
        googleKey.publicKey,
        Buffer.from(signature ?? "", "base64url"),
      ),
    ).toBe(true);
    const sent = h.platforms.fcm.seen[0];
    expect(sent?.headers.path).toBe("/v1/projects/demo-project/messages:send");
    expect(sent?.headers.authorization).toBe("Bearer access-1");
    expect(JSON.parse(sent?.body ?? "")).toEqual({
      message: {
        token: "fcm-registration-token",
        data: {
          version: "1",
          encapsulatedKey: "C".repeat(43),
          ciphertext: "D".repeat(64),
        },
        android: { collapse_key: "B".repeat(22), priority: "HIGH" },
      },
    });
  });

  it("reuses the access token until it nears expiry", async () => {
    const h = await harness();
    const capability = await h.capabilityFor("android", "fcm-registration-token");

    await h.deliver(h.signed(capability));
    h.clock.t += 1_000;
    await h.deliver(h.signed(capability));

    expect(h.platforms.oauth.seen).toHaveLength(1);
    expect(h.platforms.fcm.seen).toHaveLength(2);
  });

  it("answers unavailable to both routes while direct sending is off", async () => {
    const h = await harness();
    const capability = await h.capabilityFor("ios", APPLE_TOKEN);
    h.state.enabled = false;

    const issued = await h.gateway.issueCapability(
      JSON.stringify({
        platform: "ios",
        token: APPLE_TOKEN,
        hostKeyFingerprint: h.host.hostKeyFingerprint,
      }),
      "client-1",
    );
    const delivered = await h.deliver(h.signed(capability));

    expect([issued.status, code(issued)]).toEqual([503, "unavailable"]);
    expect([delivered.status, code(delivered)]).toEqual([503, "unavailable"]);
    expect(h.platforms.apns.seen).toHaveLength(0);
  });

  describe("refusals", () => {
    it("refuses a body that is not a delivery request, or is over 8 KiB, as malformed", async () => {
      const h = await harness();
      const headers = { hostKey: "x", timestamp: "x", signature: "x" };

      const notJson = await h.gateway.deliver("nope", headers);
      const wrongShape = await h.gateway.deliver(JSON.stringify({ capability: 1 }), headers);
      const tooLarge = await h.gateway.deliver(" ".repeat(8_193), headers);

      for (const answer of [notJson, wrongShape, tooLarge]) {
        expect([answer.status, code(answer)]).toEqual([400, "malformed"]);
      }
    });

    it("answers 421 for a capability another gateway or key issued, or anyone altered", async () => {
      const mine = await harness();
      const other = await harness();
      const foreign = await other.capabilityFor("ios", APPLE_TOKEN);
      const own = await mine.capabilityFor("ios", APPLE_TOKEN);
      const altered = `${own.slice(0, -2)}${own.endsWith("AA") ? "BB" : "AA"}`;
      const otherKeyId = own.replace(".hub1.", ".old1.");

      for (const capability of [foreign, altered, otherKeyId]) {
        const answer = await mine.deliver(mine.signed(capability));
        expect([answer.status, code(answer)]).toEqual([421, "capability-not-issued-here"]);
      }
      expect(mine.platforms.apns.seen).toHaveLength(0);
    });

    it("refuses a request signed by a key other than the one sealed in the capability", async () => {
      const h = await harness();
      const capability = await h.capabilityFor("ios", APPLE_TOKEN);

      const answer = await h.deliver(h.signed(capability, makeHost()));

      expect([answer.status, code(answer)]).toEqual([403, "host-key-mismatch"]);
    });

    it("refuses a timestamp more than five minutes from its clock and a signature that does not verify", async () => {
      const h = await harness();
      const capability = await h.capabilityFor("ios", APPLE_TOKEN);

      const stale = await h.deliver(h.signed(capability, h.host, h.clock.t - 301_000));
      const early = await h.deliver(h.signed(capability, h.host, h.clock.t + 301_000));
      const good = h.signed(capability);
      const forged = await h.deliver({ ...good, signature: makeHost().signHostPayload("other") });
      const missing = await h.gateway.deliver(good.body, {
        hostKey: good.hostKey,
        timestamp: null,
        signature: null,
      });

      for (const answer of [stale, early, forged, missing]) {
        expect([answer.status, code(answer)]).toEqual([401, "signature-invalid"]);
      }
      expect(h.platforms.apns.seen).toHaveLength(0);
    });

    it("refuses a signed request it saw in the last ten minutes, and takes it again after", async () => {
      const h = await harness();
      const capability = await h.capabilityFor("ios", APPLE_TOKEN);
      const delivery = h.signed(capability);

      const first = await h.deliver(delivery);
      const replay = await h.deliver(delivery);
      // The same signed text with the signature's other valid form is the same request.
      h.clock.t += 601_000;
      const refreshed = await h.deliver(h.signed(capability));

      expect(first.status).toBe(202);
      expect([replay.status, code(replay)]).toEqual([401, "signature-invalid"]);
      expect(refreshed.status).toBe(202);
      expect(h.platforms.apns.seen).toHaveLength(2);
    });

    it("allows twelve deliveries a minute per capability and refuses the thirteenth", async () => {
      const h = await harness();
      const capability = await h.capabilityFor("ios", APPLE_TOKEN);

      const answers: DirectPushGatewayAnswer[] = [];
      for (let index = 0; index < 13; index += 1) {
        h.clock.t += 10;
        answers.push(await h.deliver(h.signed(capability)));
      }

      expect(answers.slice(0, 12).every((answer) => answer.status === 202)).toBe(true);
      expect([answers[12]?.status, code(answers[12] as DirectPushGatewayAnswer)]).toEqual([
        429,
        "rate-limited",
      ]);
      h.clock.t += 61_000;
      expect((await h.deliver(h.signed(capability))).status).toBe(202);
    });

    it("counts a phone's deliveries across every capability that names it", async () => {
      const h = await harness();
      const first = await h.capabilityFor("ios", APPLE_TOKEN);
      // The same phone spelled in upper case still shares the one counter.
      const second = await h.capabilityFor("ios", APPLE_TOKEN.toUpperCase());
      expect(second).not.toBe(first);

      for (let index = 0; index < 12; index += 1) {
        h.clock.t += 10;
        await h.deliver(h.signed(index % 2 === 0 ? first : second));
      }
      h.clock.t += 10;
      const answer = await h.deliver(h.signed(second));

      expect([answer.status, code(answer)]).toEqual([429, "rate-limited"]);
    });

    it("limits capabilities to thirty a minute per client address", async () => {
      const h = await harness();
      const request = JSON.stringify({
        platform: "ios",
        token: APPLE_TOKEN,
        hostKeyFingerprint: h.host.hostKeyFingerprint,
      });

      const answers: DirectPushGatewayAnswer[] = [];
      for (let index = 0; index < 31; index += 1) {
        answers.push(await h.gateway.issueCapability(request, "client-1"));
      }
      const another = await h.gateway.issueCapability(request, "client-2");

      expect(answers.slice(0, 30).every((answer) => answer.status === 200)).toBe(true);
      expect([answers[30]?.status, code(answers[30] as DirectPushGatewayAnswer)]).toEqual([
        429,
        "rate-limited",
      ]);
      expect(another.status).toBe(200);
    });

    it("refuses a capability request with a token over 512 bytes, an Apple token that is not hexadecimal, or a stray field", async () => {
      const h = await harness();
      const fingerprint = h.host.hostKeyFingerprint;
      const refusals = await Promise.all(
        [
          { platform: "android", token: "t".repeat(513), hostKeyFingerprint: fingerprint },
          { platform: "ios", token: "../../v1", hostKeyFingerprint: fingerprint },
          { platform: "ios", token: APPLE_TOKEN, hostKeyFingerprint: fingerprint, extra: 1 },
        ].map((request) => h.gateway.issueCapability(JSON.stringify(request), "client-1")),
      );

      for (const answer of refusals)
        expect([answer.status, code(answer)]).toEqual([400, "malformed"]);
    });

    it("issues no capability for a platform it holds no credential for", async () => {
      const h = await harness();
      h.state.google = undefined;

      const answer = await h.gateway.issueCapability(
        JSON.stringify({
          platform: "android",
          token: "fcm-registration-token",
          hostKeyFingerprint: h.host.hostKeyFingerprint,
        }),
        "client-1",
      );

      expect([answer.status, code(answer)]).toEqual([503, "unavailable"]);
    });

    it("answers 503 unavailable when the credential was removed after the capability was issued", async () => {
      const h = await harness();
      const capability = await h.capabilityFor("ios", APPLE_TOKEN);
      h.state.apple = undefined;

      const answer = await h.deliver(h.signed(capability));

      expect([answer.status, code(answer)]).toEqual([503, "unavailable"]);
    });
  });

  describe("what the platforms answer", () => {
    it("answers 410 when Apple refuses the token as gone", async () => {
      const h = await harness();
      const capability = await h.capabilityFor("ios", APPLE_TOKEN);
      h.platforms.apns.status = 410;
      h.platforms.apns.reason = "Unregistered";

      const answer = await h.deliver(h.signed(capability));

      expect([answer.status, code(answer)]).toEqual([410, "destination-gone"]);
    });

    it("keeps the registration when Apple calls the device token bad, which a wrong environment also causes, and answers 502", async () => {
      const h = await harness();
      const capability = await h.capabilityFor("ios", APPLE_TOKEN);
      h.platforms.apns.status = 400;
      h.platforms.apns.reason = "BadDeviceToken";
      const bad = await h.deliver(h.signed(capability));
      h.clock.t += 10;
      h.platforms.apns.status = 400;
      h.platforms.apns.reason = "PayloadEmpty";
      const failed = await h.deliver(h.signed(capability));
      h.clock.t += 10;
      h.platforms.apns.status = 500;
      h.platforms.apns.reason = undefined;
      const down = await h.deliver(h.signed(capability));

      expect([bad.status, code(bad)]).toEqual([502, "platform-failed"]);
      expect([failed.status, code(failed)]).toEqual([502, "platform-failed"]);
      expect([down.status, code(down)]).toEqual([502, "platform-failed"]);
    });

    it("answers 410 when FCM says the registration is gone, and 502 for any other refusal", async () => {
      const h = await harness();
      const capability = await h.capabilityFor("android", "fcm-registration-token");
      h.platforms.fcm.status = 404;
      const gone = await h.deliver(h.signed(capability));
      h.clock.t += 10;
      h.platforms.fcm.status = 500;
      const failed = await h.deliver(h.signed(capability));

      expect([gone.status, code(gone)]).toEqual([410, "destination-gone"]);
      expect([failed.status, code(failed)]).toEqual([502, "platform-failed"]);
    });

    it("answers 502 when Google refuses to mint an access token", async () => {
      const h = await harness();
      const capability = await h.capabilityFor("android", "fcm-registration-token");
      h.platforms.oauth.status = 400;

      const answer = await h.deliver(h.signed(capability));

      expect([answer.status, code(answer)]).toEqual([502, "platform-failed"]);
      expect(h.platforms.fcm.seen).toHaveLength(0);
    });

    it("does not follow a redirect from the platform", async () => {
      const h = await harness();
      const capability = await h.capabilityFor("android", "fcm-registration-token");
      h.platforms.fcm.redirect = true;

      const answer = await h.deliver(h.signed(capability));

      expect([answer.status, code(answer)]).toEqual([502, "platform-failed"]);
      expect(h.platforms.redirected.count).toBe(0);
    });

    it("gives up on a platform that does not answer", async () => {
      const h = await harness({ timeoutMs: 150 });
      const capability = await h.capabilityFor("ios", APPLE_TOKEN);
      h.platforms.apns.hang = true;

      const answer = await h.deliver(h.signed(capability));

      expect([answer.status, code(answer)]).toEqual([502, "platform-failed"]);
    });
  });

  it("never returns or logs the credential in any answer", async () => {
    const h = await harness();
    const capability = await h.capabilityFor("ios", APPLE_TOKEN);
    h.platforms.apns.status = 500;

    const answers = [await h.deliver(h.signed(capability)), await h.deliver(h.signed(capability))];

    const text = JSON.stringify(answers) + capability;
    expect(text).not.toContain("PRIVATE KEY");
    expect(text).not.toContain(APPLE_TOKEN);
    expect(text).not.toContain(apple.keyId);
  });

  it("signs the text the domain policy builds, so any gateway can verify it", async () => {
    const h = await harness();
    const capability = await h.capabilityFor("ios", APPLE_TOKEN);
    const delivery = h.signed(capability);
    const text = remotePushDeliverySigningText({
      timestamp: delivery.timestamp,
      bodySha256: createHash("sha256").update(delivery.body).digest("base64url"),
    });

    expect(
      verify(
        "sha256",
        Buffer.from(text),
        {
          key: createPublicKey({
            key: Buffer.from(delivery.hostKey, "base64url"),
            format: "der",
            type: "spki",
          }),
          dsaEncoding: "ieee-p1363",
        },
        Buffer.from(delivery.signature, "base64url"),
      ),
    ).toBe(true);
  });
});
