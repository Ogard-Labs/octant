import { describe, expect, it } from "vitest";
import type { MobileRemoteTransport } from "./mobileInboxClient";
import { searchMobileChatTranscripts } from "./mobileTranscriptSearchClient";

const hostId = "11111111-1111-4111-8111-111111111111";
const threadId = "60000000-0000-4000-8000-000000000001";
const turnId = "61000000-0000-4000-8000-000000000001";

describe("searching Chat messages from the phone", () => {
  it("returns each match with the turn to open, dropping threads that are no longer active", async () => {
    const asked: string[] = [];
    const transport: MobileRemoteTransport = {
      hostId,
      authenticatedFetch: async ({ path, query }) => {
        asked.push(`${path}${query ?? ""}`);
        return Response.json({
          query: "fixtures",
          truncated: false,
          hits: [
            { threadId, title: "Review", lifecycle: "active", turnId, snippet: "…the fixtures…" },
            {
              threadId: "60000000-0000-4000-8000-000000000002",
              title: "Old",
              lifecycle: "archived",
              turnId,
              snippet: "fixtures",
            },
          ],
        });
      },
    };
    const result = await searchMobileChatTranscripts(transport, "  fixtures ");
    expect(asked).toEqual(["/api/chat/transcript-search?q=fixtures"]);
    expect(result).toEqual({
      status: "ready",
      truncated: false,
      hits: [{ hostId, threadId, title: "Review", turnId, snippet: "…the fixtures…" }],
    });
  });

  it("says plainly when a host does not share message search", async () => {
    const transport: MobileRemoteTransport = {
      hostId,
      authenticatedFetch: async () => new Response("{}", { status: 403 }),
    };
    await expect(searchMobileChatTranscripts(transport, "x")).resolves.toEqual({
      status: "unavailable",
      message: "This host does not share message search with paired devices.",
    });
  });
});
