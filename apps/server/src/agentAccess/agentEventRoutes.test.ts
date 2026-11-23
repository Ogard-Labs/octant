import { createHmac, randomUUID } from "node:crypto";
import { EventEnvelope } from "@octant/contracts";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { nodeServe } from "../nodeServe";
import { AgentEventRoutes, type AgentEventAccess } from "./agentEventRoutes";
import { AgentEventWebhooks, webhookOrigins } from "./agentEventWebhooks";
import { AGENT_EVENTS_VERSION, AgentMilestoneEvents } from "./agentMilestoneEvents";

const grantId = "grant";
const threadId = "10000000-0000-4000-8000-000000000001";
const otherThread = "10000000-0000-4000-8000-000000000002";
const versionMeta = "io.modelcontextprotocol/protocolVersion";
const name = "thread.turn_settled";
const time = Date.parse("2026-11-23T12:00:00.000Z");
const callback = "https://receiver.example/updates";
const key = Buffer.alloc(32, 3);
const secret = "whsec_" + key.toString("base64");
const decode = Schema.decodeUnknownSync(EventEnvelope);

function setup(
  options: { readonly legacy?: boolean; readonly webhook?: boolean; readonly echo?: boolean } = {},
) {
  const rows: Array<EventEnvelope> = [];
  const listeners = new Set<() => void>();
  const grant = new AbortController();
  const posts: Array<{
    readonly body: Record<string, unknown>;
    readonly headers: Readonly<Record<string, string>>;
  }> = [];
  const journal = {
    headSequence: () => rows.length,
    replay: ({
      afterSequence,
      limit,
    }: {
      readonly afterSequence: number;
      readonly limit: number;
    }) => rows.slice(afterSequence, afterSequence + limit),
    subscribeCommitted: (wake: () => void) => {
      listeners.add(wake);
      return () => {
        listeners.delete(wake);
      };
    },
  };
  const events = new AgentMilestoneEvents(
    journal,
    () => key,
    () => time,
  );
  const webhooks = new AgentEventWebhooks(
    events,
    webhookOrigins(
      options.webhook ? JSON.stringify({ [grantId]: [new URL(callback).origin] }) : undefined,
    ),
    async (_url, body, headers) => {
      posts.push({ body: JSON.parse(body), headers });
      return { status: 200, body: options.echo === false ? "{}" : body };
    },
    () => time,
  );
  const routes = new AgentEventRoutes(events, webhooks, options.legacy ?? false);
  const access: AgentEventAccess = {
    grantId,
    grantSignal: grant.signal,
    allowed: true,
    canRead: (id) => id === threadId,
  };
  const append = (
    thread: string,
    eventName: string,
    payload: unknown,
    occurredAt = time,
    aggregateType = "code-thread",
  ) => {
    const sequence = rows.length + 1;
    rows.push(
      decode({
        eventId: randomUUID(),
        globalSequence: sequence,
        aggregateType,
        aggregateId: thread,
        aggregateVersion: sequence,
        eventName,
        eventVersion: 1,
        hostId: "local",
        correlationId: randomUUID(),
        actor: { kind: "system", actorId: randomUUID() },
        occurredAt: new Date(occurredAt).toISOString(),
        payload,
      }),
    );
    for (const wake of listeners) wake();
  };
  const record = (thread: string, state = "completed", occurredAt = time) => {
    append(
      thread,
      "code.runtime-work-updated@1",
      {
        work: {
          kind: "provider-turn",
          threadId: thread,
          state,
          id: "turn-" + (rows.length + 1),
          transcript: "private",
        },
      },
      occurredAt,
    );
  };
  const recordChat = (attempt: Record<string, unknown>) => {
    append(
      threadId,
      "chat.attempt-updated@1",
      { attempt: { threadId, ...attempt } },
      time,
      "chat-thread",
    );
  };
  const call = (
    method: string,
    args: Record<string, unknown> = {},
    tweaks: {
      readonly eventName?: string | null;
      readonly stdioDraft?: boolean;
      readonly access?: AgentEventAccess;
    } = {},
  ) => {
    const headers = new Headers({ accept: "application/json, text/event-stream" });
    const selectedName =
      tweaks.eventName === undefined
        ? typeof args.name === "string"
          ? args.name
          : name
        : tweaks.eventName;
    if (!tweaks.stdioDraft) {
      headers.set("mcp-protocol-version", AGENT_EVENTS_VERSION);
      headers.set("mcp-method", method);
      if (selectedName !== null && method !== "events/list") headers.set("mcp-name", selectedName);
    }
    const params = {
      ...(method === "events/list" ? {} : { name, arguments: { threadId } }),
      ...(tweaks.stdioDraft ? {} : { _meta: { [versionMeta]: AGENT_EVENTS_VERSION } }),
      ...args,
    };
    const chosenAccess = tweaks.access ?? access;
    return routes.handle({
      request: new Request("https://host.example/mcp", { method: "POST", headers }),
      id: 1,
      method,
      params,
      access: chosenAccess,
      compatibility: routes.compatibility(chosenAccess),
    });
  };
  return { call, record, recordChat, grant, posts, access, listeners, journal, routes };
}

async function frame(reader: ReadableStreamDefaultReader<Uint8Array>) {
  const next = await reader.read();
  if (next.done) throw new Error("Closed before the next frame");
  return JSON.parse(new TextDecoder().decode(next.value).split("data: ")[1] ?? "");
}

describe("Octant MCP Events", () => {
  it("boots a filtered cursor, replays authorized milestones, and scopes cursors to the grant", async () => {
    const host = setup();
    host.record(threadId);
    const first = await (await host.call("events/poll")).json();
    expect(first.result).toMatchObject({ resultType: "complete", events: [], truncated: false });
    host.record(otherThread);
    host.record(threadId, "running");
    host.record(threadId, "failed");
    const next = await (await host.call("events/poll", { cursor: first.result.cursor })).json();
    expect(next.result.events).toEqual([
      {
        eventId: expect.stringMatching(/^evt_/),
        name,
        timestamp: new Date(time).toISOString(),
        data: { threadId, turnId: "turn-4", status: "failed" },
      },
    ]);
    const fromOtherGrant = await (
      await host.call(
        "events/poll",
        { cursor: first.result.cursor },
        {
          access: { ...host.access, grantId: "other" },
        },
      )
    ).json();
    expect(fromOtherGrant.result).toMatchObject({ events: [], truncated: true });
    const restored = new AgentMilestoneEvents(
      host.journal,
      () => key,
      () => time,
    );
    expect(restored.position({ grantId, name, threadId }, next.result.cursor)).toEqual({
      sequence: 4,
      truncated: false,
    });
    const forbidden = await (
      await host.call("events/poll", { arguments: { threadId: otherThread } })
    ).json();
    expect(forbidden.error.code).toBe(-32024);
  });

  it("delivers fresh milestones in the poll that skips rows older than the age limit", async () => {
    const host = setup();
    const first = await (await host.call("events/poll")).json();
    host.record(threadId, "completed", time - 4_000);
    host.record(threadId, "failed", time - 1_000);
    const next = await (
      await host.call("events/poll", {
        cursor: first.result.cursor,
        maxAgeMs: 2_000,
      })
    ).json();
    expect(next.result).toMatchObject({
      truncated: true,
      hasMore: false,
      events: [{ data: { threadId, turnId: "turn-2", status: "failed" } }],
    });
  });

  it("publishes the Chat question's request id and omits waiting attempts without a question", async () => {
    const host = setup();
    const event = { name: "thread.input_required" };
    const first = await (await host.call("events/poll", event)).json();
    const attempt = { id: randomUUID(), turnId: randomUUID(), outcome: "waiting" };
    host.recordChat(attempt);
    host.recordChat({
      ...attempt,
      pendingQuestion: { requestId: "provider-question-1", prompt: "Which test runner?" },
    });
    const next = await (
      await host.call("events/poll", { ...event, cursor: first.result.cursor })
    ).json();
    expect(next.result.events).toEqual([
      {
        eventId: expect.stringMatching(/^evt_/),
        name: event.name,
        timestamp: new Date(time).toISOString(),
        data: { threadId, requestId: "provider-question-1", kind: "question" },
      },
    ]);
  });

  it("uses the Chat turn id from the transcript for settled milestones", async () => {
    const host = setup();
    const first = await (await host.call("events/poll")).json();
    const turnId = randomUUID();
    host.recordChat({ id: randomUUID(), turnId, outcome: "completed" });
    const next = await (await host.call("events/poll", { cursor: first.result.cursor })).json();
    expect(next.result.events).toMatchObject([{ data: { threadId, turnId, status: "completed" } }]);
  });

  it("rejects missing or mismatched routing headers on the strict route", async () => {
    const host = setup();
    for (const eventName of [null, "other"]) {
      const response = await host.call("events/poll", {}, { eventName });
      expect(response.status).toBe(400);
      expect((await response.json()).error.code).toBe(-32020);
    }
    const catalog = await (await host.call("events/list")).json();
    expect(catalog.result.events.map((event: { delivery: string[] }) => event.delivery)).toEqual([
      ["poll", "push"],
      ["poll", "push"],
    ]);
  });

  it("streams committed milestones and closes a revoked grant's stream", async () => {
    const host = setup();
    const response = await host.call("events/stream");
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("Expected an event stream");
    expect(await frame(reader)).toMatchObject({
      method: "notifications/events/active",
      params: {
        _meta: { "io.modelcontextprotocol/subscriptionId": 1 },
      },
    });
    host.record(threadId);
    expect(await frame(reader)).toMatchObject({
      method: "notifications/events/event",
      params: { name, data: { threadId } },
    });
    host.grant.abort();
    expect(await frame(reader)).toMatchObject({ method: "notifications/events/terminated" });
    expect(await frame(reader)).toMatchObject({ id: 1, result: { resultType: "complete" } });
    expect((await reader.read()).done).toBe(true);
    expect(host.listeners.size).toBe(0);
  });

  it("reclaims slots from revoked streams even when their readers are stalled", async () => {
    const host = setup();
    const streams = await Promise.all(Array.from({ length: 8 }, () => host.call("events/stream")));
    const replacement = new AbortController();
    try {
      const access = { ...host.access, grantSignal: replacement.signal };
      const atLimit = await host.call("events/stream", {}, { access });
      expect((await atLimit.json()).error.code).toBe(-32025);
      host.grant.abort();
      const reopened = await host.call("events/stream", {}, { access });
      try {
        expect(reopened.headers.get("content-type")).toBe("text/event-stream");
      } finally {
        await reopened.body?.cancel();
      }
    } finally {
      replacement.abort();
      await Promise.all(streams.map((response) => response.body?.cancel()));
    }
  });

  it("reuses a subscription slot when an HTTP client disconnects", async () => {
    const host = setup();
    const occupying = await Promise.all(
      Array.from({ length: 7 }, () => host.call("events/stream")),
    );
    const abort = new AbortController();
    const server = await nodeServe({
      hostname: "127.0.0.1",
      port: 0,
      fetch: (request) =>
        host.routes.handle({
          request,
          id: 1,
          method: "events/stream",
          params: {
            name,
            arguments: { threadId },
            _meta: { [versionMeta]: AGENT_EVENTS_VERSION },
          },
          access: host.access,
          compatibility: false,
        }),
    });
    try {
      const response = await fetch(server.url, {
        method: "POST",
        headers: {
          accept: "text/event-stream",
          "mcp-protocol-version": AGENT_EVENTS_VERSION,
          "mcp-method": "events/stream",
          "mcp-name": name,
        },
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(3_000)]),
      });
      const reader = response.body?.getReader();
      if (reader === undefined) throw new Error("Expected an event stream");
      expect(await frame(reader)).toMatchObject({ method: "notifications/events/active" });
      const atLimit = await host.call("events/stream");
      expect((await atLimit.json()).error.code).toBe(-32025);
      abort.abort();
      await expect
        .poll(async () => {
          const reopened = await host.call("events/stream");
          await reopened.body?.cancel();
          return reopened.headers.get("content-type");
        })
        .toBe("text/event-stream");
    } finally {
      abort.abort();
      await server.stop(true);
      await Promise.all(occupying.map((response) => response.body?.cancel()));
    }
  });

  it.each([false, true])(
    "verifies and signs webhook deliveries with compatibility %s",
    async (legacy) => {
      const host = setup({ webhook: true, legacy });
      const delivery = { mode: "webhook", url: callback, secret };
      const subscribed = await (
        await host.call("events/subscribe", { delivery }, { stdioDraft: legacy })
      ).json();
      expect(subscribed.result).toMatchObject({
        id: expect.stringMatching(/^sub_/),
        truncated: false,
      });
      expect(host.posts[0]?.body).toMatchObject({
        type: "verification",
        challenge: expect.any(String),
      });
      host.record(threadId);
      await expect.poll(() => host.posts.length).toBe(2);
      const posted = host.posts[1];
      if (posted === undefined) throw new Error("Expected a webhook delivery");
      const id = posted.headers["webhook-id"];
      if (legacy) expect(id).toBe(posted.body["eventId"]);
      else expect(id).toMatch(/^msg_event_/);
      expect(posted.headers["x-mcp-subscription-id"]).toBe(subscribed.result.id);
      const timestamp = posted.headers["webhook-timestamp"];
      expect(posted.headers["webhook-signature"]).toBe(
        "v1," +
          createHmac("sha256", key)
            .update(`${id}.${timestamp}.${JSON.stringify(posted.body)}`)
            .digest("base64"),
      );
      const refreshed = await (
        await host.call("events/subscribe", { delivery }, { stdioDraft: legacy })
      ).json();
      expect(refreshed.result.id).toBe(subscribed.result.id);
      const removed = await (
        await host.call(
          "events/unsubscribe",
          {
            delivery: { url: callback },
          },
          { stdioDraft: legacy },
        )
      ).json();
      expect(removed.result).toEqual({ resultType: "complete" });
      host.record(threadId);
      expect(host.posts).toHaveLength(2);
      expect(host.listeners.size).toBe(0);
    },
  );

  it("restricts callbacks to the grant's approved destination and requires proof of consent", async () => {
    const host = setup({ webhook: true, echo: false });
    const denied = await (
      await host.call("events/subscribe", {
        delivery: { mode: "webhook", url: "https://other.example/updates", secret },
      })
    ).json();
    expect(denied.error.code).toBe(-32024);
    expect(host.posts).toHaveLength(0);
    const invalid = await (
      await host.call("events/subscribe", {
        delivery: { mode: "webhook", url: callback, secret },
      })
    ).json();
    expect(invalid.error).toMatchObject({ code: -32027, data: { reason: "challenge_failed" } });
    expect(host.listeners.size).toBe(0);
  });
});
