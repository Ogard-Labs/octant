import { mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ISOLATED_CLAUDE_LAUNCH_GUARDS,
  canonicalClaudeAccountDirectory,
  claudeArtifactLaunchEnvironment,
  ensureClaudeAccountConfigDirectory,
  isolatedClaudeAccountEnvironment,
} from "./claudeAccountIsolation";

const isolationSourcePath = fileURLToPath(new URL("./claudeAccountIsolation.ts", import.meta.url));
const isolationDir = dirname(isolationSourcePath);

const hostileHostEnvironment: NodeJS.ProcessEnv = {
  PATH: "/usr/bin:/bin",
  HOME: "/Users/provider-user",
  LANG: "en_US.UTF-8",
  CLAUDE_CONFIG_DIR: "/provider/other-account",
  CLAUDE_SECURESTORAGE_CONFIG_DIR: "/provider/other-secure",
  ANTHROPIC_API_KEY: "ambient-api-key-sentinel",
  ANTHROPIC_AUTH_TOKEN: "ambient-auth-token-sentinel",
  ANTHROPIC_BASE_URL: "https://routing.invalid",
  CLAUDE_CODE_OAUTH_TOKEN: "ambient-oauth-token-sentinel",
  UNRELATED_TEST_SECRET: "unrelated-secret-sentinel",
};

describe("isolatedClaudeAccountEnvironment", () => {
  it("points only at this account's Claude-owned directory and strips inherited credentials", () => {
    const environment = isolatedClaudeAccountEnvironment({
      hostEnvironment: hostileHostEnvironment,
      configDirectory: "/Users/provider-user/.claude-accounts/work",
      authentication: "subscription",
    });

    expect(environment.CLAUDE_CONFIG_DIR).toBe("/Users/provider-user/.claude-accounts/work");
    expect(environment.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(
      "/Users/provider-user/.claude-accounts/work",
    );
    expect(environment.HOME).toBe("/Users/provider-user");
    expect(environment.ANTHROPIC_API_KEY).toBeUndefined();
    expect(environment.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(environment.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(environment.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(JSON.stringify(environment)).not.toMatch(
      /ambient-|other-account|other-secure|routing\.invalid|unrelated-secret/,
    );
  });

  it("keeps an explicit API-key account on the broker key and the same isolated directory", () => {
    const environment = isolatedClaudeAccountEnvironment({
      hostEnvironment: hostileHostEnvironment,
      configDirectory: "/Users/provider-user/.claude-accounts/api",
      authentication: "api-key",
      apiKey: "broker-resolved-api-key-sentinel",
    });

    expect(environment.CLAUDE_CONFIG_DIR).toBe("/Users/provider-user/.claude-accounts/api");
    expect(environment.ANTHROPIC_API_KEY).toBe("broker-resolved-api-key-sentinel");
    expect(environment.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("does not rotate, fail over, or load-balance between account directories", () => {
    const personal = isolatedClaudeAccountEnvironment({
      hostEnvironment: hostileHostEnvironment,
      configDirectory: "/Users/provider-user/.claude-accounts/personal",
      authentication: "subscription",
    });
    const work = isolatedClaudeAccountEnvironment({
      hostEnvironment: hostileHostEnvironment,
      configDirectory: "/Users/provider-user/.claude-accounts/work",
      authentication: "subscription",
    });

    expect(personal.CLAUDE_CONFIG_DIR).toBe("/Users/provider-user/.claude-accounts/personal");
    expect(work.CLAUDE_CONFIG_DIR).toBe("/Users/provider-user/.claude-accounts/work");
    expect(personal.CLAUDE_CONFIG_DIR).not.toBe(work.CLAUDE_CONFIG_DIR);
  });

  it("creates the account directory without reading files Claude stores there", async () => {
    const parent = await mkdtemp(join(tmpdir(), "octant-claude-account-"));
    const directory = join(parent, "account");
    await ensureClaudeAccountConfigDirectory(directory);
    expect(await readdir(directory)).toEqual([]);
  });
});

describe("claudeArtifactLaunchEnvironment", () => {
  const launch = (hostEnvironment: NodeJS.ProcessEnv) =>
    claudeArtifactLaunchEnvironment(
      isolatedClaudeAccountEnvironment({
        hostEnvironment,
        configDirectory: "/Users/provider-user/.claude-accounts/personal",
        authentication: "subscription",
      }),
    );

  it("goes without only the telemetry guard and opts the runtime into its Artifact tool", () => {
    const { DISABLE_TELEMETRY: _lifted, ...kept } = ISOLATED_CLAUDE_LAUNCH_GUARDS;
    const environment = launch({ PATH: "/usr/bin" });
    expect(environment).not.toHaveProperty("DISABLE_TELEMETRY");
    expect(environment).toMatchObject({ ...kept, CLAUDE_CODE_ARTIFACT: "1" });
  });

  it("leaves a launch whole when the host turns the runtime's non-essential traffic off", () => {
    const environment = launch({ PATH: "/usr/bin", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
    expect(environment).toMatchObject({
      ...ISOLATED_CLAUDE_LAUNCH_GUARDS,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
    expect(environment).not.toHaveProperty("CLAUDE_CODE_ARTIFACT");
  });
});

describe("Claude account isolation source", () => {
  it("fails if isolated-account launch code reads Claude credential files or sets an OAuth token from Octant storage", async () => {
    const sources = await Promise.all(
      ["claudeAccountIsolation.ts", "claudeEnvironment.ts", "claudeDriver.ts"].map((name) =>
        readFile(join(isolationDir, name), "utf8"),
      ),
    );
    const isolation = sources[0] ?? "";
    const environment = sources[1] ?? "";
    const driver = sources[2] ?? "";

    expect(isolation).not.toMatch(/credentials\.json|CLAUDE_CODE_OAUTH_TOKEN/);
    expect(isolation).not.toMatch(/\breadFile(?:Sync)?\b|\bopen(?:Sync)?\b|\bcopyFile(?:Sync)?\b/);
    expect(isolation).not.toMatch(/failover|load-?balanc|rotat(?:e|ion)|round-?robin/i);

    expect(environment).toMatch(/isolatedClaudeAccountEnvironment/);
    expect(environment).toMatch(/overrides\.configDirectory !== undefined/);
    const isolatedBranch = environment.slice(
      environment.indexOf("if (overrides.configDirectory !== undefined)"),
      environment.indexOf("const environment = passthroughHostEnvironment"),
    );
    expect(isolatedBranch).toContain("isolatedClaudeAccountEnvironment");
    expect(isolatedBranch).not.toContain("credentials.json");
    expect(isolatedBranch).not.toContain("oauthToken");
    expect(isolatedBranch).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");

    expect(driver).not.toMatch(/connectedHelperToken|helperSignIn|oauthToken/);
    expect(environment).not.toMatch(/oauthToken|connectedHelperToken|helperSignIn/);
    expect(isolation).not.toMatch(/oauthToken|connectedHelperToken|helperSignIn/);
  });
});

describe("canonicalClaudeAccountDirectory", () => {
  it("resolves parent references through the nearest existing ancestor", async () => {
    // tmpdir() is a symlink on macOS; compare against the physical path.
    const parent = await realpath(
      await mkdtemp(join(tmpdir(), "octant-claude-account-canonical-")),
    );
    const nested = join(parent, "accounts", "work", "..", "..", "new-state");
    expect(canonicalClaudeAccountDirectory(nested)).toEqual({
      path: join(parent, "new-state"),
      existed: false,
    });
  });
});

describe("ensureClaudeAccountConfigDirectory", () => {
  it("does not open files that already live in the account directory", async () => {
    const parent = await mkdtemp(join(tmpdir(), "octant-claude-account-existing-"));
    const directory = join(parent, "account");
    const sentinel = join(directory, "settings.json");
    await ensureClaudeAccountConfigDirectory(directory);
    await writeFile(sentinel, '{"owned-by":"claude"}');
    await ensureClaudeAccountConfigDirectory(directory);
    expect(await readFile(sentinel, "utf8")).toBe('{"owned-by":"claude"}');
  });
});
