import { describe, expect, it } from "vitest";
import {
  applyFileMention,
  boundFileMentionText,
  classifyFileMentionRelativePath,
  FILE_MENTION_OUT_OF_ROOT_CONTEXT,
  formatFileMentionContext,
  parseFileMentionToken,
  fileMentionQueryEscapesRoot,
  rankFileMentionCandidates,
  reconcileFileMentionPaths,
} from "./fileMentionPolicy";

const CANDIDATES = [
  { path: "src", kind: "directory" as const },
  { path: "README.md", kind: "file" as const },
  { path: "src/index.ts", kind: "file" as const },
  { path: "src/code.ts", kind: "file" as const },
];

describe("classifyFileMentionRelativePath", () => {
  it("accepts a confined POSIX relative path", () => {
    expect(classifyFileMentionRelativePath("src/index.ts")).toEqual({
      kind: "in-root",
      path: "src/index.ts",
    });
  });

  it("refuses parent traversal without needing a filesystem", () => {
    expect(classifyFileMentionRelativePath("../secret")).toEqual({ kind: "out-of-root" });
    expect(classifyFileMentionRelativePath("src/../../etc/passwd")).toEqual({
      kind: "out-of-root",
    });
  });

  it("refuses an absolute path without needing a filesystem", () => {
    expect(classifyFileMentionRelativePath("/etc/passwd")).toEqual({ kind: "out-of-root" });
  });
});

describe("parseFileMentionToken", () => {
  it("opens at a word-boundary @", () => {
    expect(parseFileMentionToken("look at @src/co", 15)).toEqual({ start: 8, query: "src/co" });
    expect(parseFileMentionToken("@", 1)).toEqual({ start: 0, query: "" });
  });

  it("leaves an email address and completed token as ordinary text", () => {
    expect(parseFileMentionToken("mail henrik@ogard.no", 20)).toBeUndefined();
    expect(parseFileMentionToken("@src/co and then", 16)).toBeUndefined();
  });
});

describe("rankFileMentionCandidates", () => {
  it("prefers a closer filename match", () => {
    expect(rankFileMentionCandidates(CANDIDATES, "code").map((entry) => entry.path)).toEqual([
      "src/code.ts",
    ]);
  });
});

describe("applyFileMention", () => {
  it("writes the chosen path into the draft and leaves a trailing space for a file", () => {
    const draft = "look at @src/co";
    const token = parseFileMentionToken(draft, 15);
    expect(token).toBeDefined();
    expect(applyFileMention(draft, token!, CANDIDATES[2]!)).toEqual({
      draft: "look at @src/index.ts ",
      caret: 22,
    });
  });
});

describe("reconcileFileMentionPaths", () => {
  it("drops a path the user edited out of the draft", () => {
    expect(
      reconcileFileMentionPaths("look at @src/index.ts please", ["src/index.ts", "gone.ts"]),
    ).toEqual(["src/index.ts"]);
  });

  it("does not keep a shorter path that is only a prefix of a later mention", () => {
    expect(reconcileFileMentionPaths("look at @foobar please", ["foo"])).toEqual([]);
    expect(reconcileFileMentionPaths("look at @foo please", ["foo"])).toEqual(["foo"]);
  });
});

describe("fileMentionQueryEscapesRoot", () => {
  it("refuses a parent-traversal component and accepts double dots inside a name", () => {
    expect(fileMentionQueryEscapesRoot("../secret")).toBe(true);
    expect(fileMentionQueryEscapesRoot("archive/../secret")).toBe(true);
    expect(fileMentionQueryEscapesRoot("/etc/passwd")).toBe(true);
    expect(fileMentionQueryEscapesRoot("notes..md")).toBe(false);
    expect(fileMentionQueryEscapesRoot("archive..old/report.md")).toBe(false);
  });
});

describe("boundFileMentionText", () => {
  it("reports truncation when the file is longer than the window", () => {
    expect(boundFileMentionText("abcdef", 4)).toEqual({ text: "abcd", truncated: true });
    expect(boundFileMentionText("abcd", 4)).toEqual({ text: "abcd", truncated: false });
  });
});

describe("formatFileMentionContext", () => {
  it("frames resolved files as read-only quoted contents", () => {
    const block = formatFileMentionContext([
      { path: "src/index.ts", text: "export {}", truncated: false },
    ]);
    expect(block).toContain("Referenced file: src/index.ts");
    expect(block).toContain("export {}");
    expect(block).toContain("Quoted for reference only");
  });

  it("renders nothing when no mention resolved", () => {
    expect(formatFileMentionContext([])).toBe("");
  });

  it("states an out-of-root refusal in words", () => {
    expect(FILE_MENTION_OUT_OF_ROOT_CONTEXT).toContain("outside this thread's bound root");
  });
});
