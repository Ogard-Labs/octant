import { describe, expect, it } from "vitest";
import { importDropLines, projectPageAddress } from "./projectToolsPresentation";
import { listMobileThreadTools } from "../panes/threadPanesPresentation";

describe("a Private page's address typed on the phone", () => {
  it("adds https to a bare host and keeps an address that names its scheme", () => {
    expect(projectPageAddress(" example.com ")).toBe("https://example.com");
    expect(projectPageAddress("http://localhost:3000")).toBe("http://localhost:3000");
    expect(projectPageAddress("   ")).toBeUndefined();
  });
});

describe("what an HTML import took out", () => {
  it("names each kind with a count and a few examples, as the desktop does", () => {
    expect(
      importDropLines([
        { kind: "script-file", count: 1, examples: ["app.js"] },
        { kind: "link", count: 4, examples: ["a.example", "b.example"] },
      ]),
    ).toEqual(["1 script file (app.js)", "4 links out of the page (a.example, b.example, …)"]);
  });
});

describe("the tools a thread's sheet offers", () => {
  it("offers a device its person paired the Project terminal and page, or Import HTML in Chat", () => {
    expect(listMobileThreadTools({ mode: "work", actsAsHostPerson: true, projectId: "p" })).toEqual(
      ["terminal", "page"],
    );
    expect(
      listMobileThreadTools({ mode: "code", actsAsHostPerson: true, projectId: undefined }),
    ).toEqual([]);
    expect(
      listMobileThreadTools({ mode: "chat", actsAsHostPerson: true, projectId: undefined }),
    ).toEqual(["import-html"]);
  });

  it("offers nothing to a session that does not act as the host's person", () => {
    expect(
      listMobileThreadTools({ mode: "work", actsAsHostPerson: false, projectId: "p" }),
    ).toEqual([]);
    expect(
      listMobileThreadTools({ mode: "chat", actsAsHostPerson: false, projectId: undefined }),
    ).toEqual([]);
  });
});
