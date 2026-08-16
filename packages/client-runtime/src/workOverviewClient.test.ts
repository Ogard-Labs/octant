import { describe, expect, it, vi } from "vitest";
import { decodeProjectId } from "@octant/contracts";
import { createWorkOverviewClient, WorkOverviewClientFailure } from "./workOverviewClient";

const projectId = decodeProjectId("20000000-0000-4000-8000-000000000001");

describe("createWorkOverviewClient", () => {
  it("loads a composed overview projection from the authenticated route", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          projectId,
          filesAndArtifacts: [{ id: "a1", label: "Brief.docx", detail: "DOCX" }],
          workflowsAndThreads: [],
          approvals: [],
          versions: [],
          validation: [],
          exports: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createWorkOverviewClient({
      baseUrl: "http://127.0.0.1:4317",
      fetch,
      windowCapability: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });

    const projection = await client.load(projectId);
    expect(projection.filesAndArtifacts[0]?.label).toBe("Brief.docx");
    expect(fetch).toHaveBeenCalledWith(
      `http://127.0.0.1:4317/api/work/overview?projectId=${projectId}`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("maps unauthorized failures", async () => {
    const client = createWorkOverviewClient({
      baseUrl: "http://127.0.0.1:4317",
      fetch: vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ message: "unauthorized" }), { status: 401 }),
        ),
      windowCapability: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    await expect(client.load(projectId)).rejects.toBeInstanceOf(WorkOverviewClientFailure);
  });

  it("survives Electron replacing globalThis.fetch after client construction", async () => {
    const original = globalThis.fetch;
    const stale = vi.fn().mockRejectedValue(new TypeError("stale realm fetch"));
    const live = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          projectId,
          filesAndArtifacts: [],
          workflowsAndThreads: [],
          approvals: [],
          versions: [],
          validation: [],
          exports: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    globalThis.fetch = stale;
    const client = createWorkOverviewClient({
      baseUrl: "http://127.0.0.1:4317",
      fetch: globalThis.fetch,
      windowCapability: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    globalThis.fetch = live;

    const projection = await client.load(projectId);
    expect(projection.filesAndArtifacts).toEqual([]);
    expect(live).toHaveBeenCalled();
    expect(stale).not.toHaveBeenCalled();
    globalThis.fetch = original;
  });
});
