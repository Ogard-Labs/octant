import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderCredentialStore } from "../providers/credentialBrokerClient";
import { LocalPluginFolderRegistry } from "./localPluginFolderRegistry";
import { UserAddedMcpServerStore, packageSlug } from "./userAddedMcpServers";

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

function secretsStore(): ProviderCredentialStore & { readonly values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    has: async (id) => values.has(id),
    resolve: async (id) => {
      const value = values.get(id);
      if (value === undefined) throw new Error("missing");
      return value;
    },
    set: async (id, value) => {
      values.set(id, value);
    },
    delete: async (id) => {
      values.delete(id);
    },
  };
}

async function store(options: { readonly secrets?: ProviderCredentialStore } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "octant-user-added-"));
  directories.push(directory);
  let counter = 0;
  const registry = new LocalPluginFolderRegistry({ sourceKind: "user-added" });
  return {
    directory,
    registry,
    store: new UserAddedMcpServerStore({
      directory: join(directory, "user-added"),
      registry,
      ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
      uuid: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
    }),
  };
}

describe("MCP servers added by hand", () => {
  it("writes a package whose secret value is only a reference, and fills it in at launch", async () => {
    const secrets = secretsStore();
    const { store: servers, registry } = await store({ secrets });
    const { source } = await servers.add({
      name: "Docs search",
      server: {
        type: "stdio",
        command: "npx",
        args: ["-y", "docs-search-mcp"],
        env: [
          { name: "DOCS_URL", value: "https://docs.example", secret: false },
          { name: "DOCS_TOKEN", value: "private-value", secret: true },
        ],
      },
    });
    expect(source.kind).toBe("user-added");
    const registered = registry.get(source.sourceRef);
    expect(registered?.packageInput.source).toEqual(source);
    const mcpJson = await readFile(join(registered?.absolutePath ?? "", "mcp.json"), "utf8");
    expect(mcpJson).not.toContain("private-value");
    expect(mcpJson).toContain("${OCTANT_SECRET:00000000-0000-4000-8000-000000000001}");
    expect(secrets.values.get("00000000-0000-4000-8000-000000000001")).toBe("private-value");
    const manifest = JSON.parse(
      await readFile(join(registered?.absolutePath ?? "", "plugin.json"), "utf8"),
    ) as { name: string };
    expect(manifest.name).toBe("docs-search");

    const launch = await servers.resolveLaunchSecrets({
      transport: "stdio",
      name: "Docs search",
      command: "npx",
      args: ["-y", "docs-search-mcp"],
      cwd: "/plugin",
      env: {
        DOCS_URL: "https://docs.example",
        DOCS_TOKEN: "${OCTANT_SECRET:00000000-0000-4000-8000-000000000001}",
      },
    });
    expect(launch.transport === "stdio" ? launch.env : {}).toEqual({
      DOCS_URL: "https://docs.example",
      DOCS_TOKEN: "private-value",
    });
  });

  it("refuses a secret that is still an unfilled placeholder, and stores nothing", async () => {
    const secrets = secretsStore();
    const { store: servers } = await store({ secrets });
    await expect(
      servers.add({
        name: "Remote",
        server: {
          type: "streamable-http",
          url: "https://mcp.example/mcp",
          headers: [{ name: "Authorization", value: "Bearer ${MCP_TOKEN}", secret: true }],
        },
      }),
    ).rejects.toMatchObject({ category: "invalid" });
    expect(secrets.values.size).toBe(0);
  });

  it("refuses a secret value on a host that has no credential store", async () => {
    const { store: servers, directory } = await store();
    await expect(
      servers.add({
        name: "Remote",
        server: {
          type: "streamable-http",
          url: "https://mcp.example/mcp",
          headers: [{ name: "Authorization", value: "Bearer private-value", secret: true }],
        },
      }),
    ).rejects.toMatchObject({ category: "unavailable" });
    await expect(stat(join(directory, "user-added", "remote"))).rejects.toThrow();
  });

  it("refuses a plain http address off this computer", async () => {
    const { store: servers } = await store();
    await expect(
      servers.add({
        name: "Remote",
        server: { type: "streamable-http", url: "http://mcp.example/mcp", headers: [] },
      }),
    ).rejects.toMatchObject({ category: "invalid" });
  });

  it("fails a launch whose secret the store no longer holds, instead of starting blank", async () => {
    const secrets = secretsStore();
    const { store: servers } = await store({ secrets });
    await expect(
      servers.resolveLaunchSecrets({
        transport: "streamable-http",
        name: "Remote",
        url: "https://mcp.example/mcp",
        headers: { Authorization: "${OCTANT_SECRET:00000000-0000-4000-8000-000000000009}" },
      }),
    ).rejects.toThrow(/missing from the credential store/);
  });

  it("removes the folder and every secret the package referenced", async () => {
    const secrets = secretsStore();
    const { store: servers, registry } = await store({ secrets });
    const { source } = await servers.add({
      name: "Remote",
      server: {
        type: "streamable-http",
        url: "https://mcp.example/mcp",
        headers: [{ name: "Authorization", value: "Bearer private-value", secret: true }],
      },
    });
    const folder = registry.get(source.sourceRef)?.absolutePath ?? "";
    expect(secrets.values.size).toBe(1);
    await servers.remove(source.sourceRef);
    expect(secrets.values.size).toBe(0);
    await expect(stat(folder)).rejects.toThrow();
    expect(registry.get(source.sourceRef)).toBeUndefined();
  });

  it("refuses a second server with the same name rather than overwriting the first", async () => {
    const { store: servers } = await store();
    const add = () =>
      servers.add({
        name: "Local tools",
        server: { type: "stdio", command: "/usr/local/bin/tools", args: [], env: [] },
      });
    await add();
    await expect(add()).rejects.toMatchObject({ category: "conflict" });
  });

  it("keeps the connector package name for a catalog add and refuses it to a hand add", async () => {
    const { store: servers, registry } = await store();
    const handAdded = (name: string) =>
      servers.add({
        name,
        server: { type: "streamable-http", url: "https://example.com/mcp", headers: [] },
      });
    await handAdded("Linear");
    const connector = await servers.add({
      name: "Linear",
      connectorId: "linear",
      server: { type: "streamable-http", url: "https://mcp.linear.app/mcp", headers: [] },
    });
    expect(registry.get(connector.source.sourceRef)?.packageInput.source).toEqual(connector.source);
    const manifest = await readFile(
      join(registry.get(connector.source.sourceRef)?.absolutePath ?? "", "plugin.json"),
      "utf8",
    );
    expect(JSON.parse(manifest)).toMatchObject({ name: "connector-linear" });
    await expect(handAdded("Connector Notion")).rejects.toMatchObject({ category: "invalid" });
    await expect(
      servers.add({
        name: "Linear",
        connectorId: "linear",
        server: { type: "streamable-http", url: "https://example.com/mcp", headers: [] },
      }),
    ).rejects.toMatchObject({ category: "invalid" });
    await expect(
      servers.add({
        name: "Nope",
        connectorId: "not-in-catalog",
        server: { type: "streamable-http", url: "https://example.com/mcp", headers: [] },
      }),
    ).rejects.toMatchObject({ category: "invalid" });
  });

  it("turns a display name into a package name and refuses one with nothing usable", () => {
    expect(packageSlug("  Docs Search (v2) ")).toBe("docs-search-v2");
    expect(() => packageSlug("___")).toThrow(/at least one letter or digit/);
  });
});
