import { describe, expect, it } from "vitest";

import {
  CLAUDE_MEMORY_IMPORT_LIMITS,
  claudeMemoryImportNames,
  expandClaudeMemoryImports,
  type ClaudeMemoryFileRead,
} from "./claudeMemoryImports";

const project = "/work/app";
const home = "/home/person";
const config = `${home}/.claude`;

function reader(
  files: Readonly<Record<string, string>>,
  links: Readonly<Record<string, string>> = {},
): ClaudeMemoryFileRead {
  return (path) => {
    const realPath = links[path] ?? path;
    const text = files[realPath];
    return text === undefined ? undefined : { text, realPath };
  };
}

function expand(text: string, read: ClaudeMemoryFileRead) {
  return expandClaudeMemoryImports({
    path: `${project}/CLAUDE.md`,
    text,
    allowedRoots: [project, config],
    homeDirectory: home,
    read,
  });
}

describe("CLAUDE.md imports", () => {
  it("loads relative, nested, and home imports in the order Claude Code reads them", () => {
    const result = expand(
      "See @docs/style.md and @~/.claude/shared.md for more.",
      reader({
        [`${project}/docs/style.md`]: "Style: @./naming.md",
        [`${project}/docs/naming.md`]: "Name things plainly.",
        [`${config}/shared.md`]: "Shared rules.",
      }),
    );
    expect(result.entries.map((entry) => entry.path)).toEqual([
      `${project}/CLAUDE.md`,
      `${project}/docs/style.md`,
      `${project}/docs/naming.md`,
      `${config}/shared.md`,
    ]);
    expect(result.entries[2]?.text).toBe("Name things plainly.");
    expect(result.truncated).toBe(false);
  });

  it("refuses an import outside the Project and config folders, and one that escapes through a link", () => {
    const result = expand(
      "@/etc/passwd @../secrets.md @linked.md",
      reader(
        {
          "/etc/passwd": "root",
          "/work/secrets.md": "key",
          [`${home}/.ssh/id_ed25519`]: "private",
        },
        { [`${project}/linked.md`]: `${home}/.ssh/id_ed25519` },
      ),
    );
    expect(result.entries.map((entry) => entry.path)).toEqual([`${project}/CLAUDE.md`]);
  });

  it("treats an import inside code as text and ends a cycle", () => {
    expect(
      claudeMemoryImportNames("`@inline.md`\n```\n@fenced.md\n```\nmail me@example.com @real.md"),
    ).toEqual(["real.md"]);
    const result = expand(
      "@a.md",
      reader({
        [`${project}/CLAUDE.md`]: "@a.md",
        [`${project}/a.md`]: "@CLAUDE.md @a.md",
      }),
    );
    expect(result.entries.map((entry) => entry.path)).toEqual([
      `${project}/CLAUDE.md`,
      `${project}/a.md`,
    ]);
  });

  it("stops five hops from the first file and says the expansion was cut short", () => {
    const files: Record<string, string> = {};
    for (let index = 1; index <= 7; index += 1) {
      files[`${project}/${index}.md`] = `@${index + 1}.md`;
    }
    const result = expand("@1.md", reader(files));
    expect(result.entries).toHaveLength(CLAUDE_MEMORY_IMPORT_LIMITS.maxDepth + 1);
    expect(result.truncated).toBe(true);
  });
});
