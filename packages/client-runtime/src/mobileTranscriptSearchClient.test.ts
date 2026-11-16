import { describe, expect, it } from "vitest";
import type { MobileRemoteTransport } from "./mobileInboxClient";
import { searchMobileTranscripts } from "./mobileTranscriptSearchClient";

const hostId = "11111111-1111-4111-8111-111111111111";
const projectId = "62000000-0000-4000-8000-000000000001";
const chatThread = "60000000-0000-4000-8000-000000000001";
const workThread = "60000000-0000-4000-8000-000000000003";
const codeThread = "60000000-0000-4000-8000-000000000004";
const turnId = "61000000-0000-4000-8000-000000000001";
const operationId = "61000000-0000-4000-8000-000000000002";

function answers(byPath: Readonly<Record<string, () => Response>>): {
  readonly transport: MobileRemoteTransport;
  readonly asked: ReadonlyArray<string>;
} {
  const asked: string[] = [];
  return {
    asked,
    transport: {
      hostId,
      authenticatedFetch: async ({ path, query }) => {
        asked.push(`${path}${query ?? ""}`);
        return byPath[path]?.() ?? new Response("{}", { status: 404 });
      },
    },
  };
}

describe("searching messages from the phone", () => {
  it("searches a current host once across every mode, keeping live titles, messages, and tool output", async () => {
    const { transport, asked } = answers({
      "/api/search": () =>
        Response.json({
          query: "fixtures",
          scope: "all",
          truncated: true,
          unavailable: [],
          hits: [
            {
              mode: "chat",
              threadId: chatThread,
              field: "title",
              title: "Fixtures",
              lifecycle: "active",
              updatedAt: "2026-11-15T00:00:00.000Z",
              snippet: "Fixtures",
            },
            {
              mode: "code",
              threadId: codeThread,
              operationId,
              field: "tool",
              title: "Fix",
              lifecycle: "active",
              projectId,
              updatedAt: "2026-11-15T00:00:00.000Z",
              snippet: "fixtures.ts",
            },
            {
              mode: "work",
              threadId: workThread,
              turnId,
              field: "reply",
              title: "Old",
              lifecycle: "archived",
              projectId,
              updatedAt: "2026-11-15T00:00:00.000Z",
              snippet: "fixtures",
            },
          ],
        }),
    });

    const result = await searchMobileTranscripts(transport, " fixtures ");

    expect(asked).toEqual(["/api/search?q=fixtures&scope=all"]);
    expect(result).toEqual({
      status: "ready",
      truncated: true,
      hits: [
        {
          hostId,
          mode: "chat",
          threadId: chatThread,
          title: "Fixtures",
          field: "title",
          snippet: "Fixtures",
        },
        {
          hostId,
          mode: "code",
          threadId: codeThread,
          title: "Fix",
          turnId: operationId,
          field: "tool",
          snippet: "fixtures.ts",
        },
      ],
    });
  });

  it("asks each mode's message search on a host that predates search across modes, Code naming its operation", async () => {
    const { transport, asked } = answers({
      "/api/chat/transcript-search": () =>
        Response.json({
          query: "fixtures",
          truncated: false,
          hits: [
            { threadId: chatThread, title: "Review", lifecycle: "active", turnId, snippet: "a" },
            {
              threadId: "60000000-0000-4000-8000-000000000002",
              title: "Old",
              lifecycle: "archived",
              turnId,
              snippet: "fixtures",
            },
          ],
        }),
      "/api/work/transcript-search": () =>
        Response.json({
          query: "fixtures",
          truncated: true,
          hits: [
            {
              threadId: workThread,
              turnId,
              title: "Brief",
              lifecycle: "active",
              projectId,
              snippet: "b",
            },
          ],
        }),
      "/api/code/transcript-search": () =>
        Response.json({
          query: "fixtures",
          truncated: false,
          hits: [
            {
              threadId: codeThread,
              operationId,
              title: "Fix",
              lifecycle: "active",
              projectId,
              snippet: "c",
            },
          ],
        }),
    });

    const result = await searchMobileTranscripts(transport, "  fixtures ");

    expect(asked).toEqual([
      "/api/search?q=fixtures&scope=all",
      "/api/chat/transcript-search?q=fixtures",
      "/api/work/transcript-search?q=fixtures",
      "/api/code/transcript-search?q=fixtures",
    ]);
    expect(result).toEqual({
      status: "ready",
      truncated: true,
      hits: [
        { hostId, mode: "chat", threadId: chatThread, title: "Review", turnId, snippet: "a" },
        { hostId, mode: "work", threadId: workThread, title: "Brief", turnId, snippet: "b" },
        {
          hostId,
          mode: "code",
          threadId: codeThread,
          title: "Fix",
          turnId: operationId,
          snippet: "c",
        },
      ],
    });
  });

  it("keeps the Chat matches of a host that has no Work or Code message search", async () => {
    const { transport } = answers({
      "/api/chat/transcript-search": () =>
        Response.json({
          query: "x",
          truncated: false,
          hits: [
            { threadId: chatThread, title: "Review", lifecycle: "active", turnId, snippet: "x" },
          ],
        }),
    });
    await expect(searchMobileTranscripts(transport, "x")).resolves.toMatchObject({
      status: "ready",
      hits: [{ mode: "chat", threadId: chatThread }],
    });
  });

  it("says plainly when a host does not share message search", async () => {
    const transport: MobileRemoteTransport = {
      hostId,
      authenticatedFetch: async () => new Response("{}", { status: 403 }),
    };
    await expect(searchMobileTranscripts(transport, "x")).resolves.toEqual({
      status: "unavailable",
      message: "This host does not share message search with paired devices.",
    });
  });
});
