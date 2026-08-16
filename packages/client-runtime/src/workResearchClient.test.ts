import { describe, expect, it, vi } from "vitest";
import { decodeProjectId } from "@octant/contracts";
import { createWorkResearchClient, WorkResearchClientFailure } from "./workResearchClient";

const baseUrl = "http://127.0.0.1:7777";
const windowCapability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const projectId = decodeProjectId("00000000-0000-4000-8000-000000000902");

const actor = { kind: "local-user", actorId: "00000000-0000-4000-8000-000000000907" } as const;

const brief = {
  briefId: "00000000-0000-4000-8000-000000000905",
  projectId,
  questions: ["What changed?"],
  sourcePolicy: { allowedKinds: ["file"], maxSources: 4, excerptByteBudget: 1024 },
  notes: [],
  deliverables: ["report"],
  status: "draft",
  createdBy: actor,
  createdAt: "2026-08-15T00:00:00.000Z",
  version: 1,
};

function client(fetch: typeof globalThis.fetch) {
  return createWorkResearchClient({ baseUrl, fetch, windowCapability });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createWorkResearchClient", () => {
  it("refuses a non-loopback base URL", () => {
    expect(() =>
      createWorkResearchClient({
        baseUrl: "http://example.test",
        fetch: globalThis.fetch,
        windowCapability,
      }),
    ).toThrow(WorkResearchClientFailure);
  });

  it("requests briefs for one Project with the window capability", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ briefs: [] }));

    await client(fetch as unknown as typeof globalThis.fetch).listBriefs(projectId);

    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/api/work/research/briefs");
    expect(url).toContain(`projectId=${String(projectId)}`);
    expect((init.headers as Record<string, string>)["x-octant-window-capability"]).toBe(
      windowCapability,
    );
  });

  it("returns an empty list when the host sends no briefs array", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({}));

    const briefs = await client(fetch as unknown as typeof globalThis.fetch).listBriefs(projectId);

    expect(briefs).toEqual([]);
  });

  it("decodes a typed command result", async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({
        kind: "brief-created",
        requestId: "00000000-0000-4000-8000-000000000904",
        brief,
      }),
    );

    const result = await client(fetch as unknown as typeof globalThis.fetch).execute({
      kind: "create-brief",
      requestId: "00000000-0000-4000-8000-000000000904",
      projectId,
      briefId: "00000000-0000-4000-8000-000000000905",
      questions: ["What changed?"],
      sourcePolicy: { allowedKinds: ["file"], maxSources: 4, excerptByteBudget: 1024 },
      deliverables: ["report"],
    } as never);

    expect(result.kind).toBe("brief-created");
  });

  it("surfaces the host message and status on a failure", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(jsonResponse({ message: "Work Project is unavailable." }, 404));

    await expect(
      client(fetch as unknown as typeof globalThis.fetch).listBriefs(projectId),
    ).rejects.toMatchObject({ status: 404, message: "Work Project is unavailable." });
  });

  it("reports a transport failure as unavailable rather than a protocol error", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("offline"));

    await expect(
      client(fetch as unknown as typeof globalThis.fetch).listBriefs(projectId),
    ).rejects.toMatchObject({ status: 0 });
  });
});
