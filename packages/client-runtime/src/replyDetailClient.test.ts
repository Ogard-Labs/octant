import { describe, expect, it, vi } from "vitest";
import type { MobileRemoteTransport } from "./mobileInboxClient";
import { createReplyDetailClient, readMobileReplyDetail } from "./replyDetailClient";

type FetchInput = Parameters<MobileRemoteTransport["authenticatedFetch"]>[0];

const reading = {
  defaultLevel: "medium",
  threads: [{ mode: "work", threadId: "thread-1", level: "high" }],
} as const;

function transportAnswering(answer: () => Response) {
  const fetch = vi.fn(async (_input: FetchInput) => answer());
  const transport: MobileRemoteTransport = {
    hostId: "77000000-0000-4000-8000-0000000000ff",
    authenticatedFetch: fetch,
  };
  return { transport, fetch };
}

describe("reading the host's reply detail from a paired client", () => {
  it("reads the default and the threads' own levels with one GET", async () => {
    const host = transportAnswering(() => Response.json(reading));
    await expect(readMobileReplyDetail({ transport: host.transport })).resolves.toEqual(reading);
    expect(host.fetch.mock.calls[0]?.[0]).toEqual({ method: "GET", path: "/api/reply-detail" });
  });

  it("reads nothing, so the quiet default draws, when the host refuses or answers off-contract", async () => {
    for (const answer of [
      () => new Response(null, { status: 404 }),
      () => Response.json({ defaultLevel: "verbose", threads: [] }),
      () => {
        throw new Error("offline");
      },
    ]) {
      await expect(
        readMobileReplyDetail({ transport: transportAnswering(answer).transport }),
      ).resolves.toBeUndefined();
    }
  });

  it("reads over a paired browser's product fetch", async () => {
    const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json(reading),
    );
    const client = createReplyDetailClient({ baseUrl: "http://127.0.0.1", fetch });
    await expect(client.read()).resolves.toEqual(reading);
    expect(String(fetch.mock.calls[0]?.[0])).toBe("http://127.0.0.1/api/reply-detail");
  });
});
