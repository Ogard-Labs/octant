import { createHash } from "node:crypto";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  DiscoveredAgentToolingListing,
  DiscoveredAgentToolingOrigin,
  DiscoveredMcpServer,
  DiscoveredPlugin,
  UserAddedMcpServerRequest,
} from "@octant/contracts/extension-rpc";
import {
  looksLikeAgentPlugin,
  type AgentPluginsPackageEntry,
} from "@octant/plugin-host/agent-plugins";

/** A name that usually carries a credential, so its value goes to the credential store. */
const SECRET_NAME = /(token|secret|key|password|passwd|authorization|credential|cookie)/i;
/** `${NAME}` or `${NAME:-default}`, the forms Claude Code expands in its configuration. */
const VARIABLE = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

export interface AgentToolingDiscoveryOptions {
  readonly home: string;
  /** The folders of the Projects this host knows, for a Project's own `.mcp.json` and local servers. */
  readonly projectRoots: () => ReadonlyArray<string>;
  /** The environment the other tools would read `${VAR}` and token variables from. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly parseToml: (text: string) => unknown;
  readonly fs?: {
    readonly readFile: (path: string) => Promise<string>;
    readonly readdir: (path: string) => Promise<ReadonlyArray<string>>;
    readonly isDirectory: (path: string) => Promise<boolean>;
    readonly realpath: (path: string) => Promise<string>;
  };
}

interface DiscoveredServerRecord {
  readonly listing: DiscoveredMcpServer;
  readonly request: UserAddedMcpServerRequest;
}

interface DiscoveredPluginRecord {
  readonly listing: DiscoveredPlugin;
  readonly absolutePath: string;
}

/**
 * Reads what Claude Code and Codex keep on this computer, read-only, and
 * offers it to the person: the MCP servers in their configuration and the
 * plugins they installed. Nothing is added, trusted or enabled by listing;
 * the person's click on one item is what imports that one item, and Octant
 * never writes to the other tools' files.
 */
export class AgentToolingDiscovery {
  readonly #options: AgentToolingDiscoveryOptions;
  readonly #fs: NonNullable<AgentToolingDiscoveryOptions["fs"]>;
  #servers = new Map<string, DiscoveredServerRecord>();
  #plugins = new Map<string, DiscoveredPluginRecord>();

  constructor(options: AgentToolingDiscoveryOptions) {
    this.#options = options;
    this.#fs = options.fs ?? {
      readFile: (path) => readFile(path, "utf8"),
      readdir: (path) => readdir(path),
      isDirectory: async (path) => {
        try {
          return (await stat(path)).isDirectory();
        } catch {
          return false;
        }
      },
      realpath: (path) => realpath(path),
    };
  }

  /** The request behind a listed server, by its id, or undefined once the listing is stale. */
  server(id: string): UserAddedMcpServerRequest | undefined {
    return this.#servers.get(id)?.request;
  }

  /** The folder behind a listed plugin, by its id. The path never leaves the host. */
  pluginPath(id: string): string | undefined {
    return this.#plugins.get(id)?.absolutePath;
  }

  async list(): Promise<DiscoveredAgentToolingListing> {
    const servers = new Map<string, DiscoveredServerRecord>();
    const plugins = new Map<string, DiscoveredPluginRecord>();
    const notes: string[] = [];
    await this.#claudeCodeServers(servers, notes);
    await this.#claudeCodePlugins(plugins, notes);
    await this.#codexServers(servers, notes);
    await this.#codexPlugins(plugins, notes);
    this.#servers = servers;
    this.#plugins = plugins;
    return {
      servers: [...servers.values()].map((record) => record.listing).slice(0, 256),
      plugins: [...plugins.values()].map((record) => record.listing).slice(0, 256),
      notes: [...new Set(notes)].slice(0, 64),
    };
  }

  async #claudeCodeServers(
    servers: Map<string, DiscoveredServerRecord>,
    notes: string[],
  ): Promise<void> {
    const config = await this.#readJson(join(this.#options.home, ".claude.json"));
    const roots = this.#options.projectRoots();
    if (isRecord(config)) {
      this.#collectClaudeServers(servers, notes, config.mcpServers, "user");
      const projects = isRecord(config.projects) ? config.projects : {};
      for (const root of roots) {
        const entry = projects[root] ?? projects[`${root}/`];
        if (isRecord(entry))
          this.#collectClaudeServers(servers, notes, entry.mcpServers, "project");
      }
    }
    for (const root of roots) {
      const projectConfig = await this.#readJson(join(root, ".mcp.json"));
      if (isRecord(projectConfig)) {
        this.#collectClaudeServers(servers, notes, projectConfig.mcpServers, "project");
      }
    }
  }

  #collectClaudeServers(
    servers: Map<string, DiscoveredServerRecord>,
    notes: string[],
    declared: unknown,
    scope: "user" | "project",
  ): void {
    if (!isRecord(declared)) return;
    for (const [name, value] of Object.entries(declared)) {
      if (!isRecord(value)) continue;
      const type =
        typeof value.type === "string" ? value.type : value.command !== undefined ? "stdio" : "";
      if (type === "stdio") {
        if (typeof value.command !== "string") continue;
        this.#offer(servers, "claude-code", scope, name, {
          type: "stdio",
          command: this.#expand(value.command, []).value,
          args: stringArray(value.args),
          env: isRecord(value.env) ? value.env : {},
        });
        continue;
      }
      if (type === "http" || type === "streamable-http") {
        if (typeof value.url !== "string") continue;
        this.#offer(servers, "claude-code", scope, name, {
          type: "streamable-http",
          url: value.url,
          headers: isRecord(value.headers) ? value.headers : {},
        });
        continue;
      }
      notes.push(
        `${name} (Claude Code): its ${type || "unknown"} transport is not one Octant connects to.`,
      );
    }
  }

  async #codexServers(
    servers: Map<string, DiscoveredServerRecord>,
    notes: string[],
  ): Promise<void> {
    const config = await this.#readToml(join(this.#options.home, ".codex", "config.toml"));
    if (!isRecord(config) || !isRecord(config.mcp_servers)) return;
    for (const [name, value] of Object.entries(config.mcp_servers)) {
      if (!isRecord(value) || value.enabled === false) continue;
      if (typeof value.url === "string") {
        const headers: Record<string, unknown> = isRecord(value.http_headers)
          ? { ...value.http_headers }
          : {};
        if (isRecord(value.env_http_headers)) {
          for (const [header, variable] of Object.entries(value.env_http_headers)) {
            if (typeof variable === "string") headers[header] = `\${${variable}}`;
          }
        }
        if (typeof value.bearer_token_env_var === "string") {
          headers.Authorization = `Bearer \${${value.bearer_token_env_var}}`;
        }
        this.#offer(servers, "codex", "user", name, {
          type: "streamable-http",
          url: value.url,
          headers,
        });
        continue;
      }
      if (typeof value.command !== "string") continue;
      if (typeof value.cwd === "string" && value.cwd.length > 0) {
        notes.push(
          `${name} (Codex): its working folder is left out; Octant starts it in its own folder.`,
        );
      }
      this.#offer(servers, "codex", "user", name, {
        type: "stdio",
        command: value.command,
        args: stringArray(value.args),
        env: isRecord(value.env) ? value.env : {},
      });
    }
  }

  /**
   * Turns one found server into the request Add MCP server would send, with
   * `${VAR}` filled from the environment where it can be, and a value whose
   * name reads like a credential marked secret so it goes to the broker.
   */
  #offer(
    servers: Map<string, DiscoveredServerRecord>,
    origin: DiscoveredAgentToolingOrigin,
    scope: "user" | "project",
    name: string,
    found:
      | {
          readonly type: "stdio";
          readonly command: string;
          readonly args: ReadonlyArray<string>;
          readonly env: Readonly<Record<string, unknown>>;
        }
      | {
          readonly type: "streamable-http";
          readonly url: string;
          readonly headers: Readonly<Record<string, unknown>>;
        },
  ): void {
    const needsValues: string[] = [];
    const rows: Array<{ name: string; value: string; secret: boolean }> = [];
    const values = found.type === "stdio" ? found.env : found.headers;
    for (const [key, raw] of Object.entries(values)) {
      if (typeof raw !== "string" || !/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) continue;
      const expanded = this.#expand(raw, needsValues);
      rows.push({
        name: key,
        value: expanded.value,
        secret: expanded.fromEnvironment || SECRET_NAME.test(key),
      });
    }
    const request: UserAddedMcpServerRequest =
      found.type === "stdio"
        ? {
            name,
            server: {
              type: "stdio",
              command: found.command,
              args: found.args.map((arg) => this.#expand(arg, needsValues).value),
              env: rows,
            },
          }
        : {
            name,
            server: {
              type: "streamable-http",
              url: this.#expand(found.url, needsValues).value,
              headers: rows,
            },
          };
    const summary =
      request.server.type === "stdio"
        ? [request.server.command, ...request.server.args].join(" ")
        : request.server.url;
    const id = `${origin === "codex" ? "codex" : "claude"}-${digest(
      `${origin}\0${scope}\0${name}\0${JSON.stringify(found)}`,
    )}`;
    servers.set(id, {
      listing: {
        id,
        origin,
        scope,
        name: name.slice(0, 128),
        transport: request.server.type,
        summary: summary.slice(0, 512),
        needsValues: [...new Set(needsValues)].slice(0, 32),
        secretNames: rows
          .filter((row) => row.secret)
          .map((row) => row.name)
          .slice(0, 32),
      },
      request,
    });
  }

  #expand(
    value: string,
    needsValues: string[],
  ): { readonly value: string; readonly fromEnvironment: boolean } {
    let fromEnvironment = false;
    const expanded = value.replace(VARIABLE, (whole, name: string, fallback?: string) => {
      const present = this.#options.env[name];
      if (present !== undefined) {
        fromEnvironment = true;
        return present;
      }
      if (fallback !== undefined) return fallback;
      needsValues.push(name);
      return whole;
    });
    return { value: expanded, fromEnvironment };
  }

  async #claudeCodePlugins(
    plugins: Map<string, DiscoveredPluginRecord>,
    notes: string[],
  ): Promise<void> {
    const pluginsRoot = join(this.#options.home, ".claude", "plugins");
    const settings = await this.#readJson(join(this.#options.home, ".claude", "settings.json"));
    const enabled =
      isRecord(settings) && isRecord(settings.enabledPlugins) ? settings.enabledPlugins : {};
    const candidates = new Map<string, { readonly name: string; readonly version?: string }>();
    const installed = await this.#readJson(join(pluginsRoot, "installed_plugins.json"));
    collectInstallPaths(installed, undefined, (path, name, version) => {
      candidates.set(path, { name, ...(version === undefined ? {} : { version }) });
    });
    for (const marketplace of await this.#dirs(join(pluginsRoot, "cache"))) {
      for (const plugin of await this.#dirs(join(pluginsRoot, "cache", marketplace))) {
        for (const version of await this.#dirs(join(pluginsRoot, "cache", marketplace, plugin))) {
          candidates.set(join(pluginsRoot, "cache", marketplace, plugin, version), {
            name: `${plugin}@${marketplace}`,
            version,
          });
        }
      }
    }
    for (const synced of await this.#dirs(join(pluginsRoot, "synced"))) {
      const root = join(pluginsRoot, "synced", synced);
      for (const found of await this.#pluginFoldersUnder(root, 3)) {
        const folder =
          found
            .split("/")
            .filter((part) => part.length > 0)
            .pop() ?? synced;
        candidates.set(found, { name: `${folder}@synced` });
      }
    }
    for (const [path, candidate] of candidates) {
      await this.#offerPlugin(
        plugins,
        notes,
        "claude-code",
        path,
        candidate.name,
        candidate.version,
        () => {
          const flag = enabled[candidate.name];
          return typeof flag === "boolean" ? flag : true;
        },
      );
    }
  }

  async #codexPlugins(
    plugins: Map<string, DiscoveredPluginRecord>,
    notes: string[],
  ): Promise<void> {
    const config = await this.#readToml(join(this.#options.home, ".codex", "config.toml"));
    const declared = isRecord(config) && isRecord(config.plugins) ? config.plugins : {};
    const cache = join(this.#options.home, ".codex", "plugins", "cache");
    for (const marketplace of await this.#dirs(cache)) {
      for (const plugin of await this.#dirs(join(cache, marketplace))) {
        const versions = [...(await this.#dirs(join(cache, marketplace, plugin)))].sort();
        const version = versions.at(-1);
        if (version === undefined) continue;
        const name = `${plugin}@${marketplace}`;
        await this.#offerPlugin(
          plugins,
          notes,
          "codex",
          join(cache, marketplace, plugin, version),
          name,
          version,
          () => {
            const entry = declared[name];
            return isRecord(entry) && entry.enabled === true;
          },
        );
      }
    }
  }

  async #offerPlugin(
    plugins: Map<string, DiscoveredPluginRecord>,
    notes: string[],
    origin: DiscoveredAgentToolingOrigin,
    path: string,
    name: string,
    version: string | undefined,
    enabledThere: () => boolean,
  ): Promise<void> {
    if (!(await this.#fs.isDirectory(path))) return;
    let canonical: string;
    try {
      canonical = await this.#fs.realpath(path);
    } catch {
      return;
    }
    const format = await this.#pluginFormat(canonical);
    if (format === undefined) {
      notes.push(`${name}: no plugin files Octant can read were found in its folder.`);
      return;
    }
    const id = `${origin === "codex" ? "codex" : "claude"}-${digest(`${origin}\0${canonical}`)}`;
    if (plugins.has(id)) return;
    plugins.set(id, {
      listing: {
        id,
        origin,
        name: name.slice(0, 128),
        ...(version === undefined ? {} : { version: version.slice(0, 64) }),
        format,
        enabledThere: enabledThere(),
      },
      absolutePath: canonical,
    });
  }

  async #pluginFormat(
    folder: string,
  ): Promise<"agent-plugins" | "codex-plugin" | "claude-plugin" | undefined> {
    const names = new Set(await this.#names(folder));
    if (names.has("plugin.json")) {
      const manifest = await this.#readJson(join(folder, "plugin.json"));
      const entries: AgentPluginsPackageEntry[] = [
        {
          path: "plugin.json",
          kind: "file",
          content: new TextEncoder().encode(JSON.stringify(manifest ?? null)),
        },
      ];
      if (looksLikeAgentPlugin(entries)) return "agent-plugins";
    }
    if (await this.#fs.isDirectory(join(folder, ".codex-plugin"))) {
      if ((await this.#names(join(folder, ".codex-plugin"))).includes("plugin.json")) {
        return "codex-plugin";
      }
    }
    if (
      names.has(".mcp.json") ||
      (await this.#fs.isDirectory(join(folder, "skills"))) ||
      ((await this.#fs.isDirectory(join(folder, ".claude-plugin"))) &&
        (await this.#names(join(folder, ".claude-plugin"))).includes("plugin.json"))
    ) {
      return "claude-plugin";
    }
    return undefined;
  }

  async #pluginFoldersUnder(root: string, depth: number): Promise<ReadonlyArray<string>> {
    if ((await this.#pluginFormat(root)) !== undefined) return [root];
    if (depth === 0) return [];
    const found: string[] = [];
    for (const child of await this.#dirs(root)) {
      if (child.startsWith(".")) continue;
      found.push(...(await this.#pluginFoldersUnder(join(root, child), depth - 1)));
    }
    return found;
  }

  async #dirs(path: string): Promise<ReadonlyArray<string>> {
    const names = await this.#names(path);
    const dirs: string[] = [];
    for (const name of names) {
      if (name.startsWith(".")) continue;
      if (await this.#fs.isDirectory(join(path, name))) dirs.push(name);
    }
    return dirs.sort();
  }

  async #names(path: string): Promise<ReadonlyArray<string>> {
    try {
      return await this.#fs.readdir(path);
    } catch {
      return [];
    }
  }

  async #readJson(path: string): Promise<unknown> {
    try {
      return JSON.parse(await this.#fs.readFile(path)) as unknown;
    } catch {
      return undefined;
    }
  }

  async #readToml(path: string): Promise<unknown> {
    try {
      return this.#options.parseToml(await this.#fs.readFile(path));
    } catch {
      return undefined;
    }
  }
}

/**
 * Walks Claude Code's install records for every `installPath`, naming each
 * by the nearest `name@marketplace` key above it. The file's exact shape is
 * not relied on, only that an install record names its folder that way.
 */
function collectInstallPaths(
  value: unknown,
  nearestName: string | undefined,
  visit: (path: string, name: string, version: string | undefined) => void,
): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectInstallPaths(entry, nearestName, visit);
    return;
  }
  if (!isRecord(value)) return;
  if (typeof value.installPath === "string" && nearestName !== undefined) {
    visit(
      value.installPath,
      nearestName,
      typeof value.version === "string" ? value.version : undefined,
    );
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    collectInstallPaths(entry, key.includes("@") ? key : nearestName, visit);
  }
}

function stringArray(value: unknown): ReadonlyArray<string> {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 32);
}
