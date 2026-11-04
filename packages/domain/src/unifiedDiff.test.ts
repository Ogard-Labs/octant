import { expect, it } from "vitest";
import { diffSourceLines, parseUnifiedDiff } from "./unifiedDiff";

it("retains exact raw headers and separate hunk spans without changing default display parsing", () => {
  const patch =
    "diff --git a/src/café.ts b/src/café.ts\nindex aaaaaaa..bbbbbbb 100644\n--- a/src/café.ts\n+++ b/src/café.ts\n@@ -2 +2 @@ heading\n-old café\n+new café\n@@ -20 +20 @@\n-old end\n\\ No newline at end of file\n+new end\n\\ No newline at end of file\n";
  const ordinary = parseUnifiedDiff(patch);
  const retained = parseUnifiedDiff(patch, { retainSource: true });
  const stripped = retained.map(({ source: _source, ...file }) => ({
    ...file,
    hunks: file.hunks.map(({ source: _source, ...hunk }) => hunk),
  }));
  expect(stripped).toEqual(ordinary);
  const file = retained[0];
  if (file?.source === undefined) throw new Error("Raw file span missing");
  const rawHunks = file.hunks.map((hunk) => {
    if (hunk.source === undefined) throw new Error("Raw hunk span missing");
    return patch.slice(hunk.source.start, hunk.source.end);
  });
  expect(patch.slice(file.source.start, file.source.headerEnd) + rawHunks.join("")).toBe(patch);
  expect(rawHunks[0]).toBe("@@ -2 +2 @@ heading\n-old café\n+new café\n");
  expect(rawHunks[1]).toContain("\\ No newline at end of file\n");
  expect(diffSourceLines(file, "modified")).toEqual([
    { line: 2, text: "new café" },
    { line: 20, text: "new end" },
  ]);
  expect(ordinary[0]).not.toHaveProperty("source");
});

it("ends a deleted file's raw hunk exactly before the next binary file", () => {
  const first =
    "diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\nindex aaaaaaa..0000000\n--- a/gone.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-removed\n\\ No newline at end of file\n";
  const second =
    "diff --git a/image.png b/image.png\nindex aaaaaaa..bbbbbbb 100644\nBinary files a/image.png and b/image.png differ\n";
  const patch = first + second;
  const files = parseUnifiedDiff(patch, { retainSource: true });
  const deleted = files[0];
  const binary = files[1];
  expect(deleted?.change).toBe("deleted");
  expect(deleted?.source?.end).toBe(first.length);
  const hunk = deleted?.hunks[0];
  if (hunk?.source === undefined || binary?.source === undefined)
    throw new Error("Raw boundaries missing");
  expect(patch.slice(hunk.source.start, hunk.source.end)).toBe(first.slice(first.indexOf("@@")));
  expect(patch.slice(binary.source.start, binary.source.end)).toBe(second);
  expect(binary.binary).toBe(true);
  expect(binary.hunks).toEqual([]);
});

it("keeps header-like removed and added source lines inside their hunk", () => {
  const patch =
    "diff --git a/header.txt b/header.txt\nindex aaaaaaa..bbbbbbb 100644\n--- a/header.txt\n+++ b/header.txt\n@@ -1 +1 @@\n--- old comment\n+++ new comment\n";
  for (const options of [{}, { retainSource: true }]) {
    const file = parseUnifiedDiff(patch, options)[0];
    expect(file?.path).toBe("header.txt");
    expect(file?.original).toBe("-- old comment");
    expect(file?.modified).toBe("++ new comment");
    if (file === undefined) throw new Error("Parsed file missing");
    expect(diffSourceLines(file, "original")).toEqual([{ line: 1, text: "-- old comment" }]);
    expect(diffSourceLines(file, "modified")).toEqual([{ line: 1, text: "++ new comment" }]);
  }
});
