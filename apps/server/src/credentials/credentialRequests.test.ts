import { describe, expect, it, vi } from "vitest";
import { CredentialRequests } from "./credentialRequests";
import type { CredentialRequestReference } from "@octant/contracts/credential-request";
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
function setup(
  resolveLinked?: NonNullable<ConstructorParameters<typeof CredentialRequests>[0]>["resolveLinked"],
) {
  let now = 0;
  let current = true;
  const fetch = vi.fn(async (_request: Request) => new Response('{"ok":true}'));
  const service = new CredentialRequests({
    fetch,
    now: () => now,
    ...(resolveLinked === undefined ? {} : { resolveLinked }),
  });
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

it("resolves only the submitted linked reference and uses it once", async () => {
  const resolve = vi.fn(async (_reference: CredentialRequestReference) => ({
    status: "read" as const,
    value: "linked-token",
  }));
  const h = setup(resolve);
  await h.service.answer("window", {
    id: h.id,
    action: "allow-linked",
    store: "onepassword",
    reference: "op://Private/Linear/credential",
  });
  expect(resolve).toHaveBeenCalledTimes(1);
  expect(resolve.mock.calls[0]?.[0]).toEqual({
    store: "onepassword",
    reference: "op://Private/Linear/credential",
  });
  expect(h.fetch.mock.calls[0]?.[0].headers.get("authorization")).toBe("Bearer linked-token");
  expect(await h.pending).toEqual({ status: "used" });
  expect(JSON.stringify(h.service.view("window", "thread"))).not.toContain("linked-token");
  h.service.close();
});
it.each(["abort", "revoke", "expire", "close"] as const)(
  "refuses late linked resolution after %s",
  async (cause) => {
    const resolved = Promise.withResolvers<{ status: "read"; value: string }>();
    const h = setup(() => resolved.promise);
    const first = h.service.answer("window", {
      id: h.id,
      action: "allow-linked",
      store: "onepassword",
      reference: "op://Private/Linear/credential",
    });
    expect(await h.service.answer("window", { id: h.id, action: "allow", secret: "second" })).toBe(
      false,
    );
    if (cause === "abort") h.abort.abort();
    if (cause === "revoke") h.revoke();
    if (cause === "expire") h.expire();
    if (cause === "close") h.service.close();
    resolved.resolve({ status: "read", value: "late-token" });
    await first;
    expect(h.fetch).not.toHaveBeenCalled();
    expect((await h.pending).status).not.toBe("used");
    h.service.close();
  },
);
it.each([
  "locked",
  "missing",
  "not-linked",
  "changed",
  "unavailable",
  "invalid-reference",
] as const)("explains %s without falling back to another credential", async (status) => {
  const h = setup(async () => ({ status }));
  await h.service.answer("window", {
    id: h.id,
    action: "allow-linked",
    store: "onepassword",
    reference: "op://Private/Linear/credential",
  });
  expect(await h.pending).toEqual({ status: "failed" });
  expect(h.service.view("window", "thread").requests[0]?.failure).toBe(status);
  expect(h.fetch).not.toHaveBeenCalled();
  h.service.close();
});
