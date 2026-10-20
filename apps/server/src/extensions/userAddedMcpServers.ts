import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { UserAddedMcpServerRequest } from "@octant/contracts/extension-rpc";
import type { ExtensionSource } from "@octant/contracts/extensions";
import {
  AGENT_PLUGINS_MCP_SCHEMA,
  AGENT_PLUGINS_NAME_PATTERN,
  AGENT_PLUGINS_PLUGIN_SCHEMA,
  type AgentPluginsMcpLaunchSpec,
} from "@octant/plugin-host/agent-plugins";
import type { ProviderCredentialStore } from "../providers/credentialBrokerClient";
import type { LocalPluginFolderRegistry } from "./localPluginFolderRegistry";

/**
 * How a generated package names a secret the broker holds. The whole value is
 * the reference, so a secret is never spliced into a longer string the server
 * could echo in part.
 */
const SECRET_REFERENCE = /^\$\{OCTANT_SECRET:([0-9a-f-]{36})\}$/;
const RESERVED_ENV = new Set(["PLUGIN_ROOT", "PLUGIN_DATA"]);

export type UserAddedMcpServerSource = Extract<ExtensionSource, { readonly kind: "user-added" }>;

export class UserAddedMcpServerError extends Error {
  override readonly name = "UserAddedMcpServerError";
  readonly category: "invalid" | "conflict" | "unavailable" | "failed";

  constructor(category: UserAddedMcpServerError["category"], message: string) {
    super(message);
    this.category = category;
  }
}

export interface UserAddedMcpServerStoreOptions {
  /** The host's own folder for generated packages, one sub-folder per server. */
  readonly directory: string;
  /** A registry configured with the `user-added` source kind. */
  readonly registry: Pick<LocalPluginFolderRegistry, "register" | "get" | "unregister">;
  /** The broker namespace for secret values; absent on a host with no broker. */
  readonly secrets?: ProviderCredentialStore;
  readonly uuid?: () => string;
}

/**
 * MCP servers a person adds by hand in Settings. Each becomes an ordinary
 * Agent Plugins package the host writes into its own data folder: a manifest
 * and an `mcp.json` with the one server. A value the person marked secret goes
 * to the credential broker and the package carries only a reference, resolved
 * when the server is launched and never written to disk, the journal, or the
 * renderer. Uninstalling the package removes the folder and the secrets.
 */
export class UserAddedMcpServerStore {
  readonly #directory: string;
  readonly #registry: UserAddedMcpServerStoreOptions["registry"];
  readonly #secrets: ProviderCredentialStore | undefined;
  readonly #uuid: () => string;

  constructor(options: UserAddedMcpServerStoreOptions) {
    this.#directory = options.directory;
    this.#registry = options.registry;
    this.#secrets = options.secrets;
    this.#uuid = options.uuid ?? (() => crypto.randomUUID());
  }

  async add(request: UserAddedMcpServerRequest): Promise<{ source: UserAddedMcpServerSource }> {
    const slug = packageSlug(request.name);
    const folder = join(this.#directory, slug);
    if (await exists(folder)) {
      throw new UserAddedMcpServerError("conflict", "A server with this name is already added.");
    }
    const values = request.server.type === "stdio" ? request.server.env : request.server.headers;
    if (values.some((value) => value.secret) && this.#secrets === undefined) {
      throw new UserAddedMcpServerError(
        "unavailable",
        "This host cannot keep secrets. Add the server from the Octant app, or without secret values.",
      );
    }
    if (request.server.type === "stdio") {
      for (const value of request.server.env) {
        if (RESERVED_ENV.has(value.name)) {
          throw new UserAddedMcpServerError(
            "invalid",
            `${value.name} is set by Octant and cannot be given a value.`,
          );
        }
      }
    } else {
      validateRemoteUrl(request.server.url);
    }
    const storedSecretIds: string[] = [];
    const resolvedValues: Record<string, string> = {};
    try {
      for (const value of values) {
        if (!value.secret) {
          resolvedValues[value.name] = value.value;
          continue;
        }
        if (value.value.length === 0) {
          throw new UserAddedMcpServerError("invalid", `${value.name} is marked secret but empty.`);
        }
        const secretId = this.#uuid();
        await this.#secrets?.set(secretId, value.value);
        storedSecretIds.push(secretId);
        resolvedValues[value.name] = `\${OCTANT_SECRET:${secretId}}`;
      }
      const server =
        request.server.type === "stdio"
          ? {
              type: "stdio",
              command: request.server.command,
              args: request.server.args,
              env: resolvedValues,
            }
          : { type: "streamable-http", url: request.server.url, headers: resolvedValues };
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await writeFile(
        join(folder, "plugin.json"),
        `${JSON.stringify(
          {
            $schema: AGENT_PLUGINS_PLUGIN_SCHEMA,
            name: slug,
            version: "1.0.0",
            description: `${request.name} (added in Settings)`,
          },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      await writeFile(
        join(folder, "mcp.json"),
        `${JSON.stringify(
          { $schema: AGENT_PLUGINS_MCP_SCHEMA, mcpServers: { [request.name]: server } },
          null,
          2,
        )}\n`,
        { mode: 0o600 },
      );
      const registered = await this.#registry.register(folder);
      if (registered.source.kind !== "user-added") {
        throw new UserAddedMcpServerError("failed", "The server could not be registered.");
      }
      return { source: registered.source };
    } catch (error) {
      await rm(folder, { recursive: true, force: true }).catch(() => undefined);
      for (const secretId of storedSecretIds) {
        await this.#secrets?.delete(secretId).catch(() => undefined);
      }
      if (error instanceof UserAddedMcpServerError) throw error;
      throw new UserAddedMcpServerError(
        "invalid",
        error instanceof Error ? error.message : "The server could not be added.",
      );
    }
  }

  /**
   * Whether the host wrote the package with this source reference for a server
   * the person added. Installing a package rewrites its manifest source to a
   * generic kind, so the manifest cannot vouch for itself: only this host's
   * own registry of generated folders can.
   */
  owns(sourceRef: string): boolean {
    return this.#registry.get(sourceRef) !== undefined;
  }

  /** Removes the generated folder and every secret its package referenced. */
  async remove(sourceRef: string): Promise<void> {
    const registered = this.#registry.get(sourceRef);
    if (registered === undefined) return;
    const folder = registered.absolutePath;
    for (const secretId of await referencedSecretIds(folder)) {
      await this.#secrets?.delete(secretId).catch(() => undefined);
    }
    await rm(folder, { recursive: true, force: true });
    await this.#registry.unregister(sourceRef);
  }

  /**
   * Replaces each secret reference in a launch with the value the broker
   * holds. A reference the broker cannot answer fails the launch: the server
   * never starts with an empty or literal placeholder where a secret belongs.
   */
  async resolveLaunchSecrets(
    launch: AgentPluginsMcpLaunchSpec,
  ): Promise<AgentPluginsMcpLaunchSpec> {
    if (launch.transport === "stdio") {
      return { ...launch, env: await this.#resolveValues(launch.env) };
    }
    return { ...launch, headers: await this.#resolveValues(launch.headers) };
  }

  async #resolveValues(
    values: Readonly<Record<string, string>>,
  ): Promise<Readonly<Record<string, string>>> {
    const resolved: Record<string, string> = {};
    for (const [name, value] of Object.entries(values)) {
      const match = SECRET_REFERENCE.exec(value);
      if (match === null) {
        resolved[name] = value;
        continue;
      }
      const secretId = match[1] ?? "";
      if (this.#secrets === undefined) {
        throw new Error(`The secret for ${name} is unavailable on this host.`);
      }
      try {
        resolved[name] = await this.#secrets.resolve(secretId);
      } catch {
        throw new Error(`The secret for ${name} is missing from the credential store.`);
      }
    }
    return resolved;
  }
}

async function referencedSecretIds(folder: string): Promise<ReadonlyArray<string>> {
  let raw: string;
  try {
    raw = await readFile(join(folder, "mcp.json"), "utf8");
  } catch {
    return [];
  }
  const ids: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      const match = SECRET_REFERENCE.exec(value);
      if (match?.[1] !== undefined) ids.push(match[1]);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const entry of Object.values(value)) visit(entry);
    }
  };
  try {
    visit(JSON.parse(raw));
  } catch {
    return [];
  }
  return ids;
}

/**
 * The package name a server's display name becomes: lower-case, hyphenated,
 * within the Agent Plugins name pattern. A name that leaves nothing usable is
 * refused rather than invented.
 */
export function packageSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 64)
    .replace(/[-.]+$/g, "");
  if (slug.length === 0 || !AGENT_PLUGINS_NAME_PATTERN.test(slug)) {
    throw new UserAddedMcpServerError(
      "invalid",
      "Give the server a name with at least one letter or digit.",
    );
  }
  return slug;
}

function validateRemoteUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UserAddedMcpServerError("invalid", "Enter a full address, such as https://host/mcp.");
  }
  if (parsed.username || parsed.password || parsed.hash) {
    throw new UserAddedMcpServerError(
      "invalid",
      "The address must not carry a user name, password, or fragment.",
    );
  }
  const host = parsed.hostname.toLowerCase();
  const loopback =
    host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
  if (parsed.protocol === "https:" || (parsed.protocol === "http:" && loopback)) return;
  throw new UserAddedMcpServerError(
    "invalid",
    "A server off this computer needs an https address.",
  );
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
