import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_PREVIEW_PDF_PAGES } from "../preview/previewFormatBudget";
import {
  buildDocxFixture,
  buildPdfFixture,
  buildPptxFixture,
  buildXlsxFixture,
} from "../preview/previewTestFixtures";
import { secretGuardRefusal } from "../process/secretGuard";
import { NativeHarnessFileSystem } from "./nativeHarnessFileSystem";

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

  it("reads a PDF, Word, PowerPoint or Excel file as its text, recognized by content rather than name", async () => {
    const { root, fs } = await fixture();
    await writeFile(
      join(root, "paper.bin"),
      buildPdfFixture([["Abstract", "Results"], ["Appendix"]]),
    );
    await writeFile(join(root, "letter"), buildDocxFixture(["Dear Ada,", "Thanks & regards"]));
    await writeFile(
      join(root, "deck.dat"),
      buildPptxFixture([
        { title: "Plan", bullets: ["Ship"] },
        { title: "Risks", bullets: [] },
      ]),
    );
    await writeFile(
      join(root, "budget.zip"),
      buildXlsxFixture([
        ["Item", "Cost"],
        ["Rent", "1200"],
      ]),
    );
    expect(await fs.read({ path: "paper.bin" })).toMatchObject({
      kind: "file",
      format: "pdf",
      lines: ["[Page 1]", "Abstract", "Results", "", "[Page 2]", "Appendix"],
    });
    expect(await fs.read({ path: "letter" })).toMatchObject({
      format: "docx",
      lines: ["Dear Ada,", "Thanks & regards"],
    });
    const deck = await fs.read({ path: "deck.dat" });
    expect(deck).toMatchObject({ format: "pptx" });
    const deckText = deck.kind === "file" ? deck.lines.join("\n") : "";
    expect(deckText.indexOf("[Slide 1]\nPlan")).toBe(0);
    expect(deckText.indexOf("Ship")).toBeLessThan(deckText.indexOf("[Slide 2]\nRisks"));
    const sheet = await fs.read({ path: "budget.zip" });
    expect(sheet).toMatchObject({ format: "xlsx" });
    expect(sheet.kind === "file" && sheet.lines.slice(1)).toEqual(["Item\tCost", "Rent\t1200"]);
    expect(sheet.kind === "file" && sheet.lines[0]).toMatch(/^\[Sheet: .+\]$/);
  });

  it("pages a long document with offset and limit, and says when the reader's limits cut it", async () => {
    const { root, fs } = await fixture();
    const paragraphs = Array.from({ length: 30 }, (_, index) => `Paragraph ${index + 1}`);
    await writeFile(join(root, "long.docx"), buildDocxFixture(paragraphs));
    expect(await fs.read({ path: "long.docx", offset: 10, limit: 5 })).toMatchObject({
      format: "docx",
      startLine: 10,
      lines: paragraphs.slice(10, 15),
      nextLine: 15,
      bounds: { truncated: true, nextOffset: 15 },
    });
    expect(await fs.read({ path: "long.docx" })).not.toHaveProperty("note");
    const pages = Array.from({ length: MAX_PREVIEW_PDF_PAGES + 1 }, () => ["x"]);
    await writeFile(join(root, "huge.pdf"), buildPdfFixture(pages));
    expect(await fs.read({ path: "huge.pdf", limit: 1 })).toMatchObject({
      format: "pdf",
      note: expect.stringContaining("cut"),
    });
  });

  it("refuses an archive, a database, media, an executable or an old Office file as binary", async () => {
    const { root, fs } = await fixture();
    const binaries: Record<string, Buffer> = {
      "bundle.zip": Buffer.from("PK\x03\x04\x14\x00\x00\x00\x08\x00", "latin1"),
      "notes.txt": Buffer.from("SQLite format 3\x00\x10\x00", "latin1"),
      "song.mp3": Buffer.from("ID3\x04\x00\x00\x00\x00\x00\x00", "latin1"),
      "clip.mp4": Buffer.from("\x00\x00\x00\x18ftypmp42", "latin1"),
      tool: Buffer.from("\x7fELF\x02\x01\x01\x00\x00\x00", "latin1"),
      "old.doc": Buffer.from("\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1\x00\x00", "latin1"),
    };
    for (const [name, bytes] of Object.entries(binaries)) {
      await writeFile(join(root, name), bytes);
      expect(await fs.read({ path: name })).toMatchObject({
        kind: "refused",
        reason: "binary-file",
        message: expect.stringContaining("binary"),
      });
    }
    // Text in another encoding still reads, as it did before.
    await writeFile(join(root, "latin1.txt"), Buffer.from("caf\xe9\n", "latin1"));
    expect(await fs.read({ path: "latin1.txt" })).toMatchObject({ kind: "file" });
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
