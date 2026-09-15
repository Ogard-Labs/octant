import { describe, expect, it } from "vitest";
import {
  parseChatMessageBody,
  parseMarkdownBlocks,
  resolveChatMessageParts,
} from "./chatMessageParts";

describe("resolveChatMessageParts", () => {
  it.each([
    "```xml\n<think>example payload</think>\n```",
    "Use `<thinking>example</thinking>` literally.",
    "Use ``<reasoning>example `value`</reasoning>`` literally.",
    "~~~xml\n<think>example payload</think>\n~~~",
    "```xml\n<think>streaming example</think>",
  ])("keeps reasoning markers inside code literal: %s", (body) => {
    expect(parseChatMessageBody(body)).toEqual([{ kind: "markdown", text: body }]);
  });

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

  it("parses think tags that models emit inline as reasoning", () => {
    const parts = parseChatMessageBody("<think>Weighing the two options.</think>The short answer.");
    expect(parts).toEqual([
      { kind: "reasoning", text: "Weighing the two options." },
      { kind: "markdown", text: "The short answer." },
    ]);
  });

  it("leaves a reply without reasoning parts as one markdown part", () => {
    expect(parseChatMessageBody("Just prose, no tags.")).toEqual([
      { kind: "markdown", text: "Just prose, no tags." },
    ]);
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
