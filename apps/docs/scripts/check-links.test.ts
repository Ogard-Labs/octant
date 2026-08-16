import { describe, expect, it } from "vitest";

import { checkLinks, type LinkIssue, type SourceFile } from "./check-links";

const sources: SourceFile[] = [
  { path: "index.md", content: "" },
  { path: "guide/index.md", content: "" },
  { path: "concepts/index.md", content: "" },
  { path: "guide/topics.md", content: "" },
];

function markdown(path: string, content: string): SourceFile {
  return { path, content };
}

describe("check-links", () => {
  it("accepts absolute page links that resolve to an index page", () => {
    expect(checkLinks([markdown("guide/index.md", "[Concepts](/concepts/)"), ...sources])).toEqual(
      [],
    );
  });

  it("accepts absolute links to a bare nested page", () => {
    expect(checkLinks([markdown("guide/index.md", "[Topics](/guide/topics)"), ...sources])).toEqual(
      [],
    );
  });

  it("flags absolute links that resolve to nothing", () => {
    const issues = checkLinks([markdown("guide/index.md", "[Gone](/guide/missing)"), ...sources]);
    expect(issues).toEqual<LinkIssue[]>([{ file: "guide/index.md", target: "/guide/missing" }]);
  });

  it("accepts relative links inside the same directory", () => {
    expect(checkLinks([markdown("guide/index.md", "[Topics](./topics)"), ...sources])).toEqual([]);
  });

  it("accepts relative links to an explicit markdown file", () => {
    expect(checkLinks([markdown("guide/index.md", "[Topics](topics.md)"), ...sources])).toEqual([]);
  });

  it("flags relative links that resolve to nothing", () => {
    const issues = checkLinks([markdown("guide/index.md", "[Gone](./missing)"), ...sources]);
    expect(issues).toEqual<LinkIssue[]>([{ file: "guide/index.md", target: "./missing" }]);
  });

  it("ignores external, anchor, and empty links", () => {
    expect(
      checkLinks([
        markdown("guide/index.md", "[Ext](https://example.com/) [Anchor](#top) [Empty]()"),
        ...sources,
      ]),
    ).toEqual([]);
  });

  it("validates nav and sidebar links declared in the VitePress config", () => {
    const config = {
      path: ".vitepress/config.ts",
      content: 'nav: [{ link: "/guide/" }, { link: "/concepts/" }], sidebar: [{ link: "/gone/x" }]',
    };
    const issues = checkLinks([...sources, config]);
    expect(issues).toEqual<LinkIssue[]>([{ file: ".vitepress/config.ts", target: "/gone/x" }]);
  });

  it("tolerates a trailing fragment on an otherwise valid link", () => {
    expect(
      checkLinks([markdown("guide/index.md", "[Topics](/guide/topics#intro)"), ...sources]),
    ).toEqual([]);
  });
});
