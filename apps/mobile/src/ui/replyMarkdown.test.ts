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
  });

  it.each([
    "![a [b]](http://e/p.png)",
    "![a\\]b](http://e/p.png)",
    "![ref]\n\n[ref]: http://e/p.png",
    "![chart][ref]\n\n[ref]: http://e/p.png",
    "``![i](http://e/p.png)` x",
    "`a` ![i](<http://e/p q.png>) `b`",
    "![i](http://e/p(1).png)",
    '| a |\n|---|\n| ![i](http://e/p.png "t") |',
    "[![i](http://e/p.png)](http://e)",
    "!![i](http://e/p.png)",
  ])("leaves no picture in %s", (written) => {
    for (const segment of replySegments(written))
      if (segment.kind === "prose") expect(segment.markdown).not.toContain("![");
  });

  it.each([
    "[call](tel:123)",
    "[call](<tel:123>)",
    "[call]( TEL:123)",
    "[call](&#116;el:123)",
    "[call](t&#101;l:123)",
    "[app](octant://pair?x)",
    "[js](javascript:alert(1))",
    "[call][ref]\n\n[ref]: tel:123",
    "<tel:123>",
    "<octant://pair>",
    `[a](${" ".repeat(11)}tel:1)`,
    `[a][r]\n\n[r]:${" ".repeat(40)}tel:1`,
    "> [a](\n> tel:1)",
    "> [r]:\n> tel:1\n\n[r]",
    "[a](x[b](tel:2)",
    "[a](https://x[b](tel:2)",
    "`](`[a](tel:1)",
    "]:[a](tel:1)",
    `<octant://${"x".repeat(3_000)}>`,
    "[a](< tel:1>)",
    "<a@example.com>",
  ])("makes no link of %s", (written) => {
    for (const segment of replySegments(written))
      if (segment.kind === "prose")
        expect(segment.markdown).not.toMatch(
          /\][(:][\s>]*<?\s*(?:tel:|&|t&|octant:|javascript:)|<(?:tel:|octant:|a@)/i,
        );
  });

  it("keeps a link to a web page, however it is written", () => {
    for (const written of [
      "[page](https://example.com/a:b?c=d&e)",
      "[page](<https://example.com>)",
      "<https://example.com>",
      "[page][ref]\n\n[ref]: https://example.com",
      "[file](src/a.ts)",
      "See [1] it works",
    ])
      expect(replySegments(written)).toEqual([{ kind: "prose", markdown: written }]);
  });

  it("leaves no markup that loads something", () => {
    const [segment] = replySegments('<IMG src="http://e/a.png"> <video src="x"> </picture> <b>');
    expect(segment?.kind === "prose" ? segment.markdown : "").toBe(
      '<\u200BIMG src="http://e/a.png"> <\u200Bvideo src="x"> <\u200B/picture> <b>',
    );
  });

  it("reads a long reply quickly, however it is written", () => {
    const started = performance.now();
    replySegments("![a](".repeat(20_000) + "x".repeat(200_000));
    replySegments("](".repeat(100_000));
    replySegments(`](${" ".repeat(200_000)}`);
    replySegments("<a".repeat(100_000));
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
