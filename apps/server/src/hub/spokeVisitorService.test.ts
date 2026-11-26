import { generateKeyPairSync, sign } from "node:crypto";
import type {
  HubMemberId,
  HubMembershipChangedPayload,
  VisitorFetchRequest,
  VisitorLinkId,
} from "@octant/contracts";
import { describe, expect, it } from "vitest";
import type { HubState, HubStatePort } from "./hubStateStore";
import { publicKeyFingerprint } from "./hubCrypto";
import { SpokeVisitorService, type VisitorThreadRead } from "./spokeVisitorService";

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
    hub: {
      target: () => ({ memberId: "22222222-2222-4222-8222-222222222222" }),
      sendGrants: async (update) => {
        sent.push(update);
        return true;
      },
    },
    signing: () => key,
    source: {
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
});
