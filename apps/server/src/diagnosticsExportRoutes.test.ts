import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyMigrations, MIGRATIONS } from "./persistence/migrations";
import { openSqlite } from "./persistence/sqlitePort";
import { Journal } from "./persistence/journal";
import { createPhase1RuntimeRegistries } from "./persistence/runtimeRegistry";
import { WindowAuthorityStore } from "./windowAuthorityStore";
import { createRemoteDevicePrincipal } from "./clientPrincipal";
import { createDiagnosticsExportRouteHandler } from "./diagnosticsExportRoutes";
import * as diagnosticsExportService from "./diagnosticsExportService";
import { bindPrincipalRouteContext } from "./principalRouteContext";

const directories: Array<string> = [];
const now = "2026-08-10T12:00:00.000Z";
const nowMs = new Date(now).getTime();
const windowId = "70000000-0000-4000-8000-000000000001";
const failureCorrelationId = "00000000-0000-4000-8000-000000000001";
const capability = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0";

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "octant-diagnostics-routes-"));
  directories.push(directory);
  const connection = openSqlite(join(directory, "octant.sqlite3"));
  applyMigrations(connection, MIGRATIONS, () => now);
  const runtime = createPhase1RuntimeRegistries();
  const journal = new Journal({
    connection,
    registry: runtime.events,
    projections: runtime.projections,
    clock: () => now,
  });
  diagnosticsExportService.recordDiagnosticsFailureIncident(
    {
      correlationId: failureCorrelationId as never,
      domain: "provider",
      failureCode: "provider-failed" as never,
      observedAt: now,
    },
    { journal, eventIdGenerator: () => "00000000-0000-4000-8000-0000000000fe" },
  );

  const windowAuthorityStore = new WindowAuthorityStore();
  windowAuthorityStore.register({ windowId: windowId as never, capability, now: nowMs });

  const handler = createDiagnosticsExportRouteHandler({
    connection,
    journal,
    windowAuthorityStore,
    now: () => nowMs,
    clock: () => now,
  });

  return { connection, handler };
}

function makeRequest(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    capability?: string;
    hostname?: string;
  } = {},
): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.capability !== undefined) {
    headers["x-octant-window-capability"] = options.capability;
  }
  const host = options.hostname ?? "127.0.0.1";
  return new Request(`http://${host}:3100${path}`, {
    method: options.method ?? "POST",
    headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
}

describe("diagnostics export routes", () => {
  it("returns undefined for non-diagnostics paths", async () => {
    const { handler } = setup();
    const response = await handler(makeRequest("/api/other"));
    expect(response).toBeUndefined();
  });

  it("exports a sealed packet and a receipt for an authenticated local window", async () => {
    const { handler } = setup();
    const response = await handler(
      makeRequest("/api/diagnostics/export", {
        capability,
        body: {
          correlationId: failureCorrelationId,
          domain: "provider",
          summary: "Provider request timed out after two retries.",
        },
      }),
    );
    expect(response).toBeDefined();
    expect(response!.status).toBe(200);
    const body = (await response!.json()) as { kind: string; packet?: { redacted: boolean } };
    expect(body.kind).toBe("exported");
    expect(body.packet?.redacted).toBe(true);
  });

  it("fails closed for a bound remote principal even on loopback", async () => {
    const { handler } = setup();
    const exportSpy = vi.spyOn(diagnosticsExportService, "exportDiagnosticsEvidence");
    const request = makeRequest("/api/diagnostics/export", {
      body: { correlationId: failureCorrelationId, domain: "provider", summary: "x" },
    });
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
    const response = await handler(request);
    expect(response?.status).toBe(403);
    expect(exportSpy).not.toHaveBeenCalled();
  });

  it("fails closed for a request that is not loopback (remote)", async () => {
    const { handler } = setup();
    const request = makeRequest("/api/diagnostics/export", {
      capability,
      body: { correlationId: failureCorrelationId, domain: "provider", summary: "x" },
      hostname: "evil.example.com",
    });
    const exportSpy = vi.spyOn(diagnosticsExportService, "exportDiagnosticsEvidence");
    const response = await handler(request);
    expect(response).toBeDefined();
    expect(response!.status).toBe(400);
    expect(exportSpy).not.toHaveBeenCalled();
  });

  it("fails closed for a request with no window capability (provider/automation-shaped caller)", async () => {
    const { handler } = setup();
    const exportSpy = vi.spyOn(diagnosticsExportService, "exportDiagnosticsEvidence");
    const response = await handler(
      makeRequest("/api/diagnostics/export", {
        body: { correlationId: failureCorrelationId, domain: "provider", summary: "x" },
      }),
    );
    expect(response).toBeDefined();
    expect(response!.status).toBe(401);
    expect(exportSpy).not.toHaveBeenCalled();
  });

  it("fails closed for a request with an unrecognized window capability (automation-shaped caller)", async () => {
    const { handler } = setup();
    const exportSpy = vi.spyOn(diagnosticsExportService, "exportDiagnosticsEvidence");
    const response = await handler(
      makeRequest("/api/diagnostics/export", {
        capability: "bad-token",
        body: { correlationId: failureCorrelationId, domain: "provider", summary: "x" },
      }),
    );
    expect(response).toBeDefined();
    expect(response!.status).toBe(401);
    expect(exportSpy).not.toHaveBeenCalled();
  });

  it("fails closed for a disallowed renderer origin (extension-shaped caller)", async () => {
    const { handler } = setup();
    const exportSpy = vi.spyOn(diagnosticsExportService, "exportDiagnosticsEvidence");
    const request = new Request("http://127.0.0.1:3100/api/diagnostics/export", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-octant-window-capability": capability,
        origin: "https://extension.example",
      },
      body: JSON.stringify({
        correlationId: failureCorrelationId,
        domain: "provider",
        summary: "x",
      }),
    });
    const response = await handler(request);
    expect(response).toBeDefined();
    expect(response!.status).toBe(400);
    expect(exportSpy).not.toHaveBeenCalled();
  });

  it("rejects non-POST methods", async () => {
    const { handler } = setup();
    const response = await handler(
      makeRequest("/api/diagnostics/export", { method: "GET", capability }),
    );
    expect(response).toBeDefined();
    expect(response!.status).toBe(405);
  });

  it("handles OPTIONS preflight", async () => {
    const { handler } = setup();
    const response = await handler(
      makeRequest("/api/diagnostics/export", { method: "OPTIONS", capability }),
    );
    expect(response).toBeDefined();
    expect(response!.status).toBe(204);
  });

  it("rejects an invalid request body", async () => {
    const { handler } = setup();
    const response = await handler(
      makeRequest("/api/diagnostics/export", {
        capability,
        body: { correlationId: failureCorrelationId, domain: "not-a-domain", summary: "x" },
      }),
    );
    expect(response).toBeDefined();
    expect(response!.status).toBe(400);
  });

  it("returns a typed failure without a packet when the domain policy rejects the input", async () => {
    const { handler } = setup();
    const response = await handler(
      makeRequest("/api/diagnostics/export", {
        capability,
        body: {
          correlationId: failureCorrelationId,
          domain: "provider",
          summary: "line one\nline two",
        },
      }),
    );
    expect(response).toBeDefined();
    expect(response!.status).toBe(422);
    const body = (await response!.json()) as { kind: string; packet?: unknown };
    expect(body.kind).toBe("failed");
    expect(body.packet).toBeUndefined();
  });
});
