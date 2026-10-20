import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginDirectory } from "./pluginDirectoryLoader";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function folder(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "octant-plugin-dir-"));
  directories.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

function text(entries: ReadonlyArray<{ path: string; content?: Uint8Array }>, path: string) {
  const entry = entries.find((candidate) => candidate.path === path);
  return entry?.content === undefined ? undefined : new TextDecoder().decode(entry.content);
}

describe("loading a plugin folder in another tool's layout", () => {
  it("turns a Claude Code plugin into an Agent Plugins package, keeping its skills and servers", async () => {
    const root = await folder({
      ".claude-plugin/plugin.json": JSON.stringify({
        name: "Deploy Tools",
        version: "1.2.0",
        description: "Deploy things",
        author: { name: "Ada" },
        mcpServers: {
          inline: {
            command: "${CLAUDE_PLUGIN_ROOT}/bin/server",
            args: ["--data", "${CLAUDE_PLUGIN_DATA}"],
          },
        },
      }),
      ".mcp.json": JSON.stringify({
        mcpServers: {
          api: {
            type: "http",
            url: "https://api.example/mcp",
            headers: { "X-Key": "${user_config.key}" },
          },
          local: { command: "node", args: ["server.js"], env: { ROOT: "${CLAUDE_PLUGIN_ROOT}" } },
        },
      }),
      "skills/deploy/SKILL.md": "---\nname: deploy\ndescription: Deploys\n---\nDeploy it.",
      "commands/status.md": "Show status",
    });
    const loaded = await loadPluginDirectory(root);
    expect(loaded.format).toBe("claude-plugin");
    const manifest = JSON.parse(text(loaded.entries, "plugin.json") ?? "{}") as Record<
      string,
      unknown
    >;
    expect(manifest).toMatchObject({
      name: "deploy-tools",
      version: "1.2.0",
      author: { name: "Ada" },
    });
    const mcp = JSON.parse(text(loaded.entries, "mcp.json") ?? "{}") as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(mcp.mcpServers)).toEqual(["local", "inline"]);
    expect(mcp.mcpServers.local).toEqual({
      type: "stdio",
      command: "node",
      args: ["server.js"],
      env: { ROOT: "${PLUGIN_ROOT}" },
    });
    expect(mcp.mcpServers.inline).toEqual({
      type: "stdio",
      command: "${PLUGIN_ROOT}/bin/server",
      args: ["--data", "${PLUGIN_DATA}"],
    });
    expect(loaded.entries.some((entry) => entry.path === "skills/deploy/SKILL.md")).toBe(true);
    expect(loaded.entries.some((entry) => entry.path.startsWith(".claude-plugin"))).toBe(false);
    expect(loaded.notes).toEqual([
      "api: needs values Claude Code asks for (user_config); left out.",
      "deploy-tools: its commands are left out; Octant runs its skills and MCP servers.",
    ]);
  });

  it("reads a Codex plugin's manifest for the Codex adapter and leaves its files as they are", async () => {
    const root = await folder({
      ".codex-plugin/plugin.json": JSON.stringify({ name: "github", version: "1.0.0" }),
      ".mcp.json": JSON.stringify({ mcpServers: {} }),
    });
    const loaded = await loadPluginDirectory(root);
    expect(loaded.format).toBe("codex-plugin");
    expect(loaded.codexManifest).toEqual({ name: "github", version: "1.0.0" });
    expect(loaded.entries.some((entry) => entry.path === ".codex-plugin/plugin.json")).toBe(true);
  });

  it("passes an Agent Plugins package through untouched", async () => {
    const root = await folder({
      "plugin.json": JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "tools",
      }),
    });
    const loaded = await loadPluginDirectory(root);
    expect(loaded.format).toBe("agent-plugins");
    expect(loaded.entries.map((entry) => entry.path)).toEqual(["plugin.json"]);
  });

  it("refuses a folder that is not a plugin in any layout", async () => {
    const root = await folder({ "README.md": "nothing here" });
    await expect(loadPluginDirectory(root)).rejects.toThrow(/not a plugin/);
  });
});
