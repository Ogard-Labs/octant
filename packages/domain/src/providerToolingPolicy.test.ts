import { describe, expect, it } from "vitest";
import type { ProviderToolingProvider, ProviderToolingRequest } from "@octant/contracts";
import {
  buildProviderToolingCommand,
  formatProviderToolingCommandLine,
} from "./providerToolingPolicy";

function build(provider: ProviderToolingProvider, request: ProviderToolingRequest) {
  return buildProviderToolingCommand(provider, request);
}

// Built from parts so no key-shaped literal sits in the repository.
const KEY_SHAPED = ["sk", "-ant-", "api03-", "A".repeat(40)].join("");
const TOKEN_SHAPED = ["gh", "p_", "a".repeat(36)].join("");
const PLAIN_SECRET = "plain-secret-value-123";

const HOSTILE = [
  "a b",
  "a;b",
  "a'b",
  'a"b',
  "a$(touch x)",
  "a`id`",
  "a\nb",
  "a|b",
  "a&&b",
  "-rf",
  "--help",
  "",
  "x".repeat(65),
];

describe("provider tooling commands", () => {
  it("refuses a name that is not plain, for every command that takes one", () => {
    for (const provider of ["claude", "codex"] as const) {
      for (const hostile of HOSTILE) {
        const requests: ProviderToolingRequest[] = [
          { kind: "mcp-remove", name: hostile },
          { kind: "marketplace-remove", name: hostile },
          { kind: "plugin-install", plugin: hostile },
          { kind: "plugin-uninstall", plugin: "ok", marketplace: hostile },
          { kind: "mcp-add-stdio", name: hostile, command: "node", args: [], env: [] },
          { kind: "mcp-add-url", name: hostile, url: "https://example.com/mcp" },
        ];
        for (const request of requests) {
          const result = build(provider, request);
          expect(result.status, `${provider} ${request.kind} ${JSON.stringify(hostile)}`).toBe(
            "refused",
          );
        }
      }
    }
  });

  it("passes a command, its arguments and plain settings as single arguments, after a double dash", () => {
    const hostileArguments = ["a b", "a;b", "$(id)", "'q'", '"q"', "--flag", "-x", ""];
    for (const provider of ["claude", "codex"] as const) {
      const result = build(provider, {
        kind: "mcp-add-stdio",
        name: "files",
        command: "/usr/local/bin/my server",
        args: hostileArguments,
        env: [{ name: "MODE", value: "a b;c" }],
      });
      expect(result.status).toBe("ok");
      if (result.status !== "ok") continue;
      const argv = result.command.argv;
      const separator = argv.indexOf("--");
      expect(separator).toBeGreaterThan(0);
      expect(argv.slice(separator + 1)).toEqual(
        provider === "claude"
          ? ["files", "/usr/local/bin/my server", ...hostileArguments]
          : ["/usr/local/bin/my server", ...hostileArguments],
      );
      expect(argv).toContain("MODE=a b;c");
      expect(result.command.secret).toBeUndefined();
    }
  });

  it("names the user scope on every Claude command so the account changes, not the current folder", () => {
    const requests: ProviderToolingRequest[] = [
      { kind: "mcp-add-url", name: "a", url: "https://example.com/mcp" },
      { kind: "mcp-add-stdio", name: "a", command: "node", args: [], env: [] },
      { kind: "mcp-remove", name: "a" },
      { kind: "marketplace-add", source: "owner/repo" },
      { kind: "marketplace-remove", name: "a" },
      { kind: "plugin-install", plugin: "a", marketplace: "m" },
      { kind: "plugin-uninstall", plugin: "a", marketplace: "m" },
    ];
    for (const request of requests) {
      const result = build("claude", request);
      expect(result.status).toBe("ok");
      if (result.status !== "ok") continue;
      const argv = result.command.argv;
      expect(argv.slice(argv.indexOf("--scope"), argv.indexOf("--scope") + 2)).toEqual([
        "--scope",
        "user",
      ]);
    }
  });

  it("refuses a command that starts with a dash and a control character anywhere", () => {
    expect(
      build("codex", { kind: "mcp-add-stdio", name: "a", command: "-c", args: [], env: [] }).status,
    ).toBe("refused");
    expect(
      build("codex", {
        kind: "mcp-add-stdio",
        name: "a",
        command: "node",
        args: ["ok\nnot"],
        env: [],
      }).status,
    ).toBe("refused");
    expect(
      build("codex", {
        kind: "mcp-add-stdio",
        name: "a",
        command: "x".repeat(2049),
        args: [],
        env: [],
      }).status,
    ).toBe("refused");
  });

  it("accepts only an http or https address without credentials for a hosted server", () => {
    for (const url of [
      "ftp://example.com/x",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "-https://example.com",
      "https://user:pw@example.com/x",
      "not a url",
      "https://example.com/\nmore",
      `https://example.com/${"a".repeat(2100)}`,
    ]) {
      expect(build("claude", { kind: "mcp-add-url", name: "a", url }).status, url).toBe("refused");
    }
    expect(
      build("claude", { kind: "mcp-add-url", name: "a", url: "http://localhost:3000/mcp" }).status,
    ).toBe("ok");
  });

  it("passes a Claude client secret through the environment and never in the arguments", () => {
    const result = build("claude", {
      kind: "mcp-add-url",
      name: "hosted",
      url: "https://example.com/mcp",
      oauthClientId: "client-1",
      oauthClientSecret: PLAIN_SECRET,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.command.argv.join(" ")).not.toContain(PLAIN_SECRET);
    expect(result.command.argv).toContain("--client-secret");
    expect(result.command.secret).toEqual({ variable: "MCP_CLIENT_SECRET", value: PLAIN_SECRET });
    expect(JSON.stringify(result.command.effects) + result.command.summary).not.toContain(
      PLAIN_SECRET,
    );
  });

  it("refuses a secret where the CLI would put it on its command line", () => {
    const codex = build("codex", {
      kind: "mcp-add-url",
      name: "hosted",
      url: "https://example.com/mcp",
      oauthClientSecret: PLAIN_SECRET,
    });
    expect(codex).toMatchObject({ status: "refused", reason: "secret-unsupported" });
    const stdio = build("claude", {
      kind: "mcp-add-stdio",
      name: "files",
      command: "node",
      args: [],
      env: [{ name: "API_KEY", value: KEY_SHAPED }],
    });
    expect(stdio).toMatchObject({ status: "refused", reason: "secret-unsupported" });
    expect(JSON.stringify(stdio)).not.toContain(KEY_SHAPED);
  });

  it("names the variable Codex reads a bearer token from, and refuses a value in its place", () => {
    const named = build("codex", {
      kind: "mcp-add-url",
      name: "hosted",
      url: "https://example.com/mcp",
      bearerTokenEnvVar: "HOSTED_TOKEN",
    });
    expect(named.status).toBe("ok");
    expect(
      build("codex", {
        kind: "mcp-add-url",
        name: "hosted",
        url: "https://example.com/mcp",
        bearerTokenEnvVar: TOKEN_SHAPED,
      }).status,
    ).toBe("refused");
    expect(
      build("claude", {
        kind: "mcp-add-url",
        name: "hosted",
        url: "https://example.com/mcp",
        bearerTokenEnvVar: "HOSTED_TOKEN",
      }),
    ).toMatchObject({ status: "refused", reason: "unsupported" });
  });

  it("accepts a marketplace as owner/repo, an https address, or an absolute folder only", () => {
    for (const source of ["owner/repo", "https://github.com/owner/repo", "/Users/me/market"]) {
      expect(build("claude", { kind: "marketplace-add", source }).status, source).toBe("ok");
    }
    for (const source of [
      "-owner/repo",
      "--sparse",
      "http://example.com/m",
      "git@host:owner/repo.git",
      "ssh://host/repo",
      "../relative",
      "./relative",
      "/a/../b",
      "owner/repo;rm",
      "owner repo",
    ]) {
      expect(build("claude", { kind: "marketplace-add", source }).status, source).toBe("refused");
    }
    expect(build("codex", { kind: "marketplace-add", source: "owner/repo@main" }).status).toBe(
      "ok",
    );
    expect(build("claude", { kind: "marketplace-add", source: "owner/repo@main" }).status).toBe(
      "refused",
    );
  });

  it("shows the command quoted for reading with a secret as a placeholder", () => {
    const line = formatProviderToolingCommandLine({
      binary: "claude",
      environment: [
        { name: "CLAUDE_CONFIG_DIR", value: "/Users/me/My Account" },
        { name: "MCP_CLIENT_SECRET", value: "<secret>" },
      ],
      argv: ["mcp", "add", "--", "a b", "it's"],
    });
    expect(line).toBe(
      "CLAUDE_CONFIG_DIR='/Users/me/My Account' MCP_CLIENT_SECRET=<secret> claude mcp add -- 'a b' 'it'\\''s'",
    );
  });

  it("refuses text that could reorder or hide what the confirmation shows", () => {
    for (const hidden of ["pkg\u202E", "a\u200Bb", "a\u0085b", "a\u2028b"]) {
      const result = build("claude", {
        kind: "mcp-add-stdio",
        name: "files",
        command: "npx",
        args: ["-y", hidden],
        env: [],
      });
      expect(result.status).toBe("refused");
    }
    expect(
      build("claude", { kind: "mcp-add-url", name: "hosted", url: " https://x.example/mcp" })
        .status,
    ).toBe("refused");
  });

  it("refuses an environment setting named like a key and an address that carries one in its query", () => {
    for (const name of ["DB_PASSWORD", "API_TOKEN", "SECRET", "CLIENT_SECRET", "MY_API_KEY"]) {
      const result = build("claude", {
        kind: "mcp-add-stdio",
        name: "files",
        command: "npx",
        args: [],
        env: [{ name, value: "x1" }],
      });
      expect(result.status).toBe("refused");
    }
    expect(
      build("claude", {
        kind: "mcp-add-url",
        name: "hosted",
        url: "https://x.example/mcp?api_key=abcdefgh1234",
      }).status,
    ).toBe("refused");
    expect(
      build("claude", {
        kind: "mcp-add-stdio",
        name: "files",
        command: "npx",
        args: [],
        env: [{ name: "LOG_LEVEL", value: "debug" }],
      }).status,
    ).toBe("ok");
  });
});
