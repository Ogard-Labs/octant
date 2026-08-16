import { describe, expect, it, vi } from "vitest";
import {
  BrowserAutomationClientFailure,
  createBrowserAutomationClient,
} from "./browserAutomationClient";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const threadId = "10000000-0000-4000-8000-000000000001";
const contextId = "15000000-0000-4000-8000-000000000001";
const authority = {
  hostId: "20000000-0000-4000-8000-000000000001",
  mode: "work",
  projectId: "30000000-0000-4000-8000-000000000001",
  rootId: "40000000-0000-4000-8000-000000000001",
  providerInstanceId: "50000000-0000-4000-8000-000000000001",
  extension: { kind: "core" },
};

describe("BrowserAutomationClient", () => {
  it("resolves thread authority through the authenticated server route", async () => {
    const fetch = vi.fn(async () => Response.json({ threadId, authority }));
    const client = createBrowserAutomationClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });
    await expect(client.resolve({ threadId: threadId as any, mode: "work" })).resolves.toEqual({
      threadId,
      authority,
    });
    expect(fetch).toHaveBeenCalledWith(
      new URL("http://127.0.0.1:13773/api/browser/scope"),
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-octant-window-capability": capability }),
      }),
    );
  });

  it("invokes the browser fetch function without rebinding its receiver", async () => {
    const fetch = vi.fn(function (this: unknown) {
      expect(this).toBeUndefined();
      return Promise.resolve(Response.json({ threadId, authority }));
    });
    const client = createBrowserAutomationClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });
    await expect(client.resolve({ threadId: threadId as any, mode: "work" })).resolves.toEqual({
      threadId,
      authority,
    });
  });

  it("maps typed server failures", async () => {
    const client = createBrowserAutomationClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: vi.fn(async () =>
        Response.json({ category: "policy-denied", message: "Origin denied." }, { status: 403 }),
      ),
      windowCapability: capability,
    });
    await expect(client.resolve({ threadId: threadId as any, mode: "work" })).rejects.toEqual(
      expect.objectContaining<Partial<BrowserAutomationClientFailure>>({
        category: "policy-denied",
        message: "Origin denied.",
      }),
    );
  });

  it("sends the owning thread with lifecycle commands", async () => {
    let sentBody: unknown;
    const fetch = vi.fn(
      async (_input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
        sentBody = JSON.parse(String(init?.body));
        return Response.json({ status: "ready", threadId, evidence: [] });
      },
    );
    const client = createBrowserAutomationClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch,
      windowCapability: capability,
    });
    await client.inspect({ contextId: contextId as any, threadId: threadId as any });
    expect(sentBody).toEqual({ contextId, threadId });
  });

  it("reattaches and releases by authoritative thread scope", async () => {
    const requests: Array<{ readonly path: string; readonly body: unknown }> = [];
    const client = createBrowserAutomationClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: vi.fn(async (input, init) => {
        requests.push({
          path: new URL(String(input)).pathname,
          body: JSON.parse(String(init?.body)),
        });
        return Response.json({ status: "ready", threadId, evidence: [] });
      }),
      windowCapability: capability,
    });

    await client.inspectThread({ threadId: threadId as any });
    await client.releaseThread({ threadId: threadId as any });

    expect(requests).toEqual([
      { path: "/api/browser/contexts/current", body: { threadId } },
      { path: "/api/browser/contexts/release", body: { threadId } },
    ]);
  });

  it("maps request aborts to interrupted", async () => {
    const controller = new AbortController();
    const client = createBrowserAutomationClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: vi.fn(async () => {
        controller.abort();
        throw new DOMException("aborted", "AbortError");
      }),
      windowCapability: capability,
    });
    await expect(
      client.resolve({ threadId: threadId as any, mode: "work" }, controller.signal),
    ).rejects.toMatchObject({ category: "interrupted" });
  });
});
