import { describe, expect, it, vi } from "vitest";
import { decodeContextSubjectRef, decodeTaskAccessSnapshot } from "@octant/contracts";
import { createContextClient } from "./contextClient";
const subject = decodeContextSubjectRef({
  aggregateType: "code-thread",
  aggregateId: "82000000-0000-4000-8000-000000000002",
});
const facts = () =>
  decodeTaskAccessSnapshot({
    kind: "task-access",
    subject,
    observedAt: "2026-11-02T21:00:00.000Z",
    standing: "active",
    selectedMode: "auto",
    effectiveContext: "unknown",
    default: { status: "unknown" },
    reviewer: { kind: "unknown", availability: "unknown" },
    runtime: {
      accountId: "82000000-0000-4000-8000-000000000010",
      modelId: "model",
      capabilities: [],
    },
    outsideContent: { read: false, effect: "unknown" },
    limitations: [],
  });
describe("typed task access read", () => {
  it("uses the existing authenticated inspect path with a closed read body and forwards cancellation", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json(facts()));
    const client = createContextClient({
      baseUrl: "http://127.0.0.1",
      windowCapability: "capability",
      fetch,
    });
    const controller = new AbortController();
    expect(await client.taskAccess?.(subject, controller.signal)).toEqual(facts());
    expect(String(fetch.mock.calls[0]?.[0])).toBe("http://127.0.0.1/api/context/inspect");
    const init = fetch.mock.calls[0]?.[1];
    expect(init?.signal).toBe(controller.signal);
    expect(JSON.parse(String(init?.body))).toEqual({ subject, view: "task-access" });
    expect(init?.headers).toMatchObject({ "x-octant-window-capability": "capability" });
  });
  it("rejects a different task and reports an older/unavailable host without making up permissions", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () =>
      Response.json({
        ...facts(),
        subject: { ...subject, aggregateId: "82000000-0000-4000-8000-000000000003" },
      }),
    );
    const client = createContextClient({
      baseUrl: "https://paired.example",
      windowCapability: "capability",
      fetch,
    });
    await expect(client.taskAccess?.(subject)).rejects.toMatchObject({ category: "protocol" });
    fetch.mockImplementation(async () =>
      Response.json(
        { category: "unavailable", message: "Task access facts are unavailable." },
        { status: 503 },
      ),
    );
    await expect(client.taskAccess?.(subject)).rejects.toMatchObject({ category: "unavailable" });
  });
});
