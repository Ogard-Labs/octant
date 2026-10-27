import {
  AGENT_PLUGINS_MCP_SCHEMA,
  AGENT_PLUGINS_PLUGIN_SCHEMA,
  fail,
  looksLikeAgentPlugin,
  type AgentPluginsPackageEntry,
} from "@octant/plugin-host/agent-plugins";
import {
  readPluginDirectory,
  type LoadAgentPluginDirectoryOptions,
  type ReadPluginDirectory,
} from "./agentPluginFilesystem";
import { LANGUAGE_SERVER_PACKAGE_DOCUMENT_PATH } from "@octant/plugin-api/language-server-package";
import { packageSlug } from "./userAddedMcpServers";

export type PluginDirectoryFormat =
  | "agent-plugins"
  | "codex-plugin"
  | "claude-plugin"
  | "language-server-package";

export interface LoadedPluginDirectory extends ReadPluginDirectory {
  readonly format: PluginDirectoryFormat;
  /** Present for a Codex-format folder: its manifest, which the Codex adapter normalizes. */
  readonly codexManifest?: unknown;
  /** Servers or files the loader had to leave out, in plain words. */
  readonly notes: ReadonlyArray<string>;
}

/**
 * What format a plugin folder is, from its files alone: an Agent Plugins
 * package (root `plugin.json`), a Codex plugin (`.codex-plugin/plugin.json`),
 * or a Claude Code plugin (`.claude-plugin/plugin.json`, `.mcp.json`, or a
 * `skills/` folder). Undefined means none of them.
 *
 * A folder with a language server package's document at its root is read as
 * that and as nothing else, so a language server never also arrives as skills
 * or MCP servers, and no other layout is ever read as a language server.
 */
export function detectPluginDirectoryFormat(
  entries: ReadonlyArray<AgentPluginsPackageEntry>,
): PluginDirectoryFormat | undefined {
  if (
    entries.some(
      (entry) => entry.path === LANGUAGE_SERVER_PACKAGE_DOCUMENT_PATH && entry.kind === "file",
    )
  ) {
    return "language-server-package";
  }
  if (looksLikeAgentPlugin(entries)) return "agent-plugins";
  if (
    entries.some((entry) => entry.path === ".codex-plugin/plugin.json" && entry.kind === "file")
  ) {
    return "codex-plugin";
  }
  if (
    entries.some(
      (entry) =>
        (entry.path === ".claude-plugin/plugin.json" || entry.path === ".mcp.json") &&
        entry.kind === "file",
    ) ||
    entries.some((entry) => entry.path === "skills" && entry.kind === "directory")
  ) {
    return "claude-plugin";
  }
  return undefined;
}

/**
 * Loads a plugin folder in whichever of the three layouts it uses. A Claude
 * Code plugin is turned into an Agent Plugins package in memory: the host
 * writes a `plugin.json` and an `mcp.json` from its manifest and `.mcp.json`,
 * keeps its `skills/`, and leaves its commands, agents and hooks behind,
 * because Octant runs skills and MCP servers and nothing else from it.
 */
export async function loadPluginDirectory(
  directoryPath: string,
  options: LoadAgentPluginDirectoryOptions = {},
): Promise<LoadedPluginDirectory> {
  const read = await readPluginDirectory(directoryPath, options);
  const format = detectPluginDirectoryFormat(read.entries);
  if (format === undefined) {
    fail(
      "manifest-schema",
      "Folder is not a plugin: no plugin.json, .codex-plugin/plugin.json, .claude-plugin/plugin.json, .mcp.json or skills/ found.",
    );
  }
  if (format === "agent-plugins" || format === "language-server-package") {
    return { ...read, format, notes: [] };
  }
  if (format === "codex-plugin") {
    return {
      ...read,
      format,
      codexManifest: parseJsonEntry(read.entries, ".codex-plugin/plugin.json"),
      notes: [],
    };
  }
  return claudePluginAsAgentPlugins(read);
}

function claudePluginAsAgentPlugins(read: ReadPluginDirectory): LoadedPluginDirectory {
  const notes: string[] = [];
  const manifest = asRecord(parseJsonEntry(read.entries, ".claude-plugin/plugin.json"));
  const folderName =
    read.pluginRoot
      .split("/")
      .filter((part) => part.length > 0)
      .pop() ?? "plugin";
  const name = packageSlug(typeof manifest.name === "string" ? manifest.name : folderName);
  const servers: Record<string, unknown> = {};
  const declared = [
    ...Object.entries(asRecord(asRecord(parseJsonEntry(read.entries, ".mcp.json")).mcpServers)),
    ...(isRecord(manifest.mcpServers) ? Object.entries(manifest.mcpServers) : []),
  ];
  for (const [serverName, value] of declared) {
    const mapped = mapClaudeMcpServer(serverName, value, notes);
    if (mapped !== undefined) servers[serverName] = mapped;
  }
  for (const dropped of LEFT_OUT_FOLDERS) {
    if (
      manifest[dropped] !== undefined ||
      read.entries.some((entry) => entry.path === dropped && entry.kind === "directory") ||
      (dropped === "hooks" && read.entries.some((entry) => entry.path === "hooks/hooks.json"))
    ) {
      notes.push(`${name}: its ${dropped} are left out; Octant runs its skills and MCP servers.`);
    }
  }
  const author = isRecord(manifest.author) ? manifest.author : undefined;
  const pluginJson = {
    $schema: AGENT_PLUGINS_PLUGIN_SCHEMA,
    name,
    ...(typeof manifest.version === "string" ? { version: manifest.version } : {}),
    ...(typeof manifest.description === "string" ? { description: manifest.description } : {}),
    ...(author !== undefined && typeof author.name === "string"
      ? { author: { name: author.name } }
      : {}),
    ...(typeof manifest.homepage === "string" ? { homepage: manifest.homepage } : {}),
    ...(typeof manifest.repository === "string" ? { repository: manifest.repository } : {}),
    ...(typeof manifest.license === "string" ? { license: manifest.license } : {}),
  };
  const synthesized: AgentPluginsPackageEntry[] = [
    { path: "plugin.json", kind: "file", content: encode(pluginJson) },
  ];
  if (Object.keys(servers).length > 0) {
    synthesized.push({
      path: "mcp.json",
      kind: "file",
      content: encode({ $schema: AGENT_PLUGINS_MCP_SCHEMA, mcpServers: servers }),
    });
  }
  const kept = read.entries.filter(
    (entry) =>
      entry.path !== "plugin.json" &&
      entry.path !== "mcp.json" &&
      entry.path !== ".mcp.json" &&
      !LEFT_OUT_FOLDERS.some(
        (folder) => entry.path === folder || entry.path.startsWith(`${folder}/`),
      ) &&
      entry.path !== ".claude-plugin" &&
      !entry.path.startsWith(".claude-plugin/"),
  );
  const entries = [...kept, ...synthesized].sort((left, right) =>
    left.path.localeCompare(right.path),
  );
  const archiveBytes = entries.reduce(
    (total, entry) => total + (entry.content?.byteLength ?? 0),
    0,
  );
  return { pluginRoot: read.pluginRoot, entries, archiveBytes, format: "claude-plugin", notes };
}

/** Claude Code folders Octant does not run; their files are not copied into the package. */
const LEFT_OUT_FOLDERS = ["commands", "agents", "hooks"] as const;

/**
 * A Claude Code server entry in Agent Plugins terms: its `http` (and the
 * alias `streamable-http`) is Octant's `streamable-http`; `${CLAUDE_PLUGIN_ROOT}`
 * and `${CLAUDE_PLUGIN_DATA}` are the same two folders under their Agent
 * Plugins names. A server that reads `${user_config.*}` is left out, since
 * Octant has nowhere to ask for those values yet.
 */
function mapClaudeMcpServer(
  name: string,
  value: unknown,
  notes: string[],
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  const text = JSON.stringify(value);
  if (text.includes("${user_config.")) {
    notes.push(`${name}: needs values Claude Code asks for (user_config); left out.`);
    return undefined;
  }
  const type =
    typeof value.type === "string" ? value.type : value.command !== undefined ? "stdio" : "";
  const rename = (input: string) =>
    input
      .replaceAll("${CLAUDE_PLUGIN_ROOT}", "${PLUGIN_ROOT}")
      .replaceAll("${CLAUDE_PLUGIN_DATA}", "${PLUGIN_DATA}");
  const renameRecord = (record: unknown): Record<string, string> | undefined => {
    if (!isRecord(record)) return undefined;
    const out: Record<string, string> = {};
    for (const [key, entry] of Object.entries(record)) {
      if (typeof entry === "string") out[key] = rename(entry);
    }
    return out;
  };
  if (type === "stdio") {
    if (typeof value.command !== "string") return undefined;
    const args = Array.isArray(value.args)
      ? value.args.filter((arg): arg is string => typeof arg === "string").map(rename)
      : undefined;
    const env = renameRecord(value.env);
    return {
      type: "stdio",
      command: rename(value.command),
      ...(args === undefined ? {} : { args }),
      ...(env === undefined ? {} : { env }),
    };
  }
  if (type === "http" || type === "streamable-http" || type === "sse") {
    if (typeof value.url !== "string") return undefined;
    const headers = renameRecord(value.headers);
    return {
      type: type === "sse" ? "sse" : "streamable-http",
      url: value.url,
      ...(headers === undefined ? {} : { headers }),
    };
  }
  notes.push(
    `${name}: its ${type || "unknown"} transport is not one Octant connects to; left out.`,
  );
  return undefined;
}

function parseJsonEntry(entries: ReadonlyArray<AgentPluginsPackageEntry>, path: string): unknown {
  const entry = entries.find((candidate) => candidate.path === path && candidate.kind === "file");
  if (entry?.content === undefined) return undefined;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(entry.content)) as unknown;
  } catch {
    fail("manifest-invalid", `${path} is not valid JSON.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
}
