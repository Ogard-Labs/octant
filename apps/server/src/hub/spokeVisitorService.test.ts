import { generateKeyPairSync, sign } from "node:crypto";
import type {
  HubMemberId,
  HubMembershipChangedPayload,
  HubVisitorGrantsUpdate,
  VisitorFetchRequest,
  VisitorLinkId,
} from "@octant/contracts";
import { decodeWorkTurnRequestId, VISITOR_PROJECTION_MAX_BYTES } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import type { HubState, HubStatePort } from "./hubStateStore";
import { publicKeyFingerprint } from "./hubCrypto";
import {
  SpokeVisitorService,
  type VisitorThreadRead,
  type VisitorThreadSource,
} from "./spokeVisitorService";
import { visitorThreadSource } from "./visitorThreadSources";

// Lets a test make the next random id one that base64url would start with "-".
const randomness = vi.hoisted(() => ({ dashFirst: 0 }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomBytes: (size: number) => {
      if (randomness.dashFirst === 0) return actual.randomBytes(size);
      randomness.dashFirst -= 1;
      return Buffer.alloc(size, 0xf8);
    },
  };
});

// What the Chat and Code projections hold, for the reads of a streaming reply.
const projections = vi.hoisted(() => ({ chat: undefined as unknown, code: undefined as unknown }));
vi.mock("../persistence/chatProjection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../persistence/chatProjection")>()),
  readChatThreadView: () => projections.chat,
}));
vi.mock("../persistence/codeProjection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../persistence/codeProjection")>()),
  readCodeThread: () => projections.code,
}));

const SPOKE = "11111111-1111-4111-8111-111111111111" as HubMemberId;
const HUB = "22222222-2222-4222-8222-222222222222";
const BROWSER = "a".repeat(64);
const OTHER_BROWSER = "b".repeat(64);

function memoryState(initial: HubState = {}): HubStatePort {
  let state = initial;
  return { load: () => state, save: (next) => void (state = next) };
}

function signer() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ format: "der", type: "spki" }).toString("base64url");
  return {
    memberId: SPOKE,
    publicKey: spki,
    sign: (payload: string) =>
      sign("sha256", Buffer.from(payload), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString(
        "base64url",
      ),
  };
}

function setup(
  options: {
    thread?: () => VisitorThreadRead;
    granted?: () => boolean;
    paused?: () => boolean;
    sendGrants?: (update: HubVisitorGrantsUpdate) => Promise<boolean>;
    hubMemberId?: () => string;
    source?: VisitorThreadSource;
  } = {},
) {
  let now = 1_800_000_000_000;
  const records: HubMembershipChangedPayload[] = [];
  const tainted: string[] = [];
  const sent: unknown[] = [];
  const key = signer();
  const service = new SpokeVisitorService({
    state: memoryState(),
    publicGranted: options.granted ?? (() => true),
    remoteAccessPaused: options.paused ?? (() => false),
    hub: {
      target: () => ({ memberId: options.hubMemberId?.() ?? HUB }),
      sendGrants:
        options.sendGrants ??
        (async (update) => {
          sent.push(update);
          return true;
        }),
    },
    signing: () => key,
    source: options.source ?? {
      read: () =>
        options.thread?.() ?? {
          status: "found",
          title: "Fix the login page",
          archived: false,
          state: "idle",
          messages: [
            { role: "person", text: "Please fix /Users/ada/app/login.ts" },
            { role: "agent", text: "Done." },
          ],
        },
    },
    taint: (input) => {
      tainted.push(input.contentReference);
      return true;
    },
    record: (change) => records.push(change),
    now: () => now,
  });
  return {
    service,
    key,
    records,
    tainted,
    sent,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

async function shared(context: ReturnType<typeof setup>, scope: "read" | "comment" = "comment") {
  const result = await context.service.share({ mode: "code", threadId: "thread-1", scope });
  if (result.status !== "shared") throw new Error(result.kind);
  return result;
}

const secretOf = (link: { readonly url: string }) => link.url.split("#k=")[1] ?? "";

const fetchOf = (
  linkId: string,
  kind: VisitorFetchRequest["kind"],
  binding = BROWSER,
  extra: Partial<VisitorFetchRequest> = {},
): VisitorFetchRequest => ({
  linkId: linkId as VisitorLinkId,
  revision: 1,
  binding,
  kind,
  ...extra,
});

describe("a webhook signing secret in a shared Work thread", () => {
  it("reaches a visitor redacted, in a settled message and a still-streaming reply", async () => {
    const secret = "whsec_5WbX1kEMOo2N8gQk9Ff3LhZtA7cYdRsV";
    const context = setup({
      source: visitorThreadSource(
        () => {
          throw new Error("A Work read uses no database.");
        },
        () => ({}),
        {
          thread: () => ({ title: `Check ${secret}`, lifecycle: "active" }),
          turns: () => [
            {
              requestId: decodeWorkTurnRequestId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
              turnId: "turn-1",
              status: "running",
              transcript: [
                { role: "user", text: `Verify events with ${secret}` },
                { role: "assistant", text: "" },
              ],
            },
          ],
          // The reply has not settled, so only the live read holds it.
          liveReplyText: () => `I will use ${secret} next`,
          activity: () => ({ executing: true, awaitingInput: false }),
        },
      ),
    });
    const link = await context.service.share({
      mode: "work",
      threadId: "11111111-1111-4111-8111-111111111111",
      scope: "read",
    });
    if (link.status !== "shared") throw new Error(link.kind);
    const answer = context.service.fetch(
      fetchOf(link.linkId, "open", BROWSER, { secret: secretOf(link) }),
      HUB,
    );
    expect(answer).toMatchObject({
      status: "ok",
      projection: {
        title: "Check [redacted]",
        messages: [
          { role: "person", text: "Verify events with [redacted]" },
          { role: "agent", text: "I will use [redacted] " },
        ],
      },
    });
  });
});

describe("a secret a Work reply is still writing", () => {
  it("shows a visitor none of it, and redacts it whole once the turn settles", async () => {
    const secret = "whsec_5WbX1kEMOo2N8gQk9Ff3LhZtA7cYdRsV";
    // Shorter than the redactor's pattern, as the first streamed pieces are.
    let live: string | undefined = `The secret is ${secret.slice(0, 12)}`;
    const context = setup({
      source: visitorThreadSource(
        () => {
          throw new Error("A Work read uses no database.");
        },
        () => ({}),
        {
          thread: () => ({ title: "Check", lifecycle: "active" }),
          turns: () => [
            {
              requestId: decodeWorkTurnRequestId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
              turnId: "turn-1",
              status: live === undefined ? "completed" : "running",
              transcript: [
                { role: "user", text: "Show it" },
                {
                  role: "assistant",
                  text: live === undefined ? `The secret is ${secret}` : "",
                },
              ],
            },
          ],
          liveReplyText: () => live,
          activity: () => ({ executing: live !== undefined, awaitingInput: false }),
        },
      ),
    });
    const link = await context.service.share({
      mode: "work",
      threadId: "11111111-1111-4111-8111-111111111111",
      scope: "read",
    });
    if (link.status !== "shared") throw new Error(link.kind);
    const opened = fetchOf(link.linkId, "open", BROWSER, { secret: secretOf(link) });

    const streaming = context.service.fetch(opened, HUB);
    expect(JSON.stringify(streaming)).not.toContain("whsec_");
    live = undefined;
    expect(context.service.fetch(opened, HUB)).toMatchObject({
      projection: {
        messages: [
          { role: "person", text: "Show it" },
          { role: "agent", text: "The secret is [redacted]" },
        ],
      },
    });
  });
});

describe("sharing a thread with a visitor", () => {
  it("signs the grant with this host's key and hands the hub only the grant", async () => {
    const context = setup();
    const link = await shared(context);
    expect(link.url.startsWith(`/v/${link.linkId}#k=`)).toBe(true);
    const update = context.sent.at(-1) as { grants: ReadonlyArray<{ signerPublicKey: string }> };
    expect(update.grants).toHaveLength(1);
    expect(publicKeyFingerprint(update.grants[0]?.signerPublicKey ?? "")).toBe(
      publicKeyFingerprint(context.key.publicKey),
    );
    expect(JSON.stringify(update)).not.toContain("thread-1");
    expect(JSON.stringify(update)).not.toContain(link.url.split("#k=")[1]);
  });

  it("refuses to share while the Public item is unticked", async () => {
    const context = setup({ granted: () => false });
    expect(await context.service.share({ mode: "code", threadId: "t", scope: "read" })).toEqual({
      status: "refused",
      kind: "public-not-granted",
    });
  });

  it("a second browser cannot open a bound link", async () => {
    const context = setup();
    const link = await shared(context);
    expect(
      context.service.fetch(fetchOf(link.linkId, "open", BROWSER, { secret: secretOf(link) }), HUB)
        .status,
    ).toBe("ok");
    expect(
      context.service.fetch(
        fetchOf(link.linkId, "open", OTHER_BROWSER, { secret: secretOf(link) }),
        HUB,
      ),
    ).toEqual({
      status: "refused",
      kind: "bound-elsewhere",
    });
    expect(context.service.fetch(fetchOf(link.linkId, "read", OTHER_BROWSER), HUB)).toEqual({
      status: "refused",
      kind: "bound-elsewhere",
    });
  });

  it("binds no browser that opens the link without its secret", async () => {
    const context = setup();
    const link = await shared(context);
    expect(context.service.fetch(fetchOf(link.linkId, "open"), HUB)).toEqual({
      status: "refused",
      kind: "unknown-link",
    });
    expect(
      context.service.fetch(fetchOf(link.linkId, "open", BROWSER, { secret: "A".repeat(43) }), HUB),
    ).toEqual({ status: "refused", kind: "unknown-link" });
    expect(
      context.service.fetch(fetchOf(link.linkId, "open", BROWSER, { secret: secretOf(link) }), HUB)
        .status,
    ).toBe("ok");
  });

  it("reads nothing before a browser opened the link with its secret", async () => {
    const context = setup();
    const link = await shared(context);
    expect(context.service.fetch(fetchOf(link.linkId, "read"), HUB)).toEqual({
      status: "refused",
      kind: "not-bound",
    });
  });

  it("stops at the next fetch once the person stops sharing", async () => {
    const context = setup();
    const link = await shared(context);
    context.service.fetch(fetchOf(link.linkId, "open", BROWSER, { secret: secretOf(link) }), HUB);
    await context.service.stop(link.linkId);
    expect(context.service.fetch(fetchOf(link.linkId, "read"), HUB)).toEqual({
      status: "refused",
      kind: "revoked",
    });
  });

  it("stops once the link expires", async () => {
    const context = setup();
    const link = await shared(context);
    context.service.fetch(fetchOf(link.linkId, "open", BROWSER, { secret: secretOf(link) }), HUB);
    context.advance(24 * 3_600_000);
    expect(context.service.fetch(fetchOf(link.linkId, "read"), HUB)).toEqual({
      status: "refused",
      kind: "expired",
    });
  });

  it("ends when the thread is archived or has moved away", async () => {
    let archived = false;
    const context = setup({
      thread: () =>
        archived
          ? { status: "found", title: "t", archived: true, state: "idle", messages: [] }
          : { status: "found", title: "t", archived: false, state: "idle", messages: [] },
    });
    const link = await shared(context);
    context.service.fetch(fetchOf(link.linkId, "open", BROWSER, { secret: secretOf(link) }), HUB);
    archived = true;
    expect(context.service.fetch(fetchOf(link.linkId, "read"), HUB)).toEqual({
      status: "refused",
      kind: "ended",
    });
  });

  it("the projection never carries a path or anything but messages", async () => {
    const context = setup();
    const link = await shared(context);
    const answer = context.service.fetch(
      fetchOf(link.linkId, "open", BROWSER, { secret: secretOf(link) }),
      HUB,
    );
    expect(answer.status).toBe("ok");
    const text = JSON.stringify(answer);
    expect(text).not.toContain("/Users/ada");
    expect(answer.status === "ok" ? Object.keys(answer.projection ?? {}) : []).toEqual([
      "title",
      "state",
      "messages",
    ]);
  });
});

describe("sharing a Work thread", () => {
  it("a Work thread can be shared, and its visitor reads only redacted messages and state", async () => {
    const turn = {
      requestId: decodeWorkTurnRequestId("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
      turnId: "turn-1",
      status: "waiting",
      failure: { category: "rate-limited", message: "Limit reached.", usageLimit: {} },
      transcript: [
        { role: "user", text: "Draft the reply to /Users/ada/Mail/acme.eml" },
        { role: "assistant", text: "Here is a draft." },
      ],
      toolSteps: [{ name: "read_file", state: "completed", message: "TOOL OUTPUT: inbox" }],
    } as const;
    const context = setup({
      source: visitorThreadSource(
        () => {
          throw new Error("A Work read uses no database.");
        },
        () => ({}),
        {
          thread: () => ({ title: "Answer Acme", lifecycle: "active" }),
          turns: () => [turn],
          liveReplyText: () => undefined,
          activity: () => ({ executing: false, awaitingInput: true, waitsOnTurnAlone: true }),
        },
      ),
    });
    const link = await context.service.share({
      mode: "work",
      threadId: "11111111-1111-4111-8111-111111111111",
      scope: "read",
    });
    if (link.status !== "shared") throw new Error(link.kind);
    const answer = context.service.fetch(
      fetchOf(link.linkId, "open", BROWSER, { secret: secretOf(link) }),
      HUB,
    );
    expect(answer).toMatchObject({
      status: "ok",
      projection: {
        title: "Answer Acme",
        state: "owner-deciding",
        messages: [
          { role: "person", text: "Draft the reply to [path]" },
          { role: "agent", text: "Here is a draft." },
        ],
      },
    });
    expect(JSON.stringify(answer)).not.toContain("TOOL OUTPUT");
    expect(JSON.stringify(answer)).not.toContain("/Users/ada");
  });
});

describe("visitor comments", () => {
  it("a comment-only visitor cannot answer an approval: a comment only waits as a Request", async () => {
    const context = setup({
      thread: () => ({
        status: "found",
        title: "t",
        archived: false,
        state: "owner-deciding",
        messages: [],
      }),
    });
    const link = await shared(context);
    context.service.fetch(fetchOf(link.linkId, "open", BROWSER, { secret: secretOf(link) }), HUB);
    const answer = context.service.fetch(
      fetchOf(link.linkId, "comment", BROWSER, { comment: "approve" }),
      HUB,
    );
    expect(answer.status).toBe("ok");
    expect(answer.status === "ok" ? answer.projection?.state : undefined).toBe("owner-deciding");
    expect(context.service.view().comments).toEqual([
      expect.objectContaining({ linkId: link.linkId, text: "approve" }),
    ]);
    expect(context.tainted).toEqual([]);
  });

  it("never gives a comment an id the CLI would read as a flag", async () => {
    const context = setup();
    const link = await shared(context);
    context.service.fetch(fetchOf(link.linkId, "open", BROWSER, { secret: secretOf(link) }), HUB);
    randomness.dashFirst = 1;
    context.service.fetch(fetchOf(link.linkId, "comment", BROWSER, { comment: "hello" }), HUB);
    randomness.dashFirst = 0;
    const [comment] = context.service.view().comments;
    expect(comment?.commentId.startsWith("-")).toBe(false);
  });

  it("a read-only link takes no comment", async () => {
    const context = setup();
    const link = await shared(context, "read");
    context.service.fetch(fetchOf(link.linkId, "open", BROWSER, { secret: secretOf(link) }), HUB);
    expect(
      context.service.fetch(fetchOf(link.linkId, "comment", BROWSER, { comment: "hello" }), HUB),
    ).toEqual({ status: "refused", kind: "comment-not-allowed" });
  });

  it("only the person's Send delivers a comment, framed as outside content", async () => {
    const context = setup();
    const link = await shared(context);
    context.service.fetch(fetchOf(link.linkId, "open", BROWSER, { secret: secretOf(link) }), HUB);
    context.service.fetch(fetchOf(link.linkId, "comment", BROWSER, { comment: "Nice work" }), HUB);
    const [comment] = context.service.view().comments;
    const sent = context.service.decideComment(comment?.commentId ?? "", "send");
    expect(sent.status).toBe("sent");
    expect(sent.status === "sent" ? sent.text : "").toContain('origin="external-content"');
    expect(sent.status === "sent" ? sent.text : "").toContain("Nice work");
    expect(context.tainted).toHaveLength(1);
    expect(context.service.decideComment(comment?.commentId ?? "", "send")).toEqual({
      status: "refused",
      kind: "unknown-comment",
    });
  });

  it("holds at most twenty waiting comments per link", async () => {
    const context = setup();
    const link = await shared(context);
    context.service.fetch(fetchOf(link.linkId, "open", BROWSER, { secret: secretOf(link) }), HUB);
    for (let index = 0; index < 20; index += 1) {
      context.service.fetch(
        fetchOf(link.linkId, "comment", BROWSER, { comment: `c${index}` }),
        HUB,
      );
    }
    expect(
      context.service.fetch(fetchOf(link.linkId, "comment", BROWSER, { comment: "one more" }), HUB),
    ).toEqual({ status: "refused", kind: "comments-full" });
  });

  it("answers no visitor while its person has paused remote access", async () => {
    let paused = false;
    const context = setup({ paused: () => paused });
    const link = await shared(context);
    const open = fetchOf(link.linkId, "open", BROWSER, { secret: secretOf(link) });
    expect(context.service.fetch(open, HUB).status).toBe("ok");
    paused = true;
    expect(context.service.fetch(fetchOf(link.linkId, "read"), HUB)).toEqual({
      status: "refused",
      kind: "paused",
    });
    paused = false;
    expect(context.service.fetch(fetchOf(link.linkId, "read"), HUB).status).toBe("ok");
  });

  it("refuses to share a thread it cannot find, or one that is archived", async () => {
    let thread: VisitorThreadRead = { status: "missing" };
    const context = setup({ thread: () => thread });
    expect(
      await context.service.share({ mode: "code", threadId: "no-such", scope: "read" }),
    ).toEqual({ status: "refused", kind: "unknown-thread" });
    thread = { status: "found", title: "Old", archived: true, state: "idle", messages: [] };
    expect(await context.service.share({ mode: "code", threadId: "old", scope: "read" })).toEqual({
      status: "refused",
      kind: "unknown-thread",
    });
  });

  it("keeps a long thread's projection small enough for the private link, newest messages kept", async () => {
    const messages = Array.from({ length: 200 }, (_, index) => ({
      role: index % 2 === 0 ? ("person" as const) : ("agent" as const),
      text: `${index} ${"x".repeat(31_000)}`,
    }));
    const context = setup({
      thread: () => ({ status: "found", title: "Long", archived: false, state: "idle", messages }),
    });
    const link = await shared(context);
    const answer = context.service.fetch(
      fetchOf(link.linkId, "open", BROWSER, { secret: secretOf(link) }),
      HUB,
    );
    if (answer.status !== "ok") throw new Error(answer.kind);
    expect(Buffer.byteLength(JSON.stringify(answer))).toBeLessThanOrEqual(
      VISITOR_PROJECTION_MAX_BYTES + 1_024,
    );
    expect(answer.projection?.messages.at(-1)?.text.startsWith("199 ")).toBe(true);
  });

  it("counts the whole projection, its state and message list included, against the byte budget", async () => {
    const full = "x".repeat(32_000);
    const envelope = (text: string) => Buffer.byteLength(JSON.stringify({ role: "agent", text }));
    // Twelve full messages plus an oldest one sized to fill the budget exactly
    // when only the title and the messages are counted.
    const counted = Buffer.byteLength(JSON.stringify({ title: "T" })) + 12 * (envelope(full) + 1);
    const oldest = "y".repeat(VISITOR_PROJECTION_MAX_BYTES - counted - 1 - envelope(""));
    const messages = [oldest, ...Array.from({ length: 12 }, () => full)].map((text) => ({
      role: "agent" as const,
      text,
    }));
    const context = setup({
      thread: () => ({ status: "found", title: "T", archived: false, state: "idle", messages }),
    });
    const link = await shared(context);
    const answer = context.service.fetch(
      fetchOf(link.linkId, "open", BROWSER, { secret: secretOf(link) }),
      HUB,
    );
    if (answer.status !== "ok") throw new Error(answer.kind);
    expect(answer.projection?.messages).toHaveLength(12);
    expect(Buffer.byteLength(JSON.stringify(answer.projection))).toBeLessThanOrEqual(
      VISITOR_PROJECTION_MAX_BYTES,
    );
  });

  it("an older grant list never reaches the hub after a newer one", async () => {
    const sent: number[] = [];
    let releaseFirst: (() => void) | undefined;
    let calls = 0;
    const context = setup({
      sendGrants: async (update) => {
        calls += 1;
        if (calls === 1) await new Promise<void>((resolve) => (releaseFirst = resolve));
        sent.push(update.grants.length);
        return true;
      },
    });
    const first = context.service.share({ mode: "code", threadId: "thread-1", scope: "read" });
    await Promise.resolve();
    const second = context.service.share({ mode: "code", threadId: "thread-2", scope: "read" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(sent.at(-1)).toBe(2);
    expect(context.service.view().published).toBe(true);
  });

  it("hands its live links to a promoted hub it switched to, though the old hub took them", async () => {
    let hub = HUB;
    const context = setup({ hubMemberId: () => hub });
    await shared(context, "read");
    await context.service.look();
    expect(context.sent).toHaveLength(1);

    hub = "33333333-3333-4333-8333-333333333333";
    await context.service.look();
    expect(context.sent).toHaveLength(2);
    expect((context.sent[1] as HubVisitorGrantsUpdate).grants).toHaveLength(1);
    await context.service.look();
    expect(context.sent).toHaveLength(2);
  });
});

describe("a secret a Chat or Code reply is still writing", () => {
  const secret = "whsec_5WbX1kEMOo2N8gQk9Ff3LhZtA7cYdRsV";
  // Shorter than the redactor's pattern, as the first streamed pieces are.
  const partial = `The secret is ${secret.slice(0, 12)}`;
  const settled = {
    projection: {
      messages: [
        { role: "person", text: "Show it" },
        { role: "agent", text: "The secret is [redacted]" },
      ],
    },
  };
  const streamed = {
    projection: {
      messages: [
        { role: "person", text: "Show it" },
        { role: "agent", text: "The secret is " },
      ],
    },
  };

  async function opened(context: ReturnType<typeof setup>, mode: "chat" | "code") {
    const link = await context.service.share({
      mode,
      threadId: "11111111-1111-4111-8111-111111111111",
      scope: "read",
    });
    if (link.status !== "shared") throw new Error(link.kind);
    return fetchOf(link.linkId, "open", BROWSER, { secret: secretOf(link) });
  }

  it.each(["queued", "streaming", "waiting"])(
    "shows a visitor none of it while a Chat reply is %s, and redacts it whole once settled",
    async (outcome) => {
      const chat = (state: string, reply: string) => ({
        thread: { title: "Check", lifecycle: "active" },
        contents: [
          { contentId: "asked", role: "user", body: "Show it" },
          { contentId: "reply-1", role: "assistant", body: reply.slice(0, 7) },
          { contentId: "reply-2", role: "assistant", body: reply.slice(7) },
        ],
        turns: [
          {
            id: "turn-1",
            userMessageRef: { contentId: "asked" },
            attempts: [
              {
                id: "attempt-1",
                outcome: state,
                responseRefs: [{ contentId: "reply-1" }, { contentId: "reply-2" }],
              },
            ],
          },
        ],
      });
      projections.chat = chat(outcome, partial);
      const context = setup({
        source: visitorThreadSource(
          () => ({}) as never,
          () => ({}),
        ),
      });
      const request = await opened(context, "chat");

      const live = context.service.fetch(request, HUB);
      expect(live).toMatchObject(streamed);
      expect(JSON.stringify(live)).not.toContain("whsec_");
      projections.chat = chat("completed", `The secret is ${secret}`);
      expect(context.service.fetch(request, HUB)).toMatchObject(settled);
    },
  );

  it.each(["waiting", "interrupted", "cancelled", "failed"])(
    "keeps back the last word of a Chat reply that stopped (%s), even once a newer turn completed",
    async (outcome) => {
      projections.chat = {
        thread: { title: "Check", lifecycle: "active", releasedStopId: "attempt-1" },
        contents: [
          { contentId: "asked-1", role: "user", body: "Show it" },
          { contentId: "reply-1", role: "assistant", body: `The secret is ${secret.slice(0, 12)}` },
          { contentId: "asked-2", role: "user", body: "Go on" },
          { contentId: "reply-2", role: "assistant", body: "Done" },
        ],
        turns: [
          {
            id: "turn-1",
            userMessageRef: { contentId: "asked-1" },
            attempts: [{ id: "attempt-1", outcome, responseRefs: [{ contentId: "reply-1" }] }],
          },
          {
            id: "turn-2",
            userMessageRef: { contentId: "asked-2" },
            attempts: [
              { id: "attempt-2", outcome: "completed", responseRefs: [{ contentId: "reply-2" }] },
            ],
          },
        ],
      };
      const context = setup({
        source: visitorThreadSource(
          () => ({}) as never,
          () => ({}),
        ),
      });
      const request = await opened(context, "chat");
      const read = JSON.stringify(context.service.fetch(request, HUB));
      expect(read).toContain("The secret is");
      expect(read).toContain("Done");
      expect(read).not.toContain("whsec_");
    },
  );

  it.each([
    { executing: true, awaitingInput: false },
    { executing: false, awaitingInput: true },
  ])(
    "shows a visitor none of it while a Code turn is live (%o), and redacts it whole once settled",
    async (running) => {
      let activity = running;
      let reply = partial;
      // Newest first, as the read orders them; an earlier settled reply follows.
      const connection = {
        prepare: () => ({
          all: () => [
            { content_role: "assistant", body_text: reply },
            { content_role: "user", body_text: "Show it" },
            { content_role: "assistant", body_text: "Ready." },
          ],
        }),
      };
      projections.code = { title: "Check", lifecycle: "active" };
      const context = setup({
        source: visitorThreadSource(
          () => connection as never,
          () => activity,
        ),
      });
      const request = await opened(context, "code");

      const live = context.service.fetch(request, HUB);
      expect(live).toMatchObject({
        projection: {
          messages: [{ role: "agent", text: "Ready." }, ...streamed.projection.messages],
        },
      });
      expect(JSON.stringify(live)).not.toContain("whsec_");
      activity = { executing: false, awaitingInput: false };
      reply = `The secret is ${secret}`;
      expect(context.service.fetch(request, HUB)).toMatchObject({
        projection: {
          messages: [{ role: "agent", text: "Ready." }, ...settled.projection.messages],
        },
      });
    },
  );
});
