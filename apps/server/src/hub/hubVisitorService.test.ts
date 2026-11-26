import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import {
  type HubMemberId,
  type HubMembershipChangedPayload,
  type HubVisitorGrantsUpdate,
  type VisitorLinkId,
} from "@octant/contracts";
import { visitorProofPayload } from "@octant/domain";
import { afterEach, describe, expect, it } from "vitest";
import type { HubState, HubStatePort } from "./hubStateStore";
import { publicKeyFingerprint } from "./hubCrypto";
import { HubVisitorService } from "./hubVisitorService";
import type { PublicAnswer, PublicRequest, PublicRouteName } from "./publicEntrance";
import { SpokeVisitorService } from "./spokeVisitorService";
import { visitorViewer } from "./visitorViewer";

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
  let edits = 0;
  const hubs: HubVisitorService[] = [];
  const spoke = new SpokeVisitorService({
    state: memoryState(),
    publicGranted: () => true,
    remoteAccessPaused: () => false,
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
        messages: [{ role: "agent", text: edits === 0 ? "Working on it." : `Edit ${edits}` }],
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
    edit: () => {
      edits += 1;
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
    readBody: async (maxBytes) =>
      bytes.length > maxBytes ? { status: "too-large" } : { status: "read", bytes },
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

  it("takes a full-length comment in a script that needs three bytes a character", async () => {
    const context = world();
    const link = await shareComment(context);
    const visitor = browser();
    await call(context.hub, "visitor-open", link.linkId, visitor, { secret: link.secret });
    const text = "你".repeat(4_000);
    expect(
      (await call(context.hub, "visitor-comments", link.linkId, visitor, { text })).status,
    ).toBe(202);
    expect(context.spoke.view().comments.map((comment) => comment.text.length)).toEqual([4_000]);
  });

  it("the spoke binds no browser that a hub names without the link's secret", async () => {
    const context = world();
    const link = await shareComment(context);
    const forged = context.spoke.fetch(
      {
        linkId: link.linkId as VisitorLinkId,
        revision: 1,
        binding: "f".repeat(64),
        kind: "open",
      },
      HUB,
    );
    expect(forged).toEqual({ status: "refused", kind: "unknown-link" });
    const opened = await call(context.hub, "visitor-open", link.linkId, browser(), {
      secret: link.secret,
    });
    expect(opened.status).toBe(200);
  });

  it("refuses a replayed proof and one outside the sixty-second skew", async () => {
    const context = world();
    const link = await shareComment(context);
    const visitor = browser();
    await call(context.hub, "visitor-open", link.linkId, visitor, { secret: link.secret });
    const handler = context.hub.handlers().visitorComments;
    const path = `/v/${link.linkId}/comments`;
    const headers = visitor.headers("POST", path);
    expect(
      (await handler?.(request("visitor-comments", link.linkId, headers, { text: "Hi" })))?.status,
    ).toBe(202);
    expect(
      (await handler?.(request("visitor-comments", link.linkId, headers, { text: "Hi" })))?.status,
    ).toBe(401);
    const timestamp = String(NOW - 61_000);
    const nonce = randomBytes(12).toString("base64url");
    const stale = new Map([
      ["octant-visitor-key", visitor.key.publicKey],
      [
        "octant-visitor-proof",
        `${timestamp}.${nonce}.${visitor.key.sign(
          visitorProofPayload({ method: "POST", path, timestamp, nonce }),
        )}`,
      ],
    ]);
    expect(
      (await handler?.(request("visitor-comments", link.linkId, stale, { text: "Hi" })))?.status,
    ).toBe(401);
  });

  it("someone holding only the link id cannot spend the visitor's allowance", async () => {
    const context = world();
    const link = await shareComment(context);
    const visitor = browser();
    await call(context.hub, "visitor-open", link.linkId, visitor, { secret: link.secret });
    const stranger = browser();
    let limited = false;
    for (let index = 0; index < 130; index += 1) {
      const answer = await call(context.hub, "visitor-comments", link.linkId, stranger, {
        text: "spam",
      });
      if (answer.status === 429) limited = true;
    }
    expect(limited).toBe(true);
    expect(
      (await call(context.hub, "visitor-comments", link.linkId, visitor, { text: "Hello" })).status,
    ).toBe(202);
  });

  it("one browser holds at most four streams, even when it opens them all at once", async () => {
    const context = world();
    const link = await shareComment(context);
    const visitor = browser();
    await call(context.hub, "visitor-open", link.linkId, visitor, { secret: link.secret });
    const answers = await Promise.all(
      Array.from({ length: 6 }, () => call(context.hub, "visitor-stream", link.linkId, visitor)),
    );
    expect(answers.filter((answer) => answer.status === 200)).toHaveLength(4);
    expect(answers.filter((answer) => answer.status === 503)).toHaveLength(2);
    for (const answer of answers) {
      if (answer.body instanceof ReadableStream) await answer.body.cancel();
    }
    expect(context.hub.status().streams).toBe(0);
  });

  it("turning the visitor switch off ends a stream already open", async () => {
    const context = world();
    const link = await shareComment(context);
    const visitor = browser();
    await call(context.hub, "visitor-open", link.linkId, visitor, { secret: link.secret });
    const stream = await call(context.hub, "visitor-stream", link.linkId, visitor);
    if (!(stream.body instanceof ReadableStream)) throw new Error("no stream");
    const reader = stream.body.getReader();
    await reader.read();
    await context.hub.setEnabled(false, { kind: "local-window" });
    const decoder = new TextDecoder();
    let text = "";
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      text += decoder.decode(next.value);
    }
    expect(text).toContain("event: end");
    expect(context.hub.status().streams).toBe(0);
  });

  it("answers every visitor route 404 while the hub's visitor switch is off", async () => {
    const context = world();
    await context.hub.setEnabled(false, { kind: "local-window" });
    expect(context.hub.handlers()).toEqual({});
  });

  it("holds at most one unread snapshot for a browser that stops reading, and sends it the newest", async () => {
    const context = world();
    const link = await shareComment(context);
    const visitor = browser();
    await call(context.hub, "visitor-open", link.linkId, visitor, { secret: link.secret });
    const stream = await call(context.hub, "visitor-stream", link.linkId, visitor);
    if (!(stream.body instanceof ReadableStream)) throw new Error("no stream");
    const reader = stream.body.getReader();
    // The browser reads nothing while the thread changes on every poll.
    for (let index = 0; index < 10; index += 1) {
      context.edit();
      await new Promise((resolve) => setTimeout(resolve, 8));
    }
    const decoder = new TextDecoder();
    // What waited is the snapshot from before it stopped; none of the ten in between.
    const waiting = await reader.read();
    expect(decoder.decode(waiting.value)).toContain("Working on it.");
    // Once it reads again, the next snapshot is the thread as it is now.
    const latest = await reader.read();
    expect(decoder.decode(latest.value)).toContain("Edit 10");
    await reader.cancel();
  });
});

describe("the viewer page", () => {
  it("is the same for every link, names only its own assets, and writes thread text as text", () => {
    const viewer = visitorViewer();
    expect(viewer.page).not.toMatch(/<script>[^<]/);
    for (const name of viewer.assets.keys()) {
      expect(name).toMatch(/^[0-9a-f]{16}\.(js|css)$/);
      expect(viewer.page).toContain(`/v/_/${name}`);
    }
    const script = [...viewer.assets.values()].find((asset) =>
      asset.type.startsWith("text/javascript"),
    );
    expect(script?.body).toContain("textContent");
    expect(script?.body).not.toContain("innerHTML");
    expect(script?.body).toContain('generateKey({ name: "ECDSA", namedCurve: "P-256" }, false');
  });
});
