import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SkillDiscoveryService } from "./skillDiscoveryService";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("bounded standalone skill discovery", () => {
  it("walks only bounded project ancestry and user-global roots, rejects links, and stays disabled", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-skill-discovery-"));
    directories.push(root);
    const projectRoot = join(root, "project");
    const workingDirectory = join(projectRoot, "packages", "app");
    const globalRoot = join(root, "global", ".agents", "skills");
    await mkdir(workingDirectory, { recursive: true });
    await mkdir(join(projectRoot, ".agents", "skills", "root"), { recursive: true });
    await mkdir(join(projectRoot, "packages", ".agents", "skills", "parent"), { recursive: true });
    await mkdir(join(workingDirectory, ".agents", "skills", "nested"), { recursive: true });
    await mkdir(join(globalRoot, "global"), { recursive: true });
    await writeFile(join(projectRoot, ".agents", "skills", "root", "SKILL.md"), "# root\n");
    await writeFile(
      join(projectRoot, "packages", ".agents", "skills", "parent", "SKILL.md"),
      "# parent\n",
    );
    await writeFile(
      join(workingDirectory, ".agents", "skills", "nested", "SKILL.md"),
      "# nested\n",
    );
    await writeFile(join(globalRoot, "global", "SKILL.md"), "# global\n");
    await symlink(join(root, "outside"), join(projectRoot, ".agents", "skills", "escape"));
    await mkdir(join(root, "outside", ".agents", "skills", "unbounded"), { recursive: true });
    await writeFile(join(root, "outside", ".agents", "skills", "unbounded", "SKILL.md"), "# no\n");

    const service = new SkillDiscoveryService({
      roots: {
        resolve: async () => [
          {
            workingDirectory,
            projectRoot,
            projectRef: "project:fixture",
            scope: {
              mode: "code",
              projectId: "11111111-1111-4111-8111-111111111111" as never,
              threadRef: "22222222-2222-4222-8222-222222222222",
            },
            userGlobalSkillsRoot: globalRoot,
          },
        ],
      },
    });

    const result = await service.reconcile();
    expect(result.skills.map((entry) => entry.skill.name)).toEqual([
      "nested",
      "parent",
      "escape",
      "root",
      "global",
    ]);
    expect(result.skills.every((entry) => entry.desiredEnabled === false)).toBe(true);
    expect(result.skills.map((entry) => entry.effectiveState)).toEqual(
      result.skills.map(() => ({ kind: "blocked", reason: "review-required" })),
    );
    expect(result.skills.some((entry) => entry.skill.name === "unbounded")).toBe(false);
    expect(result.skills.some((entry) => entry.skill.name === "escape")).toBe(true);
    expect(
      result.skills
        .filter((entry) => ["nested", "parent"].includes(entry.skill.name))
        .every((entry) => entry.scope?.threadRef === "22222222-2222-4222-8222-222222222222"),
    ).toBe(true);
    expect(result.skills.find((entry) => entry.skill.name === "root")?.scope).toBeUndefined();
    expect(result.skills.find((entry) => entry.skill.name === "global")?.scope).toBeUndefined();
    expect(
      result.skills.find((entry) => entry.skill.name === "escape")?.skill.diagnostic?.code,
    ).toBe("symlink-package");
  });

  it("discovers .claude/skills in bounded project ancestry while keeping .agents/skills keys unchanged and ignoring non-allowlisted roots", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-skill-discovery-claude-"));
    directories.push(root);
    const projectRoot = join(root, "project");
    const workingDirectory = join(projectRoot, "packages", "app");
    const globalRoot = join(root, "global", ".agents", "skills");
    await mkdir(workingDirectory, { recursive: true });
    await mkdir(join(projectRoot, ".agents", "skills", "shared"), { recursive: true });
    await writeFile(join(projectRoot, ".agents", "skills", "shared", "SKILL.md"), "# agents\n");

    const baselineService = new SkillDiscoveryService({
      roots: {
        resolve: async () => [
          {
            workingDirectory,
            projectRoot,
            projectRef: "project:fixture",
            userGlobalSkillsRoot: globalRoot,
          },
        ],
      },
    });
    const baseline = await baselineService.reconcile();
    const baselineAgentsKey = baseline.skills.find((entry) => entry.skill.name === "shared")?.skill
      .qualifiedId;
    expect(baselineAgentsKey).toBeDefined();

    await mkdir(join(projectRoot, ".claude", "skills", "shared"), { recursive: true });
    await writeFile(join(projectRoot, ".claude", "skills", "shared", "SKILL.md"), "# claude\n");
    await mkdir(join(workingDirectory, ".claude", "skills", "claude-local"), { recursive: true });
    await writeFile(
      join(workingDirectory, ".claude", "skills", "claude-local", "SKILL.md"),
      "# local\n",
    );
    await symlink(join(root, "outside"), join(projectRoot, ".claude", "skills", "claude-escape"));
    await mkdir(join(root, "outside-root", "escaped-skill"), { recursive: true });
    await writeFile(join(root, "outside-root", "escaped-skill", "SKILL.md"), "# escaped\n");
    await mkdir(join(projectRoot, "packages", ".claude"), { recursive: true });
    await symlink(join(root, "outside-root"), join(projectRoot, "packages", ".claude", "skills"));
    await mkdir(join(projectRoot, ".cursor", "skills", "unlisted"), { recursive: true });
    await writeFile(join(projectRoot, ".cursor", "skills", "unlisted", "SKILL.md"), "# no\n");
    await mkdir(join(root, "global", ".claude", "skills", "global-claude"), { recursive: true });
    await writeFile(
      join(root, "global", ".claude", "skills", "global-claude", "SKILL.md"),
      "# no\n",
    );

    const result = await baselineService.reconcile();
    const agentsShared = result.skills.find(
      (entry) =>
        entry.skill.name === "shared" &&
        entry.source.kind === "agents-skills-directory" &&
        entry.source.sourceRef === "project:project:fixture:root",
    );
    const claudeShared = result.skills.find(
      (entry) =>
        entry.skill.name === "shared" &&
        entry.source.kind === "agents-skills-directory" &&
        entry.source.sourceRef === "project:project:fixture:claude:root",
    );
    const claudeLocal = result.skills.find((entry) => entry.skill.name === "claude-local");
    const claudeEscape = result.skills.find((entry) => entry.skill.name === "claude-escape");

    expect(agentsShared?.skill.qualifiedId).toBe(baselineAgentsKey);
    expect(claudeShared).toBeDefined();
    expect(claudeShared?.skill.qualifiedId).not.toBe(baselineAgentsKey);
    expect(claudeShared?.desiredEnabled).toBe(false);
    expect(claudeShared?.effectiveState).toEqual({ kind: "blocked", reason: "review-required" });
    expect(claudeLocal?.source).toEqual({
      kind: "agents-skills-directory",
      sourceRef: "project:project:fixture:claude:working",
    });
    expect(claudeLocal?.desiredEnabled).toBe(false);
    expect(claudeEscape?.skill.available).toBe(false);
    expect(claudeEscape?.skill.diagnostic?.code).toBe("symlink-package");
    expect(result.skills.some((entry) => entry.skill.name === "escaped-skill")).toBe(false);
    expect(result.skills.some((entry) => entry.skill.name === "unlisted")).toBe(false);
    expect(result.skills.some((entry) => entry.skill.name === "global-claude")).toBe(false);
    expect(result.collisions).toEqual([
      {
        name: "shared",
        candidates: [claudeShared?.skill.qualifiedId, agentsShared?.skill.qualifiedId],
      },
    ]);
  });
});
