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
});
