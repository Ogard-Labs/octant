import { describe, expect, it } from "vitest";
import {
  parseChatMessageBody,
  parseMarkdownBlocks,
  resolveChatMessageParts,
} from "./chatMessageParts";

describe("resolveChatMessageParts", () => {
  it("prefers structured parts when present", () => {
    const parts = resolveChatMessageParts({
      role: "assistant",
      body: "ignored fence body",
      parts: [{ kind: "markdown", text: "structured" }],
    });
    expect(parts).toEqual([{ kind: "markdown", text: "structured" }]);
  });

  it("maps research role to reasoning", () => {
    expect(resolveChatMessageParts({ role: "research", body: "notes" })).toEqual([
      { kind: "reasoning", text: "notes" },
    ]);
  });

  it("parses body fences when parts absent", () => {
    const parts = parseChatMessageBody("```reasoning\nConsider the host first.\n```\n\nHello");
    expect(parts[0]).toEqual({ kind: "reasoning", text: "Consider the host first." });
    expect(parts[1]).toMatchObject({ kind: "markdown" });
  });
});

describe("parseMarkdownBlocks", () => {
  it("parses headings, lists, and code fences", () => {
    expect(
      parseMarkdownBlocks("# Title\n\n- one\n- two\n\n```ts\nconst x = 1\n```\n\nTail prose."),
    ).toEqual([
      { type: "heading", level: 1, text: "Title" },
      { type: "list", ordered: false, items: ["one", "two"] },
      { type: "code", language: "ts", code: "const x = 1" },
      { type: "paragraph", text: "Tail prose." },
    ]);
  });
});
