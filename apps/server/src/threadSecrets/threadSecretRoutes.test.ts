import { randomBytes } from "node:crypto";
import { decodeWindowId } from "@octant/contracts";
import { ThreadSecretRequestInput } from "@octant/contracts/thread-secrets";
import { Schema } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { classifyProductAction } from "../authenticatedProductRoutes";
import { createRemoteDevicePrincipal } from "../clientPrincipal";
import { bindPrincipalRouteContext } from "../principalRouteContext";
import { WindowAuthorityStore } from "../windowAuthorityStore";
import { RememberedThreadSecrets } from "./rememberedThreadSecrets";
import { createPairedThreadSecretRoutes, createThreadSecretRoutes } from "./threadSecretRoutes";
import { ThreadSecretService, type ThreadSecretServiceOptions } from "./threadSecretService";

const THREAD = "00000000-0000-4000-8000-000000000009";
const REMEMBERED = "00000000-0000-4000-8000-000000000010";
const services: ThreadSecretService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.close();
});

const DEVICE = "73000000-0000-4000-8000-000000000060";

function setup(
  over: {
    readonly mayAnswer?: ThreadSecretServiceOptions["mayAnswer"];
    readonly sessionCurrent?: () => boolean;
    readonly records?: unknown[];
    readonly storeFails?: boolean;
    readonly whileStoring?: () => Promise<void>;
    readonly browse?: ThreadSecretServiceOptions["browse"];
  } = {},
) {
  const store = new WindowAuthorityStore();
  const windowId = decodeWindowId("00000000-0000-4000-8000-000000000001");
  const capability = randomBytes(32).toString("base64url");
  store.register({ windowId, capability, now: Date.now() });
  const service = new ThreadSecretService({
    uuid: () => crypto.randomUUID(),
    now: () => 0,
    journal: {
      record: (_threadId, records, actor) => {
        over.records?.push({ records, actor });
      },
      history: () => ({ open: [], lastLifetimes: new Map() }),
    },
    hold: () => () => undefined,
    ...(over.mayAnswer === undefined ? {} : { mayAnswer: over.mayAnswer }),
    threadTitle: () => "Publish",
    ...(over.browse === undefined
      ? {}
      : { browse: over.browse, readReference: async () => ({ status: "missing" as const }) }),
    remembered: new RememberedThreadSecrets({
      uuid: () => crypto.randomUUID(),
      journal: {
        record: () => undefined,
        history: () => [
          { name: "thread-secret.remembered", id: REMEMBERED, secretName: "OLD", source: "pasted" },
        ],
      },
      store: {
        resolve: async () => "old-value",
        set: async () => over.whileStoring?.(),
        delete: async () => {
          if (over.storeFails === true) throw new Error("locked");
        },
      },
    }),
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
  const pairedRoute = createPairedThreadSecretRoutes(service, {
    sessionCurrent: over.sessionCurrent ?? (() => true),
  });
  const fromDevice = (
    body: unknown,
    admittedBy: "host-person" | "hub-roster" | undefined = "host-person",
    init: RequestInit = {},
  ) => {
    const request = new Request("http://127.0.0.1/api/thread-secrets/paired", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      ...init,
    });
    bindPrincipalRouteContext(request, {
      principal: createRemoteDevicePrincipal({
        hostId: "73000000-0000-4000-8000-000000000059" as never,
        deviceId: DEVICE as never,
        credentialGeneration: 1,
        origin: "https://octant.invalid",
        protocolVersion: 1,
        capabilityDigest: "b".repeat(64),
        sessionId: "73000000-0000-4000-8000-000000000061" as never,
        ...(admittedBy === undefined ? {} : { admittedBy }),
      }),
      scopeId: DEVICE as never,
    });
    return pairedRoute(request);
  };
  return { asked, route, call, answer, windowId, service, pairedRoute, fromDevice };
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

  it("lists every thread's active secrets and the remembered ones, with no value", async () => {
    const h = setup();
    await h.route(h.call(h.answer()));
    const response = await h.route(h.call(undefined, { query: "" }));
    const text = (await response?.text()) ?? "";
    expect(JSON.parse(text)).toEqual({
      active: [
        expect.objectContaining({ threadId: THREAD, threadTitle: "Publish", name: "TOKEN" }),
      ],
      remembered: [{ id: REMEMBERED, name: "OLD", source: "pasted" }],
    });
    expect(text).not.toMatch(/private-value|old-value/);
    const other = await h.route(h.call(undefined, { query: "", token: "wrong" }));
    expect(other?.status).toBe(401);
  });

  it("forgets a remembered secret, and says when it could not", async () => {
    const forget = { kind: "forget", id: REMEMBERED };
    const h = setup();
    expect(await (await h.route(h.call(forget)))?.json()).toEqual({ status: "accepted" });
    expect(h.service.hostView().remembered).toEqual([]);
    expect(await (await h.route(h.call(forget)))?.json()).toEqual({ status: "gone" });
    const locked = setup({ storeFails: true });
    expect(await (await locked.route(locked.call(forget)))?.json()).toEqual({
      status: "refused",
      failure: "unavailable",
    });
    expect(locked.service.hostView().remembered).toHaveLength(1);
  });

  it("lists a linked store's names for a waiting card, and for nothing else", async () => {
    const listed = { status: "listed", entries: [], truncated: false } as const;
    const steps: unknown[] = [];
    const h = setup({
      browse: async (step) => {
        steps.push(step);
        return listed;
      },
    });
    const { id } = h.answer().answer;
    const browse = (over: Record<string, unknown> = {}) =>
      h.call({
        kind: "browse",
        threadId: THREAD,
        requestId: id,
        step: { kind: "vaults" },
        ...over,
      });
    expect(await (await h.route(browse()))?.json()).toEqual(listed);
    expect(await (await h.route(browse({ threadId: "other" })))?.json()).toEqual({
      status: "unavailable",
    });
    expect((await h.route(browse({ step: { kind: "items", vaultId: "x" } })))?.status).toBe(400);
    await h.route(h.call(h.answer()));
    expect(await (await h.route(browse()))?.json()).toEqual({ status: "unavailable" });
    expect(steps).toEqual([{ kind: "vaults" }]);
  });

  it("shows nothing of a store to a card that ended while it was listed", async () => {
    const reply = Promise.withResolvers<void>();
    const h = setup({
      browse: async () => {
        await reply.promise;
        return { status: "listed", entries: [{ id: "a", label: "Work" }], truncated: false };
      },
    });
    const { id } = h.answer().answer;
    const pending = h.route(
      h.call({ kind: "browse", threadId: THREAD, requestId: id, step: { kind: "vaults" } }),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    h.service.withdrawThread(THREAD);
    reply.resolve();
    expect(await (await pending)?.json()).toEqual({ status: "unavailable" });
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
  });
});

describe("a thread secret's card on a phone", () => {
  const anywhere = { mayAnswer: () => true, browse: async () => ({ status: "locked" as const }) };

  it("is shown and answered there with a typed value, journaled as that device", async () => {
    const records: unknown[] = [];
    const h = setup({ ...anywhere, records });
    const listed = await h.fromDevice({ kind: "list", threadId: THREAD });
    const view = (await listed?.json()) as { requests: ReadonlyArray<Record<string, unknown>> };
    expect(view).toMatchObject({
      active: [],
      requests: [{ name: "TOKEN", sources: ["pasted"], remembered: [] }],
    });
    expect(listed?.headers.get("cache-control")).toBe("no-store");
    const answered = await h.fromDevice(h.answer());
    expect(await answered?.text()).toBe('{"status":"accepted"}');
    expect(await h.asked).toMatchObject({ status: "saved" });
    expect(records).toContainEqual(
      expect.objectContaining({
        actor: { kind: "remote-device", actorId: DEVICE, deviceId: DEVICE },
      }),
    );
    expect(JSON.stringify(records)).not.toContain("private-value");
  });

  it("refuses a 1Password answer from there, and keeps the card for this computer", async () => {
    const h = setup(anywhere);
    const reference = {
      name: "TOKEN",
      source: "onepassword",
      store: "onepassword",
      reference: "op://Private/Deploy/credential",
      freshEachUse: false,
    };
    const answered = await h.fromDevice(h.answer({ fields: [reference] }));
    expect(await answered?.json()).toEqual({ status: "refused", failure: "not-linked" });
    expect(await (await h.route(h.call()))?.json()).toMatchObject({
      requests: [{ state: "pending", sources: expect.arrayContaining(["onepassword"]) }],
    });
  });

  it("keeps a linked store out of a card that has been answered", async () => {
    const h = setup(anywhere);
    await h.route(h.call(h.answer()));
    const listed = await h.fromDevice({ kind: "list", threadId: THREAD });
    expect(await listed?.json()).toMatchObject({
      requests: [{ state: "saved", sources: ["pasted"], remembered: [] }],
    });
  });

  it.each(["signed out", "held below Full"] as const)(
    "grants nothing to a device %s while its answer was kept, and leaves the card here",
    async (how) => {
      let lost = false;
      const h = setup({
        ...anywhere,
        mayAnswer: () => !(lost && how === "held below Full"),
        sessionCurrent: () => !(lost && how === "signed out"),
        whileStoring: async () => {
          lost = true;
        },
      });
      const answered = await h.fromDevice(h.answer({ lifetime: "remember" }));
      expect(await answered?.json()).toEqual({ status: "gone" });
      expect(h.service.active(THREAD)).toEqual([]);
      expect(h.service.hostView().remembered.map(({ name }) => name)).toEqual(["OLD"]);
      const here = (await (await h.route(h.call()))?.json()) as {
        readonly requests: ReadonlyArray<Record<string, unknown>>;
      };
      expect(here.requests).toMatchObject([{ state: "pending" }]);
      expect(here.requests[0]).not.toHaveProperty("failure");
    },
  );

  it("takes neither a listing of the store nor a revoke or forget", async () => {
    const h = setup(anywhere);
    const { id } = h.answer().answer;
    for (const body of [
      { kind: "browse", threadId: THREAD, requestId: id, step: { kind: "vaults" } },
      { kind: "revoke", threadId: THREAD, secretId: id },
      { kind: "forget", id: REMEMBERED },
    ])
      expect((await h.fromDevice(body))?.status).toBe(400);
  });

  it("refuses every other principal, a signed-out device and a malformed request", async () => {
    const h = setup(anywhere);
    const list = { kind: "list", threadId: THREAD };
    for (const admittedBy of ["hub-roster" as const])
      expect((await h.fromDevice(list, admittedBy))?.status).toBe(403);
    const unbound = new Request("http://127.0.0.1/api/thread-secrets/paired", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(list),
    });
    expect((await h.pairedRoute(unbound))?.status).toBe(403);
    expect((await h.fromDevice(list, "host-person", { body: "{" }))?.status).toBe(400);
    expect((await h.fromDevice(list, "host-person", { body: "x".repeat(300_000) }))?.status).toBe(
      413,
    );
    const gone = setup({ ...anywhere, sessionCurrent: () => false });
    expect((await gone.fromDevice(gone.answer()))?.status).toBe(401);
    expect(gone.service.active(THREAD)).toEqual([]);
  });

  it("shows a thread's cards nowhere else unless the host admits that reader", async () => {
    const h = setup({ mayAnswer: () => false });
    const listed = await h.fromDevice({ kind: "list", threadId: THREAD });
    expect(await listed?.json()).toEqual({ requests: [], active: [] });
    expect(await (await h.fromDevice(h.answer()))?.json()).toEqual({ status: "gone" });
    expect(h.service.waiting(DEVICE, { paired: true })).toEqual([]);
    expect(h.service.waiting(String(h.windowId), { paired: false })).toEqual([
      {
        askId: h.answer().answer.id,
        threadId: THREAD,
        kind: "token",
        label: "Token",
        reason: "Read the account.",
        requestedAt: "1970-01-01T00:00:00.000Z",
      },
    ]);
  });
});
