import { describe, expect, it } from "vitest";
import { MAX_CHAT_TRANSCRIPT_SEARCH_HITS, MAX_CHAT_TRANSCRIPT_SEARCH_SNIPPET_LENGTH } from "./chat";
import { decodeCodeTranscriptSearch, decodeWorkTranscriptSearch } from "./threadTranscriptSearch";

const threadId = "00000000-0000-4000-8000-000000000001";
const turnId = "00000000-0000-4000-8000-000000000002";
const projectId = "00000000-0000-4000-8000-000000000003";

describe("Work and Code transcript search", () => {
  it("decodes a Work hit that names its turn and a Code hit that names its operation", () => {
    const work = {
      query: "release",
      truncated: false,
      hits: [
        {
          threadId,
          turnId,
          title: "Plan",
          lifecycle: "active" as const,
          projectId,
          snippet: "the release date",
          matchRanges: [{ start: 4, end: 11 }],
        },
      ],
    };
    expect(decodeWorkTranscriptSearch(work)).toEqual(work);
    const code = {
      query: "release",
      truncated: true,
      hits: [
        {
          threadId,
          operationId: turnId,
          title: "Fix",
          lifecycle: "archived" as const,
          projectId,
          snippet: "release",
        },
      ],
    };
    expect(decodeCodeTranscriptSearch(code)).toEqual(code);
  });

  it("refuses a hit that names the other mode's turn, an oversized snippet, or too many hits", () => {
    const hit = {
      threadId,
      turnId,
      title: "Plan",
      lifecycle: "active" as const,
      projectId,
      snippet: "text",
    };
    expect(() =>
      decodeCodeTranscriptSearch({ query: "text", truncated: false, hits: [hit] }),
    ).toThrow();
    expect(() =>
      decodeWorkTranscriptSearch({
        query: "text",
        truncated: false,
        hits: [{ ...hit, snippet: "x".repeat(MAX_CHAT_TRANSCRIPT_SEARCH_SNIPPET_LENGTH + 1) }],
      }),
    ).toThrow();
    expect(() =>
      decodeWorkTranscriptSearch({
        query: "text",
        truncated: true,
        hits: Array.from({ length: MAX_CHAT_TRANSCRIPT_SEARCH_HITS + 1 }, () => hit),
      }),
    ).toThrow();
  });
});
