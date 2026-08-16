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

    expect(second).toHaveBeenCalledWith("http://127.0.0.1/overview", undefined);
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
});
