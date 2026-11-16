import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readClaudeGitIdentity } from "./claudeGitIdentity";

describe("Claude's git identity for sandboxed commits", () => {
  let folder: string;
  const saved = {
    global: process.env.GIT_CONFIG_GLOBAL,
    noSystem: process.env.GIT_CONFIG_NOSYSTEM,
  };

  beforeEach(async () => {
    folder = await realpath(await mkdtemp(join(tmpdir(), "octant-claude-git-identity-")));
    process.env.GIT_CONFIG_NOSYSTEM = "1";
  });

  afterEach(async () => {
    for (const [key, value] of [
      ["GIT_CONFIG_GLOBAL", saved.global],
      ["GIT_CONFIG_NOSYSTEM", saved.noSystem],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(folder, { recursive: true, force: true });
  });

  it("reads the identity git itself would use in the checkout, an includeIf file included", async () => {
    const checkout = join(folder, "work", "app");
    execFileSync("git", ["init", "-q", checkout]);
    const workIdentity = join(folder, "work.gitconfig");
    await writeFile(workIdentity, "[user]\n\temail = person@work.example\n");
    const globalConfig = join(folder, "global.gitconfig");
    await writeFile(
      globalConfig,
      [
        "[user]",
        "\tname = Person",
        "\temail = person@home.example",
        `[includeIf "gitdir:${join(folder, "work")}/"]`,
        `\tpath = ${workIdentity}`,
        "",
      ].join("\n"),
    );
    process.env.GIT_CONFIG_GLOBAL = globalConfig;

    await expect(readClaudeGitIdentity(checkout)).resolves.toEqual({
      name: "Person",
      email: "person@work.example",
    });
  });

  it("leaves out a field git has no value for", async () => {
    const checkout = join(folder, "app");
    execFileSync("git", ["init", "-q", checkout]);
    const globalConfig = join(folder, "global.gitconfig");
    await writeFile(globalConfig, "[user]\n\tname = Person\n");
    process.env.GIT_CONFIG_GLOBAL = globalConfig;

    await expect(readClaudeGitIdentity(checkout)).resolves.toEqual({ name: "Person" });
  });
});
