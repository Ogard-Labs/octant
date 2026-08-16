import { describe, expect, it } from "vitest";
import {
  AGENT_PLUGINS_MCP_SCHEMA,
  AGENT_PLUGINS_PLUGIN_SCHEMA,
  AgentPluginsError,
  expandPluginPlaceholders,
  loadAgentPluginFromEntries,
  mapAgentPluginsMcpServerToLaunchSpec,
  resolveStdioCommand,
  resolveStdioCwd,
  type AgentPluginsPackageEntry,
  validateAgentPluginsManifest,
  validateAgentPluginsMcpDocument,
} from "./index";

const encoder = new TextEncoder();

function file(path: string, content: string): AgentPluginsPackageEntry {
  return { path, kind: "file", content: encoder.encode(content) };
}

function dir(path: string): AgentPluginsPackageEntry {
  return { path, kind: "directory" };
}

function minimalPlugin(
  overrides: {
    readonly manifest?: Record<string, unknown>;
    readonly skill?: boolean;
    readonly mcp?: Record<string, unknown> | false;
    readonly extraEntries?: AgentPluginsPackageEntry[];
  } = {},
): AgentPluginsPackageEntry[] {
  const manifest = {
    $schema: AGENT_PLUGINS_PLUGIN_SCHEMA,
    name: "hello-plugin",
    ...overrides.manifest,
  };
  const entries: AgentPluginsPackageEntry[] = [
    file("plugin.json", JSON.stringify(manifest)),
    dir("skills"),
  ];
  if (overrides.skill !== false) {
    entries.push(
      dir("skills/greet"),
      file(
        "skills/greet/SKILL.md",
        `---
name: greet
description: Greet the user and offer help.
---

Greet the user and offer help.
`,
      ),
    );
  }
  if (overrides.mcp !== false) {
    const mcp =
      overrides.mcp ??
      ({
        $schema: AGENT_PLUGINS_MCP_SCHEMA,
        mcpServers: {
          "local-tools": {
            type: "stdio",
            command: "./bin/server",
            args: ["--data", "${PLUGIN_DATA}"],
            env: { CONFIG: "${PLUGIN_ROOT}/config.json" },
            cwd: "${PLUGIN_ROOT}",
          },
          "remote-tools": {
            type: "streamable-http",
            url: "https://tools.example.com/mcp",
          },
        },
      } satisfies Record<string, unknown>);
    entries.push(file("mcp.json", JSON.stringify(mcp)));
    entries.push(dir("bin"), file("bin/server", "#!/bin/sh\necho ok\n"));
  }
  if (overrides.extraEntries) entries.push(...overrides.extraEntries);
  return entries;
}

describe("Agent Plugins 1.0.0 client conformance", () => {
  describe("plugin loader", () => {
    it("loads a plugin from a directory entry set and validates plugin.json", () => {
      const loaded = loadAgentPluginFromEntries(minimalPlugin());
      expect(loaded.manifest.name).toBe("hello-plugin");
      expect(loaded.skills).toHaveLength(1);
      expect(loaded.servers.map((server) => server.name).sort()).toEqual([
        "local-tools",
        "remote-tools",
      ]);
    });

    it("selects locally supported schema rules from $schema and rejects unsupported schemas", () => {
      expect(() =>
        validateAgentPluginsManifest({
          $schema: "https://agent-plugins.org/schemas/0.9.0/plugin.schema.json",
          name: "hello",
        }),
      ).toThrow(AgentPluginsError);
    });

    it("reports and ignores unknown top-level fields", () => {
      const result = validateAgentPluginsManifest({
        $schema: AGENT_PLUGINS_PLUGIN_SCHEMA,
        name: "hello",
        experimentalThing: true,
      });
      expect(result.diagnostics.some((d) => d.code === "unknown-field")).toBe(true);
      expect(result.manifest.name).toBe("hello");
    });

    it("ignores a non-object extensions field and unimplemented namespaces", () => {
      const ignored = validateAgentPluginsManifest({
        $schema: AGENT_PLUGINS_PLUGIN_SCHEMA,
        name: "hello",
        extensions: "nope",
      });
      expect(ignored.diagnostics.some((d) => d.code === "extensions-ignored")).toBe(true);

      const namespaces = validateAgentPluginsManifest({
        $schema: AGENT_PLUGINS_PLUGIN_SCHEMA,
        name: "hello",
        extensions: { "com.example.client": { hooks: true } },
      });
      expect(
        namespaces.diagnostics.some((d) => d.code === "extension-namespace-unimplemented"),
      ).toBe(true);
    });

    it("rejects other fatal manifest violations before component discovery", () => {
      expect(() =>
        loadAgentPluginFromEntries([
          file(
            "plugin.json",
            JSON.stringify({ $schema: AGENT_PLUGINS_PLUGIN_SCHEMA, name: "BAD NAME" }),
          ),
          file(
            "skills/greet/SKILL.md",
            `---
name: greet
description: ok
---
`,
          ),
        ]),
      ).toThrow(/name/i);
    });

    it.each(["version", "description", "homepage", "repository", "license"])(
      "rejects a non-string optional %s field",
      (field) => {
        expect(() =>
          validateAgentPluginsManifest({
            $schema: AGENT_PLUGINS_PLUGIN_SCHEMA,
            name: "hello",
            [field]: 123,
          }),
        ).toThrow(AgentPluginsError);
      },
    );
  });

  describe("discovery and isolation", () => {
    it("treats missing component locations as valid absence", () => {
      const loaded = loadAgentPluginFromEntries([
        file(
          "plugin.json",
          JSON.stringify({ $schema: AGENT_PLUGINS_PLUGIN_SCHEMA, name: "skills-only" }),
        ),
        file(
          "skills/greet/SKILL.md",
          `---
name: greet
description: Greet the user.
---
Hi
`,
        ),
      ]);
      expect(loaded.mcp).toBeUndefined();
      expect(loaded.skills).toHaveLength(1);
    });

    it("skips an invalid skill and continues loading siblings", () => {
      const loaded = loadAgentPluginFromEntries(
        minimalPlugin({
          skill: false,
          mcp: false,
          extraEntries: [
            file(
              "skills/bad/SKILL.md",
              `---
name: mismatched
description: Bad name.
---
`,
            ),
            file(
              "skills/good/SKILL.md",
              `---
name: good
description: A valid sibling skill.
---
Body
`,
            ),
          ],
        }),
      );
      expect(loaded.skills.map((skill) => skill.name)).toEqual(["good"]);
      expect(loaded.diagnostics.some((d) => d.code === "skill-skipped")).toBe(true);
    });

    it("parses folded YAML descriptions in valid SKILL.md frontmatter", () => {
      const loaded = loadAgentPluginFromEntries(
        minimalPlugin({
          skill: false,
          mcp: false,
          extraEntries: [
            file(
              "skills/folded/SKILL.md",
              `---
name: folded
description: >
  Review the change carefully
  and report actionable findings.
---
Body
`,
            ),
          ],
        }),
      );

      expect(loaded.skills).toEqual([
        expect.objectContaining({
          name: "folded",
          description: "Review the change carefully and report actionable findings.\n",
        }),
      ]);
    });

    it("does not recursively search nested descendants for skills", () => {
      const loaded = loadAgentPluginFromEntries(
        minimalPlugin({
          skill: false,
          mcp: false,
          extraEntries: [
            file(
              "skills/nested/deeper/SKILL.md",
              `---
name: deeper
description: Should not be discovered.
---
`,
            ),
          ],
        }),
      );
      expect(loaded.skills).toHaveLength(0);
    });
  });

  describe("MCP support", () => {
    it("validates the closed top-level document and each server entry independently", () => {
      const doc = validateAgentPluginsMcpDocument(
        {
          $schema: AGENT_PLUGINS_MCP_SCHEMA,
          mcpServers: {
            good: { type: "streamable-http", url: "https://example.com/mcp" },
            bad: { type: "stdio", command: "./bin/x", unknownField: true },
          },
        },
        { pluginSchema: AGENT_PLUGINS_PLUGIN_SCHEMA },
      );
      expect(doc.topLevelInvalid).toBe(false);
      expect(doc.servers.map((server) => server.name)).toEqual(["good"]);
      expect(doc.diagnostics.some((d) => d.code === "mcp-entry-invalid")).toBe(true);
    });

    it("isolates empty and oversized MCP server names from valid siblings", () => {
      const doc = validateAgentPluginsMcpDocument(
        {
          $schema: AGENT_PLUGINS_MCP_SCHEMA,
          mcpServers: {
            "": { type: "streamable-http", url: "https://empty.example/mcp" },
            ["x".repeat(129)]: {
              type: "streamable-http",
              url: "https://oversized.example/mcp",
            },
            good: { type: "streamable-http", url: "https://good.example/mcp" },
          },
        },
        { pluginSchema: AGENT_PLUGINS_PLUGIN_SCHEMA },
      );

      expect(doc.servers.map((server) => server.name)).toEqual(["good"]);
      expect(
        doc.diagnostics.filter((diagnostic) => diagnostic.code === "mcp-entry-invalid"),
      ).toHaveLength(2);
    });

    it("rejects malformed placeholder-rooted and escaping stdio working directories", () => {
      const doc = validateAgentPluginsMcpDocument(
        {
          $schema: AGENT_PLUGINS_MCP_SCHEMA,
          mcpServers: {
            root: { type: "stdio", command: "node", cwd: "${PLUGIN_ROOT}" },
            data: { type: "stdio", command: "node", cwd: "${PLUGIN_DATA}/cache" },
            rootSuffix: { type: "stdio", command: "node", cwd: "${PLUGIN_ROOT}suffix" },
            dataSuffix: { type: "stdio", command: "node", cwd: "${PLUGIN_DATA}suffix" },
            escape: { type: "stdio", command: "node", cwd: "./../outside" },
          },
        },
        { pluginSchema: AGENT_PLUGINS_PLUGIN_SCHEMA },
      );

      expect(doc.servers.map((server) => server.name)).toEqual(["data", "root"]);
      expect(
        doc.diagnostics.filter((diagnostic) => diagnostic.code === "mcp-entry-invalid"),
      ).toHaveLength(3);
    });

    it("requires matching Agent Plugins versions in plugin.json and mcp.json", () => {
      const doc = validateAgentPluginsMcpDocument(
        { $schema: AGENT_PLUGINS_MCP_SCHEMA, mcpServers: {} },
        { pluginSchema: "https://agent-plugins.org/schemas/0.9.0/plugin.schema.json" },
      );
      expect(doc.topLevelInvalid).toBe(true);
      expect(doc.diagnostics[0]?.code).toBe("mcp-version-mismatch");
    });

    it("resolves stdio commands as single executable tokens and expands only defined placeholders", () => {
      expect(resolveStdioCommand("python", "/plugins/hello").executable).toBe("python");
      expect(resolveStdioCommand("./bin/server", "/plugins/hello").executable).toBe(
        "/plugins/hello/bin/server",
      );
      expect(() => resolveStdioCommand("python -m server", "/plugins/hello")).toThrow(/token/i);

      const variables = {
        PLUGIN_ROOT: "/plugins/hello",
        PLUGIN_DATA: "/data/hello",
      };
      expect(expandPluginPlaceholders("${PLUGIN_ROOT}/a/${PLUGIN_DATA}", variables)).toBe(
        "/plugins/hello/a//data/hello",
      );
      expect(resolveStdioCwd("./work", variables)).toBe("/plugins/hello/work");
      expect(resolveStdioCwd("${PLUGIN_DATA}/cache", variables)).toBe("/data/hello/cache");
      expect(() => resolveStdioCwd("work", variables)).toThrow(/cwd/i);
    });

    it("maps servers into launch specs with PLUGIN_ROOT and PLUGIN_DATA applied last", () => {
      const loaded = loadAgentPluginFromEntries(minimalPlugin());
      const stdio = loaded.servers.find((server) => server.type === "stdio")!;
      const spec = mapAgentPluginsMcpServerToLaunchSpec(
        stdio,
        {
          PLUGIN_ROOT: "/plugins/hello",
          PLUGIN_DATA: "/data/hello",
        },
        { PATH: "/usr/bin", PLUGIN_ROOT: "attacker", CONFIG: "base" },
      );
      expect(spec.transport).toBe("stdio");
      if (spec.transport !== "stdio") throw new Error("expected stdio");
      expect(spec.command).toBe("/plugins/hello/bin/server");
      expect(spec.args).toEqual(["--data", "/data/hello"]);
      expect(spec.env.PLUGIN_ROOT).toBe("/plugins/hello");
      expect(spec.env.PLUGIN_DATA).toBe("/data/hello");
      expect(spec.env.CONFIG).toBe("/plugins/hello/config.json");
      expect(spec.cwd).toBe("/plugins/hello");
    });

    it("enforces remote URL requirements and continues after an independent entry fails", () => {
      const doc = validateAgentPluginsMcpDocument(
        {
          $schema: AGENT_PLUGINS_MCP_SCHEMA,
          mcpServers: {
            insecure: { type: "streamable-http", url: "http://evil.example/mcp" },
            ok: { type: "streamable-http", url: "https://ok.example/mcp" },
            loopback: { type: "streamable-http", url: "http://127.0.0.1:3000/mcp" },
          },
        },
        { pluginSchema: AGENT_PLUGINS_PLUGIN_SCHEMA },
      );
      expect(doc.servers.map((server) => server.name).sort()).toEqual(["loopback", "ok"]);
    });

    it("preserves conforming Streamable HTTP headers for the host credential boundary", () => {
      const doc = validateAgentPluginsMcpDocument(
        {
          $schema: AGENT_PLUGINS_MCP_SCHEMA,
          mcpServers: {
            authenticated: {
              type: "streamable-http",
              url: "https://example.com/mcp",
              headers: {
                Authorization: "Bearer package-configured-value",
                "X-Token-Budget": "4096",
              },
            },
          },
        },
        { pluginSchema: AGENT_PLUGINS_PLUGIN_SCHEMA },
      );

      expect(doc.servers).toEqual([
        expect.objectContaining({
          name: "authenticated",
          headers: {
            Authorization: "Bearer package-configured-value",
            "X-Token-Budget": "4096",
          },
        }),
      ]);
      expect(doc.diagnostics).toEqual([]);
    });

    it("disables MCP for the plugin when top-level mcp.json is invalid without dropping skills", () => {
      const loaded = loadAgentPluginFromEntries(
        minimalPlugin({
          mcp: {
            $schema: AGENT_PLUGINS_MCP_SCHEMA,
            mcpServers: {},
            extra: true,
          } as Record<string, unknown>,
        }),
      );
      expect(loaded.skills).toHaveLength(1);
      expect(loaded.servers).toHaveLength(0);
      expect(loaded.mcp?.topLevelInvalid).toBe(true);
    });
  });
});

describe("Agent Plugins optional field typing", () => {
  it("rejects mistyped optional scalar fields", () => {
    expect(() =>
      validateAgentPluginsManifest({
        $schema: AGENT_PLUGINS_PLUGIN_SCHEMA,
        name: "demo",
        version: 1,
      }),
    ).toThrow(/version must be a string/);
    expect(() =>
      validateAgentPluginsManifest({
        $schema: AGENT_PLUGINS_PLUGIN_SCHEMA,
        name: "demo",
        description: ["nope"],
      }),
    ).toThrow(/description must be a string/);
    expect(() =>
      validateAgentPluginsManifest({
        $schema: AGENT_PLUGINS_PLUGIN_SCHEMA,
        name: "demo",
        homepage: 12,
      }),
    ).toThrow(/homepage must be a string/);
  });
});
