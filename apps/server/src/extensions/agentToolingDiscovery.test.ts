import { describe, expect, it } from "vitest";
import { AgentToolingDiscovery } from "./agentToolingDiscovery";

const HOME = "/Users/ada";

function fixtureFs(files: Readonly<Record<string, string>>, directories: ReadonlyArray<string>) {
  const dirs = new Set(directories);
  for (const path of Object.keys(files)) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      dirs.add(parts.slice(0, index).join("/"));
    }
  }
  return {
    readFile: async (path: string) => {
      const content = files[path];
      if (content === undefined) throw new Error("ENOENT");
      return content;
    },
    readdir: async (path: string) => {
      const names = new Set<string>();
      for (const candidate of [...dirs, ...Object.keys(files)]) {
        if (candidate.startsWith(`${path}/`)) {
          const rest = candidate.slice(path.length + 1).split("/")[0];
          if (rest !== undefined && rest.length > 0) names.add(rest);
        }
      }
      if (names.size === 0 && !dirs.has(path)) throw new Error("ENOENT");
      return [...names];
    },
    isDirectory: async (path: string) => dirs.has(path),
    realpath: async (path: string) => path,
  };
}

function discovery(
  files: Readonly<Record<string, string>>,
  options: {
    readonly directories?: ReadonlyArray<string>;
    readonly env?: Readonly<Record<string, string>>;
    readonly projectRoots?: ReadonlyArray<string>;
    readonly toml?: unknown;
  } = {},
) {
  return new AgentToolingDiscovery({
    home: HOME,
    projectRoots: () => options.projectRoots ?? [],
    env: options.env ?? {},
    parseToml: () => options.toml,
    fs: fixtureFs(files, options.directories ?? []),
  });
}

describe("servers and plugins other agent tools know on this computer", () => {
  it("lists Claude Code's servers, fills in a variable from the environment, and keeps a credential secret", async () => {
    const found = discovery(
      {
        [`${HOME}/.claude.json`]: JSON.stringify({
          mcpServers: {
            docs: {
              type: "stdio",
              command: "npx",
              args: ["-y", "docs-mcp"],
              env: { DOCS_TOKEN: "${DOCS_TOKEN}", DOCS_URL: "https://docs.example" },
            },
            remote: { type: "http", url: "https://mcp.example/mcp", headers: { "X-Team": "ada" } },
            legacy: { type: "sse", url: "https://mcp.example/sse" },
          },
          projects: {
            "/Users/ada/src/app": { mcpServers: { local: { command: "./bin/server" } } },
          },
        }),
        "/Users/ada/src/app/.mcp.json": JSON.stringify({
          mcpServers: { shared: { type: "http", url: "https://shared.example/mcp" } },
        }),
      },
      { env: { DOCS_TOKEN: "private-value" }, projectRoots: ["/Users/ada/src/app"] },
    );
    const listing = await found.list();
    expect(listing.servers.map((server) => [server.name, server.origin, server.scope])).toEqual([
      ["docs", "claude-code", "user"],
      ["remote", "claude-code", "user"],
      ["local", "claude-code", "project"],
      ["shared", "claude-code", "project"],
    ]);
    const docs = listing.servers[0];
    expect(docs?.summary).toBe("npx -y docs-mcp");
    expect(docs?.secretNames).toEqual(["DOCS_TOKEN"]);
    expect(docs?.needsValues).toEqual([]);
    expect(JSON.stringify(listing)).not.toContain("private-value");
    expect(found.server(docs?.id ?? "")).toEqual({
      name: "docs",
      server: {
        type: "stdio",
        command: "npx",
        args: ["-y", "docs-mcp"],
        env: [
          { name: "DOCS_TOKEN", value: "private-value", secret: true },
          { name: "DOCS_URL", value: "https://docs.example", secret: false },
        ],
      },
    });
    expect(listing.notes).toEqual([
      "legacy (Claude Code): its sse transport is not one Octant connects to.",
    ]);
  });

  it("leaves a variable in a command argument or address as written and refuses to add the server", async () => {
    const found = discovery(
      {
        [`${HOME}/.claude.json`]: JSON.stringify({
          mcpServers: {
            tool: { command: "npx", args: ["--token", "${API_TOKEN}"], env: {} },
            remote: { type: "http", url: "https://mcp.example/mcp?key=${API_TOKEN}" },
          },
        }),
      },
      { env: { API_TOKEN: "private-value" } },
    );
    const listing = await found.list();
    expect(JSON.stringify(listing)).not.toContain("private-value");
    const [tool, remote] = listing.servers;
    expect(tool?.summary).toBe("npx --token ${API_TOKEN}");
    expect(tool?.unsupportedPlaceholders).toEqual(["API_TOKEN"]);
    expect(remote?.summary).toBe("https://mcp.example/mcp?key=${API_TOKEN}");
    expect(remote?.unsupportedPlaceholders).toEqual(["API_TOKEN"]);
    expect(JSON.stringify(found.server(tool?.id ?? ""))).not.toContain("private-value");
    expect(found.refusal(tool?.id ?? "")).toEqual({
      kind: "unsupported-placeholders",
      names: ["API_TOKEN"],
    });
  });

  it("names a variable the environment lacks instead of inventing a value", async () => {
    const found = discovery({
      [`${HOME}/.claude.json`]: JSON.stringify({
        mcpServers: {
          remote: {
            type: "http",
            url: "https://mcp.example/mcp",
            headers: { Authorization: "Bearer ${MCP_TOKEN}", "X-Env": "${STAGE:-prod}" },
          },
        },
      }),
    });
    const listing = await found.list();
    const remote = listing.servers[0];
    expect(remote?.needsValues).toEqual(["MCP_TOKEN"]);
    expect(remote?.secretNames).toEqual(["Authorization"]);
    expect(found.refusal(remote?.id ?? "")).toEqual({ kind: "needs-values", names: ["MCP_TOKEN"] });
    const request = found.server(remote?.id ?? "");
    expect(request?.server.type === "streamable-http" ? request.server.headers : []).toEqual([
      { name: "Authorization", value: "Bearer ${MCP_TOKEN}", secret: true },
      { name: "X-Env", value: "prod", secret: false },
    ]);
  });

  it("lists Codex's servers with its token variable as a secret header, and skips a disabled one", async () => {
    const found = discovery(
      { [`${HOME}/.codex/config.toml`]: "ignored by the injected parser" },
      {
        env: { ISSUES_TOKEN: "private-value" },
        toml: {
          mcp_servers: {
            issues: {
              url: "https://issues.example/mcp",
              bearer_token_env_var: "ISSUES_TOKEN",
              http_headers: { "X-Client": "codex" },
            },
            browser: { command: "/usr/local/bin/browser-mcp", args: ["--headless"], cwd: "/tmp" },
            off: { command: "never", enabled: false },
          },
        },
      },
    );
    const listing = await found.list();
    expect(listing.servers.map((server) => server.name)).toEqual(["issues", "browser"]);
    expect(listing.servers[0]?.secretNames).toEqual(["Authorization"]);
    const issues = found.server(listing.servers[0]?.id ?? "");
    expect(issues?.server.type === "streamable-http" ? issues.server.headers : []).toEqual([
      { name: "X-Client", value: "codex", secret: false },
      { name: "Authorization", value: "Bearer private-value", secret: true },
    ]);
    expect(listing.notes).toEqual([
      "browser (Codex): its working folder is left out; Octant starts it in its own folder.",
    ]);
  });

  it("lists installed plugins from both tools by format, with whether they are on there", async () => {
    const found = discovery(
      {
        [`${HOME}/.claude/settings.json`]: JSON.stringify({
          enabledPlugins: { "notes@team": false },
        }),
        [`${HOME}/.claude/plugins/cache/team/notes/1.2.0/.claude-plugin/plugin.json`]: "{}",
        [`${HOME}/.claude/plugins/cache/team/deploy/0.3.0/.mcp.json`]: "{}",
        [`${HOME}/.codex/plugins/cache/openai-curated/github/1.0.0/.codex-plugin/plugin.json`]:
          "{}",
        [`${HOME}/.codex/plugins/cache/openai-curated/github/1.1.0/.codex-plugin/plugin.json`]:
          "{}",
        [`${HOME}/.codex/plugins/cache/local/tools/0.1.0/plugin.json`]: JSON.stringify({
          $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
          name: "tools",
        }),
        [`${HOME}/.codex/config.toml`]: "read by the injected parser",
      },
      {
        toml: { plugins: { "github@openai-curated": { enabled: true } } },
      },
    );
    const listing = await found.list();
    expect(
      listing.plugins.map((plugin) => [
        plugin.name,
        plugin.origin,
        plugin.format,
        plugin.version,
        plugin.enabledThere,
      ]),
    ).toEqual([
      ["deploy@team", "claude-code", "claude-plugin", "0.3.0", true],
      ["notes@team", "claude-code", "claude-plugin", "1.2.0", false],
      ["tools@local", "codex", "agent-plugins", "0.1.0", false],
      ["github@openai-curated", "codex", "codex-plugin", "1.1.0", true],
    ]);
    expect(found.pluginPath(listing.plugins[3]?.id ?? "")).toBe(
      `${HOME}/.codex/plugins/cache/openai-curated/github/1.1.0`,
    );
    expect(JSON.stringify(listing)).not.toContain(HOME);
  });

  it("lists nothing, without failing, on a computer that has neither tool", async () => {
    const found = discovery({});
    expect(await found.list()).toEqual({ servers: [], plugins: [], notes: [] });
    expect(found.server("claude-00000000000000000000000000000000")).toBeUndefined();
  });
});
