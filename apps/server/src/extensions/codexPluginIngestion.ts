import { createHash } from "node:crypto";
import type { ExtensionSource } from "@octant/contracts/extensions";
import {
  calculateExtensionPackageDigest,
  type ExtensionArchiveEntry,
  type ResolvedExtensionPackage,
} from "./packageInspector";

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const pluginNamePattern = /^[a-z][a-z0-9-]{0,63}$/;
const serverNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const supportedManifestFields = new Set([
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "skills",
  "mcpServers",
  "interface",
  "hooks",
  "apps",
]);

export interface CodexPluginCurationBinding {
  readonly catalogId: string;
  readonly entryId: string;
  readonly sourceCommit: string;
  readonly reviewedAt: string;
  /**
   * The exact expected digest bound to this curation record. `reviewed`
   * provenance is set to `true` only when the package source is a catalog
   * source whose `catalogId` and `entryId` exactly match this binding AND
   * `input.expectedDigest` exactly equals this value. This prevents a
   * caller-supplied digest from overriding the catalog record's pinned
   * digest to make a stale or spoofed package appear reviewed.
   */
  readonly expectedDigest: string;
}

export interface CodexPluginPackageInput {
  readonly source: ExtensionSource;
  readonly format: ResolvedExtensionPackage["format"];
  readonly archiveBytes: number;
  readonly manifest: unknown;
  readonly entries: ReadonlyArray<ExtensionArchiveEntry>;
  readonly expectedDigest?: ResolvedExtensionPackage["expectedDigest"];
  /**
   * Curated-catalog provenance binding. `reviewed` provenance is set to `true`
   * only when the package source is a catalog source whose `catalogId` and
   * `entryId` exactly match this binding AND an `expectedDigest` is provided.
   * The `sourceCommit` and `reviewedAt` are carried into the manifest
   * provenance only when the binding matches. Unreviewed or mismatched sources
   * normalize to `reviewed: false` with no pinned commit.
   */
  readonly curationBinding?: CodexPluginCurationBinding;
  readonly appVersion: string;
  readonly platform: NodeJS.Platform;
}

export class CodexPluginIngestionError extends Error {
  override readonly name = "CodexPluginIngestionError";

  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function normalizeCodexPluginPackage(
  input: CodexPluginPackageInput,
): ResolvedExtensionPackage {
  const manifest = asRecord(input.manifest, "manifest-invalid");
  rejectUnknownFields(manifest, supportedManifestFields);
  if (manifest.hooks !== undefined || manifest.apps !== undefined) {
    fail("unsupported-surface", "Codex plugin hooks and apps are unsupported.");
  }

  const name = requiredString(manifest.name, "manifest-name", pluginNamePattern);
  const version = requiredString(manifest.version, "manifest-version", semverPattern);
  const description = optionalString(manifest.description, 4_096);
  const author = asRecord(manifest.author, "provenance-missing");
  rejectUnknownFields(author, new Set(["name", "email", "url"]));
  const publisher = requiredString(author.name, "provenance-missing");
  const homepage = optionalUrl(manifest.homepage);
  const repository = optionalUrl(manifest.repository);
  const canonicalUrl = repository ?? homepage;
  if (canonicalUrl === undefined) fail("provenance-missing", "Plugin provenance URL is required.");
  const license = requiredString(manifest.license, "license-missing");
  const entries = [...input.entries];
  const components: Array<Record<string, unknown>> = [];
  const packageCapabilities = new Set<string>();

  const skillRoot = manifest.skills === undefined ? "skills" : pluginPath(manifest.skills);
  for (const skill of discoverSkills(entries, skillRoot)) {
    components.push({
      id: `skill-${skill.name}`,
      kind: "skill-instructions",
      skillName: skill.name,
      displayName: skill.displayName,
      declaredCapabilities: ["instructions"],
      contentReference: skill.path,
    });
    packageCapabilities.add("instructions");
  }

  const mcpDeclaration = manifest.mcpServers;
  if (mcpDeclaration !== undefined) {
    const mcp = resolveMcpDeclaration(mcpDeclaration, entries, name);
    for (const server of mcp.servers) {
      const componentName = `mcp-${server.name}`;
      components.push({
        id: componentName,
        kind: "mcp-server",
        displayName: server.displayName,
        declaredCapabilities: server.capabilities,
        configurationReference: mcp.path,
      });
      for (const capability of server.capabilities) packageCapabilities.add(capability);
    }
  }

  if (components.length === 0) {
    fail("component-missing", "Codex plugin does not contribute a supported component.");
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
  const normalizedManifest = {
    manifestVersion: 1,
    extensionId: stableUuid(`extension:${name}`),
    packageId: stableUuid(`package:${sourceRef}:${name}`),
    slug: name,
    displayName: interfaceDisplayName(manifest.interface) ?? name,
    ...(description === undefined ? {} : { description }),
    version,
    digest: "sha256:" + "0".repeat(64),
    source: { kind: "plugin-package", sourceRef },
    provenance: {
      canonicalUrl,
      publisher,
      ...(isReviewed && binding ? { sourceCommit: binding.sourceCommit } : {}),
      reviewed: isReviewed,
      ...(isReviewed && binding ? { reviewedAt: binding.reviewedAt } : {}),
    },
    license: spdxOrCustom(license),
    compatibility: {
      platforms: ["macos"],
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
  };
}

function discoverSkills(
  entries: ReadonlyArray<ExtensionArchiveEntry>,
  root: string,
): Array<{ readonly name: string; readonly displayName: string; readonly path: string }> {
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const found = new Map<string, { name: string; displayName: string; path: string }>();
  for (const entry of entries) {
    if (entry.kind !== "file" || !entry.path.startsWith(prefix)) continue;
    const relative = entry.path.slice(prefix.length).split("/");
    if (relative.length !== 2 || relative[1] !== "SKILL.md") continue;
    const name = normalizeComponentName(relative[0]!);
    if (found.has(name)) fail("duplicate-component", "Codex plugin contains duplicate skills.");
    if (entry.executable === true)
      fail("unsafe-content", "Codex skill content cannot be executable.");
    found.set(name, { name, displayName: relative[0]!, path: entry.path });
  }
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function resolveMcpDeclaration(
  value: unknown,
  entries: Array<ExtensionArchiveEntry>,
  pluginName: string,
): {
  readonly path: string;
  readonly servers: ReadonlyArray<{ name: string; displayName: string; capabilities: string[] }>;
} {
  let path: string;
  let configuration: unknown;
  if (typeof value === "string") {
    path = pluginPath(value);
    const entry = entries.find((candidate) => candidate.kind === "file" && candidate.path === path);
    if (entry === undefined || entry.content === undefined || entry.executable === true) {
      fail("mcp-missing", "Plugin MCP configuration is unavailable.");
    }
    try {
      configuration = JSON.parse(new TextDecoder().decode(entry.content));
    } catch {
      fail("mcp-invalid", "Plugin MCP configuration is invalid.");
    }
  } else if (isRecord(value)) {
    path = `.octant/mcp/${pluginName}.json`;
    const content = new TextEncoder().encode(stableJson({ mcpServers: value }));
    if (entries.some((entry) => entry.path === path))
      fail("duplicate-path", "Generated MCP configuration collides with package content.");
    entries.push({ path, kind: "file", content });
    configuration = { mcpServers: value };
  } else {
    fail("mcp-invalid", "Plugin MCP declaration is invalid.");
  }
  const record = asRecord(configuration, "mcp-invalid");
  rejectUnknownFields(record, new Set(["mcpServers"]));
  const servers = asRecord(record.mcpServers, "mcp-invalid");
  const normalized = Object.entries(servers)
    .filter(([, server]) => {
      const config = asRecord(server, "mcp-invalid");
      return !hasFloatingExecutable(config);
    })
    .map(([name, server]) => {
      if (!serverNamePattern.test(name)) fail("mcp-invalid", "Plugin MCP server name is invalid.");
      const config = asRecord(server, "mcp-invalid");
      const capabilities = ["mcp"];
      if (
        typeof config.url === "string" ||
        config.type === "http" ||
        config.type === "streamable-http"
      )
        capabilities.push("network");
      if (typeof config.command === "string") capabilities.push("shell");
      if (
        config.env !== undefined ||
        config.headers !== undefined ||
        config.oauth_resource !== undefined
      )
        capabilities.push("credentials");
      return {
        name: normalizeComponentName(name),
        displayName: name,
        capabilities: [...new Set(capabilities)],
      };
    });
  if (new Set(normalized.map((server) => server.name)).size !== normalized.length) {
    fail("duplicate-component", "Plugin MCP server names collide after normalization.");
  }
  if (normalized.length === 0) return { path, servers: [] };
  return { path, servers: normalized.sort((left, right) => left.name.localeCompare(right.name)) };
}

function hasFloatingExecutable(config: Record<string, unknown>): boolean {
  const command = typeof config.command === "string" ? config.command : "";
  const args = Array.isArray(config.args) ? config.args : [];
  return [command, ...args].some((value) => typeof value === "string" && /@latest\b/.test(value));
}

function sourceReference(source: ExtensionSource): string {
  return source.kind === "catalog"
    ? `catalog:${source.catalogId}:${source.entryId}`
    : source.sourceRef;
}

function pluginPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || !value.startsWith("./")) {
    fail("unsafe-path", "Plugin path must be a relative package path.");
  }
  const path = value.slice(2).replace(/\/$/, "");
  if (
    path.length === 0 ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    fail("unsafe-path", "Plugin path is unsafe.");
  }
  return path;
}

function normalizeComponentName(value: string): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  if (!pluginNamePattern.test(normalized))
    fail("component-invalid", "Plugin component name is invalid.");
  return normalized;
}

function interfaceDisplayName(value: unknown): string | undefined {
  if (!isRecord(value) || value.displayName === undefined) return undefined;
  return requiredString(value.displayName, "display-name").slice(0, 128);
}

function spdxOrCustom(value: string) {
  return /^[A-Za-z0-9-.+]{1,128}$/.test(value)
    ? { kind: "spdx" as const, identifier: value }
    : { kind: "custom" as const, label: value.slice(0, 256) };
}

function optionalUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length > 2_048)
    fail("provenance-invalid", "Plugin provenance URL is invalid.");
  try {
    const url = new URL(value);
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password)
      throw new Error();
    return value;
  } catch {
    fail("provenance-invalid", "Plugin provenance URL is invalid.");
  }
}

function requiredString(value: unknown, code: string, pattern?: RegExp): string {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.length > 4_096 ||
    (pattern && !pattern.test(value))
  ) {
    fail(code, "Plugin manifest value is invalid.");
  }
  return value;
}

function optionalString(value: unknown, maximum: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum)
    fail("manifest-invalid", "Plugin description is invalid.");
  return value;
}

function asRecord(value: unknown, code: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(code, "Plugin manifest object is invalid.");
  return value as Record<string, unknown>;
}

function rejectUnknownFields(record: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  if (Object.keys(record).some((key) => !allowed.has(key)))
    fail("manifest-invalid", "Plugin manifest contains an unsupported field.");
}

function stableUuid(seed: string): string {
  const bytes = createHash("sha256")
    .update(`octant.codex-plugin\0${seed}`)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function codexPluginExtensionId(name: string): string {
  return stableUuid(`extension:${name}`);
}

export function codexPluginPackageId(source: ExtensionSource, name: string): string {
  return stableUuid(`package:${sourceReference(source)}:${name}`);
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

function fail(code: string, message: string): never {
  throw new CodexPluginIngestionError(code, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
