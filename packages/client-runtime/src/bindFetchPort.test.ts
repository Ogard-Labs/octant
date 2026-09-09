import { describe, expect, it, vi } from "vitest";
import { bindFetchPort } from "./bindFetchPort";

describe("bindFetchPort", () => {
  it("re-reads globalThis.fetch on each call when the realm fetch was passed", async () => {
    const original = globalThis.fetch;
    const first = vi.fn().mockResolvedValue(new Response("first"));
    const second = vi.fn().mockResolvedValue(new Response("second"));
    globalThis.fetch = first;
    const port = bindFetchPort(globalThis.fetch);
    globalThis.fetch = second;

    const response = await port("http://127.0.0.1/overview");

    expect(second).toHaveBeenCalledWith("http://127.0.0.1/overview", { redirect: "error" });
    expect(first).not.toHaveBeenCalled();
    expect(await response.text()).toBe("second");
    globalThis.fetch = original;
  });

  it("preserves explicit fetch doubles that are not the realm fetch", async () => {
    const double = vi.fn().mockResolvedValue(new Response("double"));
    const port = bindFetchPort(double);
    await port("http://127.0.0.1/x");
    expect(double).toHaveBeenCalledOnce();
    expect(port).toBe(double);
  });

  it("sets redirect error on the outgoing realm fetch so a later hop cannot carry the window capability", async () => {
    const original = globalThis.fetch;
    const realm = vi.fn().mockResolvedValue(new Response("ok"));
    globalThis.fetch = realm;
    try {
      const port = bindFetchPort(globalThis.fetch);

      await port("https://host.example/api/shell/bootstrap", {
        headers: { "x-octant-window-capability": "secret" },
      });

      expect(realm).toHaveBeenCalledWith(
        "https://host.example/api/shell/bootstrap",
        expect.objectContaining({
          redirect: "error",
          headers: { "x-octant-window-capability": "secret" },
        }),
      );
    } finally {
      globalThis.fetch = original;
    }
  });

  it("does not follow a redirect when the realm fetch would otherwise resend the capability", async () => {
    const original = globalThis.fetch;
    let followedOffLoopback = false;
    globalThis.fetch = vi.fn(async (_input, init) => {
      if (init?.redirect === "error") {
        throw new TypeError("Failed to fetch");
      }
      followedOffLoopback = true;
      return new Response("ok");
    });
    try {
      const port = bindFetchPort(globalThis.fetch);
      await expect(
        port("https://host.example/api/shell/bootstrap", {
          headers: { "x-octant-window-capability": "secret" },
        }),
      ).rejects.toBeInstanceOf(TypeError);
      expect(followedOffLoopback).toBe(false);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("leaves an explicit redirect mode in place on the realm fetch", async () => {
    const original = globalThis.fetch;
    const realm = vi.fn().mockResolvedValue(new Response("ok"));
    globalThis.fetch = realm;
    try {
      const port = bindFetchPort(globalThis.fetch);

      await port("http://127.0.0.1/x", { redirect: "manual" });

      expect(realm).toHaveBeenCalledWith("http://127.0.0.1/x", { redirect: "manual" });
    } finally {
      globalThis.fetch = original;
    }
  });
});
