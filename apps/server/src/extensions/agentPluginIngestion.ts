import { createHash } from "node:crypto";
import type { ExtensionSource } from "@octant/contracts/extensions";
import {
  AGENT_PLUGINS_MCP_SCHEMA,
  AgentPluginsError,
  loadAgentPluginFromEntries,
  type AgentPluginsPackageEntry,
  type LoadedAgentPlugin,
} from "@octant/extensions/agent-plugins";
import {
  calculateExtensionPackageDigest,
  type ExtensionArchiveEntry,
  type ResolvedExtensionPackage,
} from "./packageInspector";

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const slugPattern = /^[a-z][a-z0-9-]{0,63}$/;

export interface AgentPluginCurationBinding {
  readonly catalogId: string;
  readonly entryId: string;
  readonly sourceCommit: string;
  readonly reviewedAt: string;
  readonly expectedDigest: string;
}

export interface AgentPluginPackageInput {
  readonly source: ExtensionSource;
  readonly format: ResolvedExtensionPackage["format"];
  readonly archiveBytes: number;
  readonly entries: ReadonlyArray<ExtensionArchiveEntry>;
  readonly expectedDigest?: ResolvedExtensionPackage["expectedDigest"];
  readonly curationBinding?: AgentPluginCurationBinding;
  readonly appVersion: string;
  readonly platform: NodeJS.Platform;
}

export class AgentPluginIngestionError extends Error {
  override readonly name = "AgentPluginIngestionError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Normalize an Agent Plugins 1.0.0 package into the provider-neutral Octant
 * extension package model used by the extension store and activation pipeline.
 */
export function normalizeAgentPluginPackage(
  input: AgentPluginPackageInput,
): ResolvedExtensionPackage {
  const packageEntries = toPackageEntries(input.entries);
  let loaded: LoadedAgentPlugin;
  try {
    loaded = loadAgentPluginFromEntries(packageEntries);
  } catch (error) {
    if (error instanceof AgentPluginsError) {
      throw new AgentPluginIngestionError(error.code, error.message);
    }
    throw error;
  }

  const name = loaded.manifest.name;
  const slug = toOctantSlug(name);
  const version = toOctantVersion(loaded.manifest.version);
  const components: Array<Record<string, unknown>> = [];
  const packageCapabilities = new Set<string>();
  const entries = [...input.entries];
  const diagnostics: Array<{ code: string; message: string }> = loaded.diagnostics.map(
    (diagnostic) => ({
      code: diagnostic.code.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 128) || "plugin-invalid",
      message:
        diagnostic.message
          .replaceAll(String.fromCharCode(0), " ")
          .replace(/[\\/]+/g, " ")
          .trim()
          .slice(0, 1024) || "Agent Plugin component was skipped.",
    }),
  );
  const servers = loaded.servers.filter((server) => {
    if (server.type !== "stdio" || !server.command.startsWith("./")) return true;
    const entryPoint = server.command.slice(2);
    const present = entries.some((entry) => entry.kind === "file" && entry.path === entryPoint);
    if (!present) {
      diagnostics.push({
        code: "mcp-entry-point-missing",
        message: `MCP server ${server.name} was skipped because its command is missing.`,
      });
    }
    return present;
  });

  for (const skill of loaded.skills) {
    components.push({
      id: skillComponentId(skill.name),
      kind: "skill-instructions",
      skillName: skill.name,
      displayName: skill.name,
      description: skill.description.slice(0, 2048),
      declaredCapabilities: ["instructions"],
      contentReference: skill.skillMdPath,
    });
    packageCapabilities.add("instructions");
  }

  if (servers.length > 0) {
    // Persist a normalized mcp.json snapshot so configuration references stay
    // stable even when the package also carries diagnostics about skipped entries.
    const mcpPath = "mcp.json";
    const mcpDocument = {
      $schema: AGENT_PLUGINS_MCP_SCHEMA,
      mcpServers: Object.fromEntries(
        servers.map((server) => {
          if (server.type === "stdio") {
            return [
              server.name,
              {
                type: "stdio",
                command: server.command,
                ...(server.args === undefined ? {} : { args: server.args }),
                ...(server.env === undefined ? {} : { env: server.env }),
                ...(server.cwd === undefined ? {} : { cwd: server.cwd }),
              },
            ];
          }
          return [
            server.name,
            {
              type: server.type,
              url: server.url,
              ...(server.headers === undefined ? {} : { headers: server.headers }),
            },
          ];
        }),
      ),
    };
    const encoded = new TextEncoder().encode(stableJson(mcpDocument));
    const existing = entries.findIndex((entry) => entry.path === mcpPath);
    if (existing >= 0) {
      entries[existing] = { path: mcpPath, kind: "file", content: encoded };
    } else {
      entries.push({ path: mcpPath, kind: "file", content: encoded });
    }

    for (const server of servers) {
      const capabilities = ["mcp"];
      let entryPoint: string | undefined;
      if (server.type === "stdio") {
        if (server.command.startsWith("./")) {
          entryPoint = server.command.slice(2);
          const commandIndex = entries.findIndex(
            (entry) => entry.kind === "file" && entry.path === entryPoint,
          );
          if (commandIndex < 0) continue;
          entries[commandIndex] = { ...entries[commandIndex]!, executable: true };
        }
      } else {
        capabilities.push("network");
      }
      components.push({
        id: mcpComponentId(server.name),
        kind: "mcp-server",
        displayName: server.name,
        declaredCapabilities: [...new Set(capabilities)],
        configurationReference: mcpPath,
        ...(entryPoint === undefined ? {} : { entryPoint }),
      });
      for (const capability of capabilities) packageCapabilities.add(capability);
    }
  }

  if (components.length === 0) {
    throw new AgentPluginIngestionError(
      "component-missing",
      "Agent Plugin does not contribute a supported skill or MCP server.",
    );
  }

  const sourceRef = sourceReference(input.source);
  const binding = input.curationBinding;
  const isReviewed =
    binding !== undefined &&
    input.expectedDigest !== undefined &&
    input.expectedDigest === binding.expectedDigest &&
    input.source.kind === "catalog" &&
    input.source.catalogId === binding.catalogId &&
    input.source.entryId === binding.entryId;

  const publisher = loaded.manifest.author?.name ?? "local";
  const canonicalUrl = firstUrl(loaded.manifest.repository, loaded.manifest.homepage);
  const license =
    loaded.manifest.license === undefined
      ? { kind: "unreported" as const }
      : spdxOrCustom(loaded.manifest.license);
  const syntheticCommit =
    canonicalUrl === undefined
      ? createHash("sha256").update(`agent-plugins:${name}`).digest("hex").slice(0, 16)
      : undefined;

  const normalizedManifest = {
    manifestVersion: 1,
    extensionId: stableUuid(`extension:${sourceRef}:${name}`),
    packageId: stableUuid(`package:${sourceRef}:${name}`),
    slug,
    displayName: name,
    ...(loaded.manifest.description === undefined
      ? {}
      : { description: loaded.manifest.description.slice(0, 4096) }),
    version,
    digest: "sha256:" + "0".repeat(64),
    source: { kind: "plugin-package", sourceRef },
    provenance: {
      ...(canonicalUrl === undefined ? {} : { canonicalUrl }),
      publisher: publisher.slice(0, 256),
      ...(syntheticCommit === undefined ? {} : { sourceCommit: syntheticCommit }),
      ...(isReviewed && binding ? { sourceCommit: binding.sourceCommit } : {}),
      reviewed: isReviewed,
      ...(isReviewed && binding ? { reviewedAt: binding.reviewedAt } : {}),
    },
    license,
    compatibility: {
      platforms: compatibilityPlatforms(input.platform),
      modes: ["chat", "work", "code"],
      providerFamilies: [],
    },
    declaredCapabilities: [...packageCapabilities].sort(),
    ...(components.length === 1 ? { primaryComponentId: components[0]!.id } : {}),
    components: components.sort((left, right) => String(left.id).localeCompare(String(right.id))),
  };

  const digest = calculateExtensionPackageDigest(normalizedManifest, entries);
  const finalManifest = { ...normalizedManifest, digest };
  return {
    format: input.format,
    archiveBytes: input.archiveBytes,
    manifest: finalManifest,
    entries,
    ...(input.expectedDigest === undefined
      ? { expectedDigest: digest }
      : { expectedDigest: input.expectedDigest }),
    appVersion: input.appVersion,
    platform: input.platform,
    diagnostics,
  };
}

export function agentPluginExtensionId(source: ExtensionSource, name: string): string {
  return stableUuid(`extension:${sourceReference(source)}:${name}`);
}

export function agentPluginPackageId(source: ExtensionSource, name: string): string {
  return stableUuid(`package:${sourceReference(source)}:${name}`);
}

function toPackageEntries(
  entries: ReadonlyArray<ExtensionArchiveEntry>,
): AgentPluginsPackageEntry[] {
  return entries.map((entry) => ({
    path: entry.path,
    kind: entry.kind,
    ...(entry.content === undefined ? {} : { content: entry.content }),
    ...(entry.linkTarget === undefined ? {} : { linkTarget: entry.linkTarget }),
  }));
}

function toOctantSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/\./g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return slugPattern.test(slug)
    ? slug
    : `plugin-${createHash("sha256").update(name).digest("hex").slice(0, 16)}`;
}

function skillComponentId(name: string): string {
  const token = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (name === token && slugPattern.test(token) && `skill-${token}`.length <= 64) {
    return `skill-${token}`;
  }
  const readable = token.slice(0, 38).replace(/-+$/g, "") || "skill";
  const suffix = createHash("sha256").update(name).digest("hex").slice(0, 12);
  return `skill-${readable}-${suffix}`;
}

function mcpComponentId(name: string): string {
  const token = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (name === token && slugPattern.test(token) && `mcp-${token}`.length <= 64) {
    return `mcp-${token}`;
  }
  const readable = token.slice(0, 40).replace(/-+$/g, "") || "server";
  const suffix = createHash("sha256").update(name).digest("hex").slice(0, 12);
  return `mcp-${readable}-${suffix}`;
}

function toOctantVersion(version: string | undefined): string {
  if (version !== undefined && semverPattern.test(version) && version.length <= 64) {
    return version;
  }
  return "0.0.0";
}

function compatibilityPlatforms(platform: NodeJS.Platform): Array<"macos" | "linux" | "windows"> {
  if (platform === "darwin") return ["macos", "linux", "windows"];
  if (platform === "win32") return ["windows", "macos", "linux"];
  return ["linux", "macos", "windows"];
}

function sourceReference(source: ExtensionSource): string {
  return source.kind === "catalog"
    ? `catalog:${source.catalogId}:${source.entryId}`
    : source.sourceRef;
}

function firstUrl(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value === undefined) continue;
    try {
      const url = new URL(value);
      if (
        (url.protocol === "https:" || url.protocol === "http:") &&
        !url.username &&
        !url.password
      ) {
        return value;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function spdxOrCustom(value: string) {
  return /^[A-Za-z0-9-.+]{1,128}$/.test(value)
    ? { kind: "spdx" as const, identifier: value }
    : { kind: "custom" as const, label: value.slice(0, 256) };
}

function stableUuid(seed: string): string {
  const bytes = createHash("sha256")
    .update(`octant.agent-plugins\0${seed}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}
