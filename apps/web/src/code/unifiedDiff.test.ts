import { describe, expect, it } from "vitest";
import { parseUnifiedDiff } from "./unifiedDiff";

const modified = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -10,4 +10,5 @@ export function app() {",
  "   const a = 1;",
  "-  return a;",
  "+  const b = 2;",
  "+  return a + b;",
  "   // end",
  "",
].join("\n");

describe("unified diff parsing", () => {
  it("reconstructs both sides of a modified file from its hunk", () => {
    const [file] = parseUnifiedDiff(modified);
    expect(file?.path).toBe("src/app.ts");
    expect(file?.change).toBe("modified");
    expect(file?.additions).toBe(2);
    expect(file?.deletions).toBe(1);
    expect(file?.original).toBe(["  const a = 1;", "  return a;", "  // end"].join("\n"));
    expect(file?.modified).toBe(
      ["  const a = 1;", "  const b = 2;", "  return a + b;", "  // end"].join("\n"),
    );
    expect(file?.binary).toBe(false);
  });

  it("separates every file in a multi-file diff", () => {
    const files = parseUnifiedDiff(
      [
        modified.trimEnd(),
        "diff --git a/README.md b/README.md",
        "--- a/README.md",
        "+++ b/README.md",
        "@@ -1 +1 @@",
        "-old title",
        "+new title",
      ].join("\n"),
    );
    expect(files.map((file) => file.path)).toEqual(["src/app.ts", "README.md"]);
    expect(files.map((file) => file.id)).toEqual(["0:src/app.ts", "1:README.md"]);
  });

  it("reads creation and deletion from the /dev/null side", () => {
    const files = parseUnifiedDiff(
      [
        "diff --git a/new.ts b/new.ts",
        "--- /dev/null",
        "+++ b/new.ts",
        "@@ -0,0 +1,2 @@",
        "+export const a = 1;",
        "+export const b = 2;",
        "diff --git a/gone.ts b/gone.ts",
        "--- a/gone.ts",
        "+++ /dev/null",
        "@@ -1,1 +0,0 @@",
        "-export const gone = true;",
      ].join("\n"),
    );
    expect(files.map((file) => [file.path, file.change])).toEqual([
      ["new.ts", "created"],
      ["gone.ts", "deleted"],
    ]);
    expect(files[0]?.original).toBe("");
    expect(files[1]?.modified).toBe("");
  });

  it("reports a rename with the path it came from", () => {
    const [file] = parseUnifiedDiff(
      [
        "diff --git a/old/name.ts b/new/name.ts",
        "similarity index 92%",
        "rename from old/name.ts",
        "rename to new/name.ts",
        "--- a/old/name.ts",
        "+++ b/new/name.ts",
        "@@ -1 +1 @@",
        "-const a = 1;",
        "+const a = 2;",
      ].join("\n"),
    );
    expect(file?.change).toBe("renamed");
    expect(file?.path).toBe("new/name.ts");
    expect(file?.previousPath).toBe("old/name.ts");
  });

  it("keeps a binary file in the list rather than dropping it", () => {
    const [file] = parseUnifiedDiff(
      [
        "diff --git a/logo.png b/logo.png",
        "index 3333333..4444444 100644",
        "Binary files a/logo.png and b/logo.png differ",
      ].join("\n"),
    );
    expect(file?.path).toBe("logo.png");
    expect(file?.binary).toBe(true);
    expect(file?.additions).toBe(0);
  });

  it("separates non-contiguous hunks instead of splicing them together", () => {
    const [file] = parseUnifiedDiff(
      [
        "diff --git a/x.ts b/x.ts",
        "--- a/x.ts",
        "+++ b/x.ts",
        "@@ -1,1 +1,1 @@",
        "-first",
        "+FIRST",
        "@@ -50,1 +50,1 @@",
        "-second",
        "+SECOND",
      ].join("\n"),
    );
    expect(file?.modified).toBe(["FIRST", "", "SECOND"].join("\n"));
    expect(file?.original).toBe(["first", "", "second"].join("\n"));
  });

  it("returns nothing for an empty diff", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
  });
});
