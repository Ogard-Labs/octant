import { describe, expect, it } from "vitest";
import { replySegments } from "./replyMarkdown";

describe("a reply's Markdown", () => {
  it("keeps code apart from prose, with its language", () => {
    expect(replySegments("Run **this**:\n\n```sh\nbun test\n```\n\n| a | b |\n|---|---|")).toEqual([
      { kind: "prose", markdown: "Run **this**:" },
      { kind: "code", language: "sh", code: "bun test" },
      { kind: "prose", markdown: "| a | b |\n|---|---|" },
    ]);
  });

  it("closes a fence only with one as long, and shows a fence still being written", () => {
    expect(replySegments("````md\n```\ninner\n```\n````\nafter")).toEqual([
      { kind: "code", language: "md", code: "```\ninner\n```" },
      { kind: "prose", markdown: "after" },
    ]);
    expect(replySegments("```ts\nconst a = 1")).toEqual([
      { kind: "code", language: "ts", code: "const a = 1" },
    ]);
  });

  it("never loads a picture a reply points at, and shows its address as a link", () => {
    expect(replySegments("See ![the chart](https://example.com/a.png 'title') now")).toEqual([
      { kind: "prose", markdown: "See [the chart](https://example.com/a.png) now" },
    ]);
    expect(replySegments("![](https://example.com/a.png)")).toEqual([
      { kind: "prose", markdown: "[https://example.com/a.png](https://example.com/a.png)" },
    ]);
    expect(replySegments("![chart][ref]\n\n[ref]: https://example.com/a.png")).toEqual([
      { kind: "prose", markdown: "[chart][ref]\n\n[ref]: https://example.com/a.png" },
    ]);
    expect(replySegments('<img src="https://example.com/a.png"> <video src="x">')).toEqual([
      { kind: "prose", markdown: '&lt;img src="https://example.com/a.png"> &lt;video src="x">' },
    ]);
  });

  it("leaves a picture's syntax alone inside inline code", () => {
    expect(replySegments("Write `![alt](url)` there")).toEqual([
      { kind: "prose", markdown: "Write `![alt](url)` there" },
    ]);
  });
});
