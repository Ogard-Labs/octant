import { mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_PLUGINS_MCP_SCHEMA,
  AGENT_PLUGINS_PLUGIN_SCHEMA,
} from "@octant/plugin-host/agent-plugins";
import { normalizeAgentPluginPackage, type AgentPluginPackageInput } from "./agentPluginIngestion";
import { prepareAgentPluginMcpRuntime } from "./agentPluginMcpRuntime";
import { inspectExtensionPackage } from "./packageInspector";

const source = {
  kind: "local-folder",
  sourceRef: "agent-plugins-fixture",
} as AgentPluginPackageInput["source"];

const encoder = new TextEncoder();

function fixture(overrides: Partial<AgentPluginPackageInput> = {}): AgentPluginPackageInput {
  const entries = [
    {
      path: "plugin.json",
      kind: "file" as const,
      content: encoder.encode(
        JSON.stringify({
          $schema: AGENT_PLUGINS_PLUGIN_SCHEMA,
          name: "review-tools",
          version: "1.2.3",
          description: "Review helpers",
          author: { name: "Example" },
          repository: "https://example.test/review-tools",
          license: "MIT",
        }),
      ),
    },
    {
      path: "skills/review/SKILL.md",
      kind: "file" as const,
      content: encoder.encode(`---
name: review
description: Review a change set carefully.
---

Review carefully.
`),
    },
    {
      path: "mcp.json",
      kind: "file" as const,
      content: encoder.encode(
        JSON.stringify({
          $schema: AGENT_PLUGINS_MCP_SCHEMA,
          mcpServers: {
            docs: { type: "streamable-http", url: "https://example.test/mcp" },
            local: {
              type: "stdio",
              command: "./bin/server",
              args: ["--data", "${PLUGIN_DATA}"],
              cwd: "${PLUGIN_ROOT}",
            },
          },
        }),
      ),
    },
    {
      path: "bin/server",
      kind: "file" as const,
      content: encoder.encode("#!/bin/sh\necho ready\n"),
    },
  ];
  return {
    source,
    format: "directory",
    archiveBytes: 1024,
    entries,
    appVersion: "1.0.0",
    platform: "darwin",
    ...overrides,
  };
}

describe("Agent Plugins package ingestion", () => {
  it("preserves diagnostics for invalid siblings while retaining valid components", () => {
    const input = fixture();
    const resolved = normalizeAgentPluginPackage({
      ...input,
      entries: input.entries.map((entry) =>
        entry.path !== "skills/review/SKILL.md"
          ? entry
          : { ...entry, content: encoder.encode("invalid skill metadata") },
      ),
    });

    expect(resolved.diagnostics?.length).toBeGreaterThan(0);
    expect(inspectExtensionPackage(resolved).manifest.components).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "mcp-docs" })]),
    );
  });

  it("skips a missing stdio entry point without dropping valid sibling components", () => {
    const input = fixture();
    const resolved = inspectExtensionPackage(
      normalizeAgentPluginPackage({
        ...input,
        entries: input.entries.filter((entry) => entry.path !== "bin/server"),
      }),
    );

    expect(resolved.manifest.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "mcp-docs", kind: "mcp-server" }),
        expect.objectContaining({
          id: "skill-review",
          kind: "skill-instructions",
          skillName: "review",
        }),
      ]),
    );
    expect(resolved.manifest.components).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "mcp-local" })]),
    );
    expect(resolved.diagnostics).toContainEqual(
      expect.objectContaining({ code: "mcp-entry-point-missing" }),
    );
  });

  it("keeps same-name plugins from different sources as distinct extensions", () => {
    const first = inspectExtensionPackage(normalizeAgentPluginPackage(fixture()));
    const second = inspectExtensionPackage(
      normalizeAgentPluginPackage(
        fixture({ source: { kind: "local-folder", sourceRef: "another-source" } as never }),
      ),
    );

    expect(first.manifest.extensionId).not.toBe(second.manifest.extensionId);
  });

  it("keeps normalized MCP server component identities bounded and collision-resistant", () => {
    const input = fixture();
    const entries = input.entries.map((entry) =>
      entry.path !== "mcp.json"
        ? entry
        : {
            ...entry,
            content: encoder.encode(
              JSON.stringify({
                $schema: AGENT_PLUGINS_MCP_SCHEMA,
                mcpServers: {
                  "foo.bar": { type: "streamable-http", url: "https://example.test/a" },
                  "foo-bar": { type: "streamable-http", url: "https://example.test/b" },
                  ["long-".repeat(20) + "server"]: {
                    type: "streamable-http",
                    url: "https://example.test/long",
                  },
                },
              }),
            ),
          },
    );

    const normalized = inspectExtensionPackage(normalizeAgentPluginPackage({ ...input, entries }));
    const ids = normalized.manifest.components
      .filter((component) => component.kind === "mcp-server")
      .map((component) => component.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids.every((id) => id.length <= 64)).toBe(true);
  });

  it("keeps long Agent Skill component identities within the manifest limit", () => {
    const input = fixture();
    const longName = "a".repeat(64);
    const resolved = inspectExtensionPackage(
      normalizeAgentPluginPackage({
        ...input,
        entries: input.entries.map((entry) =>
          entry.path !== "skills/review/SKILL.md"
            ? entry
            : {
                ...entry,
                path: `skills/${longName}/SKILL.md`,
                content: encoder.encode(`---
name: ${longName}
description: A valid skill with the longest supported public name.
---
`),
              },
        ),
      }),
    );

    const skill = resolved.manifest.components.find(
      (component) => component.kind === "skill-instructions",
    );
    expect(skill?.displayName).toBe(longName);
    expect(skill?.id.length).toBeLessThanOrEqual(64);
  });

  it("normalizes skills and MCP servers into Octant extension components", () => {
    const resolved = normalizeAgentPluginPackage(fixture());
    expect(resolved.manifest).toMatchObject({
      slug: "review-tools",
      version: "1.2.3",
      source: { kind: "plugin-package", sourceRef: "agent-plugins-fixture" },
      license: { kind: "spdx", identifier: "MIT" },
      components: expect.arrayContaining([
        expect.objectContaining({
          id: "mcp-docs",
          kind: "mcp-server",
          configurationReference: "mcp.json",
        }),
        expect.objectContaining({
          id: "mcp-local",
          kind: "mcp-server",
          configurationReference: "mcp.json",
          entryPoint: "bin/server",
          declaredCapabilities: ["mcp"],
        }),
        expect.objectContaining({
          id: "skill-review",
          kind: "skill-instructions",
          contentReference: "skills/review/SKILL.md",
        }),
      ]),
    });
  });

  it("maps dotted Agent Plugins names onto Octant slugs", () => {
    const resolved = normalizeAgentPluginPackage(
      fixture({
        entries: [
          {
            path: "plugin.json",
            kind: "file",
            content: encoder.encode(
              JSON.stringify({
                $schema: AGENT_PLUGINS_PLUGIN_SCHEMA,
                name: "com.example.review",
                version: "2.0.0",
              }),
            ),
          },
          {
            path: "skills/review/SKILL.md",
            kind: "file",
            content: encoder.encode(`---
name: review
description: Review helpers for Example.
---
`),
          },
        ],
      }),
    );
    expect(resolved.manifest).toMatchObject({
      slug: "com-example-review",
      displayName: "com.example.review",
      version: "2.0.0",
    });
  });

  it("defaults missing or non-semver versions to 0.0.0 and unreported license", () => {
    const resolved = normalizeAgentPluginPackage(
      fixture({
        entries: [
          {
            path: "plugin.json",
            kind: "file",
            content: encoder.encode(
              JSON.stringify({
                $schema: AGENT_PLUGINS_PLUGIN_SCHEMA,
                name: "plain-plugin",
                version: "not-a-semver",
              }),
            ),
          },
          {
            path: "skills/plain/SKILL.md",
            kind: "file",
            content: encoder.encode(`---
name: plain
description: A plain skill used for version defaults.
---
`),
          },
        ],
      }),
    );
    expect(resolved.manifest).toMatchObject({
      version: "0.0.0",
      license: { kind: "unreported" },
      provenance: { reviewed: false, publisher: "local" },
    });
    expect(() => inspectExtensionPackage(resolved)).toThrow("license metadata is required");
  });

  it("maps a digit-prefixed Agent Plugin name to a valid Octant slug", () => {
    const input = fixture();
    const resolved = normalizeAgentPluginPackage({
      ...input,
      entries: input.entries.map((entry) =>
        entry.path !== "plugin.json"
          ? entry
          : {
              ...entry,
              content: encoder.encode(
                JSON.stringify({
                  $schema: AGENT_PLUGINS_PLUGIN_SCHEMA,
                  name: "3d-tools",
                  version: "1.0.0",
                  license: "MIT",
                }),
              ),
            },
      ),
    });

    const inspected = inspectExtensionPackage(resolved);
    expect(inspected.manifest.displayName).toBe("3d-tools");
    expect(inspected.manifest.slug).toMatch(/^plugin-[a-f0-9]{16}$/);
  });

  it("skips a missing stdio executable and records a bounded diagnostic", () => {
    const input = fixture();
    const resolved = normalizeAgentPluginPackage({
      ...input,
      entries: input.entries.filter((entry) => entry.path !== "bin/server"),
    });

    const manifest = resolved.manifest as { components: ReadonlyArray<unknown> };
    expect(manifest.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "skill-review", kind: "skill-instructions" }),
        expect.objectContaining({ id: "mcp-docs", kind: "mcp-server" }),
      ]),
    );
    expect(manifest.components).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "mcp-local" })]),
    );
    expect(resolved.diagnostics).toContainEqual(
      expect.objectContaining({ code: "mcp-entry-point-missing" }),
    );
  });

  it("passes through the hostile package inspector", () => {
    const inspected = inspectExtensionPackage(normalizeAgentPluginPackage(fixture()));
    expect(inspected.manifest.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "mcp-docs", configurationReference: "config:mcp-docs" }),
        expect.objectContaining({
          id: "skill-review",
          contentReference: "content:skill-review",
        }),
      ]),
    );
    expect(inspected.configurationReferences).toMatchObject({
      "mcp-docs": "mcp.json",
      "mcp-local": "mcp.json",
    });
    expect(inspected.entryPoints).toMatchObject({ "mcp-local": "bin/server" });
    expect(inspected.files).toContainEqual(
      expect.objectContaining({ path: "bin/server", executable: true }),
    );
    expect(inspected.contentReferences).toEqual({ "skill-review": "skills/review/SKILL.md" });
  });
});

describe("Agent Plugins MCP runtime", () => {
  it("creates PLUGIN_DATA and expands launch specs for stdio and remote servers", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-agent-plugins-"));
    try {
      const pluginRoot = join(root, "plugin");
      const dataRoot = join(root, "data");
      const plan = await prepareAgentPluginMcpRuntime(
        {
          $schema: AGENT_PLUGINS_MCP_SCHEMA,
          mcpServers: {
            local: {
              type: "stdio",
              command: "./bin/server",
              cwd: "${PLUGIN_DATA}/state/cache",
              args: ["--data", "${PLUGIN_DATA}"],
              env: { CONFIG: "${PLUGIN_ROOT}/config.json" },
            },
            remote: {
              type: "streamable-http",
              url: "https://example.test/mcp",
              headers: { "X-Tenant": "public" },
            },
          },
        },
        {
          pluginRoot,
          pluginDataRoot: dataRoot,
          pluginIdentity: "review-tools",
          baseEnv: { PATH: "/usr/bin" },
        },
      );
      expect(plan.PLUGIN_ROOT).toBe(pluginRoot);
      expect(plan.PLUGIN_DATA).toBe(join(dataRoot, "review-tools"));
      expect(plan.launches).toHaveLength(2);
      const stdio = plan.launches.find((launch) => launch.transport === "stdio");
      expect(stdio).toMatchObject({
        command: join(pluginRoot, "bin/server"),
        cwd: join(plan.PLUGIN_DATA, "state", "cache"),
        args: ["--data", plan.PLUGIN_DATA],
        env: expect.objectContaining({
          PLUGIN_ROOT: pluginRoot,
          PLUGIN_DATA: plan.PLUGIN_DATA,
          CONFIG: `${pluginRoot}/config.json`,
          PATH: "/usr/bin",
        }),
      });
      await expect(stat(join(plan.PLUGIN_DATA, "state", "cache"))).resolves.toMatchObject({});
      const remote = plan.launches.find((launch) => launch.transport === "streamable-http");
      expect(remote).toMatchObject({
        url: "https://example.test/mcp",
        headers: { "X-Tenant": "public" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not follow existing symlinks while creating nested PLUGIN_DATA cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "octant-agent-plugins-cwd-"));
    try {
      const pluginRoot = join(root, "plugin");
      const dataRoot = join(root, "data");
      const pluginData = join(dataRoot, "review-tools");
      const outside = join(root, "outside");
      await mkdir(pluginData, { recursive: true });
      await mkdir(outside, { recursive: true });
      await symlink(outside, join(pluginData, "state"));

      const plan = await prepareAgentPluginMcpRuntime(
        {
          $schema: AGENT_PLUGINS_MCP_SCHEMA,
          mcpServers: {
            local: {
              type: "stdio",
              command: "./bin/server",
              cwd: "${PLUGIN_DATA}/state/cache",
            },
          },
        },
        {
          pluginRoot,
          pluginDataRoot: dataRoot,
          pluginIdentity: "review-tools",
        },
      );

      expect(plan.launches).toEqual([]);
      expect(plan.skipped).toEqual([
        expect.objectContaining({ name: "local", reason: expect.stringMatching(/symlink/i) }),
      ]);
      await expect(stat(join(outside, "cache"))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Agent Plugin identity", () => {
  it("source-qualifies extension identities so same-name packages can coexist", () => {
    const left = normalizeAgentPluginPackage(
      fixture({ source: { kind: "local-folder", sourceRef: "folder-a" } as never }),
    ) as { manifest: { extensionId: string; packageId: string } };
    const right = normalizeAgentPluginPackage(
      fixture({ source: { kind: "local-folder", sourceRef: "folder-b" } as never }),
    ) as { manifest: { extensionId: string; packageId: string } };
    expect(left.manifest.extensionId).not.toBe(right.manifest.extensionId);
    expect(left.manifest.packageId).not.toBe(right.manifest.packageId);
  });
});
