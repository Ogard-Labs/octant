import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import {
  visitorProofPayload,
  type HubMemberId,
  type HubMembershipChangedPayload,
  type HubVisitorGrantsUpdate,
} from "@octant/contracts";
import { afterEach, describe, expect, it } from "vitest";
import type { HubState, HubStatePort } from "./hubStateStore";
import { publicKeyFingerprint } from "./hubCrypto";
import { HubVisitorService } from "./hubVisitorService";
import type { PublicAnswer, PublicRequest, PublicRouteName } from "./publicEntrance";
import { SpokeVisitorService } from "./spokeVisitorService";

const SPOKE = "11111111-1111-4111-8111-111111111111" as HubMemberId;
const HUB = "22222222-2222-4222-8222-222222222222";
const STANDBY = "33333333-3333-4333-8333-333333333333";
const NOW = 1_800_000_000_000;

function memoryState(initial: HubState = {}): HubStatePort {
  let state = initial;
  return { load: () => state, save: (next) => void (state = next) };
}

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  return {
    publicKey: spki,
    sign: (payload: string) =>
      sign("sha256", Buffer.from(payload), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString(
        "base64url",
      ),
  };
}

const closers: Array<() => void> = [];
afterEach(() => {
  for (const close of closers.splice(0)) close();
});

function world() {
  const spokeKey = keyPair();
  const records: HubMembershipChangedPayload[] = [];
  let thread: "open" | "waiting" = "open";
  const hubs: HubVisitorService[] = [];
  const spoke = new SpokeVisitorService({
    state: memoryState(),
    publicGranted: () => true,
    hub: {
      target: () => ({ memberId: HUB }),
      sendGrants: async (update: HubVisitorGrantsUpdate) => {
        for (const hub of hubs) hub.receiveGrants(SPOKE, update);
        return true;
      },
    },
    signing: () => ({ memberId: SPOKE, ...spokeKey }),
    source: {
      read: () => ({
        status: "found",
        title: "Fix the login page",
        archived: false,
        state: thread === "waiting" ? "owner-deciding" : "idle",
        messages: [{ role: "agent", text: "Working on it." }],
      }),
    },
    taint: () => true,
    record: (change) => records.push(change),
    now: () => NOW,
  });
  const makeHub = (memberId: string) => {
    const hub = new HubVisitorService({
      state: memoryState({ visitorHub: { enabled: true, grants: [] } }),
      serving: () => true,
      hubMemberId: () => memberId,
      rosterFingerprintFor: (member) =>
        String(member) === SPOKE ? publicKeyFingerprint(spokeKey.publicKey) : undefined,
      ask: async (_spoke, request) => spoke.fetch(request, memberId),
      record: (change) => records.push(change),
      now: () => NOW,
      pollMs: 5,
    });
    hubs.push(hub);
    return hub;
  };
  return {
    spoke,
    hub: makeHub(HUB),
    standby: makeHub(STANDBY),
    records,
    waitForApproval: () => {
      thread = "waiting";
    },
  };
}

function browser() {
  const key = keyPair();
  return {
    key,
    headers(method: string, path: string): Map<string, string> {
      const timestamp = String(NOW);
      const nonce = randomBytes(12).toString("base64url");
      const signature = key.sign(visitorProofPayload({ method, path, timestamp, nonce }));
      return new Map([
        ["octant-visitor-key", key.publicKey],
        ["octant-visitor-proof", `${timestamp}.${nonce}.${signature}`],
      ]);
    },
  };
}

function request(
  route: PublicRouteName,
  linkId: string,
  headers: ReadonlyMap<string, string>,
  body?: unknown,
): PublicRequest {
  const suffix =
    route === "visitor-open"
      ? "/open"
      : route === "visitor-stream"
        ? "/stream"
        : route === "visitor-comments"
          ? "/comments"
          : "";
  const controller = new AbortController();
  closers.push(() => controller.abort());
  const bytes = Buffer.from(body === undefined ? "" : JSON.stringify(body));
  return {
    route,
    params: { id: linkId },
    method: route === "visitor-stream" || route === "visitor-page" ? "GET" : "POST",
    path: `/v/${linkId}${suffix}`,
    headers,
    principal: { kind: "visitor", linkId },
    readBody: async () => ({ status: "read", bytes }),
    signal: controller.signal,
  };
}

async function call(
  hub: HubVisitorService,
  route: PublicRouteName,
  linkId: string,
  visitor: ReturnType<typeof browser>,
  body?: unknown,
): Promise<PublicAnswer> {
  const handlers = hub.handlers();
  const handler =
    route === "visitor-open"
      ? handlers.visitorOpen
      : route === "visitor-stream"
        ? handlers.visitorStream
        : handlers.visitorComments;
  if (handler === undefined) throw new Error("visitor links are off");
  const suffix =
    route === "visitor-open" ? "/open" : route === "visitor-stream" ? "/stream" : "/comments";
  const method = route === "visitor-stream" ? "GET" : "POST";
  return handler(request(route, linkId, visitor.headers(method, `/v/${linkId}${suffix}`), body));
}

async function firstEvent(answer: PublicAnswer): Promise<string> {
  const body = answer.body;
  if (!(body instanceof ReadableStream)) return String(body);
  const reader = body.getReader();
  const next = await reader.read();
  await reader.cancel();
  return new TextDecoder().decode(next.value);
}

async function shareComment(context: ReturnType<typeof world>) {
  const link = await context.spoke.share({ mode: "code", threadId: "t-1", scope: "comment" });
  if (link.status !== "shared") throw new Error(link.kind);
  return { linkId: link.linkId, secret: link.url.split("#k=")[1] ?? "" };
}

describe("visitor links on the hub", () => {
  it("opens with the secret, then streams the thread to the browser that opened it", async () => {
    const context = world();
    const link = await shareComment(context);
    const visitor = browser();
    const opened = await call(context.hub, "visitor-open", link.linkId, visitor, {
      secret: link.secret,
    });
    expect(opened.status).toBe(200);
    const stream = await call(context.hub, "visitor-stream", link.linkId, visitor);
    expect(stream.status).toBe(200);
    expect(await firstEvent(stream)).toContain("Working on it.");
  });

  it("answers a wrong secret exactly as an unknown link", async () => {
    const context = world();
    const link = await shareComment(context);
    const wrong = await call(context.hub, "visitor-open", link.linkId, browser(), {
      secret: randomBytes(32).toString("base64url"),
    });
    const unknown = await call(context.hub, "visitor-open", "AAAAAAAAAAAAAAAAAAAAAA", browser(), {
      secret: link.secret,
    });
    expect(wrong.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(wrong.body).toEqual(unknown.body);
  });

  it("refuses a request whose proof was not signed by the key it names", async () => {
    const context = world();
    const link = await shareComment(context);
    const visitor = browser();
    const headers = visitor.headers("POST", `/v/${link.linkId}/open`);
    headers.set("octant-visitor-key", browser().key.publicKey);
    const handler = context.hub.handlers().visitorOpen;
    const answer = await handler?.(
      request("visitor-open", link.linkId, headers, { secret: link.secret }),
    );
    expect(answer?.status).toBe(401);
  });

  it("a second browser cannot open a bound link", async () => {
    const context = world();
    const link = await shareComment(context);
    await call(context.hub, "visitor-open", link.linkId, browser(), { secret: link.secret });
    const second = await call(context.hub, "visitor-open", link.linkId, browser(), {
      secret: link.secret,
    });
    expect(second.status).toBe(403);
  });

  it("a revoked link stops on the next fetch, on the hub and the standby", async () => {
    const context = world();
    const link = await shareComment(context);
    const visitor = browser();
    await call(context.hub, "visitor-open", link.linkId, visitor, { secret: link.secret });
    expect((await call(context.standby, "visitor-stream", link.linkId, visitor)).status).toBe(200);
    await context.spoke.stop(link.linkId);
    // The hub dropped the grant when the spoke withdrew it; a standby that
    // still held it is refused by the spoke at its next fetch.
    expect((await call(context.hub, "visitor-stream", link.linkId, visitor)).status).toBe(404);
    const standbyGrants = context.standby.status().grants;
    expect(standbyGrants).toBe(0);
  });

  it("a standby still holding a stopped link's grant is refused by the spoke", async () => {
    const context = world();
    const link = await shareComment(context);
    const visitor = browser();
    await call(context.hub, "visitor-open", link.linkId, visitor, { secret: link.secret });
    const held = context.standby.heldGrants();
    await context.spoke.stop(link.linkId);
    context.standby.receiveGrants(SPOKE, { grants: held });
    expect((await call(context.standby, "visitor-stream", link.linkId, visitor)).status).toBe(410);
  });

  it("a comment-only visitor cannot answer an approval", async () => {
    const context = world();
    const link = await shareComment(context);
    const visitor = browser();
    await call(context.hub, "visitor-open", link.linkId, visitor, { secret: link.secret });
    context.waitForApproval();
    const answer = await call(context.hub, "visitor-comments", link.linkId, visitor, {
      text: "approve",
    });
    expect(answer.status).toBe(202);
    expect(context.spoke.view().comments.map((comment) => comment.text)).toEqual(["approve"]);
    expect(context.hub.handlers()).not.toHaveProperty("visitorApprove");
  });

  it("answers every visitor route 404 while the hub's visitor switch is off", async () => {
    const context = world();
    await context.hub.setEnabled(false, { kind: "local-window" });
    expect(context.hub.handlers()).toEqual({});
  });
});
