import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { suggestProjectActions } from "./projectActionSuggestions";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function folder(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "octant-action-suggestions-"));
  directories.push(root);
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  return root;
}

describe("Project action suggestions", () => {
  it("offers a package's scripts with the manager its lockfile names, leaving out install hooks", async () => {
    const root = folder({
      "package.json": JSON.stringify({
        scripts: { dev: "vite", test: "vitest", postinstall: "node x.js", prebuild: "x" },
      }),
      "bun.lock": "",
    });

    expect(await suggestProjectActions(root)).toEqual([
      { name: "Dev", command: "bun run dev", directory: ".", source: "package.json" },
      { name: "Test", command: "bun run test", directory: ".", source: "package.json" },
    ]);
  });

  it("offers Makefile targets, skipping variables, pattern rules and special targets", async () => {
    const root = folder({
      Makefile: [
        ".PHONY: build test",
        "CC := gcc",
        "build: main.o",
        "\tcc -o app main.o",
        "%.o: %.c",
        "test:",
      ].join("\n"),
    });

    expect(await suggestProjectActions(root)).toEqual([
      { name: "Build", command: "make build", directory: ".", source: "Makefile" },
      { name: "Test", command: "make test", directory: ".", source: "Makefile" },
    ]);
  });

  it("offers nothing from a malformed, symlinked, or missing file", async () => {
    const root = folder({ "package.json": "{ not json" });
    const outside = folder({ Makefile: "evil:\n" });
    symlinkSync(join(outside, "Makefile"), join(root, "Makefile"));
    mkdirSync(join(root, "nested"));

    expect(await suggestProjectActions(root)).toEqual([]);
    expect(await suggestProjectActions(join(root, "nested"))).toEqual([]);
  });
});
