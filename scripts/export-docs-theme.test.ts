import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fixtures: string[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "oct-docs-theme-"));
  fixtures.push(root);
  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "packages/theme/src"), { recursive: true });
  await mkdir(join(root, "node_modules/@octant"), { recursive: true });
  await writeFile(
    join(root, "scripts/export-docs-theme.ts"),
    await readFile(new URL("./export-docs-theme.ts", import.meta.url)),
  );
  await writeFile(
    join(root, "packages/theme/package.json"),
    JSON.stringify({ type: "module", exports: { "./tokens": "./src/tokens.ts" } }),
  );
  await writeFile(
    join(root, "packages/theme/src/tokens.ts"),
    'export const THEME_TOKEN_ROLE_IDS = ["chrome"]; export const DEFAULT_LIGHT_TOKENS = {chrome:"#ffffff"}; export const DEFAULT_DARK_TOKENS = {chrome:"#000000"};\n',
  );
  await symlink("../../packages/theme", join(root, "node_modules/@octant/theme"));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync(
    "git",
    ["add", "--", "packages/theme/src/tokens.ts", "packages/theme/package.json"],
    { cwd: root },
  );
  execFileSync(
    "git",
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "user.name=Guide fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Theme fixture",
    ],
    { cwd: root },
  );
  return root;
}

function exported(root: string) {
  return spawnSync("bun", ["scripts/export-docs-theme.ts"], { cwd: root, encoding: "utf8" });
}

describe("guide theme export", () => {
  it("exports committed values with a matching immutable tree despite unrelated edits", async () => {
    const root = await fixture();
    await writeFile(join(root, "unrelated.md"), "Unrelated documentation");
    const result = exported(root);
    expect(result.status).toBe(0);
    const value = JSON.parse(result.stdout);
    const revision = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    expect(value.source).toBe(
      `https://github.com/Ogard-Labs/octant/blob/${revision}/packages/theme/src/tokens.ts`,
    );
    expect(value.light).toEqual({ chrome: "#ffffff" });
  });

  it("refuses uncommitted token values without emitting a misleading source reference", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "packages/theme/src/tokens.ts"),
      'export const THEME_TOKEN_ROLE_IDS = ["chrome"]; export const DEFAULT_LIGHT_TOKENS = {chrome:"#eeeeee"}; export const DEFAULT_DARK_TOKENS = {chrome:"#000000"};\n',
    );
    const result = exported(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Commit theme sources before exporting");
  });

  it("refuses a staged theme dependency before recording an immutable tree", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "packages/theme/src/chartScales.ts"),
      "export const changed = true;\n",
    );
    execFileSync("git", ["add", "--", "packages/theme/src/chartScales.ts"], { cwd: root });
    const result = exported(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });
});
