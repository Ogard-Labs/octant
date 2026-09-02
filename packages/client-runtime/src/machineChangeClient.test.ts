import { describe, expect, it, vi } from "vitest";
import { createMachineChangeClient } from "./machineChangeClient";

describe("MachineChangeClient", () => {
  it("reads cursor-ordered invalidations from one shared stream", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          `${JSON.stringify({
            kind: "changed",
            sequence: 5,
            topics: ["work-navigation", "code-navigation"],
          })}\n`,
          { headers: { "content-type": "application/x-ndjson" } },
        ),
    );
    const client = createMachineChangeClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: fetch as typeof globalThis.fetch,
      windowCapability: "capability",
    });
    const controller = new AbortController();
    const stream = client.subscribe(4, controller.signal);

    await expect(stream.next()).resolves.toMatchObject({
      value: { kind: "changed", sequence: 5, topics: ["work-navigation", "code-navigation"] },
    });
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:13773/api/machine/changes?afterSequence=4",
      expect.objectContaining({ method: "GET", signal: controller.signal }),
    );
  });

  it("accepts a restart snapshot marker below the previous process cursor", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(`${JSON.stringify({ kind: "snapshot-required", sequence: 0 })}\n`, {
          headers: { "content-type": "application/x-ndjson" },
        }),
    );
    const client = createMachineChangeClient({
      baseUrl: "http://127.0.0.1:13773",
      fetch: fetch as typeof globalThis.fetch,
      windowCapability: "capability",
    });

    const stream = client.subscribe(42, new AbortController().signal);

    await expect(stream.next()).resolves.toMatchObject({
      value: { kind: "snapshot-required", sequence: 0 },
    });
  });
});
