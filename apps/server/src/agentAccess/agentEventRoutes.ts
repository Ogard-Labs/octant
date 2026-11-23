import { setImmediate as yieldToEvents } from "node:timers/promises";
import {
  AGENT_EVENTS_EXTENSION,
  AGENT_EVENTS_VERSION,
  isMilestoneName,
  milestoneCatalog,
  type AgentMilestoneEvents,
  type JsonObject,
  type MilestoneFilter,
  type RpcId,
} from "./agentMilestoneEvents";
import { httpsCallback, webhookSecret, type AgentEventWebhooks } from "./agentEventWebhooks";

const MAX_STREAMS = 64;
const MAX_GRANT_STREAMS = 8;
const NEXT_POLL_MS = 5_000;
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_SUBSCRIPTION = "io.modelcontextprotocol/subscriptionId";
const FORBIDDEN = { code: -32024, message: "Forbidden" };

export interface AgentEventAccess {
  readonly grantId: string;
  readonly grantSignal: AbortSignal;
  readonly canRead: (threadId: string) => boolean;
  readonly allowed: boolean;
}

interface EventRequest {
  readonly request: Request;
  readonly id: RpcId;
  readonly method: string;
  readonly params: JsonObject | undefined;
  readonly access: AgentEventAccess;
  readonly compatibility: boolean;
}

export function rpcObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function rpc(id: RpcId, result: JsonObject): Response {
  return Response.json(
    { jsonrpc: "2.0", id, result: { resultType: "complete", ...result } },
    { headers: { "cache-control": "no-store" } },
  );
}

export function eventFailure(
  id: RpcId,
  code: number,
  message: string,
  status = 200,
  data?: JsonObject,
): Response {
  return Response.json(
    { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export function modernAgentMcp(request: Request, params: JsonObject | undefined): boolean {
  const version = request.headers.get("mcp-protocol-version");
  return (
    rpcObject(params?.["_meta"])?.[META_VERSION] !== undefined ||
    (version !== null && version >= AGENT_EVENTS_VERSION)
  );
}

export function validateEventHeaders(
  request: Request,
  id: RpcId,
  method: string,
  params: JsonObject | undefined,
  compatibility: boolean,
  named: boolean,
): Response | undefined {
  const headerVersion = request.headers.get("mcp-protocol-version");
  const bodyVersion = rpcObject(params?.["_meta"])?.[META_VERSION];
  const headerMethod = request.headers.get("mcp-method");
  const encodedName = request.headers.get("mcp-name");
  const sentinel =
    encodedName === null
      ? undefined
      : /^=\?base64\?([A-Za-z0-9+/]+={0,2})\?=$/.exec(encodedName)?.[1];
  const name =
    sentinel === undefined ? encodedName : Buffer.from(sentinel, "base64").toString("utf8");
  if (
    (!compatibility &&
      (headerMethod === null ||
        bodyVersion === undefined ||
        headerVersion === null ||
        (named && name === null))) ||
    (headerVersion !== null && bodyVersion !== undefined && headerVersion !== bodyVersion) ||
    (headerMethod !== null && headerMethod !== method) ||
    (named && name !== null && name !== params?.["name"])
  ) {
    return eventFailure(id, -32020, "HeaderMismatch", 400);
  }
  const version = bodyVersion ?? headerVersion;
  const legacyVersion =
    version === null ||
    version === "2025-11-25" ||
    version === "2025-06-18" ||
    version === "2025-03-26" ||
    version === "2024-11-05";
  if (version !== AGENT_EVENTS_VERSION && !(compatibility && legacyVersion)) {
    return eventFailure(id, -32022, "UnsupportedProtocolVersionError", 400, {
      supported: [AGENT_EVENTS_VERSION],
      requested: version,
    });
  }
  return undefined;
}

export class AgentEventRoutes {
  readonly #streamsByGrant = new Map<string, number>();
  #streams = 0;

  readonly #events: AgentMilestoneEvents;
  readonly #webhooks: AgentEventWebhooks;
  readonly #legacyWebhooks: boolean;

  constructor(events: AgentMilestoneEvents, webhooks: AgentEventWebhooks, legacyWebhooks: boolean) {
    this.#events = events;
    this.#webhooks = webhooks;
    this.#legacyWebhooks = legacyWebhooks;
  }

  compatibility(access: AgentEventAccess): boolean {
    return access.allowed && this.#legacyWebhooks && this.#webhooks.available(access.grantId);
  }

  discover(id: RpcId, access: AgentEventAccess, version: string): Response {
    return rpc(id, {
      supportedVersions: [AGENT_EVENTS_VERSION],
      capabilities: {
        tools: {},
        ...(access.allowed ? { extensions: { [AGENT_EVENTS_EXTENSION]: {} } } : {}),
        ...(this.compatibility(access) ? { events: {} } : {}),
      },
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "octant", title: "Octant", version } },
    });
  }

  async handle(input: EventRequest): Promise<Response> {
    const { request, id, method, params, access, compatibility } = input;
    if (
      ![
        "events/list",
        "events/poll",
        "events/stream",
        "events/subscribe",
        "events/unsubscribe",
      ].includes(method)
    ) {
      return eventFailure(id, -32601, "Method not found", 404);
    }
    const legacy =
      compatibility && ["events/list", "events/subscribe", "events/unsubscribe"].includes(method);
    const invalidHeaders = validateEventHeaders(
      request,
      id,
      method,
      params,
      legacy,
      method !== "events/list",
    );
    if (invalidHeaders !== undefined) return invalidHeaders;
    if (!access.allowed) return eventFailure(id, FORBIDDEN.code, FORBIDDEN.message);
    if (method === "events/list") {
      return rpc(id, { events: milestoneCatalog(this.#webhooks.available(access.grantId)) });
    }

    const name = params?.["name"];
    if (!isMilestoneName(name))
      return eventFailure(id, -32023, "Unknown event", 200, { kind: "event" });
    const arguments_ = rpcObject(params?.["arguments"]);
    const threadId = arguments_?.["threadId"];
    const cursor = params?.["cursor"] ?? null;
    const maxAgeMs = params?.["maxAgeMs"];
    const maxEvents = params?.["maxEvents"];
    const heartbeatMs = params?.["heartbeatMs"];
    const ttlMs = params?.["ttlMs"] ?? undefined;
    if (
      typeof threadId !== "string" ||
      threadId.length === 0 ||
      threadId.length > 64 ||
      Object.keys(arguments_ ?? {}).length !== 1 ||
      (cursor !== null && (typeof cursor !== "string" || cursor.length > 128)) ||
      !optionalInteger(maxAgeMs, 0) ||
      !optionalInteger(maxEvents, 1) ||
      !optionalInteger(heartbeatMs, 1) ||
      !optionalInteger(ttlMs, 1)
    ) {
      return eventFailure(id, -32602, "Invalid event parameters");
    }
    const filter = { grantId: access.grantId, name, threadId };
    const authorized = () => !access.grantSignal.aborted && access.canRead(threadId);
    if (!authorized()) return eventFailure(id, FORBIDDEN.code, FORBIDDEN.message);

    if (method === "events/poll") {
      const position = this.#events.position(filter, cursor, maxAgeMs);
      const batch =
        cursor === null
          ? {
              entries: [],
              sequence: position.sequence,
              hasMore: false,
              truncated: false,
            }
          : this.#events.batch(filter, position.sequence, Math.min(maxEvents ?? 20, 64));
      return rpc(id, {
        events: batch.entries.map(({ event }) => event),
        cursor: this.#events.cursor(filter, batch.sequence),
        truncated: position.truncated || batch.truncated,
        hasMore: batch.hasMore,
        nextPollMs: NEXT_POLL_MS,
      });
    }

    if (method === "events/stream") {
      if (!(request.headers.get("accept") ?? "").includes("text/event-stream")) {
        return eventFailure(id, -32602, "Accept must include text/event-stream", 406);
      }
      return this.#stream(input, filter, authorized, cursor, maxAgeMs, heartbeatMs);
    }

    if (!this.#webhooks.available(access.grantId)) {
      return eventFailure(id, -32026, "Webhook delivery is disabled for this grant", 200, {
        feature: "deliveryMode",
        value: "webhook",
      });
    }
    const delivery = rpcObject(params?.["delivery"]);
    const url = httpsCallback(delivery?.["url"]);
    if (
      url === undefined ||
      (method === "events/subscribe" &&
        delivery?.["mode"] !== "webhook" &&
        !(legacy && delivery?.["mode"] === undefined))
    ) {
      return eventFailure(id, -32602, "Invalid webhook delivery parameters");
    }
    if (!this.#webhooks.allows(access.grantId, url)) {
      return eventFailure(id, FORBIDDEN.code, FORBIDDEN.message);
    }
    if (method === "events/unsubscribe") {
      return this.#webhooks.unsubscribe(filter, url)
        ? rpc(id, {})
        : eventFailure(id, -32023, "Unknown subscription", 200, { kind: "subscription" });
    }
    const secret = webhookSecret(delivery?.["secret"]);
    if (secret === undefined) return eventFailure(id, -32602, "Invalid webhook signing secret");
    const subscription = await this.#webhooks.subscribe(
      {
        filter,
        delivery: { url, secret },
        compatibility: legacy,
        authorized,
        grantSignal: access.grantSignal,
      },
      this.#events.position(filter, cursor, maxAgeMs),
      ttlMs,
      request.signal,
    );
    switch (subscription.kind) {
      case "subscribed":
        return rpc(id, subscription.result);
      case "refused":
        return eventFailure(id, FORBIDDEN.code, FORBIDDEN.message);
      case "limited":
        return eventFailure(id, -32025, "Subscription limit reached", 200, {
          limit: "subscriptions",
        });
      case "callback":
        return eventFailure(id, legacy ? -32015 : -32027, "Callback verification failed", 200, {
          reason: subscription.reason,
        });
    }
  }

  #stream(
    input: EventRequest,
    filter: MilestoneFilter,
    authorized: () => boolean,
    cursor: string | null,
    maxAgeMs: number | undefined,
    suggestedHeartbeat: number | undefined,
  ): Response {
    const heartbeatMs = Math.min(10_000, Math.max(1_000, suggestedHeartbeat ?? 5_000));
    const position = this.#events.position(filter, cursor, maxAgeMs);
    const initialCursor = this.#events.cursor(filter, position.sequence);
    const byGrant = this.#streamsByGrant.get(filter.grantId) ?? 0;
    if (this.#streams >= MAX_STREAMS || byGrant >= MAX_GRANT_STREAMS) {
      return eventFailure(input.id, -32025, "Stream limit reached", 200, {
        limit: "subscriptions",
      });
    }
    this.#streams += 1;
    this.#streamsByGrant.set(filter.grantId, byGrant + 1);
    const stop = new AbortController();
    const events = this.#events;
    const requestSignal = input.request.signal;
    const grantSignal = input.access.grantSignal;
    let removeListeners = () => {};
    const release = () => {
      if (stop.signal.aborted) return;
      stop.abort();
      this.#streams -= 1;
      const remaining = (this.#streamsByGrant.get(filter.grantId) ?? 1) - 1;
      if (remaining === 0) this.#streamsByGrant.delete(filter.grantId);
      else this.#streamsByGrant.set(filter.grantId, remaining);
      removeListeners();
    };

    const encoder = new TextEncoder();
    const frame = (message: JsonObject) =>
      encoder.encode("event: message\ndata: " + JSON.stringify(message) + "\n\n");
    const _meta = { [META_SUBSCRIPTION]: input.id };
    const notice = (type: string, params: JsonObject) =>
      frame({
        jsonrpc: "2.0",
        method: "notifications/events/" + type,
        params: { ...params, _meta },
      });
    const finish = (controller: ReadableStreamDefaultController<Uint8Array>, revoked: boolean) => {
      if (stop.signal.aborted) return;
      if (revoked) {
        controller.enqueue(notice("terminated", { error: FORBIDDEN }));
        controller.enqueue(
          frame({ jsonrpc: "2.0", id: input.id, result: { resultType: "complete", _meta } }),
        );
      }
      controller.close();
      release();
    };
    let sequence = position.sequence;
    let heartbeatAt = Date.now() + heartbeatMs;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // A backpressured stream can stop calling pull, so close and release it
        // directly when its grant or transport ends.
        const disconnect = () => finish(controller, false);
        const revoke = () => finish(controller, true);
        removeListeners = () => {
          requestSignal.removeEventListener("abort", disconnect);
          grantSignal.removeEventListener("abort", revoke);
        };
        if (requestSignal.aborted) {
          disconnect();
          return;
        }
        controller.enqueue(
          notice("active", {
            cursor: initialCursor,
            truncated: position.truncated,
            heartbeatMs,
          }),
        );
        if (grantSignal.aborted) {
          revoke();
          return;
        }
        requestSignal.addEventListener("abort", disconnect, { once: true });
        grantSignal.addEventListener("abort", revoke, { once: true });
      },
      async pull(controller) {
        try {
          while (!stop.signal.aborted) {
            if (!authorized()) {
              finish(controller, true);
              return;
            }
            const batch = events.batch(filter, sequence, 1);
            sequence = batch.sequence;
            const entry = batch.entries[0];
            if (batch.truncated || entry !== undefined) {
              const advanced = events.cursor(filter, sequence);
              controller.enqueue(
                batch.truncated
                  ? notice("active", { cursor: advanced, truncated: true, heartbeatMs })
                  : notice("event", { ...entry?.event, cursor: advanced }),
              );
              heartbeatAt = Date.now() + heartbeatMs;
              return;
            }
            const remaining = heartbeatAt - Date.now();
            if (remaining <= 0) {
              controller.enqueue(notice("heartbeat", { cursor: events.cursor(filter, sequence) }));
              heartbeatAt = Date.now() + heartbeatMs;
              return;
            }
            if (batch.hasMore) {
              await yieldToEvents();
              continue;
            }
            await waitForCommit(events, remaining, stop.signal);
          }
        } catch {
          if (!stop.signal.aborted) {
            controller.error(new Error("Octant could not read thread milestones"));
            release();
          }
        }
      },
      cancel: release,
    });
    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  }
}

function optionalInteger(value: unknown, min: number): value is number | undefined {
  return (
    value === undefined ||
    (typeof value === "number" && Number.isSafeInteger(value) && value >= min)
  );
}

function waitForCommit(
  events: AgentMilestoneEvents,
  ms: number,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      unsubscribe();
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const unsubscribe = events.onCommit(finish);
    const timer = setTimeout(finish, ms);
    if (signal.aborted) finish();
    else signal.addEventListener("abort", finish, { once: true });
  });
}
