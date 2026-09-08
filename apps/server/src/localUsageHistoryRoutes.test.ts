import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { ProviderLocalUsageHistorySource } from "@octant/provider-sdk";
import { createLocalUsageHistoryRouteHandler } from "./localUsageHistoryRoutes";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const windowId = "10000000-0000-4000-8000-000000000001" as never;
const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function source(): ProviderLocalUsageHistorySource {
  return {
    sourceKind: "codex",
    read: () =>
      Effect.succeed({
        records: [],
        coverage: {
          sourceKind: "codex",
          sourceInstallationId: "install-1",
          status: "ready",
          scannedFileCount: 0,
          acceptedRecordCount: 0,
          omittedRecordCount: 0,
          truncated: false,
          detail: "synthetic",
        },
      } as never),
  };
}

describe("local provider usage history route", () => {
  it("serves bounded local aggregates only with a live window capability", async () => {
    const store = new WindowAuthorityStore();
    store.register({ windowId, capability, now: Date.now() });
    const handler = createLocalUsageHistoryRouteHandler({
      windowAuthorityStore: store,
      sources: [source()],
      clock: () => "2026-09-09T12:00:00.000Z",
    });
    const response = await handler(
      new Request("http://127.0.0.1/api/usage/local-history", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-octant-window-capability": capability,
        },
        body: JSON.stringify({
          from: "2026-09-01T00:00:00.000Z",
          to: "2026-09-09T23:59:59.999Z",
          timeZone: "UTC",
        }),
      }),
    );
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      source: "local-provider-history",
      totals: { requestCount: 0, sessionCount: 0, totalTokens: 0 },
      coverage: [{ sourceKind: "codex", status: "ready" }],
    });
  });

  it("does not expose local history without window authority", async () => {
    const handler = createLocalUsageHistoryRouteHandler({
      windowAuthorityStore: new WindowAuthorityStore(),
      sources: [source()],
    });
    const response = await handler(
      new Request("http://127.0.0.1/api/usage/local-history", {
        method: "POST",
        body: JSON.stringify({
          from: "2026-09-01T00:00:00.000Z",
          to: "2026-09-09T23:59:59.999Z",
          timeZone: "UTC",
        }),
      }),
    );
    expect(response?.status).toBe(401);
  });
});
