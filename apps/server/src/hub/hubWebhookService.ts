// Webhook receipt on the acting hub (decisions H33 and H35). A spoke whose hub
// grant ticks Public hands the hub its endpoints with each secret sealed to the
// hub's own sealing key. A delivery is checked on its raw bytes before anything
// is queued: a forged, stale or repeated one is answered and dropped. Accepted
// deliveries wait in the hub's state file, at most a day, until the spoke takes
// them; the spoke checks them again and alone decides whether a routine runs.
// The hub journals counts, never a payload.

import {
  HubMemberId,
  WEBHOOK_BODY_MAX_BYTES,
  WEBHOOK_FORWARDED_HEADERS,
  WEBHOOK_HOLD_MS,
  WEBHOOK_TIMESTAMP_WINDOW_MS,
  WEBHOOK_QUEUE_MAX_BYTES,
  WEBHOOK_QUEUE_MAX_DELIVERIES,
  WEBHOOK_REQUESTS_PER_MINUTE,
  type HubMembershipChangedPayload,
  type HubSealingKey,
  type HubWebhookEndpoint,
  type HubWebhookEndpointsUpdate,
  type HubWebhookHandback,
  type WebhookDeliveryAnswer,
  type WebhookDeliveryEnvelope,
} from "@octant/contracts";
import { Schema } from "effect";
import { decideWebhookDelivery, readWebhookHeaders, hubSealingKeyPayload } from "@octant/domain";
import type { HubHostIdentity } from "./hubService";
import type { HubStatePort, HubWebhookQueued } from "./hubStateStore";
import type { PublicAnswer, PublicRequest } from "./publicEntrance";
import {
  makeSealingKeyPair,
  openWebhookSecret,
  verifiedWebhookDelivery,
} from "./publicEntranceCrypto";

const decodeMemberId = Schema.decodeUnknownSync(HubMemberId);
const MINUTE_MS = 60_000;
/** A sleeping spoke gets one Wake-on-LAN packet per this long while deliveries wait for it. */
const WAKE_EVERY_MS = 5 * MINUTE_MS;

export interface HubWebhookServiceOptions {
  readonly state: HubStatePort;
  readonly identity: () => HubHostIdentity;
  /** This hub's member id in its roster: what spokes seal secrets to. */
  readonly hubMemberId: () => string;
  /** Whether this host serves the entrance now: it is the acting hub. */
  readonly serving: () => boolean;
  /** Hands one delivery to its spoke over the pinned transport; undefined when the spoke cannot be reached. */
  readonly send: (
    spokeMemberId: string,
    envelope: WebhookDeliveryEnvelope,
  ) => Promise<WebhookDeliveryAnswer | undefined>;
  /** Sends a Wake-on-LAN packet to a spoke whose address the wake service holds; nothing else. */
  readonly wake?: (spokeMemberId: string) => Promise<void>;
  /** The member ids the roster this host serves lists; absent while it holds none. */
  readonly members?: () => ReadonlyArray<string> | undefined;
  /**
   * Whether this host may take deliveries for endpoints it owns as a spoke:
   * only while its own hub's Public grant stands. A standby promoted to hub is
   * no one's spoke, so its own endpoints could never reach a routine; they
   * answer 404 rather than acknowledge a delivery nothing will run.
   */
  readonly servesOwnEndpoints?: () => boolean;
  readonly record: (change: HubMembershipChangedPayload) => void;
  readonly now: () => number;
}

export interface HubWebhookStatus {
  readonly endpoints: number;
  readonly queued: number;
  readonly forwarded: number;
  readonly refused: number;
  readonly expired: number;
}

const answer = (
  status: number,
  body?: unknown,
  headers?: Record<string, string>,
): PublicAnswer => ({
  status,
  headers: { "content-type": "application/json", ...headers },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const NOT_FOUND = answer(404, { error: "not-found" });

export class HubWebhookService {
  readonly #options: HubWebhookServiceOptions;
  readonly #rate = new Map<string, number[]>();
  readonly #wokenAt = new Map<string, number>();
  #inFlight: Promise<void> | undefined;
  #unsaved = { forwarded: 0, refused: 0 };

  constructor(options: HubWebhookServiceOptions) {
    this.#options = options;
  }

  /** This hub's sealing key, made on first use and kept in the state file, signed with its identity key. */
  sealingKey(): HubSealingKey {
    const state = this.#options.state.load();
    const held = state.webhookHub;
    const key = held?.sealingKey ?? makeSealingKeyPair();
    if (held === undefined) {
      this.#options.state.save({
        ...state,
        webhookHub: { sealingKey: key, endpoints: [], queue: [], counts: emptyCounts() },
      });
    }
    const memberId = this.#options.hubMemberId();
    const identity = this.#options.identity();
    return {
      memberId: decodeMemberId(memberId),
      sealingPublicKey: key.publicKey,
      signerPublicKey: identity.signing.hostPublicKey,
      signature: identity.signing.signHostPayload(hubSealingKeyPayload(memberId, key.publicKey)),
    };
  }

  /** Replaces what this hub holds for one spoke. Queued deliveries for a withdrawn endpoint are dropped. */
  receiveEndpoints(
    spokeMemberId: string,
    update: HubWebhookEndpointsUpdate,
  ): { readonly status: "recorded"; readonly count: number } {
    this.sealingKey();
    const state = this.#options.state.load();
    const hub = state.webhookHub;
    if (hub === undefined) return { status: "recorded", count: 0 };
    const kept = hub.endpoints.filter(
      (endpoint) => String(endpoint.spokeMemberId) !== spokeMemberId,
    );
    // An id another member already holds stays that member's: the public
    // lookup takes the first match, so a second holder could have genuine
    // deliveries checked against its own secret.
    const othersHold = new Set(kept.map((endpoint) => String(endpoint.endpointId)));
    const own = update.endpoints.filter(
      (endpoint) =>
        String(endpoint.spokeMemberId) === spokeMemberId &&
        !othersHold.has(String(endpoint.endpointId)),
    );
    const live = new Set([...kept, ...own].map((endpoint) => String(endpoint.endpointId)));
    this.#options.state.save({
      ...state,
      webhookHub: {
        ...hub,
        endpoints: [...kept, ...own],
        queue: hub.queue.filter((queued) => live.has(String(queued.envelope.endpointId))),
      },
    });
    this.#options.record({
      change: "webhook-endpoints-received",
      actingPrincipal: { kind: "peer", memberId: decodeMemberId(spokeMemberId) },
      memberId: decodeMemberId(spokeMemberId),
      webhookCount: own.length,
    });
    return { status: "recorded", count: own.length };
  }

  /**
   * A delivery a standby queued while it stood in and hands back now. The hub
   * checks it as it checks one from the internet: the signature on the
   * original bytes with its own copy of the secret, the timestamp at the time
   * the standby received it, and dedupe keys it works out itself, so a standby
   * can neither slip in a forged delivery nor name keys that would make a
   * genuine one look like a duplicate. It is queued once, and one for an
   * endpoint this hub does not hold for that spoke is dropped. Whether it runs
   * is still the spoke's claim to decide.
   */
  takeHandback(
    standbyMemberId: string,
    queued: HubWebhookHandback,
  ): {
    readonly status: "queued" | "duplicate" | "unknown-endpoint" | "queue-full" | "refused";
  } {
    this.sealingKey();
    const state = this.#options.state.load();
    const hub = state.webhookHub;
    if (hub === undefined) return { status: "unknown-endpoint" };
    const endpointId = String(queued.envelope.endpointId);
    const endpoint = hub.endpoints.find(
      (entry) =>
        String(entry.endpointId) === endpointId &&
        String(entry.spokeMemberId) === String(queued.spokeMemberId),
    );
    if (endpoint === undefined) return { status: "unknown-endpoint" };
    const secret = this.#secretFor(endpoint, hub.sealingKey.privateKey);
    if (secret === undefined) return { status: "unknown-endpoint" };
    const body = Buffer.from(queued.envelope.body, "base64");
    const reading = readWebhookHeaders(endpoint.scheme, queued.envelope.headers);
    const receivedAt = queued.envelope.receivedAt;
    const now = this.#options.now();
    if (
      reading.status === "refused" ||
      receivedAt > now + WEBHOOK_TIMESTAMP_WINDOW_MS ||
      now - receivedAt > WEBHOOK_HOLD_MS
    ) {
      return { status: "refused" };
    }
    const verified = verifiedWebhookDelivery({ scheme: endpoint.scheme, secret, reading, body });
    if (verified !== undefined && verified.deliveryId !== queued.envelope.deliveryId) {
      return { status: "refused" };
    }
    const keys = verified?.keys ?? [];
    const forEndpoint = hub.queue.filter(
      (entry) => String(entry.envelope.endpointId) === endpointId,
    );
    const held = new Set(forEndpoint.flatMap((entry) => entry.keys));
    const decision = decideWebhookDelivery({
      endpointEnabled: true,
      signatureMatches: verified !== undefined,
      ...(reading.timestampMs === undefined ? {} : { timestampMs: reading.timestampMs }),
      nowMs: receivedAt,
      dedupeKeys: keys,
      claimed: (key) => held.has(key),
    });
    if (decision.status === "refused") return { status: "refused" };
    if (decision.status === "duplicate") return { status: "duplicate" };
    const heldBytes = forEndpoint.reduce((total, entry) => total + entry.bytes, 0);
    // Counted from the body itself, not from what the standby says it weighs.
    const bytes = body.length;
    if (
      forEndpoint.length >= WEBHOOK_QUEUE_MAX_DELIVERIES ||
      heldBytes + bytes > WEBHOOK_QUEUE_MAX_BYTES
    ) {
      return { status: "queue-full" };
    }
    this.#options.state.save({
      ...state,
      webhookHub: { ...hub, queue: [...hub.queue, { ...queued, bytes, keys: [...keys] }] },
    });
    this.#options.record({
      change: "webhook-deliveries-handed-back",
      actingPrincipal: { kind: "peer", memberId: decodeMemberId(standbyMemberId) },
      memberId: decodeMemberId(standbyMemberId),
      webhookCount: 1,
    });
    return { status: "queued" };
  }

  /**
   * Forgets every endpoint copy and queued delivery this host holds; for a host
   * that is no longer a hub or a named standby, so it keeps no sealed secret
   * the spokes meant only for the members that may stand in.
   */
  forgetCopies(): void {
    const state = this.#options.state.load();
    const hub = state.webhookHub;
    if (hub === undefined || (hub.endpoints.length === 0 && hub.queue.length === 0)) return;
    this.#options.state.save({ ...state, webhookHub: { ...hub, endpoints: [], queue: [] } });
    if (hub.queue.length > 0) {
      this.#options.record({
        change: "webhook-deliveries-dropped",
        actingPrincipal: { kind: "hub", memberId: decodeMemberId(this.#options.hubMemberId()) },
        webhookCount: hub.queue.length,
      });
    }
  }

  /** What this host still queues, for a standby to hand back when the hub returns. */
  handbackQueue(): ReadonlyArray<HubWebhookHandback> {
    return (this.#options.state.load().webhookHub?.queue ?? []).map((queued) => ({
      spokeMemberId: queued.spokeMemberId,
      keys: [...queued.keys],
      bytes: queued.bytes,
      envelope: queued.envelope,
    }));
  }

  /** Drops what the hub took back; it is the hub's to deliver now. */
  handedBack(taken: ReadonlyArray<HubWebhookHandback>): void {
    // One write for the whole hand-back: a write per delivery rewrote the
    // queue, up to 32 MiB, once for each of up to 500 deliveries.
    this.#removeAll(taken);
  }

  /** Drops deliveries the returning hub can never take, and journals how many. */
  dropHandback(dropped: ReadonlyArray<HubWebhookHandback>): void {
    if (dropped.length === 0) return;
    this.#removeAll(dropped);
    this.#options.record({
      change: "webhook-deliveries-dropped",
      actingPrincipal: { kind: "hub", memberId: decodeMemberId(this.#options.hubMemberId()) },
      webhookCount: dropped.length,
    });
  }

  status(): HubWebhookStatus {
    const hub = this.#options.state.load().webhookHub;
    const counts = hub?.counts ?? emptyCounts();
    return {
      endpoints: hub?.endpoints.length ?? 0,
      queued: hub?.queue.length ?? 0,
      forwarded: counts.forwarded + this.#unsaved.forwarded,
      refused: counts.refused + this.#unsaved.refused,
      expired: counts.expired,
    };
  }

  /** The entrance's `POST /hooks/<id>` handler. */
  readonly handle = async (request: PublicRequest): Promise<PublicAnswer> => {
    if (!this.#options.serving()) return NOT_FOUND;
    const endpointId = request.params.id ?? "";
    const known = this.#options.state
      .load()
      .webhookHub?.endpoints.some((entry) => String(entry.endpointId) === endpointId);
    if (known !== true) return NOT_FOUND;
    const now = this.#options.now();
    if (!this.#takeRate(endpointId, now)) {
      this.#count("refused");
      return answer(429, { error: "rate-limited" }, { "retry-after": "60" });
    }
    const body = await request.readBody(WEBHOOK_BODY_MAX_BYTES);
    if (body.status === "too-large") return answer(413, { error: "too-large" });
    if (body.status === "aborted") return answer(400, { error: "invalid" });
    // The body read awaited; the endpoint, its queue and this host's role are
    // judged as they are now, and nothing below awaits before the save. A
    // standby that began handing back meanwhile has already taken its queue's
    // snapshot, so it answers 503 and the sender retries at the hub.
    if (!this.#options.serving()) {
      return answer(503, { error: "unavailable" }, { "retry-after": "60" });
    }
    const hub = this.#options.state.load().webhookHub;
    const endpoint = hub?.endpoints.find((entry) => String(entry.endpointId) === endpointId);
    if (hub === undefined || endpoint === undefined) return NOT_FOUND;
    if (
      String(endpoint.spokeMemberId) === this.#options.hubMemberId() &&
      this.#options.servesOwnEndpoints?.() === false
    ) {
      return NOT_FOUND;
    }
    const headers = Object.fromEntries(
      WEBHOOK_FORWARDED_HEADERS.flatMap((name) => {
        const value = request.headers.get(name);
        return value === undefined ? [] : [[name, value]];
      }),
    );
    const reading = readWebhookHeaders(endpoint.scheme, headers);
    if (reading.status === "refused") {
      this.#count("refused");
      return answer(401, { error: reading.kind });
    }
    const secret = this.#secretFor(endpoint, hub.sealingKey.privateKey);
    if (secret === undefined) return NOT_FOUND;
    const verified = verifiedWebhookDelivery({
      scheme: endpoint.scheme,
      secret,
      reading,
      body: body.bytes,
    });
    const keys = verified?.keys ?? [];
    const queuedKeys = new Set(
      hub.queue
        .filter((queued) => String(queued.envelope.endpointId) === endpointId)
        .flatMap((queued) => queued.keys),
    );
    const decision = decideWebhookDelivery({
      endpointEnabled: true,
      signatureMatches: verified !== undefined,
      ...(reading.timestampMs === undefined ? {} : { timestampMs: reading.timestampMs }),
      nowMs: now,
      dedupeKeys: keys,
      claimed: (key) => queuedKeys.has(key),
    });
    if (decision.status === "duplicate") return answer(200, { duplicate: true });
    // An accepted decision always has a verified delivery; the second test narrows it.
    if (decision.status === "refused" || verified === undefined) {
      this.#count("refused");
      const kind = decision.status === "refused" ? decision.kind : "bad-signature";
      return answer(kind === "stale-timestamp" ? 400 : 401, { error: kind });
    }
    const forEndpoint = hub.queue.filter(
      (queued) => String(queued.envelope.endpointId) === endpointId,
    );
    const heldBytes = forEndpoint.reduce((total, queued) => total + queued.bytes, 0);
    if (
      forEndpoint.length >= WEBHOOK_QUEUE_MAX_DELIVERIES ||
      heldBytes + body.bytes.length > WEBHOOK_QUEUE_MAX_BYTES
    ) {
      this.#count("refused");
      return answer(503, { error: "queue-full" }, { "retry-after": "60" });
    }
    const queued: HubWebhookQueued = {
      spokeMemberId: endpoint.spokeMemberId,
      keys: [...keys],
      bytes: body.bytes.length,
      envelope: {
        endpointId: endpoint.endpointId,
        deliveryId: verified.deliveryId,
        receivedAt: now,
        headers,
        body: body.bytes.toString("base64"),
      },
    };
    const latest = this.#options.state.load();
    this.#options.state.save({
      ...latest,
      webhookHub: { ...hub, queue: [...hub.queue, queued] },
    });
    void this.tick().catch(() => undefined);
    return answer(202, { queued: true });
  };

  /** One look at the queue: drop what is older than a day, hand the rest to each spoke, wake a spoke that does not answer. */
  tick(): Promise<void> {
    if (!this.#options.serving()) return Promise.resolve();
    // A look already under way is the one a caller waits for.
    this.#inFlight ??= this.#look().finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }

  async #look(): Promise<void> {
    this.#flushCounts();
    this.#forgetDeparted();
    this.#expire();
    const queue = this.#options.state.load().webhookHub?.queue ?? [];
    const unreachable = new Set<string>();
    const paused = new Set<string>();
    // A spoke counts room per endpoint, so one full endpoint holds back only
    // its own deliveries, not another routine's on the same spoke.
    const busy = new Set<string>();
    for (const queued of queue) {
      const spoke = String(queued.spokeMemberId);
      const endpoint = `${spoke}|${String(queued.envelope.endpointId)}`;
      if (unreachable.has(spoke) || paused.has(spoke) || busy.has(endpoint)) continue;
      const result = await this.#options.send(spoke, queued.envelope);
      if (result === undefined) {
        unreachable.add(spoke);
        continue;
      }
      if (result.status === "refused" && result.kind === "busy") {
        // The spoke is awake but this routine has not caught up; no wake, and
        // the rest of this endpoint's queue waits for the next look.
        busy.add(endpoint);
        continue;
      }
      if (result.status === "refused" && result.kind === "paused") {
        // The spoke's person paused remote access: held for the day, no wake.
        paused.add(spoke);
        continue;
      }
      this.#remove(queued);
      this.#count(result.status === "refused" ? "refused" : "forwarded");
    }
    for (const spoke of unreachable) await this.#wake(spoke);
  }

  #secretFor(endpoint: HubWebhookEndpoint, privateKey: string): string | undefined {
    const sealed = endpoint.sealedSecrets.find(
      (entry) => String(entry.recipientMemberId) === this.#options.hubMemberId(),
    );
    return sealed === undefined
      ? undefined
      : openWebhookSecret({ sealed, endpointId: String(endpoint.endpointId), privateKey });
  }

  #takeRate(endpointId: string, now: number): boolean {
    const recent = (this.#rate.get(endpointId) ?? []).filter((at) => now - at < MINUTE_MS);
    if (recent.length >= WEBHOOK_REQUESTS_PER_MINUTE) {
      this.#rate.set(endpointId, recent);
      return false;
    }
    recent.push(now);
    this.#rate.set(endpointId, recent);
    return true;
  }

  async #wake(spokeMemberId: string): Promise<void> {
    const now = this.#options.now();
    const last = this.#wokenAt.get(spokeMemberId);
    if (this.#options.wake === undefined || (last !== undefined && now - last < WAKE_EVERY_MS))
      return;
    this.#wokenAt.set(spokeMemberId, now);
    await this.#options.wake(spokeMemberId).catch(() => undefined);
  }

  #expire(): void {
    const state = this.#options.state.load();
    const hub = state.webhookHub;
    if (hub === undefined) return;
    const cutoff = this.#options.now() - WEBHOOK_HOLD_MS;
    const kept = hub.queue.filter((queued) => queued.envelope.receivedAt >= cutoff);
    const dropped = hub.queue.length - kept.length;
    if (dropped === 0) return;
    this.#options.state.save({
      ...state,
      webhookHub: {
        ...hub,
        queue: kept,
        counts: { ...hub.counts, expired: hub.counts.expired + dropped },
      },
    });
    this.#options.record({
      change: "webhook-deliveries-expired",
      actingPrincipal: { kind: "hub", memberId: decodeMemberId(this.#options.hubMemberId()) },
      webhookCount: dropped,
    });
  }

  #removeAll(targets: ReadonlyArray<Pick<HubWebhookQueued, "envelope">>): void {
    if (targets.length === 0) return;
    const state = this.#options.state.load();
    const hub = state.webhookHub;
    if (hub === undefined) return;
    const key = (queued: Pick<HubWebhookQueued, "envelope">) =>
      `${String(queued.envelope.endpointId)}|${queued.envelope.deliveryId}`;
    const gone = new Set(targets.map(key));
    this.#options.state.save({
      ...state,
      webhookHub: { ...hub, queue: hub.queue.filter((queued) => !gone.has(key(queued))) },
    });
  }

  #remove(target: Pick<HubWebhookQueued, "envelope">): void {
    const state = this.#options.state.load();
    const hub = state.webhookHub;
    if (hub === undefined) return;
    const same = (queued: HubWebhookQueued) =>
      String(queued.envelope.endpointId) === String(target.envelope.endpointId) &&
      queued.envelope.deliveryId === target.envelope.deliveryId;
    this.#options.state.save({
      ...state,
      webhookHub: { ...hub, queue: hub.queue.filter((queued) => !same(queued)) },
    });
  }

  /**
   * Counts in memory and lands them in the state file at the next look, so an
   * unauthenticated flood of refused requests never rewrites the file per request.
   */
  #count(kind: "forwarded" | "refused"): void {
    this.#unsaved[kind] += 1;
  }

  #flushCounts(): void {
    if (this.#unsaved.forwarded === 0 && this.#unsaved.refused === 0) return;
    const state = this.#options.state.load();
    const hub = state.webhookHub;
    if (hub === undefined) return;
    this.#options.state.save({
      ...state,
      webhookHub: {
        ...hub,
        counts: {
          ...hub.counts,
          forwarded: hub.counts.forwarded + this.#unsaved.forwarded,
          refused: hub.counts.refused + this.#unsaved.refused,
        },
      },
    });
    this.#unsaved = { forwarded: 0, refused: 0 };
  }

  /** Drops the endpoints and queue of a spoke the roster no longer lists; it cannot withdraw them itself. */
  #forgetDeparted(): void {
    const listed = this.#options.members?.();
    if (listed === undefined) return;
    const members = new Set(listed);
    const state = this.#options.state.load();
    const hub = state.webhookHub;
    if (hub === undefined) return;
    const endpoints = hub.endpoints.filter((endpoint) =>
      members.has(String(endpoint.spokeMemberId)),
    );
    if (endpoints.length === hub.endpoints.length) return;
    this.#options.state.save({
      ...state,
      webhookHub: {
        ...hub,
        endpoints,
        queue: hub.queue.filter((queued) => members.has(String(queued.spokeMemberId))),
      },
    });
  }
}

function emptyCounts() {
  return { forwarded: 0, refused: 0, expired: 0 };
}
