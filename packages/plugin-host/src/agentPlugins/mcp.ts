import {
  AGENT_PLUGINS_MCP_SCHEMA,
  AGENT_PLUGINS_PLUGIN_SCHEMA,
  type AgentPluginsDiagnostic,
  type AgentPluginsTransport,
} from "./constants";
import { asRecord, isRecord } from "./errors";
import { expandPluginPlaceholders, resolveStdioCommand, resolveStdioCwd } from "./paths";

const RESERVED_ENV = new Set(["PLUGIN_ROOT", "PLUGIN_DATA"]);

export interface AgentPluginsStdioServer {
  readonly type: "stdio";
  readonly name: string;
  readonly command: string;
  readonly args?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string>>;
  readonly cwd?: string;
}

export interface AgentPluginsRemoteServer {
  readonly type: "streamable-http" | "sse";
  readonly name: string;
  readonly url: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export type AgentPluginsMcpServer = AgentPluginsStdioServer | AgentPluginsRemoteServer;

export interface AgentPluginsMcpDocument {
  readonly $schema: typeof AGENT_PLUGINS_MCP_SCHEMA;
  readonly servers: ReadonlyArray<AgentPluginsMcpServer>;
  readonly diagnostics: ReadonlyArray<AgentPluginsDiagnostic>;
  /** True when top-level mcp.json is invalid (MCP disabled for the plugin). */
  readonly topLevelInvalid: boolean;
}

export interface AgentPluginsMcpRuntimeVariables {
  readonly PLUGIN_ROOT: string;
  readonly PLUGIN_DATA: string;
}

export type AgentPluginsMcpLaunchSpec =
  | {
      readonly transport: "stdio";
      readonly name: string;
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly cwd: string;
      readonly env: Readonly<Record<string, string>>;
    }
  | {
      readonly transport: "streamable-http" | "sse";
      readonly name: string;
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    };

/**
 * Validate mcp.json in two stages: top-level document, then each server entry.
 * Top-level failure disables MCP. Entry failures skip only that entry.
 */
export function validateAgentPluginsMcpDocument(
  raw: unknown,
  options: {
    /** Schema identifier from the plugin manifest; versions must match. */
    readonly pluginSchema: string;
    readonly supportedTransports?: ReadonlySet<AgentPluginsTransport>;
  },
): AgentPluginsMcpDocument {
  const diagnostics: AgentPluginsDiagnostic[] = [];
  const supported =
    options.supportedTransports ??
    new Set<AgentPluginsTransport>(["stdio", "streamable-http", "sse"]);

  if (options.pluginSchema !== AGENT_PLUGINS_PLUGIN_SCHEMA) {
    return {
      $schema: AGENT_PLUGINS_MCP_SCHEMA,
      servers: [],
      diagnostics: [
        {
          code: "mcp-version-mismatch",
          severity: "error",
          message: "mcp.json Agent Plugins version must match plugin.json.",
        },
      ],
      topLevelInvalid: true,
    };
  }

  if (!isRecord(raw)) {
    return topLevelFailure(diagnostics, "mcp.json must be a JSON object.");
  }

  if (raw.$schema !== AGENT_PLUGINS_MCP_SCHEMA) {
    return topLevelFailure(
      diagnostics,
      "mcp.json $schema must identify a locally supported Agent Plugins MCP schema.",
    );
  }

  for (const key of Object.keys(raw)) {
    if (key !== "$schema" && key !== "mcpServers") {
      return topLevelFailure(diagnostics, `mcp.json contains unknown top-level field "${key}".`);
    }
  }

  if (!isRecord(raw.mcpServers)) {
    return topLevelFailure(diagnostics, "mcp.json mcpServers must be an object.");
  }

  const servers: AgentPluginsMcpServer[] = [];
  for (const [name, value] of Object.entries(raw.mcpServers)) {
    try {
      const server = validateServerEntry(name, value, supported, diagnostics);
      if (server !== undefined) servers.push(server);
    } catch (error) {
      diagnostics.push({
        code: "mcp-entry-invalid",
        severity: "warning",
        message:
          error instanceof Error
            ? `Skipping MCP server "${name}": ${error.message}`
            : `Skipping MCP server "${name}".`,
        path: `mcpServers.${name}`,
      });
    }
  }

  return {
    $schema: AGENT_PLUGINS_MCP_SCHEMA,
    servers: servers.sort((left, right) => left.name.localeCompare(right.name)),
    diagnostics,
    topLevelInvalid: false,
  };
}

function topLevelFailure(
  diagnostics: AgentPluginsDiagnostic[],
  message: string,
): AgentPluginsMcpDocument {
  diagnostics.push({ code: "mcp-top-level-invalid", severity: "error", message });
  return {
    $schema: AGENT_PLUGINS_MCP_SCHEMA,
    servers: [],
    diagnostics,
    topLevelInvalid: true,
  };
}

function validateServerEntry(
  name: string,
  value: unknown,
  supported: ReadonlySet<AgentPluginsTransport>,
  diagnostics: AgentPluginsDiagnostic[],
): AgentPluginsMcpServer | undefined {
  if (
    name.length < 1 ||
    name.length > 128 ||
    name.trim() !== name ||
    /[\u0000-\u001f\u007f]/.test(name)
  ) {
    throw new Error("MCP server name must be 1–128 characters.");
  }
  const record = asRecord(value, "mcp-entry-invalid", "MCP server entry must be an object.");
  const type = record.type;
  if (type !== "stdio" && type !== "streamable-http" && type !== "sse") {
    throw new Error("unknown MCP transport.");
  }
  if (!supported.has(type)) {
    diagnostics.push({
      code: "mcp-transport-unsupported",
      severity: "warning",
      message: `Skipping MCP server "${name}": transport "${type}" is not enabled.`,
      path: `mcpServers.${name}`,
    });
    return undefined;
  }

  if (type === "stdio") {
    for (const key of Object.keys(record)) {
      if (!["type", "command", "args", "env", "cwd"].includes(key)) {
        throw new Error(`unknown field "${key}".`);
      }
    }
    if (typeof record.command !== "string" || record.command.length < 1) {
      throw new Error("stdio command is required.");
    }
    const args = record.args;
    if (args !== undefined) {
      if (!Array.isArray(args) || args.some((entry) => typeof entry !== "string")) {
        throw new Error("stdio args must be an array of strings.");
      }
    }
    const env = parseEnv(record.env);
    const cwd = record.cwd;
    if (cwd !== undefined && typeof cwd !== "string") {
      throw new Error("stdio cwd must be a string.");
    }
    if (typeof cwd === "string") {
      if (cwd.length === 0) {
        throw new Error("stdio cwd must be plugin-relative or PLUGIN_ROOT/PLUGIN_DATA rooted.");
      }
      try {
        resolveStdioCwd(cwd, {
          PLUGIN_ROOT: "/octant/plugin-root",
          PLUGIN_DATA: "/octant/plugin-data",
        });
      } catch {
        throw new Error("stdio cwd must be plugin-relative or PLUGIN_ROOT/PLUGIN_DATA rooted.");
      }
    }
    return {
      type: "stdio",
      name,
      command: record.command,
      ...(args === undefined ? {} : { args: args as string[] }),
      ...(env === undefined ? {} : { env }),
      ...(typeof cwd === "string" ? { cwd } : {}),
    };
  }

  for (const key of Object.keys(record)) {
    if (!["type", "url", "headers"].includes(key)) {
      throw new Error(`unknown field "${key}".`);
    }
  }
  if (typeof record.url !== "string" || record.url.length < 1) {
    throw new Error("remote MCP url is required.");
  }
  validateRemoteUrl(record.url);
  const headers = parseHeaders(record.headers);
  return {
    type,
    name,
    url: record.url,
    ...(headers === undefined ? {} : { headers }),
  };
}

function parseEnv(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value, "mcp-entry-invalid", "stdio env must be an object.");
  const env: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (RESERVED_ENV.has(key)) {
      throw new Error(`env must not set reserved variable ${key}.`);
    }
    if (typeof entry !== "string") throw new Error("env values must be strings.");
    env[key] = entry;
  }
  return env;
}

function parseHeaders(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined;
  const record = asRecord(value, "mcp-entry-invalid", "headers must be an object.");
  const headers: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string") throw new Error("header values must be strings.");
    headers[key] = entry;
  }
  return headers;
}

function validateRemoteUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("remote MCP url is invalid.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("remote MCP url must be http or https.");
  }
  if (parsed.username || parsed.password) {
    throw new Error("remote MCP url must not include user information.");
  }
  if (parsed.hash) {
    throw new Error("remote MCP url must not include a fragment.");
  }
  const host = parsed.hostname.toLowerCase();
  const loopback =
    host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  if (!loopback && parsed.protocol !== "https:") {
    throw new Error("non-loopback remote MCP endpoints must use HTTPS.");
  }
}

/**
 * Map a validated MCP server entry into a concrete launch/connect specification.
 */
export function mapAgentPluginsMcpServerToLaunchSpec(
  server: AgentPluginsMcpServer,
  variables: AgentPluginsMcpRuntimeVariables,
  baseEnv: Readonly<Record<string, string>> = {},
): AgentPluginsMcpLaunchSpec {
  if (server.type === "stdio") {
    const resolved = resolveStdioCommand(server.command, variables.PLUGIN_ROOT);
    const args = (server.args ?? []).map((arg) => expandPluginPlaceholders(arg, variables));
    const env: Record<string, string> = { ...baseEnv };
    if (server.env !== undefined) {
      for (const [key, value] of Object.entries(server.env)) {
        env[key] = expandPluginPlaceholders(value, variables);
      }
    }
    // Client-controlled values win last.
    env.PLUGIN_ROOT = variables.PLUGIN_ROOT;
    env.PLUGIN_DATA = variables.PLUGIN_DATA;
    return {
      transport: "stdio",
      name: server.name,
      command: resolved.executable,
      args,
      cwd: resolveStdioCwd(server.cwd, variables),
      env,
    };
  }
  return {
    transport: server.type,
    name: server.name,
    url: server.url,
    headers: server.headers ?? {},
  };
}
