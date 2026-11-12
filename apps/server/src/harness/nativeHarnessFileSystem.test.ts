import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { renameSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { secretGuardRefusal } from "../process/secretGuard";
import {
  buildDocxFixture,
  buildPdfFixture,
  buildPptxFixture,
  buildXlsxFixture,
} from "../preview/previewTestFixtures";
import {
  MAX_EXTRACTED_TEXT_BYTES,
  NativeHarnessFileSystem,
  readFileContent,
} from "./nativeHarnessFileSystem";

async function fixture(): Promise<{ readonly root: string; readonly fs: NativeHarnessFileSystem }> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "octant-harness-fs-")));
  await mkdir(join(root, "src", "nested"), { recursive: true });
  await mkdir(join(root, "node_modules", "dep"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "const a = 1;\nexport const b = a + 1;\n");
  await writeFile(join(root, "src", "nested", "c.ts"), "export const c = 3;\n");
  await writeFile(join(root, "node_modules", "dep", "index.ts"), "export const dep = 1;\n");
  await writeFile(join(root, "README.md"), "# fixture\n");
  return { root, fs: new NativeHarnessFileSystem({ root }) };
}

describe("native harness file tools and the secret guard", () => {
  // The root stands in for a home folder opened as the Project.
  async function homeFixture() {
    const root = await realpath(await mkdtemp(join(tmpdir(), "octant-harness-home-")));
    await mkdir(join(root, ".ssh"), { recursive: true });
    await writeFile(join(root, ".ssh", "id_test"), "fake private key\n");
    await writeFile(join(root, ".ssh", "config"), "Host example\n");
    await writeFile(join(root, "notes.md"), "fake private key mentioned here\n");
    await symlink(join(root, ".ssh", "id_test"), join(root, "key-link"));
    const fs = new NativeHarnessFileSystem({
      root,
      protectedFileRefusal: (path) =>
        secretGuardRefusal(path, { platform: "darwin", homeDirectory: root }),
    });
    return { root, fs };
  }

  it("refuses to read, write, or edit a protected file and names the rule and channel", async () => {
    const { fs } = await homeFixture();
    for (const outcome of [
      await fs.read({ path: ".ssh/id_test" }),
      await fs.read({ path: "key-link" }),
      await fs.write({ path: ".ssh/id_new", content: "x" }),
      await fs.edit({ path: ".ssh/id_test", oldText: "fake", newText: "x" }),
      await fs.editFiles([{ path: ".ssh/id_test", oldText: "fake", newText: "x" }]),
      await fs.grep({ pattern: "fake", path: ".ssh/id_test" }),
    ]) {
      expect(outcome.kind).toBe("refused");
      if (outcome.kind !== "refused") continue;
      expect(outcome.reason).toBe("protected-file");
      expect(outcome.message).toContain("SSH private keys");
      expect(outcome.message).toContain("SSH agent");
    }
    expect((await fs.read({ path: ".ssh/config" })).kind).toBe("file");
  });

  it("searches a folder without opening the protected files inside it", async () => {
    const { fs } = await homeFixture();
    const outcome = await fs.grep({ pattern: "fake private key" });
    expect(outcome.kind).toBe("matches");
    if (outcome.kind !== "matches") return;
    expect(outcome.matches.map((match) => match.path)).toEqual(["notes.md"]);
  });
});

describe("native harness file system", () => {
  it("reads and writes a Project's extra folder by absolute path and refuses the folder beside it", async () => {
    const { root } = await fixture();
    const notes = await realpath(await mkdtemp(join(tmpdir(), "octant-harness-notes-")));
    const beside = await realpath(await mkdtemp(join(tmpdir(), "octant-harness-beside-")));
    await writeFile(join(notes, "today.md"), "notes\n");
    await writeFile(join(beside, "secret.md"), "no\n");
    const fs = new NativeHarnessFileSystem({ root, extraRoots: [notes] });

    const read = await fs.read({ path: join(notes, "today.md") });
    expect(read.kind).toBe("file");
    expect(await fs.write({ path: join(notes, "new.md"), content: "x" })).toMatchObject({
      kind: "written",
    });
    expect(await fs.read({ path: join(beside, "secret.md") })).toEqual({
      kind: "refused",
      reason: "path-escapes-root",
    });
    expect(await fs.write({ path: join(beside, "new.md"), content: "x" })).toEqual({
      kind: "refused",
      reason: "path-escapes-root",
    });
    // Relative paths still resolve against the main folder.
    expect((await fs.read({ path: "README.md" })).kind).toBe("file");
  });

  it("refuses a symlink that points outside the root", async () => {
    const { root, fs } = await fixture();
    await symlink("/etc", join(root, "escape"));
    expect(await fs.read({ path: "escape/hosts" })).toEqual({
      kind: "refused",
      reason: "path-escapes-root",
    });
    expect(await fs.read({ path: "../../etc/hosts" })).toEqual({
      kind: "refused",
      reason: "path-escapes-root",
    });
  });

  it("refuses to write through a symlinked parent that leaves the root", async () => {
    const { root, fs } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "octant-harness-outside-"));
    await symlink(outside, join(root, "out"));
    expect(await fs.write({ path: "out/new.txt", content: "x" })).toEqual({
      kind: "refused",
      reason: "path-escapes-root",
    });
  });

  describe("an ancestor swapped for a link to a host folder after containment was checked", () => {
    // The secret guard runs between the containment check and the write, so it
    // stands in for the agent's own process flipping `src` to a link while the
    // server decides. A path `writeFile` resolved `src` again and followed it.
    async function swapping() {
      const root = await realpath(await mkdtemp(join(tmpdir(), "octant-harness-swap-")));
      const outside = await realpath(await mkdtemp(join(tmpdir(), "octant-harness-host-")));
      await mkdir(join(root, "src"));
      await writeFile(join(root, "src", "a.ts"), "same\n");
      await writeFile(join(outside, "a.ts"), "same\n");
      const when = new Date("2026-01-01T00:00:00.000Z");
      await utimes(join(root, "src", "a.ts"), when, when);
      await utimes(join(outside, "a.ts"), when, when);
      let armed = false;
      let swapped = false;
      const fs = new NativeHarnessFileSystem({
        root,
        protectedFileRefusal: () => {
          if (armed && !swapped) {
            swapped = true;
            renameSync(join(root, "src"), join(root, "src-real"));
            symlinkSync(outside, join(root, "src"));
          }
          return undefined;
        },
      });
      return { root, outside, fs, arm: () => (armed = true) };
    }

    it("never overwrites the host file of the same name", async () => {
      const { outside, fs, arm } = await swapping();
      arm();
      expect(await fs.write({ path: "src/a.ts", content: "agent\n" })).toMatchObject({
        kind: "refused",
      });
      expect(await readFile(join(outside, "a.ts"), "utf8")).toBe("same\n");
    });

    it("never creates a file in the host folder", async () => {
      const { outside, fs, arm } = await swapping();
      arm();
      expect(await fs.write({ path: "src/new.ts", content: "agent\n" })).toMatchObject({
        kind: "refused",
      });
      await expect(readFile(join(outside, "new.ts"), "utf8")).rejects.toThrow();
    });

    it("never writes an edit into the host file", async () => {
      const { outside, fs, arm } = await swapping();
      expect((await fs.read({ path: "src/a.ts" })).kind).toBe("file");
      arm();
      expect(await fs.edit({ path: "src/a.ts", oldText: "same", newText: "agent" })).toMatchObject({
        kind: "refused",
      });
      expect(await readFile(join(outside, "a.ts"), "utf8")).toBe("same\n");
    });

    it("still writes, creates under new folders, and edits when nothing is swapped", async () => {
      const { root, fs } = await swapping();
      expect(await fs.write({ path: "src/a.ts", content: "next\n" })).toMatchObject({
        kind: "written",
        created: false,
      });
      expect(await fs.write({ path: "src/deep/er/b.ts", content: "b\n" })).toMatchObject({
        kind: "written",
        created: true,
      });
      expect(await readFile(join(root, "src", "deep", "er", "b.ts"), "utf8")).toBe("b\n");
      // A created file keeps the mode a plain write gave it, not a private one.
      expect((await stat(join(root, "src", "deep", "er", "b.ts"))).mode & 0o777).toBe(
        0o666 & ~process.umask(),
      );
      expect(await fs.edit({ path: "src/a.ts", oldText: "next", newText: "last" })).toMatchObject({
        kind: "edited",
      });
      expect(await readFile(join(root, "src", "a.ts"), "utf8")).toBe("last\n");
    });
  });

  it("reads numbered pages and says where to continue when a file is cut", async () => {
    const { root, fs } = await fixture();
    await writeFile(
      join(root, "big.txt"),
      Array.from({ length: 5_000 }, (_, index) => `line ${index}`).join("\n"),
    );
    const page = await fs.read({ path: "big.txt", limit: 10 });
    expect(page.kind).toBe("file");
    if (page.kind !== "file") return;
    expect(page.lines).toHaveLength(10);
    expect(page.nextLine).toBe(10);
    expect(page.bounds.truncated).toBe(true);
    expect(page.bounds.omittedBytes).toBeGreaterThan(0);
    const next = await fs.read({ path: "big.txt", offset: page.nextLine, limit: 10 });
    expect(next.kind === "file" && next.lines[0]).toBe("line 10");
  });

  it("refuses an edit before a read, and after the file changed under it", async () => {
    const { root, fs } = await fixture();
    expect(await fs.edit({ path: "src/a.ts", oldText: "1", newText: "2" })).toEqual({
      kind: "refused",
      reason: "not-read-first",
    });
    await fs.read({ path: "src/a.ts" });
    const later = new Date(Date.now() + 5_000);
    await utimes(join(root, "src", "a.ts"), later, later);
    expect(await fs.edit({ path: "src/a.ts", oldText: "1", newText: "2" })).toEqual({
      kind: "refused",
      reason: "file-changed-since-read",
    });
  });

  it("edits an exact match, refuses an ambiguous one, and replaces all when asked", async () => {
    const { fs } = await fixture();
    await fs.read({ path: "src/a.ts" });
    expect(await fs.edit({ path: "src/a.ts", oldText: "a", newText: "z" })).toEqual({
      kind: "refused",
      reason: "old-text-ambiguous",
    });
    const edited = await fs.edit({
      path: "src/a.ts",
      oldText: "const a = 1;",
      newText: "const a = 9;",
    });
    expect(edited).toMatchObject({ kind: "edited", replacements: 1, fuzzy: false });
    const all = await fs.edit({ path: "src/a.ts", oldText: "a", newText: "q", replaceAll: true });
    expect(all).toMatchObject({ kind: "edited", replacements: 2 });
    const after = await fs.read({ path: "src/a.ts" });
    expect(after.kind === "file" && after.lines.join("\n")).toBe(
      "const q = 9;\nexport const b = q + 1;\n",
    );
  });

  it("retries an edit once with whitespace normalized and keeps the file's own indentation before it", async () => {
    const { root, fs } = await fixture();
    await writeFile(join(root, "src", "w.ts"), "function f() {\n    return   1;\n}\n");
    await fs.read({ path: "src/w.ts" });
    const edited = await fs.edit({ path: "src/w.ts", oldText: "return 1;", newText: "return 2;" });
    expect(edited).toMatchObject({ kind: "edited", fuzzy: true });
    const after = await fs.read({ path: "src/w.ts" });
    expect(after.kind === "file" && after.lines[1]).toBe("    return 2;");
  });

  it("applies several replacements across files in one call, in order within a file", async () => {
    const { root, fs } = await fixture();
    await fs.read({ path: "src/a.ts" });
    await fs.read({ path: "src/nested/c.ts" });
    const outcome = await fs.editFiles([
      { path: "src/a.ts", oldText: "const a = 1;", newText: "const a = 2;" },
      { path: "src/nested/c.ts", oldText: "3", newText: "4" },
      // Matches only the text the first replacement left.
      { path: "./src/a.ts", oldText: "a = 2", newText: "a = 5" },
    ]);
    expect(outcome).toEqual({
      kind: "edited",
      files: [
        { path: "src/a.ts", replacements: 2, fuzzy: false },
        { path: "src/nested/c.ts", replacements: 1, fuzzy: false },
      ],
    });
    expect(await readFile(join(root, "src", "a.ts"), "utf8")).toBe(
      "const a = 5;\nexport const b = a + 1;\n",
    );
    expect(await readFile(join(root, "src", "nested", "c.ts"), "utf8")).toBe(
      "export const c = 4;\n",
    );
    // The call's own writes count as read, so the next edit needs no re-read.
    expect(await fs.edit({ path: "src/a.ts", oldText: "a = 5", newText: "a = 6" })).toMatchObject({
      kind: "edited",
    });
  });

  it("changes no file when any replacement is refused, and names the one that was", async () => {
    const { root, fs } = await fixture();
    await fs.read({ path: "src/a.ts" });
    await fs.read({ path: "src/nested/c.ts" });
    const before = await readFile(join(root, "src", "a.ts"), "utf8");
    expect(
      await fs.editFiles([
        { path: "src/a.ts", oldText: "const a = 1;", newText: "const a = 2;" },
        { path: "README.md", oldText: "fixture", newText: "x" },
      ]),
    ).toEqual({ kind: "refused", reason: "not-read-first", edit: 1 });
    expect(
      await fs.editFiles([
        { path: "src/a.ts", oldText: "const a = 1;", newText: "const a = 2;" },
        { path: "src/nested/c.ts", oldText: "missing", newText: "x" },
      ]),
    ).toEqual({ kind: "refused", reason: "old-text-not-found", edit: 1 });
    expect(
      await fs.editFiles([
        { path: "src/nested/c.ts", oldText: "3", newText: "4" },
        { path: "src/a.ts", oldText: "a", newText: "z" },
      ]),
    ).toEqual({ kind: "refused", reason: "old-text-ambiguous", edit: 1 });
    const later = new Date(Date.now() + 5_000);
    await utimes(join(root, "src", "nested", "c.ts"), later, later);
    expect(
      await fs.editFiles([
        { path: "src/a.ts", oldText: "const a = 1;", newText: "const a = 2;" },
        { path: "src/nested/c.ts", oldText: "3", newText: "4" },
      ]),
    ).toEqual({ kind: "refused", reason: "file-changed-since-read", edit: 1 });
    expect(await readFile(join(root, "src", "a.ts"), "utf8")).toBe(before);
    expect(await readFile(join(root, "src", "nested", "c.ts"), "utf8")).toBe(
      "export const c = 3;\n",
    );
  });

  it.skipIf(process.getuid?.() === 0)(
    "puts back the files it wrote when a later write fails",
    async () => {
      const { root, fs } = await fixture();
      await fs.read({ path: "src/a.ts" });
      await fs.read({ path: "src/nested/c.ts" });
      await chmod(join(root, "src", "nested", "c.ts"), 0o444);
      const outcome = await fs.editFiles([
        { path: "src/a.ts", oldText: "const a = 1;", newText: "const a = 2;" },
        { path: "src/nested/c.ts", oldText: "3", newText: "4" },
      ]);
      expect(outcome).toEqual({ kind: "write-failed", path: "src/nested/c.ts", unrestored: [] });
      expect(await readFile(join(root, "src", "a.ts"), "utf8")).toBe(
        "const a = 1;\nexport const b = a + 1;\n",
      );
      expect(await readFile(join(root, "src", "nested", "c.ts"), "utf8")).toBe(
        "export const c = 3;\n",
      );
    },
  );

  it("skips node_modules in glob and grep unless the pattern names it", async () => {
    const { fs } = await fixture();
    const files = await fs.glob({ pattern: "**/*.ts" });
    expect(files.kind === "paths" && files.paths).toEqual(["src/a.ts", "src/nested/c.ts"]);
    const explicit = await fs.glob({ pattern: "node_modules/**/*.ts" });
    expect(explicit.kind === "paths" && explicit.paths).toEqual(["node_modules/dep/index.ts"]);
    const matches = await fs.grep({ pattern: "export const", include: "*.ts" });
    expect(matches.kind === "matches" && matches.matches.map((match) => match.path)).toEqual([
      "src/a.ts",
      "src/nested/c.ts",
    ]);
  });

  it("reads an image by its content, whatever the file is named", async () => {
    const { root, fs } = await fixture();
    const gif = Buffer.from("GIF89a\x01\x00\x01\x00\x00\x00\x00;", "latin1");
    await writeFile(join(root, "pixel.dat"), gif);
    expect(await fs.read({ path: "pixel.dat" })).toEqual({
      kind: "image",
      path: "pixel.dat",
      mimeType: "image/gif",
      bytes: gif.length,
      data: gif.toString("base64"),
    });
  });

  describe("reading office documents and PDFs as text", () => {
    it("reads a Word document's paragraphs, whatever the file is named", async () => {
      const { root, fs } = await fixture();
      await writeFile(join(root, "notes.bin"), buildDocxFixture(["First point", "Second point"]));
      expect(await fs.read({ path: "notes.bin" })).toMatchObject({
        kind: "file",
        extractedFrom: "docx",
        lines: ["First point", "Second point"],
      });
    });

    it("reads a presentation's slides in order", async () => {
      const { root, fs } = await fixture();
      await writeFile(
        join(root, "deck.pptx"),
        buildPptxFixture([
          { title: "Plan", bullets: ["Ship it"] },
          { title: "Risks", bullets: ["None known"] },
        ]),
      );
      expect(await fs.read({ path: "deck.pptx" })).toMatchObject({
        kind: "file",
        extractedFrom: "pptx",
        lines: ["--- Slide 1 ---", "Plan", "Ship it", "--- Slide 2 ---", "Risks", "None known"],
      });
    });

    it("reads a PDF's text page by page", async () => {
      const { root, fs } = await fixture();
      await writeFile(join(root, "paper.pdf"), buildPdfFixture([["Abstract"], ["Results"]]));
      const outcome = await fs.read({ path: "paper.pdf" });
      expect(outcome).toMatchObject({ kind: "file", extractedFrom: "pdf" });
      const text = outcome.kind === "file" ? outcome.lines.join("\n") : "";
      expect(text).toMatch(/^--- Page 1 ---\n.*Abstract[\s\S]*--- Page 2 ---\n.*Results/);
    });

    it("reads each worksheet of a workbook as tab-separated rows", async () => {
      const { root, fs } = await fixture();
      await writeFile(
        join(root, "budget.xlsx"),
        buildXlsxFixture([
          ["Item", "Cost"],
          ["Disk", "40"],
        ]),
      );
      const outcome = await fs.read({ path: "budget.xlsx" });
      expect(outcome).toMatchObject({ kind: "file", extractedFrom: "xlsx" });
      const lines = outcome.kind === "file" ? outcome.lines : [];
      expect(lines[0]).toMatch(/^--- Sheet: .+ ---$/);
      expect(lines.slice(1, 3)).toEqual(["Item\tCost", "Disk\t40"]);
    });

    it("pages a long document with offset and limit", async () => {
      const { root, fs } = await fixture();
      const paragraphs = Array.from({ length: 50 }, (_, index) => `Paragraph ${index}`);
      await writeFile(join(root, "long.docx"), buildDocxFixture(paragraphs));
      const page = await fs.read({ path: "long.docx", limit: 10 });
      expect(page).toMatchObject({ kind: "file", nextLine: 10, bounds: { truncated: true } });
      const next = await fs.read({ path: "long.docx", offset: 10, limit: 10 });
      expect(next.kind === "file" && next.lines[0]).toBe("Paragraph 10");
    });

    it("says when the parser's own limit cut the document", async () => {
      const { root, fs } = await fixture();
      // One paragraph longer than the parser keeps of any paragraph.
      await writeFile(join(root, "cut.docx"), buildDocxFixture(["x".repeat(300 * 1024)]));
      const outcome = await fs.read({ path: "cut.docx" });
      expect(outcome).toMatchObject({ kind: "file", extractedFrom: "docx" });
      expect(outcome.kind === "file" && outcome.parserNote).toContain("limit");
    });

    it("stops a workbook's text at the extraction budget when one large shared string repeats", async () => {
      // 2,000 rows that each name the same 32,767-character string expand to
      // about 64 MB of text from a file the size of one copy of it.
      const big = "x".repeat(32_767);
      const content = Buffer.from(
        buildXlsxFixture(
          Array.from({ length: 2_000 }, () => [big]),
          { sharedStrings: true },
        ),
      );
      const started = Date.now();
      const outcome = readFileContent("big.xlsx", content, {});
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(outcome).toMatchObject({ kind: "file", extractedFrom: "xlsx" });
      if (outcome.kind !== "file") return;
      expect(outcome.parserNote).toContain("limit");
      // A read counts a newline after every line, the last one included.
      const pagedBytes = outcome.bounds.returnedBytes + (outcome.bounds.omittedBytes ?? 0);
      expect(pagedBytes).toBeLessThanOrEqual(MAX_EXTRACTED_TEXT_BYTES + 1);
    });

    it("says when one PDF page held more text than the parser keeps of a page", async () => {
      const { root, fs } = await fixture();
      await writeFile(join(root, "long.pdf"), buildPdfFixture([["y".repeat(300 * 1024)]]));
      const outcome = await fs.read({ path: "long.pdf" });
      expect(outcome).toMatchObject({ kind: "file", extractedFrom: "pdf" });
      expect(outcome.kind === "file" && outcome.parserNote).toContain("limit");
    });

    it("refuses an archive or other binary file and says what it can read", async () => {
      const { root, fs } = await fixture();
      await writeFile(join(root, "bundle.zip"), Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));
      await writeFile(join(root, "tool"), Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0]));
      for (const path of ["bundle.zip", "tool"]) {
        const outcome = await fs.read({ path });
        expect(outcome).toMatchObject({ kind: "refused", reason: "binary-file" });
        expect(outcome.kind === "refused" && outcome.message).toContain("Word");
      }
    });

    it("reads text whose first bytes end partway through a character", async () => {
      const { root, fs } = await fixture();
      await writeFile(join(root, "norsk.txt"), `${"a".repeat(4_095)}ø\n`);
      expect((await fs.read({ path: "norsk.txt" })).kind).toBe("file");
    });

    it("does not count a document read as a read before an edit", async () => {
      const { root, fs } = await fixture();
      await writeFile(join(root, "notes.docx"), buildDocxFixture(["First point"]));
      await fs.read({ path: "notes.docx" });
      expect(await fs.edit({ path: "notes.docx", oldText: "First", newText: "Last" })).toEqual({
        kind: "refused",
        reason: "not-read-first",
      });
    });
  });

  it("refuses an image larger than one tool image may carry and names the limit", async () => {
    const { root, fs } = await fixture();
    const png = Buffer.alloc(2 * 1024 * 1024);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png);
    await writeFile(join(root, "large.png"), png);
    const outcome = await fs.read({ path: "large.png" });
    expect(outcome).toMatchObject({ kind: "refused", reason: "file-too-large" });
    expect(outcome.kind === "refused" && outcome.message).toContain("1572864 bytes");
  });

  it("caps grep results and says so", async () => {
    const { fs } = await fixture();
    const matches = await fs.grep({ pattern: "const", maxMatches: 1 });
    expect(matches.kind === "matches" && matches.matches).toHaveLength(1);
    expect(matches.kind === "matches" && matches.bounds.truncated).toBe(true);
  });
});
