import { THREAD_EXPORT_FORMAT } from "@octant/contracts/thread-export";
import { describe, expect, it, vi } from "vitest";
import { createThreadExportClient, ThreadExportClientError } from "./threadExportClient";

const threadId = "00000000-0000-4000-8000-000000000901";
const exportedBody = {
  kind: "exported",
  bundle: {
    octant: {
      format: THREAD_EXPORT_FORMAT,
      threadId,
      mode: "chat",
      title: "Launch plan",
      hostId: "local",
      version: 1,
      sequence: 1,
      generatedAt: "2026-08-19T12:00:00.000Z",
    },
    transcript: { entries: [], activeCount: 0, revisedCount: 0 },
    evidence: { artifacts: [], attachments: [], citations: [] },
    provenance: {
      mode: "chat",
      threadId,
      hostId: "local",
      providerInstanceId: "10000000-0000-4000-8000-000000000001",
      modelId: "model-a",
      createdAt: "2026-08-19T12:00:00.000Z",
      updatedAt: "2026-08-19T12:00:00.000Z",
    },
    omissions: [],
  },
};

function fetchReturning(status: number, body: unknown) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      }),
  );
}

describe("createThreadExportClient", () => {
  it("posts the request with the window capability and decodes the cut", async () => {
    const fetchImpl = fetchReturning(200, exportedBody);
    const client = createThreadExportClient({
      baseUrl: "http://127.0.0.1:4100",
      fetch: fetchImpl,
      windowCapability: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0",
    });

    const outcome = await client.exportThread({ mode: "chat", threadId });
    expect(outcome.kind).toBe("exported");
    const call = fetchImpl.mock.calls[0] as unknown as [string, RequestInit] | undefined;
    expect(call?.[0]).toContain("/api/threads/export");
    expect((call?.[1].headers as Record<string, string>)["x-octant-window-capability"]).toBe(
      "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0",
    );
  });

  it("decodes a closed refusal without throwing", async () => {
    const client = createThreadExportClient({
      baseUrl: "http://127.0.0.1:4100",
      fetch: fetchReturning(404, { kind: "refused", reason: "not-found" }),
      windowCapability: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0",
    });
    await expect(client.exportThread({ mode: "chat", threadId })).resolves.toEqual({
      kind: "refused",
      reason: "not-found",
    });
  });

  it("fails closed when the host is unreachable", async () => {
    const client = createThreadExportClient({
      baseUrl: "http://127.0.0.1:4100",
      fetch: vi.fn(async () => {
        throw new Error("offline");
      }),
      windowCapability: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0",
    });
    await expect(client.exportThread({ mode: "chat", threadId })).rejects.toBeInstanceOf(
      ThreadExportClientError,
    );
  });
});
