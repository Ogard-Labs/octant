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

describe("parseChatMessageBody while streaming", () => {
  it("parses an open think tail as reasoning while a reply streams", () => {
    const parts = parseChatMessageBody("<think>Weighing the two options.");
    expect(parts).toEqual([{ kind: "reasoning", text: "Weighing the two options." }]);
  });

  it("keeps prose before an open reasoning tail as markdown", () => {
    const parts = parseChatMessageBody("The short answer is coming. <think>weighing options");
    expect(parts[0]).toMatchObject({ kind: "markdown" });
    expect(parts[1]).toMatchObject({ kind: "reasoning", text: "weighing options" });
  });

  it("parses an open reasoning fence tail as reasoning", () => {
    const parts = parseChatMessageBody("```reasoning\nWeighing the two options.\n");
    expect(parts).toEqual([{ kind: "reasoning", text: "Weighing the two options." }]);
  });

  it("keeps a reply without any reasoning opener as plain markdown", () => {
    const parts = parseChatMessageBody("Just prose, still streaming.");
    expect(parts).toEqual([{ kind: "markdown", text: "Just prose, still streaming." }]);
  });
});

describe("parseChatMessageBody with follow-up suggestions", () => {
  const block =
    '```octant-follow-ups\n{"suggestions":[{"title":"Tests","prompt":"Add tests.","target":"new-thread"}]}\n```';

  it("leaves the suggestion block out of the reply a person reads", () => {
    expect(parseChatMessageBody(`Done. The parser handles lists.\n\n${block}`)).toEqual([
      { kind: "markdown", text: "Done. The parser handles lists." },
    ]);
  });

  it("hides a suggestion block that is still streaming in", () => {
    expect(parseChatMessageBody('Done.\n\n```octant-follow-ups\n{"suggestions":[{"ti')).toEqual([
      { kind: "markdown", text: "Done." },
    ]);
  });

  it("shows nothing rather than raw JSON when the block is the whole reply", () => {
    expect(parseChatMessageBody(block)).toEqual([{ kind: "markdown", text: "" }]);
  });
});
