import { describe, expect, it, vi } from "vitest";
import { createThreadSearchClient } from "./threadSearchClient";

const answer = {
  query: "release",
  scope: "all",
  truncated: false,
  unavailable: [],
  hits: [
    {
      mode: "code",
      threadId: "87000000-0000-4000-8000-000000000001",
      operationId: "87000000-0000-4000-8000-000000000002",
      field: "tool",
      title: "CI",
      lifecycle: "active",
      projectId: "87000000-0000-4000-8000-000000000003",
      updatedAt: "2026-11-14T10:00:00.000Z",
      snippet: "release.yml",
    },
  ],
};

describe("search across modes client", () => {
  it("asks the host for the query and scope with the window capability and reads its hits", async () => {
    const fetch = vi.fn(async () => Response.json(answer));
    const client = createThreadSearchClient({
      baseUrl: "http://127.0.0.1:4100",
      fetch,
      windowCapability: "capability",
    });

    const read = await client.search("release notes", "code");

    expect(read).toEqual({ status: "ready", search: answer });
    expect(fetch).toHaveBeenCalledWith(
      "http://127.0.0.1:4100/api/search?q=release+notes&scope=code",
      { method: "GET", headers: { "x-octant-window-capability": "capability" } },
    );
  });

  it("tells a refusal apart from a host that could not answer or answered something else", async () => {
    const read = (response: Response | Error) =>
      createThreadSearchClient({
        baseUrl: "http://127.0.0.1:4100",
        fetch: vi.fn(async () => {
          if (response instanceof Error) throw response;
          return response;
        }),
      }).search("release", "all");

    expect(await read(new Response(null, { status: 401 }))).toEqual({ status: "refused" });
    expect(await read(new Response(null, { status: 503 }))).toEqual({ status: "unavailable" });
    expect(await read(new Error("offline"))).toEqual({ status: "unavailable" });
    expect(await read(Response.json({ ...answer, hits: [{ mode: "chat" }] }))).toEqual({
      status: "unavailable",
    });
  });
});
