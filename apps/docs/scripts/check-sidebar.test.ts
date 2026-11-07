import { describe, expect, it } from "vitest";

import { checkSidebar, routeFor, type SourceFile } from "./check-sidebar";

const config = `
sidebar: {
  "/guide/": [{ text: "Guide", items: [{ text: "Overview", link: "/guide/" }, { text: "Export", link: "/guide/export" }] }],
}
`;

describe("check-sidebar", () => {
  it("maps pages to clean routes the way cleanUrls builds them", () => {
    expect(routeFor("index.md")).toBe("/");
    expect(routeFor("guide/index.md")).toBe("/guide/");
    expect(routeFor("guide/export.md")).toBe("/guide/export");
    expect(routeFor("advanced/build-export-destination-plugin.md")).toBe(
      "/advanced/build-export-destination-plugin",
    );
  });

  it("accepts pages the sidebar links", () => {
    const sources: SourceFile[] = [
      { path: "index.md", content: "" },
      { path: "guide/index.md", content: "" },
      { path: "guide/export.md", content: "" },
    ];
    expect(checkSidebar(sources, config)).toEqual([]);
  });

  it("flags a page no sidebar entry reaches", () => {
    const sources: SourceFile[] = [
      { path: "index.md", content: "" },
      { path: "guide/index.md", content: "" },
      { path: "guide/export.md", content: "" },
      { path: "guide/orphan.md", content: "" },
    ];
    expect(checkSidebar(sources, config)).toEqual([
      { page: "guide/orphan.md", route: "/guide/orphan" },
    ]);
  });
});
