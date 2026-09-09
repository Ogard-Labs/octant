import { describe, expect, it, vi } from "vitest";
import { decodeGitHistoryQuery } from "@octant/contracts/git-history";
import { createGitHistoryClient } from "./gitHistoryClient";

const query = decodeGitHistoryQuery({
  kind: "history",
  threadId: "11111111-1111-4111-8111-111111111111",
  checkoutId: "22222222-2222-4222-8222-222222222222",
});
describe("Git history client", () => {
  it("carries the authorized scope and abort signal without following redirects", async () => {
    const fetch = vi.fn(async () => Response.json({ status: "unavailable", message: "Offline" }));
    const client = createGitHistoryClient({
      baseUrl: "http://127.0.0.1:13773",
      windowCapability: "capability",
      fetch,
    });
    const abort = new AbortController();
    expect(await client.read(query, abort.signal)).toEqual({
      status: "unavailable",
      message: "Offline",
    });
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/code/git/history?query="),
      expect.objectContaining({
        signal: abort.signal,
        redirect: "error",
        headers: { "x-octant-window-capability": "capability" },
      }),
    );
  });
  it("refuses to send a capability to an external origin", () => {
    expect(() =>
      createGitHistoryClient({
        baseUrl: "https://example.com",
        windowCapability: "capability",
        fetch,
      }),
    ).toThrow();
  });
});
