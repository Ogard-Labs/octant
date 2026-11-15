import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyProtectedFilesChoice, currentProtectedFilesChoice } from "../process/secretGuard";
import { claudeSessionInstructions } from "./claudeDriver";
import { MAX_CLAUDE_INSTRUCTION_FILE_BYTES } from "./claudeInstructionFiles";

let base: string;
let configDir: string;
let projectRoot: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "octant-claude-instructions-")));
  configDir = join(base, "config");
  projectRoot = join(base, "project");
  await mkdir(configDir);
  await mkdir(join(projectRoot, ".claude"), { recursive: true });
  await writeFile(join(configDir, "CLAUDE.md"), "Global: answer briefly.");
  await writeFile(join(projectRoot, "CLAUDE.md"), "Project: use tabs.\n\nSee @docs/style.md");
  await mkdir(join(projectRoot, "docs"));
  await writeFile(join(projectRoot, "docs", "style.md"), "Imported: no semicolons.");
  await writeFile(join(projectRoot, ".claude", "CLAUDE.md"), "Dot folder: run the tests.");
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const instructionsFor = (
  overrides: Partial<Parameters<typeof claudeSessionInstructions>[0]> = {},
  diagnostics: string[] = [],
) =>
  claudeSessionInstructions({
    mode: "code",
    executionPolicy: "approval-gated",
    singleUse: false,
    nativeSetup: undefined,
    projectRoot,
    environment: { CLAUDE_CONFIG_DIR: configDir },
    onDiagnostic: (message) => diagnostics.push(message),
    ...overrides,
  });

describe("Claude instruction files", () => {
  it("gives an untrusted Project's session the global and Project CLAUDE.md text, imports included", async () => {
    const text = await instructionsFor();
    expect(text).toContain("Global: answer briefly.");
    expect(text).toContain("Project: use tabs.");
    expect(text).toContain("Imported: no semicolons.");
    expect(text).toContain("Dot folder: run the tests.");
  });

  it("gives a Work turn the same instruction files", async () => {
    const text = await instructionsFor({ mode: "work" });
    expect(text).toContain("Global: answer briefly.");
    expect(text).toContain("Project: use tabs.");
  });

  it("adds nothing in a trusted Project, where Claude Code loads the files itself", async () => {
    const trusted = await instructionsFor({
      nativeSetup: {
        subagents: false,
        webTools: false,
        skills: false,
        toolServers: false,
        hooks: false,
        projectCode: true,
      },
    });
    expect(trusted).toBeUndefined();
  });

  it("reads nothing for Chat, which has no folder", async () => {
    expect(await instructionsFor({ mode: "chat" })).toBeUndefined();
  });

  it("skips an oversized file and a symlink out of the Project, saying why", async () => {
    await writeFile(
      join(projectRoot, "CLAUDE.md"),
      "x".repeat(MAX_CLAUDE_INSTRUCTION_FILE_BYTES + 1),
    );
    const outside = join(base, "secret.md");
    await writeFile(outside, "Outside: never read.");
    await rm(join(projectRoot, ".claude", "CLAUDE.md"));
    await symlink(outside, join(projectRoot, ".claude", "CLAUDE.md"));
    const diagnostics: string[] = [];

    const text = await instructionsFor({}, diagnostics);

    expect(text).toContain("Global: answer briefly.");
    expect(text).not.toContain("xxxx");
    expect(text).not.toContain("Outside: never read.");
    expect(diagnostics).toEqual([
      `Claude instruction file ${join(projectRoot, "CLAUDE.md")} was not read: too-large.`,
      `Claude instruction file ${join(projectRoot, ".claude", "CLAUDE.md")} was not read: outside-folder.`,
    ]);
  });

  it("follows a home-relative or absolute import into the account's config folder and no further", async () => {
    await writeFile(join(configDir, "shared.md"), "Shared: write plain sentences.");
    await writeFile(join(configDir, "absolute.md"), "Absolute: keep tests close.");
    const outside = join(base, "elsewhere.md");
    await writeFile(outside, "Elsewhere: never read.");
    await writeFile(
      join(projectRoot, "CLAUDE.md"),
      [
        "Project: use tabs.",
        "See @~/config/shared.md and @" + join(configDir, "absolute.md"),
        "and @" + outside,
        "~~~",
        "@docs/style.md stays text inside a fence",
        "~~~",
      ].join("\n"),
    );
    const home = process.env.HOME;
    process.env.HOME = base;
    try {
      const text = await instructionsFor();
      expect(text).toContain("Shared: write plain sentences.");
      expect(text).toContain("Absolute: keep tests close.");
      expect(text).not.toContain("Elsewhere: never read.");
      expect(text).not.toContain("Imported: no semicolons.");
    } finally {
      if (home === undefined) delete process.env.HOME;
      else process.env.HOME = home;
    }
  });

  it.each(["approval-gated", "plan"] as const)(
    "skips an import the secret guard protects at %s and still loads an ordinary one",
    async (executionPolicy) => {
      const envFile = join(projectRoot, ".env");
      await writeFile(envFile, "TOKEN=never-read");
      await writeFile(
        join(projectRoot, "CLAUDE.md"),
        "Project: use tabs.\n\nSee @docs/style.md and @.env",
      );
      const before = currentProtectedFilesChoice();
      // The person added the Project's `.env` to their protected files.
      applyProtectedFilesChoice({ added: [envFile], removed: [] });
      const diagnostics: string[] = [];
      try {
        const text = await instructionsFor({ executionPolicy }, diagnostics);
        expect(text).toContain("Imported: no semicolons.");
        expect(text).not.toContain("never-read");
        expect(diagnostics).toEqual([
          `Claude instruction file ${envFile} was not read: protected.`,
        ]);
      } finally {
        applyProtectedFilesChoice(before);
      }
    },
  );

  it.each(["approval-gated", "full-access"] as const)(
    "never reads the account's own sign-in file through an import, even at %s",
    async (executionPolicy) => {
      const credentials = join(configDir, ".credentials.json");
      await writeFile(credentials, '{"token":"account-secret"}');
      await writeFile(
        join(configDir, "CLAUDE.md"),
        "Global: answer briefly.\n\n@.credentials.json",
      );
      const diagnostics: string[] = [];

      const text = await instructionsFor({ executionPolicy }, diagnostics);

      expect(text).toContain("Global: answer briefly.");
      expect(text).toContain("Imported: no semicolons.");
      expect(text).not.toContain("account-secret");
      expect(diagnostics).toEqual([
        `Claude instruction file ${credentials} was not read: protected.`,
      ]);
    },
  );
});
