import { describe, expect, it, vi } from "vitest";
import { createBenchmarksClient, BenchmarksClientError } from "./benchmarksClient";

const baseUrl = "http://127.0.0.1:4310";
const capability = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop0";
const at = "2026-11-07T10:00:00.000Z";
const suite = {
  suiteId: "67000000-0000-4000-8000-000000000001",
  revision: 1,
  name: "Smoke",
  cases: [
    {
      caseId: "67000000-0000-4000-8000-000000000002",
      kind: "prompt",
      title: "Greeting",
      prompt: "Say hello.",
      checks: [],
    },
  ],
  createdAt: at,
  updatedAt: at,
};

describe("benchmarks client", () => {
  it("posts a suite to the save path and decodes the saved suite", async () => {
    const fetch = vi.fn(async () => Response.json({ suite }));
    const client = createBenchmarksClient({ baseUrl, fetch, windowCapability: capability });

    const saved = await client.saveSuite({
      suiteId: suite.suiteId as never,
      name: "Smoke",
      cases: suite.cases as never,
    });

    expect(saved.suite.revision).toBe(1);
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/benchmarks/suites/save`,
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ "x-octant-window-capability": capability }),
      }),
    );
  });

  it("lists suites from the list path", async () => {
    const fetch = vi.fn(async () => Response.json({ suites: [suite] }));
    const client = createBenchmarksClient({ baseUrl, fetch, windowCapability: capability });
    expect((await client.listSuites()).suites).toHaveLength(1);
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/benchmarks/suites/list`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("keeps the host's sentence and status when it refuses", async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        { message: "Contender 1 is not an enabled provider model on this host." },
        { status: 422 },
      ),
    );
    const client = createBenchmarksClient({ baseUrl, fetch, windowCapability: capability });
    const refusal = await client
      .startRun({} as never)
      .then(() => undefined)
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(BenchmarksClientError);
    expect(refusal).toMatchObject({
      status: 422,
      message: "Contender 1 is not an enabled provider model on this host.",
    });
  });

  it("posts stars to the rate path and decodes the stored rating", async () => {
    const ids = {
      runId: "67000000-0000-4000-8000-0000000000a1",
      cellId: "67000000-0000-4000-8000-0000000000a2",
    };
    const fetch = vi.fn(async () =>
      Response.json({ ...ids, rating: { stars: 4, note: "Clear", ratedAt: at } }),
    );
    const client = createBenchmarksClient({ baseUrl, fetch, windowCapability: capability });

    const rated = await client.rateCell({ ...ids, stars: 4, note: "Clear" } as never);

    expect(rated.rating).toEqual({ stars: 4, note: "Clear", ratedAt: at });
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/benchmarks/cells/rate`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ ...ids, stars: 4, note: "Clear" }),
      }),
    );
  });

  it("posts a suite id to the history path and decodes the runs", async () => {
    const history = {
      suiteId: suite.suiteId,
      runs: [
        {
          runId: "67000000-0000-4000-8000-000000000009",
          startedAt: at,
          status: "finished",
          suiteRevision: 1,
          rows: [
            {
              contender: {
                providerInstanceId: "67000000-0000-4000-8000-0000000000b1",
                modelId: "m",
              },
              cells: 2,
              answered: 2,
              checkPassRate: 0.5,
              totalTokens: 10,
              failedCount: 0,
            },
          ],
        },
      ],
    };
    const fetch = vi.fn(async () => Response.json(history));
    const client = createBenchmarksClient({ baseUrl, fetch, windowCapability: capability });

    const read = await client.history({ suiteId: suite.suiteId as never });

    expect(read.runs[0]?.rows[0]?.checkPassRate).toBe(0.5);
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/benchmarks/suites/history`,
      expect.objectContaining({ method: "POST", body: JSON.stringify({ suiteId: suite.suiteId }) }),
    );
  });

  it("posts a run id and format to the export path and returns the file", async () => {
    const file = {
      fileName: "benchmark-smoke-67000000.csv",
      contentType: "text/csv",
      content: "a\r\n",
    };
    const fetch = vi.fn(async () => Response.json(file));
    const client = createBenchmarksClient({ baseUrl, fetch, windowCapability: capability });
    const runId = "67000000-0000-4000-8000-000000000009";

    const exported = await client.exportRun({ runId: runId as never, format: "csv" });

    expect(exported).toEqual(file);
    expect(fetch).toHaveBeenCalledWith(
      `${baseUrl}/api/benchmarks/runs/export`,
      expect.objectContaining({ body: JSON.stringify({ runId, format: "csv" }) }),
    );
  });
});
