import { describe, expect, it } from "vitest";
import {
  appendTerminalOutput,
  importDropLines,
  PHONE_TERMINAL_KEPT_CHARACTERS,
  projectPageAddress,
  terminalPlainText,
} from "./projectToolsPresentation";
import { listMobileThreadTools } from "../panes/threadPanesPresentation";

describe("a Project terminal's output on the phone", () => {
  it("extends what it shows, and takes the host's tail whole when it fell behind", () => {
    expect(appendTerminalOutput("$ ", { text: "ls\r\n", replace: false, characters: 6 })).toBe(
      "$ ls\r\n",
    );
    expect(appendTerminalOutput("old", { text: "tail", replace: true, characters: 900 })).toBe(
      "tail",
    );
    const long = "x".repeat(PHONE_TERMINAL_KEPT_CHARACTERS);
    expect(appendTerminalOutput(long, { text: "y", replace: false, characters: 1 })).toHaveLength(
      PHONE_TERMINAL_KEPT_CHARACTERS,
    );
  });

  it("drops colours and titles, honours backspace, and lets a carriage return redraw its line", () => {
    const raw =
      "\u001b]0;user@mac\u0007\u001b[1;32muser\u001b[0m$ lss\b\r\n" + "10%\r50%\r100%\n" + "done";
    expect(terminalPlainText(raw)).toBe("user$ ls\n100%\ndone");
  });
});

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
