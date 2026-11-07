import { describe, expect, it } from "vitest";

import {
  checkAnchors,
  checkLinks,
  headingSlugs,
  slugifyHeading,
  type AnchorIssue,
  type LinkIssue,
  type SourceFile,
} from "./check-links";

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

describe("check-links anchors", () => {
  const pages: SourceFile[] = [
    markdown("guide/index.md", "# Guide\n\n## Servers that run the repository's tools\n"),
    markdown(
      "guide/topics.md",
      "# Topics\n\nSee [the services](/guide/index#servers-that-run-the-repository-s-tools).\n\nBroken: [x](/guide/index#nope).\n",
    ),
  ];

  it("slugifies headings the way the built site does (punctuation runs become one hyphen)", () => {
    expect(slugifyHeading("Publish as a web page on sharehtml.org")).toBe(
      "publish-as-a-web-page-on-sharehtml-org",
    );
    expect(slugifyHeading("Servers that run the repository's tools")).toBe(
      "servers-that-run-the-repository-s-tools",
    );
    expect(headingSlugs("# A\n\n```\n# not a heading\n```\n\n## `code` heading\n")).toEqual([
      "a",
      "code-heading",
    ]);
  });

  it("accepts in-page anchors that match a heading", () => {
    expect(checkAnchors(pages)).toEqual<AnchorIssue[]>([
      { file: "guide/topics.md", target: "/guide/index#nope", anchor: "nope" },
    ]);
  });

  it("accepts same-page fragment links", () => {
    const same = [markdown("guide/topics.md", "# Topics\n\n[down](#topics)\n")];
    expect(checkAnchors(same)).toEqual([]);
  });

  it("reports a missing same-page heading", () => {
    expect(checkAnchors([markdown("guide/topics.md", "# Topics\n\n[down](#missing)\n")])).toEqual([
      { file: "guide/topics.md", target: "#missing", anchor: "missing" },
    ]);
  });

  it("keeps a linked heading's visible text in its anchor", () => {
    expect(headingSlugs("## [A link](https://example.com)\n")).toEqual(["a-link"]);
  });
});
