import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRemoteDevicePrincipal } from "./clientPrincipal";
import { Journal } from "./persistence/journal";
import { applyMigrations, MIGRATIONS } from "./persistence/migrations";
import { createPhase1RuntimeRegistries } from "./persistence/runtimeRegistry";
import { openSqlite } from "./persistence/sqlitePort";
import { bindPrincipalRouteContext } from "./principalRouteContext";
import { createSupportBundleRouteHandler } from "./supportBundleRoutes";
import { WindowAuthorityStore } from "./windowAuthorityStore";

const NOW = "2026-10-31T10:00:00.000Z";
const nowMs = new Date(NOW).getTime();
const windowId = "70000000-0000-4000-8000-000000000001";
const capability = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0";

const directories: Array<string> = [];
afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "octant-support-bundle-routes-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => NOW);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => NOW,
  });
  const windowAuthorityStore = new WindowAuthorityStore();
  windowAuthorityStore.register({ windowId: windowId as never, capability, now: nowMs });
  let built = 0;
  const handler = createSupportBundleRouteHandler({
    windowAuthorityStore,
    now: () => nowMs,
    sources: () => {
      built += 1;
      return {
        connection,
        journal,
        octantVersion: "0.9.0-test",
        clock: () => NOW,
        providers: () => ({ instances: [], observed: [] }),
        codeSettings: () => undefined,
        codeThreadPolicies: () => [],
        platformCapabilities: [],
        hostDiagnostics: () => ({
          identity: { hostId: "h", instanceId: "i", endpoint: "e", serviceMode: "foreground" },
          version: { server: "0.9.0-test", wire: "1" },
          store: { state: "ready", integrity: "ok" },
          replay: { journalHead: 0, projections: 0 },
          clients: { connected: 1 },
          capabilities: [],
          work: { active: 0, attentionRequired: false },
        }),
        hostHealth: () => ({
          slowStatementCount: 0,
          slowStatementWorstMs: 0,
          eventLoopLagCount: 0,
          eventLoopLagWorstMs: 0,
        }),
      };
    },
  });
  return { handler, connection, builds: () => built };
}

function call(
  path: string,
  options: { method?: string; body?: unknown; capability?: string; hostname?: string } = {},
): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.capability !== undefined) {
    headers["x-octant-window-capability"] = options.capability;
  }
  return new Request(`http://${options.hostname ?? "127.0.0.1"}:3100${path}`, {
    method: options.method ?? "POST",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

describe("support bundle routes", () => {
  it("ignores paths that are not the bundle's", async () => {
    expect(await setup().handler(call("/api/other"))).toBeUndefined();
  });

  it("answers a preflight with an empty 204 that names the allowed headers", async () => {
    const { handler, builds } = setup();
    const request = new Request("http://127.0.0.1:3100/api/diagnostics/bundle", {
      method: "OPTIONS",
      headers: { origin: "http://localhost:5173" },
    });
    const response = await handler(request);
    expect(response?.status).toBe(204);
    expect(await response!.text()).toBe("");
    expect(response!.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
    expect(response!.headers.get("access-control-allow-headers")).toContain(
      "x-octant-window-capability",
    );
    expect(builds()).toBe(0);
  });

  it("lists what a bundle holds for a local window, without recording anything", async () => {
    const { handler, connection } = setup();
    const response = await handler(
      call("/api/diagnostics/bundle/preview", { method: "GET", capability }),
    );
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as { sections: Array<{ id: string }> };
    expect(body.sections.map((section) => section.id)).toContain("host-log");
    const rows = connection.prepare("SELECT count(*) AS n FROM event_journal").get() as {
      n: number;
    };
    expect(rows.n).toBe(0);
  });

  it("hands a local window the bundle files and journals the category", async () => {
    const { handler, connection } = setup();
    const response = await handler(
      call("/api/diagnostics/bundle", { capability, body: { destinationCategory: "desktop" } }),
    );
    expect(response?.status).toBe(200);
    const body = (await response!.json()) as { kind: string; files: Array<{ path: string }> };
    expect(body.kind).toBe("exported");
    expect(body.files.map((file) => file.path)).toContain("readme.txt");
    const row = connection
      .prepare("SELECT payload_json AS payload FROM event_journal WHERE event_name = ?")
      .get("diagnostics.support-bundle-exported@1") as { payload: string };
    expect(JSON.parse(row.payload).receipt.destinationCategory).toBe("desktop");
  });

  it("refuses a destination that is a path rather than a category", async () => {
    const { handler, builds } = setup();
    const response = await handler(
      call("/api/diagnostics/bundle", {
        capability,
        body: { destinationCategory: "/Users/ada/Desktop" },
      }),
    );
    expect(response?.status).toBe(400);
    expect(builds()).toBe(0);
  });

  it("refuses a paired device even on loopback", async () => {
    const { handler, builds } = setup();
    const request = call("/api/diagnostics/bundle/preview", { method: "GET" });
    bindPrincipalRouteContext(request, {
      principal: createRemoteDevicePrincipal({
        hostId: "11111111-1111-4111-8111-111111111111" as never,
        deviceId: "22222222-2222-4222-8222-222222222222" as never,
        credentialGeneration: 1,
        origin: "https://octant.example",
        protocolVersion: 1,
        capabilityDigest: "b".repeat(64),
        sessionId: "33333333-3333-4333-8333-333333333333" as never,
      }),
      scopeId: windowId as never,
    });
    expect((await handler(request))?.status).toBe(403);
    expect(builds()).toBe(0);
  });

  it("refuses a request that is not loopback, has no capability, or has the wrong method", async () => {
    const { handler, builds } = setup();
    expect(
      (
        await handler(
          call("/api/diagnostics/bundle/preview", {
            method: "GET",
            capability,
            hostname: "octant.example.com",
          }),
        )
      )?.status,
    ).toBe(400);
    expect(
      (await handler(call("/api/diagnostics/bundle/preview", { method: "GET" })))?.status,
    ).toBe(401);
    expect(
      (await handler(call("/api/diagnostics/bundle", { method: "GET", capability })))?.status,
    ).toBe(405);
    expect(builds()).toBe(0);
  });
});
