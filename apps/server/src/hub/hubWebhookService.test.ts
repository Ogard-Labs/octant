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

function setup(
  options: {
    readonly forward?: "unreachable" | "accepted" | "busy" | "paused";
    /** The endpoints whose spoke answers busy, when the rest are accepted. */
    readonly busyEndpoints?: ReadonlySet<string>;
    readonly members?: () => ReadonlyArray<string> | undefined;
    readonly servesOwnEndpoints?: boolean;
  } = {},
) {
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
      if (options.forward === "busy") return { status: "refused", kind: "busy" };
      if (options.forward === "paused") return { status: "refused", kind: "paused" };
      if (options.busyEndpoints?.has(String(envelope.endpointId)) === true) {
        return { status: "refused", kind: "busy" };
      }
      forwarded.push(envelope.deliveryId);
      return { status: "accepted" };
    },
    ...(options.members === undefined ? {} : { members: options.members }),
    ...(options.servesOwnEndpoints === undefined
      ? {}
      : { servesOwnEndpoints: () => options.servesOwnEndpoints === true }),
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
  /** Hands the hub one member's whole list: these endpoints, each with its secret. */
  const handEndpoints = (
    owner: HubMemberId,
    list: ReadonlyArray<readonly [WebhookEndpointId, string]>,
  ) =>
    service.receiveEndpoints(owner, {
      endpoints: list.map(([endpointId, endpointSecret]) => ({
        endpointId,
        spokeMemberId: owner,
        scheme: "standard-webhooks" as const,
        sealedSecrets: [
          sealWebhookSecret({
            secret: endpointSecret,
            endpointId,
            recipientMemberId: HUB as HubMemberId,
            recipientPublicKey: key.sealingPublicKey,
          }),
        ],
      })),
    });
  return { service, secret, clock, forwarded, woken, handEndpoints };
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

  it("keeps a delivery a busy spoke has no room for, and sends no wake", async () => {
    const { service, secret, woken } = setup({ forward: "busy" });
    await service.handle(delivery({ secret, id: "msg_1", timestampMs: NOW }));
    await service.tick();
    await service.tick();
    expect(service.status().queued).toBe(1);
    expect(woken).toEqual([]);
  });

  it("forgets the endpoints and queue of a spoke the roster no longer lists", async () => {
    let members: ReadonlyArray<string> = [HUB, SPOKE];
    const { service, secret } = setup({ forward: "unreachable", members: () => members });
    await service.handle(delivery({ secret, id: "msg_1", timestampMs: NOW }));
    await service.tick();
    members = [HUB];
    await service.tick();
    expect(service.status()).toMatchObject({ endpoints: 0, queued: 0 });
    expect((await service.handle(delivery({ secret, id: "msg_2", timestampMs: NOW }))).status).toBe(
      404,
    );
  });

  it("drops a delivery held longer than a day and counts it as expired", async () => {
    const { service, secret, clock } = setup({ forward: "unreachable" });
    await service.handle(delivery({ secret, id: "msg_1", timestampMs: NOW }));
    await service.tick();
    clock.now += 24 * 60 * 60_000 + 1;
    await service.tick();
    expect(service.status()).toMatchObject({ queued: 0, expired: 1 });
  });

  it("a full endpoint holds back only its own deliveries, not another routine's on the same spoke", async () => {
    const OTHER = "CCCCCCCCCCCCCCCCCCCCCC" as WebhookEndpointId;
    const { service, secret, forwarded, handEndpoints } = setup({
      busyEndpoints: new Set([ENDPOINT]),
    });
    const other = { secret: mintWebhookSecret() };
    expect(
      handEndpoints(SPOKE, [
        [ENDPOINT, secret],
        [OTHER, other.secret],
      ]).count,
    ).toBe(2);
    await service.handle(delivery({ secret, id: "msg_full", timestampMs: NOW }));
    expect(
      (
        await service.handle(
          delivery({ secret: other.secret, id: "msg_other", timestampMs: NOW, endpointId: OTHER }),
        )
      ).status,
    ).toBe(202);
    await service.tick();
    expect(forwarded).toEqual(["msg_other"]);
    expect(service.status().queued).toBe(1);
  });

  it("keeps a delivery for a paused spoke through the hold, and sends no wake", async () => {
    const { service, secret, woken } = setup({ forward: "paused" });
    await service.handle(delivery({ secret, id: "msg_1", timestampMs: NOW }));
    await service.tick();
    expect(service.status().queued).toBe(1);
    expect(woken).toEqual([]);
  });

  it("refuses an endpoint id another member already holds", async () => {
    const OTHER_SPOKE = "33333333-3333-4333-8333-333333333333" as HubMemberId;
    const { service, secret, handEndpoints } = setup({ forward: "accepted" });
    expect(handEndpoints(OTHER_SPOKE, [[ENDPOINT, mintWebhookSecret()]]).count).toBe(0);
    expect((await service.handle(delivery({ secret, id: "msg_1", timestampMs: NOW }))).status).toBe(
      202,
    );
  });

  it("a promoted hub answers 404 for an endpoint it owned as a spoke, rather than take a delivery no routine will run", async () => {
    const OWN = "DDDDDDDDDDDDDDDDDDDDDD" as WebhookEndpointId;
    const { service, handEndpoints } = setup({ forward: "accepted", servesOwnEndpoints: false });
    const own = mintWebhookSecret();
    handEndpoints(HUB as HubMemberId, [[OWN, own]]);
    expect(
      (await service.handle(delivery({ secret: own, id: "m", timestampMs: NOW, endpointId: OWN })))
        .status,
    ).toBe(404);
  });

  describe("a standby's hand-back", () => {
    const STANDBY = "44444444-4444-4444-8444-444444444444";
    const handback = (input: {
      readonly secret: string;
      readonly id: string;
      readonly keys: ReadonlyArray<string>;
      readonly signature?: string;
    }) => {
      const body = Buffer.from('{"ref":"refs/heads/main"}');
      const seconds = Math.floor(NOW / 1000);
      const signature =
        input.signature ??
        createHmac("sha256", Buffer.from(input.secret.slice("whsec_".length), "base64"))
          .update(`${input.id}.${seconds}.`)
          .update(body)
          .digest("base64");
      return {
        spokeMemberId: SPOKE,
        keys: [...input.keys],
        bytes: body.length,
        envelope: {
          endpointId: ENDPOINT,
          deliveryId: input.id,
          receivedAt: NOW,
          headers: {
            "webhook-id": input.id,
            "webhook-timestamp": String(seconds),
            "webhook-signature": `v1,${signature}`,
          },
          body: body.toString("base64"),
        },
      };
    };

    it("refuses a delivery its own copy of the secret does not verify", () => {
      const { service } = setup();
      expect(
        service.takeHandback(
          STANDBY,
          handback({ secret: mintWebhookSecret(), id: "forged", keys: ["id:forged"] }),
        ),
      ).toEqual({ status: "refused" });
      expect(service.status().queued).toBe(0);
    });

    it("a standby cannot make a genuine delivery look like a duplicate by naming its keys", async () => {
      const { service, secret } = setup({ forward: "unreachable" });
      // A genuine delivery the standby really queued, handed back with the key
      // of another delivery that has not arrived yet.
      expect(
        service.takeHandback(STANDBY, handback({ secret, id: "msg_1", keys: ["id:msg_2"] })),
      ).toEqual({ status: "queued" });
      expect(
        (await service.handle(delivery({ secret, id: "msg_2", timestampMs: NOW }))).status,
      ).toBe(202);
      expect(service.status().queued).toBe(2);
    });
  });
});
