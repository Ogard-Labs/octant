/** Canonical Agent Plugins 1.0.0 identifiers and patterns. */

export const AGENT_PLUGINS_SPEC_VERSION = "1.0.0" as const;

export const AGENT_PLUGINS_PLUGIN_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json" as const;

export const AGENT_PLUGINS_MCP_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json" as const;

/** Agent Plugins plugin name pattern from plugin.schema.json. */
export const AGENT_PLUGINS_NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

export type AgentPluginsTransport = "stdio" | "streamable-http" | "sse";

export type AgentPluginsDiagnosticSeverity = "info" | "warning" | "error";

export interface AgentPluginsDiagnostic {
  readonly code: string;
  readonly severity: AgentPluginsDiagnosticSeverity;
  readonly message: string;
  readonly path?: string;
}
