import { decodeWindowId } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { CURATED_SCAFFOLDS, curatedScaffoldTools } from "./scaffold/curatedScaffoldCatalog";
import { createScaffoldRouteHandler } from "./scaffoldRoutes";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const windowId = decodeWindowId("00000000-0000-4000-8000-000000000921");

function route(availableTools: ReadonlyArray<string> = ["bunx"]) {
  const store = new WindowAuthorityStore();
  store.register({ windowId, capability, now: 0 });
  return createScaffoldRouteHandler({
    entries: CURATED_SCAFFOLDS,
    availableTools: async () => availableTools,
    windowAuthorityStore: store,
    now: () => 1,
    clock: () => "2026-08-18T09:00:00.000Z",
  });
}

function request(url: string, headers: Record<string, string> = {}) {
  return new Request(url, { headers: { "x-octant-window-capability": capability, ...headers } });
}

describe("reading the curated scaffolds a host offers", () => {
  it("lists the entries and says which of their tools this machine has", async () => {
    const response = await route()(request("http://127.0.0.1/api/scaffolds"));

    expect(response?.status).toBe(200);
    const body = (await response?.json()) as {
      entries: ReadonlyArray<{ id: string }>;
      availableTools: ReadonlyArray<string>;
    };
    expect(body.entries.map((entry) => entry.id)).toEqual([
      "web-app",
      "cross-platform-app",
      "native-apple-app",
    ]);
    expect(body.availableTools).toEqual(["bunx"]);
    expect(curatedScaffoldTools()).toEqual(["bunx", "swift"]);
  });

  it("refuses a caller without the window's capability", async () => {
    const response = await route()(new Request("http://127.0.0.1/api/scaffolds"));

    expect(response?.status).toBe(401);
  });

  it("refuses a request that did not arrive over loopback", async () => {
    const response = await route()(request("http://octant.example/api/scaffolds"));

    expect(response?.status).toBe(400);
  });

  it("refuses an origin that is not the renderer's", async () => {
    const response = await route()(
      request("http://127.0.0.1/api/scaffolds", { origin: "https://example.test" }),
    );

    expect(response?.status).toBe(400);
  });
});
