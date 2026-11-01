import { describe, expect, it } from "vitest";
import {
  browserOwnerMergeUnlock,
  browserPageTransport,
  createBrowserGuestStore,
} from "./browserHubGuest";

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

  it("also reaches the web app origins the hub's roster names, and still no other origin", () => {
    const studio = "https://studio.tail1234.ts.net";
    const transport = browserPageTransport(PAGE, [studio]);

    expect(transport({ origin: studio, trust: { current: { kind: "platform" } } }).status).toBe(
      "available",
    );
    expect(
      transport({ origin: studio, trust: { current: { kind: "pinned", pin: "sha256-AAAA" } } })
        .status,
    ).toBe("unavailable");
    expect(
      transport({
        origin: "https://elsewhere.tail1234.ts.net",
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

describe("a browser's unlock for a merge its page's host asks for", () => {
  it("does not ask for a passkey when the browser never joined a hub as an owner", async () => {
    let asked = 0;
    const unlock = browserOwnerMergeUnlock({
      store: { load: async () => undefined },
      deviceKeyStore: {} as never,
      credentials: async () => {
        asked += 1;
        return undefined;
      },
      pageOrigin: PAGE,
    });

    expect(
      await unlock({
        hostMemberId: "11111111-1111-4111-8111-111111111111",
        path: "/api/code/project-pull-requests/merge",
        body: "{}",
      }),
    ).toEqual({ status: "no-owner-device" });
    expect(asked).toBe(0);
  });
});
