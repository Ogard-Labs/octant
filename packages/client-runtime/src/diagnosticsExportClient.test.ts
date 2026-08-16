import { describe, expect, it, vi } from "vitest";
import type { CorrelationId } from "@octant/contracts";
import {
  createDiagnosticsExportClient,
  DiagnosticsExportClientError,
} from "./diagnosticsExportClient";

const exportedBody = {
  kind: "exported",
  packet: {
    packetVersion: 1,
    packetId: "00000000-0000-4000-8000-0000000000aa",
    domain: "provider",
    failureCode: "provider-support-export",
    summary: "Provider request timed out.",
    hostVersions: [{ component: "runtime", version: "v22.1.0" }],
    candidateVersions: [{ component: "runtime", version: "v22.1.0" }],
    correlations: [
      {
        correlationId: "00000000-0000-4000-8000-000000000001",
        observedAt: "2026-08-10T12:00:00.000Z",
      },
    ],
    recovery: [
      { action: "Verify provider credentials and network connectivity.", automated: false },
    ],
    redactions: [],
    redacted: true,
    generatedAt: "2026-08-10T12:00:00.000Z",
  },
  receipt: {
    packetId: "00000000-0000-4000-8000-0000000000aa",
    domain: "provider",
    failureCode: "provider-support-export",
    redactions: [],
    contentDigest: "a".repeat(64),
    generatedAt: "2026-08-10T12:00:00.000Z",
    createdAt: "2026-08-10T12:00:01.000Z",
  },
};
const failureCorrelationId = "00000000-0000-4000-8000-000000000001" as CorrelationId;

function fetchReturning(status: number, body: unknown) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

describe("createDiagnosticsExportClient", () => {
  it("posts the request with the window capability header and decodes an exported outcome", async () => {
    const fetchImpl = fetchReturning(200, exportedBody);
    const client = createDiagnosticsExportClient({
      baseUrl: "http://127.0.0.1:4100",
      fetch: fetchImpl,
      windowCapability: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0",
    });

    const outcome = await client.exportEvidence({
      correlationId: failureCorrelationId,
      domain: "provider",
      summary: "Provider request timed out.",
    });

    expect(outcome.kind).toBe("exported");
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit] | undefined;
    expect(call).toBeDefined();
    const init = (call as [string, RequestInit])[1];
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-octant-window-capability"]).toBe(
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0",
    );
  });

  it("decodes a failed outcome without throwing", async () => {
    const fetchImpl = fetchReturning(422, {
      kind: "failed",
      failure: { category: "incomplete", message: "A diagnostic summary is required." },
    });
    const client = createDiagnosticsExportClient({
      baseUrl: "http://127.0.0.1:4100",
      fetch: fetchImpl,
      windowCapability: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0",
    });

    const outcome = await client.exportEvidence({
      correlationId: failureCorrelationId,
      domain: "provider",
      summary: "x",
    });
    expect(outcome.kind).toBe("failed");
  });

  it("throws a client error for an unauthorized response instead of decoding a body", async () => {
    const fetchImpl = fetchReturning(401, { error: "unauthorized" });
    const client = createDiagnosticsExportClient({
      baseUrl: "http://127.0.0.1:4100",
      fetch: fetchImpl,
      windowCapability: "bad",
    });

    await expect(
      client.exportEvidence({
        correlationId: failureCorrelationId,
        domain: "provider",
        summary: "x",
      }),
    ).rejects.toBeInstanceOf(DiagnosticsExportClientError);
  });

  it("throws a client error when the transport itself fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const client = createDiagnosticsExportClient({
      baseUrl: "http://127.0.0.1:4100",
      fetch: fetchImpl,
      windowCapability: "token",
    });

    await expect(
      client.exportEvidence({
        correlationId: failureCorrelationId,
        domain: "provider",
        summary: "x",
      }),
    ).rejects.toBeInstanceOf(DiagnosticsExportClientError);
  });
});
