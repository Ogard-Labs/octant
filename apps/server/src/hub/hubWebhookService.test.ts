import { createHmac, generateKeyPairSync, sign } from "node:crypto";
import type { HubMemberId, StableHostId, WebhookEndpointId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import type { HubStatePort, HubState } from "./hubStateStore";
import { HubWebhookService } from "./hubWebhookService";
import type { PublicRequest } from "./publicEntrance";
import { mintWebhookSecret, sealWebhookSecret } from "./publicEntranceCrypto";

const HUB = "22222222-2222-4222-8222-222222222222";
const SPOKE = "11111111-1111-4111-8111-111111111111" as HubMemberId;
const ENDPOINT = "BBBBBBBBBBBBBBBBBBBBBB" as WebhookEndpointId;
const NOW = 1_800_000_000_000;

function memoryState(): HubStatePort {
  let state: HubState = {};
  return { load: () => state, save: (next) => void (state = next) };
}

function hubIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  return {
    hostId: HUB as StableHostId,
    displayName: "Mac mini",
    signing: {
      hostKeyFingerprint: "",
      hostPublicKey: spki,
      signHostPayload: (payload: string) =>
        sign("sha256", Buffer.from(payload), {
          key: privateKey,
          dsaEncoding: "ieee-p1363",
        }).toString("base64url"),
    },
  };
}

function setup(options: { readonly forward?: "unreachable" | "accepted" } = {}) {
  const clock = { now: NOW };
  const forwarded: string[] = [];
  const woken: string[] = [];
  const identity = hubIdentity();
  const service = new HubWebhookService({
    state: memoryState(),
    identity: () => identity,
    hubMemberId: () => HUB,
    serving: () => true,
    send: async (_spoke, envelope) => {
      if (options.forward === "unreachable") return undefined;
      forwarded.push(envelope.deliveryId);
      return { status: "accepted" };
    },
    wake: async (memberId) => void woken.push(memberId),
    record: () => undefined,
    now: () => clock.now,
  });
  const secret = mintWebhookSecret();
  const key = service.sealingKey();
  service.receiveEndpoints(SPOKE, {
    endpoints: [
      {
        endpointId: ENDPOINT,
        spokeMemberId: SPOKE,
        scheme: "standard-webhooks",
        sealedSecrets: [
          sealWebhookSecret({
            secret,
            endpointId: ENDPOINT,
            recipientMemberId: HUB as HubMemberId,
            recipientPublicKey: key.sealingPublicKey,
          }),
        ],
      },
    ],
  });
  return { service, secret, clock, forwarded, woken };
}

function delivery(input: {
  readonly secret: string;
  readonly id: string;
  readonly timestampMs: number;
  readonly body?: string;
  readonly endpointId?: string;
  readonly signature?: string;
}): PublicRequest {
  const body = Buffer.from(input.body ?? '{"ref":"refs/heads/main"}');
  const seconds = Math.floor(input.timestampMs / 1000);
  const signature =
    input.signature ??
    createHmac("sha256", Buffer.from(input.secret.slice("whsec_".length), "base64"))
      .update(`${input.id}.${seconds}.`)
      .update(body)
      .digest("base64");
  return {
    route: "webhook",
    params: { id: input.endpointId ?? ENDPOINT },
    method: "POST",
    path: `/hooks/${input.endpointId ?? ENDPOINT}`,
    headers: new Map([
      ["webhook-id", input.id],
      ["webhook-timestamp", String(seconds)],
      ["webhook-signature", `v1,${signature}`],
      ["content-type", "application/json"],
    ]),
    principal: { kind: "webhook", endpointId: input.endpointId ?? ENDPOINT },
    readBody: async (maxBytes) =>
      body.length > maxBytes ? { status: "too-large" } : { status: "read", bytes: body },
    signal: new AbortController().signal,
  };
}

describe("webhook receipt on the hub", () => {
  it("queues a signed delivery and answers 202", async () => {
    const { service, secret } = setup({ forward: "unreachable" });
    const answer = await service.handle(delivery({ secret, id: "msg_1", timestampMs: NOW }));
    expect(answer.status).toBe(202);
    expect(service.status().queued).toBe(1);
  });

  it("refuses a delivery whose timestamp is older than five minutes", async () => {
    const { service, secret } = setup({ forward: "unreachable" });
    const answer = await service.handle(
      delivery({ secret, id: "msg_1", timestampMs: NOW - 5 * 60_000 - 1_000 }),
    );
    expect(answer.status).toBe(400);
    expect(service.status().queued).toBe(0);
  });

  it("a redelivered webhook id starts no second run", async () => {
    const { service, secret } = setup({ forward: "unreachable" });
    await service.handle(delivery({ secret, id: "msg_1", timestampMs: NOW }));
    const again = await service.handle(delivery({ secret, id: "msg_1", timestampMs: NOW }));
    expect(again.status).toBe(200);
    expect(again.body).toBe('{"duplicate":true}');
    expect(service.status().queued).toBe(1);
  });

  it("drops a forged delivery before it queues anything", async () => {
    const { service, secret } = setup({ forward: "unreachable" });
    const answer = await service.handle(
      delivery({ secret, id: "msg_1", timestampMs: NOW, signature: "bm9wZQ==" }),
    );
    expect(answer.status).toBe(401);
    expect(service.status().queued).toBe(0);
  });

  it("answers an unknown endpoint exactly as a disabled one, and a large body with 413", async () => {
    const { service, secret } = setup({ forward: "unreachable" });
    const unknown = await service.handle(
      delivery({ secret, id: "m", timestampMs: NOW, endpointId: "CCCCCCCCCCCCCCCCCCCCCC" }),
    );
    expect(unknown.status).toBe(404);
    const large = await service.handle(
      delivery({ secret, id: "m", timestampMs: NOW, body: "x".repeat(256 * 1024 + 1) }),
    );
    expect(large.status).toBe(413);
  });

  it("takes sixty deliveries a minute on one endpoint and answers the next with 429", async () => {
    const { service, secret } = setup({ forward: "unreachable" });
    for (let index = 0; index < 60; index += 1) {
      const answer = await service.handle(
        delivery({ secret, id: `msg_${index}`, timestampMs: NOW }),
      );
      expect(answer.status).toBe(202);
    }
    const limited = await service.handle(delivery({ secret, id: "msg_60", timestampMs: NOW }));
    expect(limited.status).toBe(429);
    expect(limited.headers?.["retry-after"]).toBeDefined();
  });

  it("forwards the queue when the spoke answers, and wakes it while it does not", async () => {
    const unreachable = setup({ forward: "unreachable" });
    await unreachable.service.handle(
      delivery({ secret: unreachable.secret, id: "msg_1", timestampMs: NOW }),
    );
    await unreachable.service.tick();
    await unreachable.service.tick();
    expect(unreachable.woken).toEqual([SPOKE]);
    expect(unreachable.service.status().queued).toBe(1);

    const reachable = setup({ forward: "accepted" });
    await reachable.service.handle(
      delivery({ secret: reachable.secret, id: "msg_1", timestampMs: NOW }),
    );
    await reachable.service.tick();
    expect(reachable.forwarded).toEqual(["msg_1"]);
    expect(reachable.service.status().queued).toBe(0);
  });

  it("drops a delivery held longer than a day and counts it as expired", async () => {
    const { service, secret, clock } = setup({ forward: "unreachable" });
    await service.handle(delivery({ secret, id: "msg_1", timestampMs: NOW }));
    await service.tick();
    clock.now += 24 * 60 * 60_000 + 1;
    await service.tick();
    expect(service.status()).toMatchObject({ queued: 0, expired: 1 });
  });
});
