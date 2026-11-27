// Webhook endpoints on the spoke that owns them (decisions H33 and H34). The
// spoke mints each endpoint and its secret, shows the secret once, and hands
// the hub only the secret sealed to the hub's own sealing key. Stripe mints
// its own secret after it is given the URL, so a Stripe endpoint waits for its
// person to paste that secret and reaches the hub only then. A delivery the
// hub forwards is checked again here on its original bytes and claimed by its
// dedupe keys, which this spoke keeps seven days; only then does it become an
// event of the webhook source, which a routine reads through the ordinary
// integration-event path: framed outside content, run-first claims, and the
// routine's own allowance. Nothing in a payload reaches a routine's authority.

import { createHash } from "node:crypto";
import {
  AUTOMATION_WEBHOOK_ENDPOINT_FILTER,
  AUTOMATION_WEBHOOK_INTEGRATION_ID,
  AUTOMATION_WEBHOOK_SOURCE_ID,
  HUB_WEBHOOK_MAX_ENDPOINTS_PER_SPOKE,
  HubMemberId,
  UtcTimestamp,
  WEBHOOK_DEDUPE_RETENTION_MS,
  WEBHOOK_HOLD_MS,
  WEBHOOK_TIMESTAMP_WINDOW_MS,
  WebhookEndpointId,
  type AutomationIntegrationEvent,
  type HubMembershipChangedPayload,
  type HubSealingKey,
  type HubWebhookEndpointsUpdate,
  type WebhookDeliveryAnswer,
  type WebhookDeliveryEnvelope,
  type WebhookSignatureScheme,
} from "@octant/contracts";
import {
  decideWebhookDelivery,
  readWebhookHeaders,
  hubSealingKeyPayload,
  replacedWebhookSecretKept,
  replacedWebhookSecretVerifies,
} from "@octant/domain";
import type { IntegrationEventSourceProvider } from "@octant/plugin-api/integration";
import { Schema } from "effect";
import { publicKeyFingerprint, verifySignature } from "./hubCrypto";
import {
  SPOKE_REPLACED_SECRETS_MAX,
  type HubStatePort,
  type SpokeWebhookDelivery,
  type SpokeWebhookEndpoint,
  type SpokeWebhookState,
} from "./hubStateStore";
import {
  mintPublicId,
  mintWebhookSecret,
  sealPreviousWebhookSecret,
  sealWebhookSecret,
  verifiedWebhookDeliveryByAny,
} from "./publicEntranceCrypto";

const decodeEndpointId = Schema.decodeUnknownSync(WebhookEndpointId);
const decodeMemberId = Schema.decodeUnknownSync(HubMemberId);
const decodeTimestamp = Schema.decodeUnknownSync(UtcTimestamp);
const EVENT_DATA_MAX = 2_048;
const EVENTS_PER_READ = 128;
const LOG_MAX = 50;
const DELIVERIES_MAX = 1_024;
const CLAIMED_MAX = 50_000;
// A routine takes at most 32 waiting events at one look, so a spoke takes no
// more than this many unread deliveries per endpoint; the rest stay on the hub.
const UNREAD_PER_ENDPOINT_MAX = 16;
/** The longest part after `whsec_` a pasted Stripe secret may have; it bounds the published list. */
export const STRIPE_SECRET_BODY_MAX = 240;
/** Stripe's signing secret as its dashboard shows it; Stripe keys the HMAC with the whole string. */
const STRIPE_SECRET = new RegExp(`^whsec_[A-Za-z0-9+/=_-]{16,${STRIPE_SECRET_BODY_MAX}}$`);

/**
 * The hub this spoke hands its endpoints to, and each named standby when the
 * spoke's person ticked Standby, over the pinned private transport. The hub is
 * always first.
 */
export interface SpokeWebhookHubPort {
  /** Each recipient's member id and the identity-key fingerprint the hub-signed roster lists for it. */
  readonly targets: () => ReadonlyArray<{
    readonly memberId: string;
    readonly fingerprint: string;
  }>;
  /** Every member that could hold copies (the hub and each named standby), ticked or not. */
  readonly named?: () => ReadonlyArray<string>;
  /**
   * The sequence of the hub-signed roster the targets came from. A standby
   * taken out of the order forgets its copies, and one put back gets the same
   * member id, so a new roster sends the list again.
   */
  readonly copyEpoch?: () => string;
  readonly sealingKey: (memberId: string) => Promise<HubSealingKey | undefined>;
  readonly sendEndpoints: (memberId: string, update: HubWebhookEndpointsUpdate) => Promise<boolean>;
}

export interface SpokeWebhookServiceOptions {
  readonly state: HubStatePort;
  /** Whether this spoke's person ticked Public in the hub grant. Read on every request. */
  readonly publicGranted: () => boolean;
  /** Whether this host's person paused remote access; a paused spoke takes no delivery. */
  readonly remoteAccessPaused: () => boolean;
  /** Absent in a test that has no hub; then nothing is published. */
  readonly hub: SpokeWebhookHubPort | undefined;
  readonly record: (change: HubMembershipChangedPayload) => void;
  readonly now: () => number;
}

export type SpokeWebhookCreated =
  | {
      readonly status: "created";
      readonly endpointId: string;
      /** Shown to the person once; it is never read back. */
      readonly secret: string;
      readonly path: string;
      readonly published: boolean;
    }
  /** A Stripe endpoint: give Stripe the URL, then paste the secret Stripe shows. */
  | {
      readonly status: "awaiting-secret";
      readonly endpointId: string;
      readonly path: string;
    }
  | {
      readonly status: "refused";
      readonly kind: "public-not-granted" | "unknown-endpoint" | "full";
    };

export type SpokeWebhookSecretSet =
  | { readonly status: "set"; readonly published: boolean }
  | {
      readonly status: "refused";
      /**
       * `scheme-mints-its-own`: the endpoint's scheme uses the secret this spoke
       * minted, not a pasted one. `too-many-replaced-secrets`: the paste would
       * drop a replaced secret whose day is not over.
       */
      readonly kind:
        | "public-not-granted"
        | "unknown-endpoint"
        | "scheme-mints-its-own"
        | "invalid-secret"
        | "too-many-replaced-secrets";
    };

export interface SpokeWebhookView {
  readonly endpoints: ReadonlyArray<{
    readonly endpointId: string;
    readonly scheme: WebhookSignatureScheme;
    readonly label: string;
    readonly createdAt: number;
    readonly path: string;
    readonly deliveries: number;
    /** A Stripe endpoint whose secret has not been pasted; it takes no delivery yet. */
    readonly awaitingSecret: boolean;
  }>;
  readonly log: SpokeWebhookState["log"];
  readonly published: boolean;
}

const LOCAL_WINDOW = { kind: "local-window" } as const;

function empty(): SpokeWebhookState {
  return { endpoints: [], deliveries: [], claimed: [], log: [] };
}

function eventData(body: Buffer): string {
  const text = body.toString("utf8");
  // Bytes that are not text say so instead of arriving as noise.
  if (Buffer.from(text, "utf8").equals(body) === false) {
    return `A binary payload of ${body.length} bytes.`;
  }
  return text.length <= EVENT_DATA_MAX
    ? text
    : `${text.slice(0, EVENT_DATA_MAX - 40)}\n[payload cut at ${EVENT_DATA_MAX} characters]`;
}

export class SpokeWebhookService {
  readonly #options: SpokeWebhookServiceOptions;
  /** Whether Public was ticked at the last list the hub took; unticking it withdraws every endpoint. */
  #publishedGranted: boolean | undefined;
  /** One publication at a time, so an older list can never reach the hub after a newer one. */
  #publishing: Promise<boolean> = Promise.resolve(true);
  /** Counts endpoint changes; a send clears `unpublished` only if none came while it was out. */
  #revision = 0;
  #publishedRecipients: string | undefined;

  constructor(options: SpokeWebhookServiceOptions) {
    this.#options = options;
  }

  view(): SpokeWebhookView {
    const held = this.#load();
    return {
      endpoints: held.endpoints.map((endpoint) => ({
        endpointId: String(endpoint.endpointId),
        scheme: endpoint.scheme,
        label: endpoint.label,
        createdAt: endpoint.createdAt,
        path: `/hooks/${String(endpoint.endpointId)}`,
        deliveries: held.deliveries.filter(
          (delivery) => String(delivery.endpointId) === String(endpoint.endpointId),
        ).length,
        awaitingSecret: endpoint.secret === undefined,
      })),
      log: held.log,
      published: held.unpublished !== true,
    };
  }

  /**
   * Mints a new endpoint and its secret, then hands the hub its sealed copy.
   * A Stripe endpoint gets no secret here; it waits for {@link setSecret}.
   */
  async create(input: {
    readonly scheme: WebhookSignatureScheme;
    readonly label: string;
    readonly formerIds?: ReadonlyArray<WebhookEndpointId>;
  }): Promise<SpokeWebhookCreated> {
    if (!this.#options.publicGranted()) return { status: "refused", kind: "public-not-granted" };
    const held = this.#load();
    if (held.endpoints.length >= HUB_WEBHOOK_MAX_ENDPOINTS_PER_SPOKE) {
      return { status: "refused", kind: "full" };
    }
    const endpoint: SpokeWebhookEndpoint = {
      endpointId: decodeEndpointId(mintPublicId()),
      scheme: input.scheme,
      ...(input.scheme === "stripe" ? {} : { secret: mintWebhookSecret() }),
      label: input.label.trim().slice(0, 128) || "Webhook",
      createdAt: this.#options.now(),
      ...(input.formerIds === undefined || input.formerIds.length === 0
        ? {}
        : { formerIds: input.formerIds.slice(-8) }),
    };
    this.#revision += 1;
    this.#save({ ...held, endpoints: [...held.endpoints, endpoint], unpublished: true });
    this.#options.record({ change: "webhook-endpoint-created", actingPrincipal: LOCAL_WINDOW });
    const published = await this.publish();
    const path = `/hooks/${String(endpoint.endpointId)}`;
    return endpoint.secret === undefined
      ? { status: "awaiting-secret", endpointId: String(endpoint.endpointId), path }
      : {
          status: "created",
          endpointId: String(endpoint.endpointId),
          secret: endpoint.secret,
          path,
          published,
        };
  }

  /**
   * Takes the secret Stripe minted for one of this spoke's Stripe endpoints,
   * first or after the person rolled it in Stripe, and hands the hub its
   * sealed copy. No other scheme takes a pasted secret. New deliveries signed
   * with a replaced secret are still taken for a day, as Stripe itself does,
   * and the secret is kept a further hold after that, because the hub answered
   * Stripe for what it holds and Stripe will not send those deliveries again.
   * So a paste that would have to drop one still kept is refused.
   */
  async setSecret(endpointId: string, secret: string): Promise<SpokeWebhookSecretSet> {
    if (!this.#options.publicGranted()) return { status: "refused", kind: "public-not-granted" };
    const held = this.#load();
    const endpoint = held.endpoints.find((entry) => String(entry.endpointId) === endpointId);
    if (endpoint === undefined) return { status: "refused", kind: "unknown-endpoint" };
    if (endpoint.scheme !== "stripe") return { status: "refused", kind: "scheme-mints-its-own" };
    const trimmed = secret.trim();
    if (!STRIPE_SECRET.test(trimmed)) return { status: "refused", kind: "invalid-secret" };
    const now = this.#options.now();
    // A secret pasted back becomes the current one again, so it leaves the list.
    const previousSecrets = [
      ...keptPrevious(endpoint, now).filter((previous) => previous.secret !== trimmed),
      ...(endpoint.secret === undefined || endpoint.secret === trimmed
        ? []
        : [{ secret: endpoint.secret, until: now + WEBHOOK_HOLD_MS }]),
    ];
    if (previousSecrets.length > SPOKE_REPLACED_SECRETS_MAX) {
      return { status: "refused", kind: "too-many-replaced-secrets" };
    }
    const { previousSecrets: _replaced, ...rest } = endpoint;
    this.#revision += 1;
    this.#save({
      ...held,
      endpoints: held.endpoints.map((entry) =>
        entry === endpoint
          ? {
              ...rest,
              secret: trimmed,
              ...(previousSecrets.length === 0 ? {} : { previousSecrets }),
            }
          : entry,
      ),
      unpublished: true,
    });
    this.#options.record({ change: "webhook-endpoint-secret-set", actingPrincipal: LOCAL_WINDOW });
    return { status: "set", published: await this.publish() };
  }

  /**
   * A new URL and secret with the same scheme and label; the old pair stops at
   * once. The new endpoint remembers the ids it replaced, so a routine that
   * named the old one reads the new one without being edited or re-armed.
   */
  async rotate(endpointId: string): Promise<SpokeWebhookCreated> {
    const held = this.#load();
    const old = held.endpoints.find((endpoint) => String(endpoint.endpointId) === endpointId);
    if (old === undefined) return { status: "refused", kind: "unknown-endpoint" };
    // Checked before the old one goes, so a refused rotate leaves it working.
    if (!this.#options.publicGranted()) return { status: "refused", kind: "public-not-granted" };
    this.#drop(endpointId);
    return this.create({
      scheme: old.scheme,
      label: old.label,
      formerIds: [...(old.formerIds ?? []), old.endpointId],
    });
  }

  async remove(
    endpointId: string,
  ): Promise<
    | { readonly status: "removed" }
    | { readonly status: "refused"; readonly kind: "unknown-endpoint" }
  > {
    if (!this.#drop(endpointId)) return { status: "refused", kind: "unknown-endpoint" };
    await this.publish();
    return { status: "removed" };
  }

  /**
   * Hands the hub, and each standby the spoke lets stand in, every endpoint
   * with its secret sealed to each recipient's own sealing key. A key is taken
   * only when its signer is the member the hub-signed roster lists. An empty
   * list withdraws everything; without Public, that is what is sent. It counts
   * as published only once every recipient took it.
   */
  publish(): Promise<boolean> {
    const next = this.#publishing.then(
      () => this.#publishNow(),
      () => this.#publishNow(),
    );
    this.#publishing = next.catch(() => false);
    return next;
  }

  async #publishNow(): Promise<boolean> {
    const hub = this.#options.hub;
    const targets = hub?.targets() ?? [];
    if (hub === undefined || targets.length === 0) return false;
    // The roster these targets came from, read before any send awaits: one
    // that changes while the list is out must not count as published.
    const epoch = hub.copyEpoch?.() ?? "";
    const revision = this.#revision;
    const held = this.#load();
    const now = this.#options.now();
    // A Stripe endpoint still waiting for its secret has nothing the hub could check.
    const endpoints = this.#options.publicGranted()
      ? held.endpoints.flatMap((endpoint) =>
          endpoint.secret === undefined ? [] : [{ ...endpoint, secret: endpoint.secret }],
        )
      : [];
    const keys = new Map<string, HubSealingKey>();
    if (endpoints.length > 0) {
      for (const target of targets) {
        const key = await hub.sealingKey(target.memberId);
        if (
          key !== undefined &&
          String(key.memberId) === target.memberId &&
          publicKeyFingerprint(key.signerPublicKey) === target.fingerprint &&
          verifySignature({
            payload: hubSealingKeyPayload(String(key.memberId), key.sealingPublicKey),
            signature: key.signature,
            publicKey: key.signerPublicKey,
          })
        ) {
          keys.set(target.memberId, key);
        }
      }
      // Without the hub's own key there is nothing the hub could open.
      if (!keys.has(targets[0]?.memberId ?? "")) return false;
    }
    const spokeMemberId = this.#options.state.load().link?.selfMemberId;
    if (endpoints.length > 0 && spokeMemberId === undefined) return false;
    // Each recipient gets only the copy sealed to its own key.
    const updateFor = (key: HubSealingKey | undefined): HubWebhookEndpointsUpdate => ({
      endpoints:
        spokeMemberId === undefined || key === undefined
          ? []
          : endpoints.map((endpoint) => ({
              endpointId: endpoint.endpointId,
              spokeMemberId,
              scheme: endpoint.scheme,
              sealedSecrets: (() => {
                const recipient = {
                  endpointId: String(endpoint.endpointId),
                  recipientMemberId: decodeMemberId(String(key.memberId)),
                  recipientPublicKey: key.sealingPublicKey,
                };
                // The current copy comes first: a holder that opens only the
                // first one for its member id checks with the current secret.
                return [
                  sealWebhookSecret({ ...recipient, secret: endpoint.secret }),
                  ...keptPrevious(endpoint, now).map((previous) =>
                    sealPreviousWebhookSecret({ ...recipient, ...previous }),
                  ),
                ];
              })(),
            })),
    });
    const granted = this.#options.publicGranted();
    const recipients = targets.map((target) => target.memberId);
    let complete = endpoints.length === 0 || keys.size === targets.length;
    for (const target of targets) {
      if (endpoints.length > 0 && !keys.has(target.memberId)) continue;
      if (!(await hub.sendEndpoints(target.memberId, updateFor(keys.get(target.memberId))))) {
        complete = false;
      }
    }
    // A standby the person withdrew (Standby unticked, or out of the order)
    // is sent an empty list, so it keeps no sealed secret it was not meant to.
    for (const memberId of hub.named?.() ?? []) {
      if (recipients.includes(memberId)) continue;
      if (!(await hub.sendEndpoints(memberId, { endpoints: [] }))) complete = false;
    }
    // An endpoint made or removed while this list was out is not in it; the
    // flag stays, and the next look sends the newer list.
    if (complete && revision === this.#revision) {
      this.#publishedGranted = granted;
      this.#publishedRecipients = `${recipients.join(",")}@${epoch}`;
      const { unpublished: _unpublished, ...rest } = this.#load();
      this.#save(rest);
    } else if (!complete) {
      this.#save({ ...this.#load(), unpublished: true });
    }
    return complete;
  }

  /** Sends the list again when the hub has not taken it, or when the Public item changed since. */
  async look(): Promise<void> {
    this.#dropEndedPrevious();
    const granted = this.#options.publicGranted();
    const recipients = (this.#options.hub?.targets() ?? []).map((target) => target.memberId);
    if (
      this.#load().unpublished !== true &&
      granted === this.#publishedGranted &&
      `${recipients.join(",")}@${this.#options.hub?.copyEpoch?.() ?? ""}` ===
        this.#publishedRecipients
    )
      return;
    await this.publish();
  }

  /** A delivery the hub, or a standing-in standby, forwarded. */
  receive(envelope: WebhookDeliveryEnvelope): WebhookDeliveryAnswer {
    if (!this.#options.publicGranted()) return { status: "refused", kind: "public-not-granted" };
    // Pause refuses this spoke's deliveries; the hub keeps them for the hold,
    // so a resume within a day still runs what arrived.
    if (this.#options.remoteAccessPaused()) return { status: "refused", kind: "paused" };
    const now = this.#options.now();
    const held = this.#prune(this.#load(), now);
    const endpointId = String(envelope.endpointId);
    const endpoint = held.endpoints.find((entry) => String(entry.endpointId) === endpointId);
    const secret = endpoint?.secret;
    if (endpoint === undefined || secret === undefined) {
      return { status: "refused", kind: "unknown-endpoint" };
    }
    const body = Buffer.from(envelope.body, "base64");
    const outcome = (result: WebhookDeliveryAnswer): WebhookDeliveryAnswer => {
      const latest = this.#load();
      this.#save({
        ...latest,
        log: [
          ...latest.log,
          {
            at: now,
            endpointId,
            outcome: result.status === "refused" ? result.kind : result.status,
          },
        ].slice(-LOG_MAX),
      });
      return result;
    };
    const reading = readWebhookHeaders(endpoint.scheme, envelope.headers);
    if (reading.status === "refused") return outcome({ status: "refused", kind: reading.kind });
    const verified = verifiedWebhookDeliveryByAny({
      scheme: endpoint.scheme,
      secrets: [
        secret,
        ...keptPrevious(endpoint, now)
          .filter((previous) =>
            replacedWebhookSecretVerifies({
              until: previous.until,
              receivedAtMs: envelope.receivedAt,
              nowMs: now,
            }),
          )
          .map((previous) => previous.secret),
      ],
      reading,
      body,
    });
    const claimed = new Set(
      held.claimed
        .filter((entry) => entry.key.startsWith(`${endpointId}|`))
        .map((entry) => entry.key),
    );
    // The hub may hold a delivery up to a day, so its timestamp is judged at the
    // time the hub received it, and that time must itself be inside the hold.
    // The hub's clock may lead this one by as much as a signature may.
    const decision =
      envelope.receivedAt > now + WEBHOOK_TIMESTAMP_WINDOW_MS ||
      now - envelope.receivedAt > WEBHOOK_HOLD_MS
        ? ({ status: "refused", kind: "stale-timestamp" } as const)
        : decideWebhookDelivery({
            endpointEnabled: true,
            signatureMatches: verified !== undefined,
            ...(reading.timestampMs === undefined ? {} : { timestampMs: reading.timestampMs }),
            nowMs: envelope.receivedAt,
            dedupeKeys: verified?.keys ?? [],
            claimed: (key) => claimed.has(`${endpointId}|${key}`),
          });
    if (decision.status === "duplicate") return outcome({ status: "duplicate" });
    if (decision.status === "refused") return outcome({ status: "refused", kind: decision.kind });
    // An accepted decision always has a verified delivery; this narrows it.
    if (verified === undefined) return outcome({ status: "refused", kind: "bad-signature" });
    // Claims are the only replay guard for GitHub, so they are never evicted
    // to make room; a spoke that is full, or whose routine has not read what
    // it holds, answers busy and the hub keeps the delivery for a later look.
    const unread = held.deliveries.filter(
      (entry) => String(entry.endpointId) === endpointId && entry.readAt === undefined,
    ).length;
    if (
      unread >= UNREAD_PER_ENDPOINT_MAX ||
      held.claimed.length + decision.claimKeys.length > CLAIMED_MAX
    ) {
      return outcome({ status: "refused", kind: "busy" });
    }
    const delivery: SpokeWebhookDelivery = {
      endpointId: endpoint.endpointId,
      deliveryId: verified.deliveryId,
      receivedAt: envelope.receivedAt,
      ...(reading.event === undefined
        ? {}
        : { event: reading.event.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 64) }),
      data: eventData(body),
    };
    this.#save({
      ...held,
      deliveries: keepUnread([...held.deliveries, delivery]),
      claimed: [
        ...held.claimed,
        ...decision.claimKeys.map((key) => ({ key: `${endpointId}|${key}`, at: now })),
      ],
    });
    return outcome({ status: "accepted" });
  }

  /** The webhook source a routine names in its integration-event trigger. */
  eventSources(): IntegrationEventSourceProvider {
    return {
      choices: async () => {
        const endpoints = this.#load().endpoints;
        if (endpoints.length === 0 || !this.#options.publicGranted()) return [];
        return [
          {
            integrationId: AUTOMATION_WEBHOOK_INTEGRATION_ID,
            sourceId: AUTOMATION_WEBHOOK_SOURCE_ID,
            label: "Webhook",
            fields: [
              {
                id: AUTOMATION_WEBHOOK_ENDPOINT_FILTER,
                label: "Endpoint",
                required: true,
                options: endpoints.map((endpoint) => ({
                  value: String(endpoint.endpointId),
                  label: endpoint.label,
                })),
              },
            ],
          },
        ];
      },
      bind: async (selection) => {
        if (
          selection.integrationId !== AUTOMATION_WEBHOOK_INTEGRATION_ID ||
          selection.sourceId !== AUTOMATION_WEBHOOK_SOURCE_ID
        )
          return undefined;
        const endpointId = selection.filters[AUTOMATION_WEBHOOK_ENDPOINT_FILTER];
        if (endpointId === undefined) return undefined;
        // A rotated endpoint answers for the ids it replaced.
        const current = () =>
          this.#load().endpoints.find(
            (entry) =>
              String(entry.endpointId) === endpointId ||
              (entry.formerIds ?? []).some((former) => String(former) === endpointId),
          );
        const endpoint = current();
        if (endpoint === undefined) return undefined;
        const exists = () => this.#options.publicGranted() && current() !== undefined;
        return {
          identity: createHash("sha256").update(`octant-webhook|${endpointId}`).digest("hex"),
          label: `Webhook: ${endpoint.label}`,
          semantics: "assignment-set",
          heldWhileAway: true,
          current: exists,
          read: async () => {
            const live = current();
            if (live === undefined || !this.#options.publicGranted()) {
              return { kind: "unavailable", reason: "source-unavailable" };
            }
            const held = this.#load();
            const shown = held.deliveries
              .filter((delivery) => String(delivery.endpointId) === String(live.endpointId))
              .slice(-EVENTS_PER_READ);
            // A routine starts at most one run a look and holds at most 32
            // waiting events, so each read frees one slot, the oldest: a burst
            // waits on the hub instead of overflowing a busy routine.
            const freed = shown.find((delivery) => delivery.readAt === undefined);
            if (freed !== undefined) {
              const readAt = this.#options.now();
              this.#save({
                ...held,
                deliveries: held.deliveries.map((delivery) =>
                  delivery === freed ? { ...delivery, readAt } : delivery,
                ),
              });
            }
            return { kind: "complete", events: shown.map(eventOf) };
          },
        };
      },
    };
  }

  #drop(endpointId: string): boolean {
    const held = this.#load();
    const kept = held.endpoints.filter((endpoint) => String(endpoint.endpointId) !== endpointId);
    if (kept.length === held.endpoints.length) return false;
    this.#revision += 1;
    this.#save({
      ...held,
      endpoints: kept,
      deliveries: held.deliveries.filter((delivery) => String(delivery.endpointId) !== endpointId),
      unpublished: true,
    });
    this.#options.record({ change: "webhook-endpoint-removed", actingPrincipal: LOCAL_WINDOW });
    return true;
  }

  /** Forgets each replaced Stripe secret nothing held can still need, and withdraws its sealed copies. */
  #dropEndedPrevious(): void {
    const held = this.#load();
    const now = this.#options.now();
    const ended = (entry: SpokeWebhookEndpoint) =>
      (entry.previousSecrets?.length ?? 0) > keptPrevious(entry, now).length;
    if (!held.endpoints.some(ended)) return;
    this.#revision += 1;
    this.#save({
      ...held,
      endpoints: held.endpoints.map((entry) => {
        if (!ended(entry)) return entry;
        const { previousSecrets: _ended, ...rest } = entry;
        const kept = keptPrevious(entry, now);
        return kept.length === 0 ? rest : { ...rest, previousSecrets: kept };
      }),
      unpublished: true,
    });
  }

  #prune(held: SpokeWebhookState, now: number): SpokeWebhookState {
    const cutoff = now - WEBHOOK_DEDUPE_RETENTION_MS;
    return {
      ...held,
      claimed: held.claimed.filter((entry) => entry.at >= cutoff),
      deliveries: held.deliveries.filter((delivery) => delivery.receivedAt >= cutoff),
    };
  }

  #load(): SpokeWebhookState {
    return this.#options.state.load().webhooks ?? empty();
  }

  #save(webhooks: SpokeWebhookState): void {
    this.#options.state.save({ ...this.#options.state.load(), webhooks });
  }
}

/** The secrets Stripe pastes replaced that this spoke still holds, oldest first. */
function keptPrevious(
  endpoint: SpokeWebhookEndpoint,
  now: number,
): NonNullable<SpokeWebhookEndpoint["previousSecrets"]> {
  if (endpoint.scheme !== "stripe") return [];
  return (endpoint.previousSecrets ?? []).filter((previous) =>
    replacedWebhookSecretKept(previous.until, now),
  );
}

/** Trims the oldest deliveries a routine already read, never one it has not. */
function keepUnread(
  deliveries: ReadonlyArray<SpokeWebhookDelivery>,
): ReadonlyArray<SpokeWebhookDelivery> {
  let excess = deliveries.length - DELIVERIES_MAX;
  if (excess <= 0) return deliveries;
  return deliveries.filter((delivery) => {
    if (excess > 0 && delivery.readAt !== undefined) {
      excess -= 1;
      return false;
    }
    return true;
  });
}

/**
 * A routine's event id for a delivery. A delivery id is up to 256 characters,
 * so a long one is hashed whole rather than cut, which would make two deliveries
 * that share a prefix one event.
 */
function eventIdOf(delivery: SpokeWebhookDelivery): string {
  const plain = `${String(delivery.endpointId)}:${delivery.deliveryId}`;
  if (plain.length <= 256) return plain;
  const digest = createHash("sha256").update(delivery.deliveryId).digest("base64url");
  return `${String(delivery.endpointId)}:sha256:${digest}`;
}

function eventOf(delivery: SpokeWebhookDelivery): AutomationIntegrationEvent {
  return {
    id: eventIdOf(delivery),
    label: delivery.event === undefined ? "Webhook delivery" : `GitHub ${delivery.event} delivery`,
    occurredAt: decodeTimestamp(new Date(delivery.receivedAt).toISOString()),
    data: delivery.data,
    routineOutput: false,
  };
}
