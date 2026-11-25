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

  it("leaves no markup that loads something", () => {
    const [segment] = replySegments('<IMG src="http://e/a.png"> <video src="x"> </picture> <b>');
    expect(segment?.kind === "prose" ? segment.markdown : "").toBe(
      '<\u200BIMG src="http://e/a.png"> <\u200Bvideo src="x"> <\u200B/picture> <b>',
    );
  });

  it("reads a long reply quickly, however it is written", () => {
    const started = performance.now();
    replySegments("![a](".repeat(20_000) + "x".repeat(200_000));
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});
