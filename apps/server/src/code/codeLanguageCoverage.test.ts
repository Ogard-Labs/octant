import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LanguageServerHostPlatform } from "@octant/domain";
import { foldersHoldCoveredFile } from "./codeLanguageCoverage";
import { CodeLanguageService, type CodeLanguageServerComponent } from "./codeLanguageService";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function checkout(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "octant-language-coverage-"));
  folders.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

function server(
  languages: ReadonlyArray<string>,
  launchClass: CodeLanguageServerComponent["launchClass"],
): CodeLanguageServerComponent {
  return {
    componentKey: `${launchClass}-${languages.join("-")}`,
    approvalKey: `${launchClass}-${languages.join("-")}`,
    languages,
    launchClass,
    executable: async () => undefined,
    args: [],
    installRoot: "/nonexistent",
    sourceLabel: "fixture",
  };
}

function service(
  components: ReadonlyArray<CodeLanguageServerComponent>,
  platform: LanguageServerHostPlatform = "linux",
) {
  return new CodeLanguageService({
    authority: {} as never,
    components: () => components,
    processes: { launch: async () => ({ status: "confinement-unavailable" }) },
    platform,
    cacheRoot: "/nonexistent",
  });
}

const typescript = server(["typescript", "typescriptreact", "javascript"], "static");

describe("Code language reads offered to agents", () => {
  it("are offered when a server an agent may start covers a file of the checkout", () => {
    const folder = checkout({ "package.json": "{}", "src/app/index.ts": "export {};\n" });
    expect(service([typescript]).servesAgentsIn([folder])).toBe(true);
  });

  it("count a file in an extra folder of the turn as well as the checkout's", () => {
    const python = checkout({ "main.py": "print(1)\n" });
    const notes = checkout({ "notes/draw.js": "export {};\n" });
    expect(service([typescript]).servesAgentsIn([python])).toBe(false);
    expect(service([typescript]).servesAgentsIn([python, notes])).toBe(true);
  });

  it("are not offered where no server covers the checkout's files, its server is off, or only repository tooling covers it", () => {
    const python = checkout({ "pyproject.toml": "", "src/app/main.py": "print(1)\n" });
    const typed = checkout({ "src/index.ts": "export {};\n" });
    expect(service([typescript]).servesAgentsIn([python])).toBe(false);
    // The Settings switch removes the bundled server from the effective set.
    expect(service([]).servesAgentsIn([typed])).toBe(false);
    // An agent's read never starts or reads through a `repo-tooling` server.
    expect(service([server(["python"], "repo-tooling")]).servesAgentsIn([python])).toBe(false);
    expect(service([typescript], "windows").servesAgentsIn([typed])).toBe(false);
  });

  it("ignore dependencies and hidden folders, and do not follow links out of the checkout", () => {
    const outside = checkout({ "secret.ts": "export {};\n" });
    const folder = checkout({
      "node_modules/pkg/index.js": "",
      ".cache/build.ts": "",
      "README.md": "",
    });
    symlinkSync(outside, join(folder, "linked"));
    symlinkSync(join(outside, "secret.ts"), join(folder, "linked.ts"));
    expect(service([typescript]).servesAgentsIn([folder])).toBe(false);
  });

  it("stop looking once the scan's bounds are spent", () => {
    const folder = checkout({
      ...Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`docs/${i}.md`, ""])),
      "a/b/c/deep.ts": "",
    });
    const covered = (name: string) => name.endsWith(".ts");
    expect(foldersHoldCoveredFile([folder], covered, { entries: 200, depth: 6 })).toBe(true);
    expect(foldersHoldCoveredFile([folder], covered, { entries: 20, depth: 6 })).toBe(false);
    expect(foldersHoldCoveredFile([folder], covered, { entries: 200, depth: 2 })).toBe(false);
  });
});
