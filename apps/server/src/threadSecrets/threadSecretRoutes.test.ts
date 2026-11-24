import { randomBytes } from "node:crypto";
import { decodeWindowId } from "@octant/contracts";
import { ThreadSecretRequestInput } from "@octant/contracts/thread-secrets";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { classifyProductAction } from "../authenticatedProductRoutes";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { createThreadSecretRoutes } from "./threadSecretRoutes";
import { ThreadSecretService } from "./threadSecretService";

const THREAD = "00000000-0000-4000-8000-000000000009";
const services: ThreadSecretService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
});

function setup() {
  const store = new WindowAuthorityStore();
  const windowId = decodeWindowId("00000000-0000-4000-8000-000000000001");
  const capability = randomBytes(32).toString("base64url");
  store.register({ windowId, capability, now: Date.now() });
  const service = new ThreadSecretService({
    uuid: () => crypto.randomUUID(),
    now: () => 0,
    journal: { record: () => undefined, history: () => ({ open: [], lastLifetimes: new Map() }) },
    hold: () => () => undefined,
  });
  services.push(service);
  const asked = service.request(
    {
      windowId: String(windowId),
      threadId: THREAD,
      turnId: "turn",
      authority: () => ({ mode: "code", strict: false, commandsConfined: false }),
      signal: new AbortController().signal,
    },
    Schema.decodeUnknownSync(ThreadSecretRequestInput)({
      operation: "request-secret",
      name: "TOKEN",
      label: "Token",
      kind: "token",
      reason: "Read the account.",
    }),
  );
  const route = createThreadSecretRoutes(service, store);
  const call = (body?: unknown, over: { token?: string; query?: string; host?: string } = {}) => {
    const request = new Request(
      `http://${over.host ?? "127.0.0.1"}/api/thread-secrets${body === undefined ? (over.query ?? `?threadId=${THREAD}`) : ""}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          "x-octant-window-capability": over.token ?? capability,
          "content-type": "application/json",
        },
        ...(body === undefined
          ? {}
          : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      },
    );
    return request;
  };
  const id = service.view(String(windowId), THREAD).requests[0]?.id;
  const answer = (over: Record<string, unknown> = {}) => ({
    kind: "answer",
    threadId: THREAD,
    answer: {
      id,
      action: "save",
      lifetime: "1-hour",
      fields: [{ name: "TOKEN", source: "pasted", value: "private-value" }],
      ...over,
    },
  });
  return { asked, route, call, answer, windowId, service };
}

describe("thread secret routes", () => {
  it("shows the card, takes one answer, and echoes no value", async () => {
    const h = setup();
    expect(await (await h.route(h.call()))?.json()).toMatchObject({
      requests: [{ state: "pending", name: "TOKEN" }],
      active: [],
    });
    const saved = await h.route(h.call(h.answer()));
    expect(await saved?.json()).toEqual({ status: "accepted" });
    expect(saved?.headers.get("cache-control")).toBe("no-store");
    expect(await h.asked).toMatchObject({ status: "saved" });
    const after = await (await h.route(h.call()))?.text();
    expect(after).toContain('"active":[{');
    expect(after).not.toContain("private-value");
    expect(await (await h.route(h.call(h.answer())))?.json()).toEqual({ status: "gone" });
  });

  it("revokes an active secret", async () => {
    const h = setup();
    await h.route(h.call(h.answer()));
    const [secret] = h.service.active(THREAD);
    const revoke = { kind: "revoke", threadId: THREAD, secretId: secret?.id };
    expect(await (await h.route(h.call(revoke)))?.json()).toEqual({ status: "accepted" });
    expect(h.service.active(THREAD)).toEqual([]);
  });

  it("refuses another window, a paired device, a remote name and a forwarded action", async () => {
    const h = setup();
    expect((await h.route(h.call(undefined, { token: "wrong" })))?.status).toBe(401);
    expect((await h.route(h.call(undefined, { host: "evil.test" })))?.status).toBe(403);
    const remote = h.call(h.answer());
    bindPrincipalRouteContext(remote, {
      principal: { kind: "remote-device" } as never,
      scopeId: h.windowId,
    });
    expect((await h.route(remote))?.status).toBe(403);
    expect(classifyProductAction(remote)).toBeUndefined();
  });

  it("refuses a malformed submission without repeating it", async () => {
    const h = setup();
    for (const body of [
      "{",
      h.answer({ lifetime: "forever" }),
      h.answer({ extra: "private-value" }),
      { ...h.answer(), url: "https://evil.test" },
    ]) {
      const response = await h.route(h.call(body));
      expect(response?.status).toBe(400);
      expect(await response?.text()).toBe('{"status":"invalid"}');
    }
    expect((await h.route(h.call("x".repeat(300_000))))?.status).toBe(413);
    expect((await h.route(h.call(undefined, { query: "?threadId=a&other=b" })))?.status).toBe(400);
    expect((await h.route(h.call(undefined, { query: "" })))?.status).toBe(400);
  });
});
