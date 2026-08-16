import {
  AGENT_PLUGINS_PLUGIN_SCHEMA,
  mapAgentPluginsMcpServerToLaunchSpec,
  validateAgentPluginsMcpDocument,
  type AgentPluginsMcpLaunchSpec,
  type AgentPluginsTransport,
} from "@octant/plugin-host/agent-plugins";
import { lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";

export interface AgentPluginMcpRuntimeOptions {
  /** Absolute filesystem-resolved plugin package root. */
  readonly pluginRoot: string;
  /**
   * Absolute parent directory for per-plugin persistent data.
   * A dedicated subdirectory is created/reused per plugin identity.
   */
  readonly pluginDataRoot: string;
  /** Stable plugin identity used for the PLUGIN_DATA directory name. */
  readonly pluginIdentity: string;
  readonly baseEnv?: Readonly<Record<string, string>>;
  readonly supportedTransports?: ReadonlySet<AgentPluginsTransport>;
}

export interface AgentPluginMcpRuntimePlan {
  readonly PLUGIN_ROOT: string;
  readonly PLUGIN_DATA: string;
  readonly launches: ReadonlyArray<AgentPluginsMcpLaunchSpec>;
  readonly skipped: ReadonlyArray<{ readonly name: string; readonly reason: string }>;
}

/**
 * Ensure PLUGIN_DATA exists and map each validated MCP server into a launch or
 * connect specification. Callers own process supervision and MCP wire protocol.
 */
export async function prepareAgentPluginMcpRuntime(
  mcpJson: unknown,
  options: AgentPluginMcpRuntimeOptions,
): Promise<AgentPluginMcpRuntimePlan> {
  if (!isAbsolute(options.pluginRoot) || !isAbsolute(options.pluginDataRoot)) {
    throw new Error("PLUGIN_ROOT and PLUGIN_DATA roots must be absolute paths.");
  }
  const pluginData = join(options.pluginDataRoot, sanitizeIdentity(options.pluginIdentity));
  await mkdir(pluginData, { recursive: true });

  const document = validateAgentPluginsMcpDocument(mcpJson, {
    pluginSchema: AGENT_PLUGINS_PLUGIN_SCHEMA,
    ...(options.supportedTransports === undefined
      ? {}
      : { supportedTransports: options.supportedTransports }),
  });
  if (document.topLevelInvalid) {
    return {
      PLUGIN_ROOT: options.pluginRoot,
      PLUGIN_DATA: pluginData,
      launches: [],
      skipped: [{ name: "*", reason: "mcp.json top-level validation failed" }],
    };
  }

  const variables = {
    PLUGIN_ROOT: options.pluginRoot,
    PLUGIN_DATA: pluginData,
  };
  const launches: AgentPluginsMcpLaunchSpec[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  for (const server of document.servers) {
    try {
      const launch = mapAgentPluginsMcpServerToLaunchSpec(server, variables, options.baseEnv ?? {});
      if (launch.transport === "stdio" && isContainedPath(pluginData, launch.cwd)) {
        await ensureContainedDirectory(pluginData, launch.cwd);
      }
      launches.push(launch);
    } catch (error) {
      skipped.push({
        name: server.name,
        reason: error instanceof Error ? error.message : "MCP server mapping failed",
      });
    }
  }

  return {
    PLUGIN_ROOT: options.pluginRoot,
    PLUGIN_DATA: pluginData,
    launches,
    skipped,
  };
}

function isContainedPath(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return (
    child === "" ||
    (!isAbsolute(child) && !child.split(/[\\/]/).some((segment) => segment === ".."))
  );
}

async function ensureContainedDirectory(root: string, candidate: string): Promise<void> {
  if (!isContainedPath(root, candidate)) {
    throw new Error("MCP working directory escapes PLUGIN_DATA.");
  }
  const segments = relative(root, candidate).split(/[\\/]/).filter(Boolean);
  let current = root;
  for (const segment of ["", ...segments]) {
    if (segment !== "") current = join(current, segment);
    let entry;
    try {
      entry = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current);
      entry = await lstat(current);
    }
    if (entry.isSymbolicLink()) {
      throw new Error("MCP working directory must not traverse a symlink.");
    }
    if (!entry.isDirectory()) {
      throw new Error("MCP working directory path is not a directory.");
    }
  }
}

function sanitizeIdentity(value: string): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 128);
  return sanitized.length === 0 ? "plugin" : sanitized;
}
