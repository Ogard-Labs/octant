import { describe, expect, it } from "vitest";
import { browserPageTransport, createBrowserGuestStore } from "./browserHubGuest";

const PAGE = "https://hub.tail1234.ts.net:8443";

describe("a browser's way of reaching a host", () => {
  it("reaches only the origin that served the page, under the platform's certificate check", () => {
    const transport = browserPageTransport(PAGE);

    expect(transport({ origin: PAGE, trust: { current: { kind: "platform" } } }).status).toBe(
      "available",
    );
    expect(
      transport({
        origin: "https://100.101.102.104:8443",
        trust: { current: { kind: "platform" } },
      }).status,
    ).toBe("unavailable");
  });

  it("will not send a request that asks for a pin it cannot check", () => {
    const transport = browserPageTransport(PAGE);

    expect(
      transport({ origin: PAGE, trust: { current: { kind: "pinned", pin: "sha256-AAAA" } } })
        .status,
    ).toBe("unavailable");
  });
});

describe("what a browser keeps about its hub", () => {
  it("does not use a stored hub that cannot be trusted", async () => {
    const held = new Map<string, string>([["octant.web.guest-hub.v1", '{"record":{"roster":1}}']]);
    const store = createBrowserGuestStore({
      getItem: async (key) => held.get(key) ?? null,
      setItem: async (key, value) => void held.set(key, value),
      deleteItem: async (key) => void held.delete(key),
    });

    expect(await store.load()).toBeUndefined();
  });
});
