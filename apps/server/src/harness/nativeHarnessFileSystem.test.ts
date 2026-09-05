import { mkdtemp, mkdir, realpath, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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

describe("native harness file system", () => {
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

  it("caps grep results and says so", async () => {
    const { fs } = await fixture();
    const matches = await fs.grep({ pattern: "const", maxMatches: 1 });
    expect(matches.kind === "matches" && matches.matches).toHaveLength(1);
    expect(matches.kind === "matches" && matches.bounds.truncated).toBe(true);
  });
});
