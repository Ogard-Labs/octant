import { decodeReplyDetailReading, type ShellSettings } from "@octant/contracts";
import { defaultShellSettings } from "@octant/domain/shell-policy";
import { describe, expect, it } from "vitest";
import { classifyProductAction } from "./authenticatedProductRoutes";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import { createReplyDetailRouteHandler } from "./replyDetailRoutes";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const nowMs = Date.parse("2026-11-05T10:00:00.000Z");
const windowId = "70000000-0000-4000-8000-000000000001";
const capability = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0";
const deviceId = "55000000-0000-4000-8000-000000000001";

const settings: ShellSettings = {
  ...defaultShellSettings(),
  replyDetail: "medium",
  threadReplyDetail: [{ mode: "work", threadId: "thread-1", level: "high" }],
  streamReplies: false,
};

function setup() {
  const windowAuthorityStore = new WindowAuthorityStore();
  windowAuthorityStore.register({ windowId: windowId as never, capability, now: nowMs });
  return createReplyDetailRouteHandler({
    readShellSettings: () => settings,
    windowAuthorityStore,
    now: () => nowMs,
  });
}

function pairedRequest(path: string, method = "GET"): Request {
  const request = new Request(`http://127.0.0.1${path}`, { method });
  bindPrincipalRouteContext(request, {
    principal: {
      kind: "remote-device",
      hostId: "11111111-1111-4111-8111-111111111111",
      deviceId,
      credentialGeneration: 1,
      origin: "https://remote.example",
      protocolVersion: 1,
      capabilityDigest: "a".repeat(64),
      sessionId: "55000000-0000-4000-8000-0000000000aa",
    } as never,
    scopeId: deviceId as never,
  });
  return request;
}

describe("the reply detail read", () => {
  it("gives a paired device the default and each thread's own level, and no other setting", async () => {
    const response = await setup()(pairedRequest("/api/reply-detail"));
    expect(response?.status).toBe(200);
    const body: unknown = await response?.json();
    expect(body).toEqual({
      defaultLevel: "medium",
      threads: [{ mode: "work", threadId: "thread-1", level: "high" }],
    });
    expect(decodeReplyDetailReading(body).defaultLevel).toBe("medium");
  });

  it("answers a window on this host that holds a live capability", async () => {
    const response = await setup()(
      new Request("http://127.0.0.1:3100/api/reply-detail", {
        headers: { "x-octant-window-capability": capability },
      }),
    );
    expect(response?.status).toBe(200);
  });

  it("refuses a caller with no principal, any write, and a query", async () => {
    const handler = setup();
    expect((await handler(new Request("http://127.0.0.1:3100/api/reply-detail")))?.status).toBe(
      401,
    );
    expect((await handler(pairedRequest("/api/reply-detail", "POST")))?.status).toBe(405);
    expect((await handler(pairedRequest("/api/reply-detail?thread=1")))?.status).toBe(400);
    expect(await handler(pairedRequest("/api/reply-detail/extra"))).toBeUndefined();
  });

  it("is classified as a read of non-secret settings and never as a write", () => {
    expect(classifyProductAction(new Request("https://octant.example/api/reply-detail"))).toBe(
      "settings.read-non-secret",
    );
    expect(
      classifyProductAction(
        new Request("https://octant.example/api/reply-detail", { method: "POST" }),
      ),
    ).toBeUndefined();
  });
});
