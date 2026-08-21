import { describe, expect, it, vi } from "vitest";
import { createFileMentionClient, FileMentionClientFailure } from "./fileMentionClient";

const baseUrl = "http://127.0.0.1:8787";
const windowCapability = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const requestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const threadId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createFileMentionClient", () => {
  it("refuses a non-loopback base URL", () => {
    expect(() =>
      createFileMentionClient({
        baseUrl: "https://example.com",
        fetch: vi.fn(),
        windowCapability,
      }),
    ).toThrow(FileMentionClientFailure);
  });

  it("returns confined complete hits from the host", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        kind: "file-mentions-completed",
        requestId,
        candidates: [{ path: "notes.md", kind: "file" }],
      }),
    );
    const client = createFileMentionClient({
      baseUrl,
      fetch: fetchImpl,
      windowCapability,
    });
    const hits = await client.complete(
      requestId as never,
      { mode: "work", threadId: threadId as never },
      "notes",
    );
    expect(hits).toEqual([{ path: "notes.md", kind: "file" }]);
  });
});
