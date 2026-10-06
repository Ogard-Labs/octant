import type { PendingRequestList } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { PendingRequestClientFailure, createPendingRequestClient } from "./pendingRequestClient";

const baseUrl = "http://127.0.0.1:13773";
const capability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

const list = {
  requests: [
    {
      mode: "work",
      kind: "approval",
      projectId: "00000000-0000-4000-8000-000000000901",
      threadId: "00000000-0000-4000-8000-000000000902",
      threadTitle: "Quarterly report",
      text: "Run `bun install`.",
      requestedAt: "2026-10-06T08:00:00.000Z",
      answer: { requestId: "00000000-0000-4000-8000-000000000903", expectedVersion: 1 },
    },
  ],
  truncated: false,
} as unknown as PendingRequestList;

describe("createPendingRequestClient", () => {
  it("reads the window's pending requests with its capability", async () => {
    const fetch = vi.fn(async () => Response.json(list));
    const client = createPendingRequestClient({ baseUrl, fetch, windowCapability: capability });
    await expect(client.list()).resolves.toEqual(list);
    expect(fetch).toHaveBeenCalledWith(`${baseUrl}/api/pending-requests`, {
      method: "GET",
      headers: { "x-octant-window-capability": capability },
    });
  });

  it("surfaces the host's refusal as a typed failure", async () => {
    const fetch = vi.fn(async () =>
      Response.json(
        { code: "unauthorized", message: "Pending requests are read at a local window." },
        { status: 403 },
      ),
    );
    const client = createPendingRequestClient({ baseUrl, fetch, windowCapability: capability });
    await expect(client.list()).rejects.toMatchObject({
      name: "PendingRequestClientFailure",
      code: "unauthorized",
    });
  });

  it("refuses a response that is not a pending request list", async () => {
    const fetch = vi.fn(async () => Response.json({ requests: [] }));
    const client = createPendingRequestClient({ baseUrl, fetch, windowCapability: capability });
    await expect(client.list()).rejects.toMatchObject({ code: "unavailable" });
  });

  it("refuses to be created for a host that is not on loopback", () => {
    expect(() =>
      createPendingRequestClient({
        baseUrl: "https://octant.example",
        fetch: vi.fn(),
        windowCapability: capability,
      }),
    ).toThrow(PendingRequestClientFailure);
  });
});
