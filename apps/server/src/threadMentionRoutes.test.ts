import { describe, expect, it, vi } from "vitest";
import { decodeWindowId } from "@octant/contracts";
import { WindowAuthorityStore } from "./windowAuthorityStore";
import {
  createThreadMentionRouteHandler,
  type ThreadMentionRouteDependencies,
} from "./threadMentionRoutes";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000901");
const requestId = "00000000-0000-4000-8000-000000000902";
const commandsUrl = "http://127.0.0.1/api/thread-mentions/commands";

const authHeaders = {
  "content-type": "application/json",
  "x-octant-window-capability": capability,
};

function searchedResult() {
  return { kind: "mentions-searched", requestId, candidates: [] };
}

function createRoute(execute?: ThreadMentionRouteDependencies["service"]["execute"]) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  const spy = execute ?? vi.fn().mockResolvedValue(searchedResult());
  return {
    execute: spy,
    handler: createThreadMentionRouteHandler({
      service: { execute: spy },
      windowAuthorityStore: store,
      now: () => 1,
    }),
  };
}

function searchRequest(body: unknown = { kind: "search-mentions", requestId, query: "rel" }) {
  return new Request(commandsUrl, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify(body),
  });
}

describe("Thread mention routes", () => {
  it("ignores paths it does not own", async () => {
    const { handler } = createRoute();

    expect(await handler(new Request("http://127.0.0.1/api/chat/bootstrap"))).toBeUndefined();
  });

  it("rejects a non-loopback host", async () => {
    const { handler } = createRoute();

    const response = await handler(
      new Request("http://example.com/api/thread-mentions/commands", {
        method: "POST",
        headers: authHeaders,
        body: "{}",
      }),
    );

    expect(response?.status).toBe(400);
  });

  it("rejects a disallowed renderer origin", async () => {
    const { handler } = createRoute();

    const response = await handler(
      new Request(commandsUrl, {
        method: "POST",
        headers: { ...authHeaders, origin: "https://evil.example" },
        body: "{}",
      }),
    );

    expect(response?.status).toBe(400);
  });

  it("answers a preflight for the loopback renderer", async () => {
    const { handler } = createRoute();

    const response = await handler(
      new Request(commandsUrl, { method: "OPTIONS", headers: { origin: "http://127.0.0.1" } }),
    );

    expect(response?.status).toBe(204);
    expect(response?.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1");
  });

  it("rejects a request without a valid window capability", async () => {
    const { execute, handler } = createRoute();

    const response = await handler(
      new Request(commandsUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "search-mentions", requestId, query: "" }),
      }),
    );

    expect(response?.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects a non-JSON content type", async () => {
    const { handler } = createRoute();

    const response = await handler(
      new Request(commandsUrl, {
        method: "POST",
        headers: { "x-octant-window-capability": capability, "content-type": "text/plain" },
        body: "{}",
      }),
    );

    expect(response?.status).toBe(400);
  });

  it("rejects a body larger than the bound", async () => {
    const store = new WindowAuthorityStore();
    store.register({ windowId, capability, now: 0 });
    const handler = createThreadMentionRouteHandler({
      service: { execute: vi.fn() },
      windowAuthorityStore: store,
      maxJsonBodySize: 8,
      now: () => 1,
    });

    const response = await handler(searchRequest());

    expect(response?.status).toBe(413);
  });

  it("rejects GET and query strings", async () => {
    const { handler } = createRoute();

    expect((await handler(new Request(commandsUrl)))?.status).toBe(400);
    expect(
      (
        await handler(
          new Request(`${commandsUrl}?query=x`, {
            method: "POST",
            headers: authHeaders,
            body: "{}",
          }),
        )
      )?.status,
    ).toBe(400);
  });

  it("hands the decoded command to the service under the authenticated window", async () => {
    const { execute, handler } = createRoute();

    const response = await handler(searchRequest());

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual(searchedResult());
    expect(execute).toHaveBeenCalledWith(
      { kind: "search-mentions", requestId, query: "rel" },
      { windowId },
    );
  });

  it("never lets the renderer supply its own principal", async () => {
    const { execute, handler } = createRoute();

    const response = await handler(
      searchRequest({ kind: "search-mentions", requestId, query: "rel", windowId: "other" }),
    );

    expect(response?.status).toBe(401);
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns a refusal rather than a partial resolution when the service throws", async () => {
    const { handler } = createRoute(vi.fn().mockRejectedValue(new Error("boom")));

    const response = await handler(
      searchRequest({ kind: "resolve-mentions", requestId, threadIds: ["thread-1"] }),
    );

    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({ message: "Thread mention command is invalid." });
  });
});
