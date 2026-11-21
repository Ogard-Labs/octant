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

it("preserves old and new file modes for mode-only, binary-plus-mode, and mixed mode-and-content diffs", () => {
  const patch = [
    "diff --git a/scripts/check.sh b/scripts/check.sh",
    "old mode 100644",
    "new mode 100755",
    "diff --git a/assets/logo.png b/assets/logo.png",
    "old mode 100644",
    "new mode 100755",
    "index 1111111..2222222",
    "Binary files a/assets/logo.png and b/assets/logo.png differ",
    "diff --git a/scripts/run.sh b/scripts/run.sh",
    "old mode 100755",
    "new mode 100644",
    "index aaaaaaa..bbbbbbb",
    "--- a/scripts/run.sh",
    "+++ b/scripts/run.sh",
    "@@ -1 +1 @@",
    "-echo old",
    "+echo new",
  ].join("\n");
  const files = parseUnifiedDiff(patch);
  expect(files[0]?.path).toBe("scripts/check.sh");
  expect(files[0]?.binary).toBe(true);
  expect(files[0]?.modeOnly).toBe(true);
  expect(files[0]?.modeChange).toEqual({ oldMode: "100644", newMode: "100755" });
  expect(files[1]?.path).toBe("assets/logo.png");
  expect(files[1]?.binary).toBe(true);
  expect(files[1]?.modeOnly).toBeUndefined();
  expect(files[1]?.modeChange).toEqual({ oldMode: "100644", newMode: "100755" });
  expect(files[2]?.path).toBe("scripts/run.sh");
  expect(files[2]?.binary).toBe(false);
  expect(files[2]?.modeOnly).toBeUndefined();
  expect(files[2]?.modeChange).toEqual({ oldMode: "100755", newMode: "100644" });
});

it("preserves end-of-file no-newline markers on the lines they follow", () => {
  const patch = [
    "diff --git a/added-newline.txt b/added-newline.txt",
    "--- a/added-newline.txt",
    "+++ b/added-newline.txt",
    "@@ -1 +1 @@",
    "-hello",
    "\\ No newline at end of file",
    "+hello",
    "diff --git a/removed-newline.txt b/removed-newline.txt",
    "--- a/removed-newline.txt",
    "+++ b/removed-newline.txt",
    "@@ -1 +1 @@",
    "-hello",
    "+hello",
    "\\ No newline at end of file",
    "diff --git a/context-no-newline.txt b/context-no-newline.txt",
    "--- a/context-no-newline.txt",
    "+++ b/context-no-newline.txt",
    "@@ -1,2 +1,2 @@",
    "-old",
    "+new",
    " tail",
    "\\ No newline at end of file",
  ].join("\n");

  const files = parseUnifiedDiff(patch);
  expect(files[0]?.hunks[0]?.lines).toEqual([
    { kind: "removed", text: "hello", oldNumber: 1, noNewlineAtEndOfFile: true },
    { kind: "added", text: "hello", newNumber: 1 },
  ]);
  expect(files[1]?.hunks[0]?.lines).toEqual([
    { kind: "removed", text: "hello", oldNumber: 1 },
    { kind: "added", text: "hello", newNumber: 1, noNewlineAtEndOfFile: true },
  ]);
  expect(files[2]?.hunks[0]?.lines).toEqual([
    { kind: "removed", text: "old", oldNumber: 1 },
    { kind: "added", text: "new", newNumber: 1 },
    { kind: "context", text: "tail", oldNumber: 2, newNumber: 2, noNewlineAtEndOfFile: true },
  ]);
});

it("preserves creation and deletion modes for empty, executable, and binary files", () => {
  const patch = [
    "diff --git a/scripts/empty.sh b/scripts/empty.sh",
    "new file mode 100755",
    "index 0000000..e69de29",
    "diff --git a/obsolete.txt b/obsolete.txt",
    "deleted file mode 100644",
    "index e69de29..0000000",
    "diff --git a/scripts/start.sh b/scripts/start.sh",
    "new file mode 100755",
    "index 0000000..abcdef1",
    "--- /dev/null",
    "+++ b/scripts/start.sh",
    "@@ -0,0 +1 @@",
    "+#!/bin/sh",
    "diff --git a/assets/new.png b/assets/new.png",
    "new file mode 100644",
    "index 0000000..1234567",
    "Binary files /dev/null and b/assets/new.png differ",
  ].join("\n");

  const files = parseUnifiedDiff(patch);
  expect(files[0]).toMatchObject({
    path: "scripts/empty.sh",
    change: "created",
    fileMode: "100755",
    binary: true,
    emptyFile: true,
  });
  expect(files[1]).toMatchObject({
    path: "obsolete.txt",
    change: "deleted",
    fileMode: "100644",
    binary: true,
    emptyFile: true,
  });
  expect(files[2]).toMatchObject({
    path: "scripts/start.sh",
    change: "created",
    fileMode: "100755",
    binary: false,
  });
  expect(files[2]?.emptyFile).toBeUndefined();
  expect(files[3]).toMatchObject({
    path: "assets/new.png",
    change: "created",
    fileMode: "100644",
    binary: true,
  });
  expect(files[3]?.emptyFile).toBeUndefined();
});

it("decodes Git C-quoted UTF-8 octal and escape sequences in diff paths", () => {
  const patch = [
    'diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"',
    '--- "a/caf\\303\\251.txt"',
    '+++ "b/caf\\303\\251.txt"',
    "@@ -1 +1 @@",
    "-old",
    "+new",
    'diff --git "a/dir/\\"quote\\"\\tname.txt" "b/dir/\\"quote\\"\\tname.txt"',
    '--- "a/dir/\\"quote\\"\\tname.txt"',
    '+++ "b/dir/\\"quote\\"\\tname.txt"',
    "@@ -1 +1 @@",
    "-a",
    "+b",
    "diff --git a/plain\\keep.txt b/plain\\keep.txt",
    "--- a/plain\\keep.txt",
    "+++ b/plain\\keep.txt",
    "@@ -1 +1 @@",
    "-x",
    "+y",
  ].join("\n");

  const files = parseUnifiedDiff(patch);
  expect(files[0]?.path).toBe("café.txt");
  expect(files[0]?.previousPath).toBeUndefined();
  expect(files[0]?.change).toBe("modified");
  expect(files[1]?.path).toBe('dir/"quote"\tname.txt');
  expect(files[1]?.previousPath).toBeUndefined();
  expect(files[2]?.path).toBe("plain\\keep.txt");
});

it("preserves unquoted paths with spaces for empty deleted and added files", () => {
  const patch = [
    "diff --git a/my file.txt b/my file.txt",
    "deleted file mode 100644",
    "index e69de29..0000000",
    "diff --git a/another empty file.sh b/another empty file.sh",
    "new file mode 100755",
    "index 0000000..e69de29",
  ].join("\n");

  const files = parseUnifiedDiff(patch);
  expect(files[0]).toMatchObject({
    path: "my file.txt",
    change: "deleted",
    fileMode: "100644",
    binary: true,
    emptyFile: true,
  });
  expect(files[0]?.previousPath).toBeUndefined();
  expect(files[1]).toMatchObject({
    path: "another empty file.sh",
    change: "created",
    fileMode: "100755",
    binary: true,
    emptyFile: true,
  });
  expect(files[1]?.previousPath).toBeUndefined();
});

it("keeps invalid UTF-8 quoted paths distinct from literal replacement characters and flags nonUtf8Path", () => {
  const patch = [
    'diff --git "a/file-\\303.txt" "b/file-\\303.txt"',
    '--- "a/file-\\303.txt"',
    '+++ "b/file-\\303.txt"',
    "@@ -1 +1 @@",
    "-old invalid",
    "+new invalid",
    'diff --git "a/file-\\357\\277\\275.txt" "b/file-\\357\\277\\275.txt"',
    '--- "a/file-\\357\\277\\275.txt"',
    '+++ "b/file-\\357\\277\\275.txt"',
    "@@ -1 +1 @@",
    "-old replacement",
    "+new replacement",
  ].join("\n");

  const files = parseUnifiedDiff(patch);
  expect(files).toHaveLength(2);
  expect(files[0]?.path).toBe("file-\\303.txt");
  expect(files[0]?.nonUtf8Path).toBe(true);
  expect(files[1]?.path).toBe("file-\uFFFD.txt");
  expect(files[1]?.nonUtf8Path).toBeUndefined();
  expect(files[0]?.path).not.toBe(files[1]?.path);
});

it("preserves rename and copy paths containing spaces from rename/copy headers", () => {
  const patch = [
    "diff --git a/old name.txt b/new name.txt",
    "similarity index 100%",
    "rename from old name.txt",
    "rename to new name.txt",
    "diff --git a/source doc.md b/copied doc.md",
    "similarity index 100%",
    "copy from source doc.md",
    "copy to copied doc.md",
  ].join("\n");

  const files = parseUnifiedDiff(patch);
  expect(files[0]).toMatchObject({
    path: "new name.txt",
    previousPath: "old name.txt",
    change: "renamed",
    binary: true,
  });
  expect(files[1]).toMatchObject({
    path: "copied doc.md",
    previousPath: "source doc.md",
    change: "renamed",
    binary: true,
  });
});

it("preserves leading spaces in unquoted extended headers and leading UTF-8 BOMs in quoted paths", () => {
  const patch = [
    'diff --git "a/old\\tname.txt" "b/ file.txt"',
    "similarity index 100%",
    'rename from "old\\tname.txt"',
    "rename to  file.txt",
    'diff --git "a/\\357\\273\\277bom.txt" "b/\\357\\273\\277bom.txt"',
    "similarity index 100%",
    'rename from "old-bom.txt"',
    'rename to "\\357\\273\\277bom.txt"',
  ].join("\n");

  const files = parseUnifiedDiff(patch);
  expect(files[0]).toMatchObject({
    path: " file.txt",
    previousPath: "old\tname.txt",
    change: "renamed",
  });
  expect(files[1]?.path).toBe("\uFEFFbom.txt");
  expect(files[1]?.nonUtf8Path).toBeUndefined();
});

it("sets nonUtf8Path from the destination path on renames", () => {
  const patch = [
    'diff --git "a/file-\\303.txt" b/report.txt',
    "similarity index 100%",
    'rename from "file-\\303.txt"',
    "rename to report.txt",
    'diff --git a/report.txt "b/file-\\303.txt"',
    "similarity index 100%",
    "rename from report.txt",
    'rename to "file-\\303.txt"',
  ].join("\n");

  const files = parseUnifiedDiff(patch);
  expect(files[0]).toMatchObject({
    path: "report.txt",
    previousPath: "file-\\303.txt",
    change: "renamed",
    nonUtf8PreviousPath: true,
  });
  expect(files[0]?.nonUtf8Path).toBeUndefined();

  expect(files[1]).toMatchObject({
    path: "file-\\303.txt",
    previousPath: "report.txt",
    change: "renamed",
    nonUtf8Path: true,
  });
  expect(files[1]?.nonUtf8PreviousPath).toBeUndefined();
});
