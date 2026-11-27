import { describe, expect, it, vi } from "vitest";
import { createTrackerMentionSearchClient } from "./trackerMentionSearchClient";

const answered = () =>
  vi.fn<typeof globalThis.fetch>(async () => Response.json({ candidates: [] }));

describe("searching pull requests and issues from a window", () => {
  it("sends the token under the window capability and nothing for one that asks nothing", async () => {
    const fetch = answered();
    const search = createTrackerMentionSearchClient({
      baseUrl: "http://127.0.0.1:4000",
      fetch,
      windowCapability: "capability",
    });

    await search({ query: "" });
    await search({ query: "a" });
    expect(fetch).not.toHaveBeenCalled();
    await search({ query: "2901" });

    expect(fetch).toHaveBeenCalledExactlyOnceWith(
      "http://127.0.0.1:4000/api/thread-mentions/trackers",
      expect.objectContaining({
        body: JSON.stringify({ query: "2901" }),
        headers: expect.objectContaining({ "x-octant-window-capability": "capability" }),
      }),
    );
  });

  it("offers nothing when the host refuses, and never sends its capability elsewhere", async () => {
    const refused = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 401 }));
    const outside = answered();

    await expect(
      createTrackerMentionSearchClient({
        baseUrl: "http://127.0.0.1:4000",
        fetch: refused,
        windowCapability: "capability",
      })({ query: "login" }),
    ).resolves.toEqual([]);
    await createTrackerMentionSearchClient({
      baseUrl: "https://example.com",
      fetch: outside,
      windowCapability: "capability",
    })({ query: "login" });
    expect(outside).not.toHaveBeenCalled();
  });
});
