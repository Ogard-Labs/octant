import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { ProviderLocalUsageHistorySource } from "@octant/provider-sdk";
import { createLocalUsageHistoryRouteHandler } from "./localUsageHistoryRoutes";
import { createRemoteDevicePrincipal } from "./clientPrincipal";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import { createCodexLocalUsageHistorySource } from "./providers/codexUsageHistory";
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
          hasMore: false,
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
          origin: "null",
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

  it("continues a bounded Codex scan across fresh route source instances", async () => {
    const root = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "octant-route-resume-"));
    const metadata = JSON.stringify({
      type: "session_meta",
      payload: { id: "route-session", base_instructions: { provenance: { model: "gpt-5.6-sol" } } },
    });
    const usage = JSON.stringify({
      timestamp: "2026-09-09T12:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        thread_id: "route-session",
        info: {
          total_token_usage: { input_tokens: 20, output_tokens: 3 },
          last_token_usage: {
            input_tokens: 10,
            cached_input_tokens: 2,
            cache_write_input_tokens: 0,
            output_tokens: 3,
          },
        },
      },
    });
    await writeFile(join(root, "rollout.jsonl"), `${metadata}\n${usage}\n`);
    const store = new WindowAuthorityStore();
    store.register({ windowId, capability, now: Date.now() });
    const handler = createLocalUsageHistoryRouteHandler({
      windowAuthorityStore: store,
      sources: () => [
        createCodexLocalUsageHistorySource({
          root,
          maxFileBytes: Buffer.byteLength(`${metadata}\n`),
        }),
      ],
    });
    const body = JSON.stringify({
      from: "2026-09-01T00:00:00.000Z",
      to: "2026-09-09T23:59:59.999Z",
      timeZone: "UTC",
    });
    const request = () =>
      new Request("http://127.0.0.1/api/usage/local-history", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": capability },
        body,
      });
    const [first, parallel] = await Promise.all([handler(request()), handler(request())]);
    expect(first?.status).toBe(200);
    expect(parallel?.status).toBe(200);
    expect((await first?.json()).coverage).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "partial", hasMore: true })]),
    );
    expect((await parallel?.json()).coverage).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "partial" })]),
    );
    const second = await handler(request());
    expect(second?.status).toBe(200);
    expect(await second?.json()).toMatchObject({
      totals: { requestCount: 1, inputTokens: 10 },
      models: [expect.objectContaining({ key: "codex/gpt-5.6-sol" })],
      coverage: [expect.objectContaining({ status: "ready", hasMore: false })],
    });
  });

  it("refuses a bound remote principal even when the URL is loopback", async () => {
    const handler = createLocalUsageHistoryRouteHandler({
      windowAuthorityStore: new WindowAuthorityStore(),
      sources: [source()],
    });
    const request = new Request("http://127.0.0.1/api/usage/local-history", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        from: "2026-09-01T00:00:00.000Z",
        to: "2026-09-09T23:59:59.999Z",
        timeZone: "UTC",
      }),
    });
    const principal = createRemoteDevicePrincipal({
      hostId: "host-remote" as never,
      deviceId: "device-remote" as never,
      credentialGeneration: 1,
      origin: "http://127.0.0.1",
      protocolVersion: 1,
      capabilityDigest: "a".repeat(64),
      sessionId: "session-remote" as never,
    });
    bindPrincipalRouteContext(request, {
      principal,
      scopeId: "10000000-0000-4000-8000-000000000002" as never,
    });
    const response = await handler(request);
    expect(response?.status).toBe(403);
  });

  it("rejects inverted ranges and invalid timezones before reading files", async () => {
    const store = new WindowAuthorityStore();
    store.register({ windowId, capability, now: Date.now() });
    let sourceCalls = 0;
    const handler = createLocalUsageHistoryRouteHandler({
      windowAuthorityStore: store,
      sources: () => {
        sourceCalls += 1;
        return [source()];
      },
    });
    const request = (body: string) =>
      new Request("http://127.0.0.1/api/usage/local-history", {
        method: "POST",
        headers: { "content-type": "application/json", "x-octant-window-capability": capability },
        body,
      });
    const inverted = await handler(
      request(
        JSON.stringify({
          from: "2026-09-10T00:00:00.000Z",
          to: "2026-09-09T00:00:00.000Z",
          timeZone: "UTC",
        }),
      ),
    );
    const invalidTimezone = await handler(
      request(
        JSON.stringify({
          from: "2026-09-01T00:00:00.000Z",
          to: "2026-09-09T00:00:00.000Z",
          timeZone: "Not/AZone",
        }),
      ),
    );
    expect(inverted?.status).toBe(400);
    expect(invalidTimezone?.status).toBe(400);
    expect(sourceCalls).toBe(0);
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
