import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { setTimeout as pause } from "node:timers/promises";
import { isPrivateAddress, onThisComputerOrNetwork } from "@octant/host-runtime";
import type { AgentMilestoneEvents, JsonObject, MilestoneFilter } from "./agentMilestoneEvents";

const MAX_SUBSCRIPTIONS = 64;
const MAX_PER_GRANT = 8;
const REFRESH_MS = 15 * 60_000;
const MAX_TTL_MS = 60 * 60_000;
const RETRIES_MS = [5_000, 30_000, 120_000] as const;
const CHECK_MS = 5_000;
const REQUEST_MS = 8_000;
const MAX_CHALLENGE_BYTES = 8_192;

export interface WebhookDelivery {
  readonly url: URL;
  readonly secret: Buffer;
}

export interface WebhookSubscription {
  readonly filter: MilestoneFilter;
  readonly delivery: WebhookDelivery;
  readonly compatibility: boolean;
  readonly authorized: () => boolean;
  readonly grantSignal: AbortSignal;
}

interface Subscription extends Omit<WebhookSubscription, "delivery"> {
  readonly url: URL;
  readonly id: string;
  readonly stop: AbortController;
  secret: Buffer;
  previousSecret?: { readonly key: Buffer; readonly until: number };
  sequence: number;
  expires: number;
  busy: boolean;
  unsubscribe: () => void;
}

type PostResult =
  | { readonly status: number; readonly body: string }
  | { readonly reason: "connection_refused" | "timeout" | "tls_error" };

type CallbackReason =
  | "challenge_failed"
  | "http_4xx"
  | "http_5xx"
  | "connection_refused"
  | "timeout"
  | "tls_error";
type CallbackPost = (
  url: URL,
  body: string,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
  readChallenge: boolean,
) => Promise<PostResult>;

export function httpsCallback(value: unknown): URL | undefined {
  if (typeof value !== "string" || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      !onThisComputerOrNetwork(url.href)
    )
      return url;
  } catch {
    return undefined;
  }
  return undefined;
}

/** Host configuration maps each agent grant id to explicit HTTPS origins. */
export function webhookOrigins(
  configuration: string | undefined,
): ReadonlyMap<string, ReadonlySet<string>> {
  if (configuration === undefined) return new Map();
  try {
    const parsed: unknown = JSON.parse(configuration);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    const grants = new Map<string, Set<string>>();
    for (const [grant, values] of Object.entries(parsed)) {
      if (!Array.isArray(values)) continue;
      const origins = new Set<string>();
      for (const value of values) {
        const url = httpsCallback(value);
        if (url !== undefined && url.pathname === "/" && !url.search) origins.add(url.origin);
      }
      if (origins.size > 0) grants.set(grant, origins);
    }
    return grants;
  } catch {
    return new Map();
  }
}

export function webhookSecret(value: unknown): Buffer | undefined {
  if (typeof value !== "string" || !/^whsec_[A-Za-z0-9+/]{32,86}={0,2}$/.test(value))
    return undefined;
  const encoded = value.slice(6);
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.length < 24 || decoded.length > 64) return undefined;
  const canonical = decoded.toString("base64");
  return encoded === canonical || encoded === canonical.replace(/=+$/, "") ? decoded : undefined;
}

function subscriptionId(filter: MilestoneFilter, url: URL): string {
  return (
    "sub_" +
    createHash("sha256")
      .update(
        JSON.stringify([filter.grantId, url.href, filter.name, { threadId: filter.threadId }]),
      )
      .digest("base64url")
  );
}

export class AgentEventWebhooks {
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #verifying = new Set<string>();
  readonly #lastVerification = new Map<string, number>();

  readonly #events: AgentMilestoneEvents;
  readonly #origins: ReadonlyMap<string, ReadonlySet<string>>;
  readonly #post: CallbackPost;
  readonly #clock: () => number;

  constructor(
    events: AgentMilestoneEvents,
    origins: ReadonlyMap<string, ReadonlySet<string>>,
    post: CallbackPost = postToCallback,
    clock: () => number = Date.now,
  ) {
    this.#events = events;
    this.#origins = origins;
    this.#post = post;
    this.#clock = clock;
  }

  available(grantId: string): boolean {
    return this.#origins.has(grantId);
  }

  allows(grantId: string, url: URL): boolean {
    return this.#origins.get(grantId)?.has(url.origin) === true;
  }

  async subscribe(
    input: WebhookSubscription,
    position: { readonly sequence: number; readonly truncated: boolean },
    ttlMs: number | undefined,
    requestSignal: AbortSignal,
  ): Promise<
    | { readonly kind: "subscribed"; readonly result: JsonObject }
    | { readonly kind: "refused" | "limited" }
    | { readonly kind: "callback"; readonly reason: CallbackReason }
  > {
    if (!input.authorized() || !this.allows(input.filter.grantId, input.delivery.url))
      return { kind: "refused" };
    const id = subscriptionId(input.filter, input.delivery.url);
    const now = this.#clock();
    const ttl = Math.min(ttlMs ?? REFRESH_MS, MAX_TTL_MS);
    let current = this.#subscriptions.get(id);
    if (current !== undefined && (current.expires <= now || !current.authorized())) {
      this.#end(current);
      current = undefined;
    }
    if (current !== undefined) {
      if (!current.secret.equals(input.delivery.secret)) {
        current.previousSecret = { key: current.secret, until: now + 5 * 60_000 };
        current.secret = input.delivery.secret;
      }
      current.expires = now + ttl;
      return { kind: "subscribed", result: this.#result(current, false) };
    }

    const perGrant = [...this.#subscriptions.values()].filter(
      (sub) => sub.filter.grantId === input.filter.grantId,
    ).length;
    const origin = input.delivery.url.origin;
    for (const [target, at] of this.#lastVerification) {
      if (now - at >= 1_000) this.#lastVerification.delete(target);
    }
    if (
      perGrant >= MAX_PER_GRANT ||
      this.#subscriptions.size + this.#verifying.size >= MAX_SUBSCRIPTIONS ||
      this.#verifying.has(input.filter.grantId) ||
      this.#lastVerification.has(origin)
    ) {
      return { kind: "limited" };
    }
    this.#verifying.add(input.filter.grantId);
    this.#lastVerification.set(origin, now);
    const challenge = randomBytes(24).toString("base64url");
    const stop = new AbortController();
    const subscription: Subscription = {
      filter: input.filter,
      url: input.delivery.url,
      authorized: input.authorized,
      grantSignal: input.grantSignal,
      compatibility: input.compatibility,
      id,
      stop,
      secret: input.delivery.secret,
      sequence: position.sequence,
      expires: now + ttl,
      busy: false,
      unsubscribe: () => {},
    };
    let verified: PostResult;
    try {
      verified = await this.#signAndPost(
        subscription,
        { type: "verification", challenge },
        messageId("verification"),
        AbortSignal.any([input.grantSignal, requestSignal]),
        true,
      );
    } finally {
      this.#verifying.delete(input.filter.grantId);
    }
    if (!input.authorized() || requestSignal.aborted) return { kind: "refused" };
    const reason = callbackFailure(verified);
    if (reason !== undefined) return { kind: "callback", reason };
    if (!("body" in verified) || !matchesChallenge(verified.body, challenge)) {
      return { kind: "callback", reason: "challenge_failed" };
    }

    subscription.expires = this.#clock() + ttl;
    const result = this.#result(subscription, position.truncated);
    this.#subscriptions.set(id, subscription);
    const wake = () => {
      void this.#drain(subscription).catch(() => this.#end(subscription));
    };
    const timer = setInterval(wake, CHECK_MS);
    timer.unref();
    const unsubscribe = this.#events.onCommit(() => {
      setImmediate(wake);
    });
    const revoked = () => {
      void this.#terminate(subscription).catch(() => this.#end(subscription));
    };
    input.grantSignal.addEventListener("abort", revoked, { once: true });
    subscription.unsubscribe = () => {
      unsubscribe();
      clearInterval(timer);
      input.grantSignal.removeEventListener("abort", revoked);
    };
    setImmediate(wake);
    return { kind: "subscribed", result };
  }

  unsubscribe(filter: MilestoneFilter, url: URL): boolean {
    const subscription = this.#subscriptions.get(subscriptionId(filter, url));
    if (subscription === undefined) return false;
    this.#end(subscription);
    return true;
  }

  #result(subscription: Subscription, truncated: boolean): JsonObject {
    return {
      id: subscription.id,
      refreshBefore: new Date(subscription.expires).toISOString(),
      cursor: this.#events.cursor(subscription.filter, subscription.sequence),
      truncated,
    };
  }

  #end(subscription: Subscription): void {
    if (this.#subscriptions.get(subscription.id) !== subscription) return;
    this.#subscriptions.delete(subscription.id);
    subscription.stop.abort();
    subscription.unsubscribe();
  }

  async #terminate(subscription: Subscription): Promise<void> {
    if (subscription.stop.signal.aborted) return;
    this.#end(subscription);
    await this.#signAndPost(
      subscription,
      {
        type: "terminated",
        error: { code: -32024, message: "Forbidden" },
      },
      messageId("terminated"),
      AbortSignal.timeout(REQUEST_MS),
      false,
    );
  }

  async #drain(subscription: Subscription): Promise<void> {
    if (subscription.stop.signal.aborted || subscription.busy) return;
    if (!subscription.authorized()) {
      await this.#terminate(subscription);
      return;
    }
    if (subscription.expires <= this.#clock()) {
      this.#end(subscription);
      return;
    }
    subscription.busy = true;
    try {
      const batch = this.#events.batch(subscription.filter, subscription.sequence, 1);
      const entry = batch.entries[0];
      if (batch.truncated) {
        await this.#deliver(
          subscription,
          {
            type: "gap",
            cursor: this.#events.cursor(subscription.filter, batch.sequence),
          },
          messageId("gap"),
        );
      } else if (entry !== undefined) {
        // Keep the previous watermark until this delivery is acknowledged or abandoned.
        const id = subscription.compatibility ? entry.event.eventId : messageId("event");
        await this.#deliver(
          subscription,
          {
            ...entry.event,
            cursor: this.#events.cursor(subscription.filter, subscription.sequence),
          },
          id,
        );
      }
      if (!subscription.stop.signal.aborted) {
        subscription.sequence = batch.sequence;
        if (batch.hasMore)
          setImmediate(() => {
            void this.#drain(subscription).catch(() => this.#end(subscription));
          });
      }
    } finally {
      subscription.busy = false;
    }
  }

  async #deliver(subscription: Subscription, payload: JsonObject, id: string): Promise<void> {
    for (const delay of [0, ...RETRIES_MS]) {
      if (delay > 0) {
        await pause(delay, undefined, { signal: subscription.stop.signal }).catch(() => undefined);
      }
      if (
        subscription.stop.signal.aborted ||
        subscription.expires <= this.#clock() ||
        !subscription.authorized()
      )
        return;
      const result = await this.#signAndPost(
        subscription,
        payload,
        id,
        subscription.stop.signal,
        false,
      );
      if (
        "status" in result &&
        ((result.status >= 200 && result.status < 300) ||
          result.status === 410 ||
          result.status === 413)
      )
        return;
    }
  }

  #signAndPost(
    subscription: Subscription,
    payload: JsonObject,
    id: string,
    signal: AbortSignal,
    challenge: boolean,
  ): Promise<PostResult> {
    const body = JSON.stringify(payload);
    const timestamp = String(Math.floor(this.#clock() / 1000));
    const previous = subscription.previousSecret;
    const keys =
      previous !== undefined && previous.until > this.#clock()
        ? [subscription.secret, previous.key]
        : [subscription.secret];
    const signatures = keys.map(
      (key) =>
        "v1," + createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64"),
    );
    return this.#post(
      subscription.url,
      body,
      {
        "content-type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": timestamp,
        "webhook-signature": signatures.join(" "),
        "x-mcp-subscription-id": subscription.id,
      },
      signal,
      challenge,
    );
  }
}

function messageId(type: string): string {
  return `msg_${type}_${randomBytes(18).toString("base64url")}`;
}

function matchesChallenge(body: string, challenge: string): boolean {
  try {
    const offered: unknown = JSON.parse(body)?.challenge;
    if (typeof offered !== "string") return false;
    const value = Buffer.from(offered);
    const expected = Buffer.from(challenge);
    return value.length === expected.length && timingSafeEqual(value, expected);
  } catch {
    return false;
  }
}

function callbackFailure(result: PostResult): CallbackReason | undefined {
  if ("reason" in result) return result.reason;
  if (result.status >= 200 && result.status < 300) return undefined;
  return result.status >= 500 ? "http_5xx" : "http_4xx";
}

/** Connect to the vetted address directly and keep the callback's hostname for TLS. */
async function postToCallback(
  url: URL,
  body: string,
  headers: Readonly<Record<string, string>>,
  signal: AbortSignal,
  challenge: boolean,
): Promise<PostResult> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const timeout = AbortSignal.timeout(REQUEST_MS);
  const requestSignal = AbortSignal.any([signal, timeout]);
  try {
    const addresses = await lookup(hostname, { all: true });
    const target = addresses[0];
    if (
      requestSignal.aborted ||
      target === undefined ||
      addresses.some(({ address }) => isPrivateAddress(address))
    ) {
      return { reason: timeout.aborted ? "timeout" : "connection_refused" };
    }
    return await new Promise<PostResult>((resolve) => {
      const post = request(
        {
          hostname: target.address,
          port: url.port || 443,
          path: url.pathname + url.search,
          method: "POST",
          servername: isIP(hostname) === 0 ? hostname : undefined,
          headers: { ...headers, host: url.host, "content-length": Buffer.byteLength(body) },
          agent: false,
          signal: requestSignal,
        },
        (response) => {
          const status = response.statusCode ?? 500;
          if (!challenge || status < 200 || status >= 300) {
            response.destroy();
            resolve({ status, body: "" });
            return;
          }
          const chunks: Array<Buffer> = [];
          let length = 0;
          response.on("data", (chunk: Buffer) => {
            length += chunk.length;
            if (length > MAX_CHALLENGE_BYTES) {
              resolve({ status, body: "" });
              response.destroy();
            } else {
              chunks.push(chunk);
            }
          });
          response.on("end", () =>
            resolve({ status, body: Buffer.concat(chunks).toString("utf8") }),
          );
          response.on("error", () =>
            resolve({ reason: timeout.aborted ? "timeout" : "connection_refused" }),
          );
          response.on("close", () =>
            resolve({ reason: timeout.aborted ? "timeout" : "connection_refused" }),
          );
        },
      );
      post.on("error", (error: NodeJS.ErrnoException) =>
        resolve({
          reason: timeout.aborted
            ? "timeout"
            : /^(ERR_TLS|CERT_|UNABLE_TO_|SELF_SIGNED)/.test(error.code ?? "")
              ? "tls_error"
              : "connection_refused",
        }),
      );
      post.end(body);
    });
  } catch {
    return { reason: timeout.aborted ? "timeout" : "connection_refused" };
  }
}
