import { describe, expect, it, vi } from "vitest";
import { CredentialRequests } from "./credentialRequests";
import type { CredentialOperation } from "@octant/plugin-api/credential-request";

const operation: CredentialOperation = {
  id: "account-check",
  label: "API token",
  reason: "Check access",
  consumer: "Test",
  actionLabel: "Check access",
  request: { url: "https://api.example.com/account", body: "{}", authorization: "bearer" },
  accepted: (body) => body !== null,
};
function setup() {
  let now = 0;
  let current = true;
  const fetch = vi.fn(async (_request: Request) => new Response('{"ok":true}'));
  const service = new CredentialRequests({ fetch, now: () => now });
  const abort = new AbortController();
  const pending = service.request({
    windowId: "window",
    threadId: "thread",
    operation,
    current: () => current,
    signal: abort.signal,
  });
  const id = service.view("window", "thread").requests[0]?.id ?? "missing";
  return {
    service,
    fetch,
    pending,
    id,
    abort,
    expire: () => {
      now = 600_001;
    },
    revoke: () => {
      current = false;
    },
  };
}
describe("private credential requests", () => {
  it("uses a submitted token once without returning it to the agent or card", async () => {
    const h = setup();
    expect(h.service.view("other", "thread").requests).toEqual([]);
    expect(
      await h.service.answer("other", { id: h.id, action: "allow", secret: "private-token" }),
    ).toBe(false);
    expect(
      await h.service.answer("window", { id: h.id, action: "allow", secret: "private-token" }),
    ).toBe(true);
    expect(await h.pending).toEqual({ status: "used" });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    const request = h.fetch.mock.calls[0]?.[0];
    expect(request).toBeDefined();
    expect(JSON.stringify(h.service.view("window", "thread"))).not.toContain("private-token");
    expect(await h.service.answer("window", { id: h.id, action: "allow", secret: "again" })).toBe(
      false,
    );
    h.service.close();
  });
  it.each(["decline", "expire", "revoke", "abort"] as const)(
    "refuses use after %s",
    async (action) => {
      const h = setup();
      if (action === "decline") await h.service.answer("window", { id: h.id, action: "decline" });
      if (action === "expire") h.expire();
      if (action === "revoke") h.revoke();
      if (action === "abort") h.abort.abort();
      expect(await h.service.answer("window", { id: h.id, action: "allow", secret: "token" })).toBe(
        false,
      );
      expect((await h.pending).status).not.toBe("used");
      expect(h.fetch).not.toHaveBeenCalled();
      h.service.close();
    },
  );
  it("does not replay a failed request or expose an error containing the token", async () => {
    const h = setup();
    h.fetch.mockRejectedValueOnce(new Error("private-token"));
    await h.service.answer("window", { id: h.id, action: "allow", secret: "private-token" });
    expect(await h.pending).toEqual({ status: "failed" });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    h.service.close();
  });
  it("claims the operation before a concurrent submission can send another token", async () => {
    const h = setup();
    const first = h.service.answer("window", { id: h.id, action: "allow", secret: "first" });
    const second = h.service.answer("window", { id: h.id, action: "allow", secret: "second" });
    expect(await second).toBe(false);
    await first;
    expect(await h.pending).toEqual({ status: "used" });
    expect(h.fetch).toHaveBeenCalledTimes(1);
    h.service.close();
  });
  it("cancels outstanding grants when the host closes", async () => {
    const h = setup();
    h.service.close();
    expect(await h.pending).toEqual({ status: "cancelled" });
    expect(await h.service.answer("window", { id: h.id, action: "allow", secret: "token" })).toBe(
      false,
    );
    expect(h.fetch).not.toHaveBeenCalled();
  });
});

describe("fixed credential reads", () => {
  it("sends one GET to the registered complete URL without a body or redirect following", async () => {
    const fetch = vi.fn(async (_request: Request) => new Response('{"value":[]}'));
    const service = new CredentialRequests({ fetch });
    const pending = service.request({
      windowId: "window",
      threadId: "thread",
      operation: {
        ...operation,
        request: {
          url: "https://management.azure.com/subscriptions?api-version=2022-12-01",
          method: "GET",
          authorization: "bearer",
        },
        accepted: () => true,
      },
      current: () => true,
      signal: new AbortController().signal,
    });
    try {
      const card = service.view("window", "thread").requests[0];
      if (card === undefined) throw new Error("No private credential card");
      expect(card.destination).toBe(
        "https://management.azure.com/subscriptions?api-version=2022-12-01",
      );
      await service.answer("window", {
        id: card.id,
        action: "allow",
        secret: "short-lived-fixture-token",
      });
      expect(await pending).toEqual({ status: "used" });
      const request = fetch.mock.calls[0]?.[0];
      expect(request?.method).toBe("GET");
      expect(request?.redirect).toBe("error");
      expect(request?.headers.get("authorization")).toBe("Bearer short-lived-fixture-token");
      expect(request?.body).toBeNull();
      expect(JSON.stringify(service.view("window", "thread"))).not.toContain(
        "short-lived-fixture-token",
      );
    } finally {
      service.close();
    }
  });
});
