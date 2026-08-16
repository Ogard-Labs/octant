import type { AgentPluginsDiagnostic } from "./constants";
import { AGENT_PLUGINS_PLUGIN_SCHEMA } from "./constants";
import { AgentPluginsError, fail } from "./errors";
import { type AgentPluginsManifest, validateAgentPluginsManifest } from "./manifest";
import {
  type AgentPluginsMcpDocument,
  type AgentPluginsMcpServer,
  validateAgentPluginsMcpDocument,
} from "./mcp";
import { normalizePackageRelativePath } from "./paths";
import {
  type AgentPluginsPackageEntry,
  type DiscoveredAgentSkill,
  discoverAgentPluginSkills,
} from "./skills";

export interface LoadedAgentPlugin {
  readonly format: "agent-plugins";
  readonly specVersion: "1.0.0";
  readonly manifest: AgentPluginsManifest;
  readonly skills: ReadonlyArray<DiscoveredAgentSkill>;
  readonly mcp: AgentPluginsMcpDocument | undefined;
  readonly servers: ReadonlyArray<AgentPluginsMcpServer>;
  readonly diagnostics: ReadonlyArray<AgentPluginsDiagnostic>;
  readonly entries: ReadonlyArray<AgentPluginsPackageEntry>;
}

/**
 * Load an Agent Plugin from an already-materialized package entry list.
 * Mirrors the normative client loading sequence against a virtual filesystem.
 */
export function loadAgentPluginFromEntries(
  entries: ReadonlyArray<AgentPluginsPackageEntry>,
): LoadedAgentPlugin {
  const diagnostics: AgentPluginsDiagnostic[] = [];
  enforcePackageBoundary(entries);

  const manifestEntry = entries.find((entry) => entry.path === "plugin.json");
  if (
    manifestEntry === undefined ||
    manifestEntry.kind !== "file" ||
    manifestEntry.content === undefined
  ) {
    fail("manifest-missing", "plugin.json is required at the plugin root.");
  }

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(new TextDecoder().decode(manifestEntry.content));
  } catch {
    fail("manifest-invalid", "plugin.json is not valid JSON.");
  }

  const manifestResult = validateAgentPluginsManifest(rawManifest);
  diagnostics.push(...manifestResult.diagnostics);

  const skillResult = discoverAgentPluginSkills(entries);
  diagnostics.push(...skillResult.diagnostics);

  let mcp: AgentPluginsMcpDocument | undefined;
  const mcpEntry = entries.find((entry) => entry.path === "mcp.json");
  if (mcpEntry !== undefined) {
    if (mcpEntry.kind !== "file" || mcpEntry.content === undefined) {
      diagnostics.push({
        code: "mcp-location-invalid",
        severity: "error",
        message: "mcp.json exists but is not a regular file; MCP component type is invalid.",
        path: "mcp.json",
      });
      mcp = {
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        servers: [],
        diagnostics: [],
        topLevelInvalid: true,
      };
    } else {
      let rawMcp: unknown;
      try {
        rawMcp = JSON.parse(new TextDecoder().decode(mcpEntry.content));
      } catch {
        mcp = {
          $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
          servers: [],
          diagnostics: [
            {
              code: "mcp-top-level-invalid",
              severity: "error",
              message: "mcp.json is not valid JSON.",
            },
          ],
          topLevelInvalid: true,
        };
        diagnostics.push(...mcp.diagnostics);
      }
      if (mcp === undefined) {
        mcp = validateAgentPluginsMcpDocument(rawMcp, {
          pluginSchema: AGENT_PLUGINS_PLUGIN_SCHEMA,
        });
        diagnostics.push(...mcp.diagnostics);
      }
    }
  }

  const skills = skillResult.componentInvalid ? [] : skillResult.skills;
  const servers = mcp === undefined || mcp.topLevelInvalid ? [] : mcp.servers;

  if (skills.length === 0 && servers.length === 0) {
    // A plugin with no loadable components is still a valid package structurally,
    // but Octant requires at least one supported component to install.
    diagnostics.push({
      code: "component-missing",
      severity: "warning",
      message: "Plugin does not contribute a loadable skill or MCP server.",
    });
  }

  return {
    format: "agent-plugins",
    specVersion: "1.0.0",
    manifest: manifestResult.manifest,
    skills,
    mcp,
    servers,
    diagnostics,
    entries,
  };
}

function enforcePackageBoundary(entries: ReadonlyArray<AgentPluginsPackageEntry>): void {
  for (const entry of entries) {
    try {
      normalizePackageRelativePath(entry.path);
    } catch (error) {
      if (error instanceof AgentPluginsError && entry.path === "plugin.json") {
        fail("manifest-missing", "plugin.json does not resolve within the plugin root.");
      }
      fail("unsafe-path", `Package entry path is unsafe: ${entry.path}`);
    }
    if (entry.kind === "symlink" || entry.kind === "hardlink") {
      // Symlinks may resolve within the plugin root, but Octant's hostile
      // inspector rejects link entries for installed packages. At the Agent
      // Plugins load boundary we still reject link-based SKILL.md / mcp.json /
      // plugin.json discovery by requiring kind === "file" at those sites.
      continue;
    }
  }
}

/** True when the entry set looks like an Agent Plugins package root. */
export function looksLikeAgentPlugin(entries: ReadonlyArray<AgentPluginsPackageEntry>): boolean {
  const manifest = entries.find((entry) => entry.path === "plugin.json" && entry.kind === "file");
  if (manifest?.content === undefined) return false;
  try {
    const raw = JSON.parse(new TextDecoder().decode(manifest.content)) as unknown;
    return (
      typeof raw === "object" &&
      raw !== null &&
      !Array.isArray(raw) &&
      (raw as { $schema?: unknown }).$schema === AGENT_PLUGINS_PLUGIN_SCHEMA
    );
  } catch {
    return false;
  }
}
