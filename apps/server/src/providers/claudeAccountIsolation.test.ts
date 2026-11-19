import { mkdtemp, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ISOLATED_CLAUDE_LAUNCH_GUARDS,
  OPEN_CLAUDE_LAUNCH_GUARDS,
  canonicalClaudeAccountDirectory,
  claudeArtifactLaunchEnvironment,
  claudeOwnMemoryLaunchEnvironment,
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

  it("outside Strict passes the host's environment less Octant's variables, other providers' keys and host Claude credentials, and leaves channels to the person", () => {
    const environment = isolatedClaudeAccountEnvironment({
      hostEnvironment: {
        ...hostileHostEnvironment,
        HTTPS_PROXY: "http://proxy.invalid:8080",
        NODE_EXTRA_CA_CERTS: "/etc/company-ca.pem",
        CLAUDE_CODE_USE_BEDROCK: "1",
        GH_TOKEN: "gh-token-sentinel",
        OPENAI_API_KEY: "other-provider-key-sentinel",
        OCTANT_PI_TOOL_BRIDGE_TOKEN: "octant-secret-sentinel",
        DISABLE_ERROR_REPORTING: "0",
      },
      configDirectory: "/Users/provider-user/.claude-accounts/work",
      authentication: "subscription",
      strict: false,
    });

    expect(environment).toMatchObject({
      ...OPEN_CLAUDE_LAUNCH_GUARDS,
      CLAUDE_CONFIG_DIR: "/Users/provider-user/.claude-accounts/work",
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "/Users/provider-user/.claude-accounts/work",
      ANTHROPIC_BASE_URL: "https://routing.invalid",
      HTTPS_PROXY: "http://proxy.invalid:8080",
      NODE_EXTRA_CA_CERTS: "/etc/company-ca.pem",
      CLAUDE_CODE_USE_BEDROCK: "1",
      GH_TOKEN: "gh-token-sentinel",
      UNRELATED_TEST_SECRET: "unrelated-secret-sentinel",
      DISABLE_ERROR_REPORTING: "0",
    });
    expect(environment).not.toHaveProperty("DISABLE_TELEMETRY");
    expect(environment).not.toHaveProperty("DISABLE_BUG_COMMAND");
    expect(environment).not.toHaveProperty("CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL");
    expect(JSON.stringify(environment)).not.toMatch(
      /ambient-|other-account|other-secure|other-provider-key|octant-secret/,
    );
  });

  it("under Strict keeps the fixed list and every channel off", () => {
    const environment = isolatedClaudeAccountEnvironment({
      hostEnvironment: { ...hostileHostEnvironment, GH_TOKEN: "gh-token-sentinel" },
      configDirectory: "/Users/provider-user/.claude-accounts/work",
      authentication: "subscription",
      strict: true,
    });

    expect(environment).toMatchObject(ISOLATED_CLAUDE_LAUNCH_GUARDS);
    expect(environment).not.toHaveProperty("GH_TOKEN");
    expect(environment).not.toHaveProperty("ANTHROPIC_BASE_URL");
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

  it("gives a gateway account only its own address and token, in its own directory, with every ambient credential stripped", () => {
    for (const strict of [true, false]) {
      const environment = isolatedClaudeAccountEnvironment({
        hostEnvironment: { ...hostileHostEnvironment, OPENAI_API_KEY: "other-provider-key" },
        configDirectory: "/Users/provider-user/.claude-accounts/gateway",
        authentication: "gateway",
        gatewayBaseUrl: "https://gateway.example.com/anthropic",
        apiKey: "broker-resolved-gateway-token-sentinel",
        strict,
      });

      expect(environment.CLAUDE_CONFIG_DIR).toBe("/Users/provider-user/.claude-accounts/gateway");
      expect(environment.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(
        "/Users/provider-user/.claude-accounts/gateway",
      );
      expect(environment.ANTHROPIC_BASE_URL).toBe("https://gateway.example.com/anthropic");
      expect(environment.ANTHROPIC_AUTH_TOKEN).toBe("broker-resolved-gateway-token-sentinel");
      expect(environment).not.toHaveProperty("ANTHROPIC_API_KEY");
      expect(environment).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
      expect(JSON.stringify(environment)).not.toMatch(
        /ambient-|other-account|other-secure|routing\.invalid|other-provider-key/,
      );
    }
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

  it("does not let a gateway account's address or token reach a subscription account beside it", () => {
    const gateway = isolatedClaudeAccountEnvironment({
      hostEnvironment: hostileHostEnvironment,
      configDirectory: "/Users/provider-user/.claude-accounts/gateway",
      authentication: "gateway",
      gatewayBaseUrl: "https://gateway.example.com",
      apiKey: "gateway-token-sentinel",
    });
    for (const strict of [true, false]) {
      const subscription = isolatedClaudeAccountEnvironment({
        hostEnvironment: hostileHostEnvironment,
        configDirectory: "/Users/provider-user/.claude-accounts/personal",
        authentication: "subscription",
        strict,
      });

      expect(gateway.CLAUDE_CONFIG_DIR).not.toBe(subscription.CLAUDE_CONFIG_DIR);
      expect(subscription).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
      expect(subscription.ANTHROPIC_BASE_URL).not.toBe("https://gateway.example.com");
      expect(JSON.stringify(subscription)).not.toMatch(/gateway-token|gateway\.example/);
    }
  });

  it("creates the account directory without reading files Claude stores there", async () => {
    const parent = await mkdtemp(join(tmpdir(), "octant-claude-account-"));
    const directory = join(parent, "account");
    await ensureClaudeAccountConfigDirectory(directory);
    expect(await readdir(directory)).toEqual([]);
  });
});

describe("claudeOwnMemoryLaunchEnvironment", () => {
  it("goes without only the auto-memory guard, so telemetry and the self-update stay off", () => {
    const { CLAUDE_CODE_DISABLE_AUTO_MEMORY: _lifted, ...kept } = ISOLATED_CLAUDE_LAUNCH_GUARDS;
    const environment = claudeOwnMemoryLaunchEnvironment(
      isolatedClaudeAccountEnvironment({
        hostEnvironment: { PATH: "/usr/bin", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
        configDirectory: "/Users/provider-user/.claude-accounts/personal",
        authentication: "subscription",
      }),
    );
    expect(environment).not.toHaveProperty("CLAUDE_CODE_DISABLE_AUTO_MEMORY");
    expect(environment).toEqual(expect.objectContaining(kept));
    expect(environment).toMatchObject({
      DISABLE_TELEMETRY: "1",
      DISABLE_AUTOUPDATER: "1",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    });
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

  it.each([{ DISABLE_TELEMETRY: "1" }, { DISABLE_TELEMETRY: "true" }, { DO_NOT_TRACK: "1" }])(
    "keeps telemetry off when the host opted out with %o",
    (optOut) => {
      const environment = launch({ PATH: "/usr/bin", ...optOut });
      expect(environment).toMatchObject({ ...ISOLATED_CLAUDE_LAUNCH_GUARDS, DO_NOT_TRACK: "1" });
      expect(environment).not.toHaveProperty("CLAUDE_CODE_ARTIFACT");
    },
  );

  it("outside Strict lifts nothing, and the person's own telemetry opt-out keeps the tool off", () => {
    const open = (hostEnvironment: NodeJS.ProcessEnv) =>
      claudeArtifactLaunchEnvironment(
        isolatedClaudeAccountEnvironment({
          hostEnvironment,
          configDirectory: "/Users/provider-user/.claude-accounts/personal",
          authentication: "subscription",
          strict: false,
        }),
        false,
      );
    expect(open({ PATH: "/usr/bin" })).toMatchObject({ CLAUDE_CODE_ARTIFACT: "1" });
    const optedOut = open({ PATH: "/usr/bin", DISABLE_TELEMETRY: "1" });
    expect(optedOut).toMatchObject({ DISABLE_TELEMETRY: "1" });
    expect(optedOut).not.toHaveProperty("CLAUDE_CODE_ARTIFACT");
  });

  it("carries no opt-out the host did not set", () => {
    const environment = launch({ PATH: "/usr/bin", DO_NOT_TRACK: "0" });
    expect(environment).not.toHaveProperty("DO_NOT_TRACK");
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
