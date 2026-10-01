import { isExtensionComponentModeSafe } from "@octant/plugin-host";
import { describe, expect, it } from "vitest";
import { normalizeCodexPluginPackage, type CodexPluginPackageInput } from "./codexPluginIngestion";
import { inspectExtensionPackage } from "./packageInspector";

const source = {
  kind: "local-folder",
  sourceRef: "fixture-plugin",
} as CodexPluginPackageInput["source"];

function fixture(overrides: Partial<CodexPluginPackageInput> = {}): CodexPluginPackageInput {
  const entries = [
    {
      path: ".codex-plugin/plugin.json",
      kind: "file" as const,
      content: new TextEncoder().encode("manifest"),
    },
    {
      path: ".mcp.json",
      kind: "file" as const,
      content: new TextEncoder().encode(
        JSON.stringify({
          mcpServers: {
            docs: { type: "http", url: "https://example.test/mcp" },
          },
        }),
      ),
    },
    {
      path: "skills/review/SKILL.md",
      kind: "file" as const,
      content: new TextEncoder().encode("# Review\n"),
    },
  ];
  return {
    source,
    format: "directory",
    archiveBytes: 512,
    entries,
    manifest: {
      name: "review-tools",
      version: "1.2.3",
      description: "Review helpers",
      author: { name: "Example", url: "https://example.test" },
      repository: "https://example.test/review-tools",
      license: "MIT",
      skills: "./skills/",
      mcpServers: "./.mcp.json",
    },
    appVersion: "1.0.0",
    platform: "darwin",
    ...overrides,
  };
}

describe("Codex-compatible plugin ingestion", () => {
  it("normalizes skills and plugin-local MCP servers without provider runtime dependencies", () => {
    const resolved = normalizeCodexPluginPackage(fixture());

    expect(resolved.manifest).toMatchObject({
      slug: "review-tools",
      version: "1.2.3",
      source: { kind: "plugin-package", sourceRef: "fixture-plugin" },
      components: [
        {
          id: "mcp-docs",
          kind: "mcp-server",
          configurationReference: ".mcp.json",
        },
        {
          id: "skill-review",
          kind: "skill-instructions",
          contentReference: "skills/review/SKILL.md",
        },
      ],
    });
    expect(resolved.entries.map((entry) => entry.path)).toEqual([
      ".codex-plugin/plugin.json",
      ".mcp.json",
      "skills/review/SKILL.md",
    ]);
  });

  it("lets a plugin's command-launched MCP server run in Work, like an Agent Plugin's", () => {
    const entries = fixture().entries.map((entry) =>
      entry.path === ".mcp.json"
        ? {
            ...entry,
            content: new TextEncoder().encode(
              JSON.stringify({ mcpServers: { notes: { command: "node", args: ["server.js"] } } }),
            ),
          }
        : entry,
    );
    const inspected = inspectExtensionPackage(normalizeCodexPluginPackage(fixture({ entries })));
    const server = inspected.manifest.components.find((component) => component.id === "mcp-notes");

    expect(server?.declaredCapabilities).toEqual(["mcp"]);
    expect(server === undefined ? false : isExtensionComponentModeSafe("work", server)).toBe(true);
  });

  it("rejects unsupported plugin surfaces instead of silently dropping them", () => {
    expect(() =>
      normalizeCodexPluginPackage(fixture({ manifest: { hooks: "./hooks.json" } })),
    ).toThrow(/unsupported/i);
  });

  it("passes normalized references through the hostile inspector", () => {
    const inspected = inspectExtensionPackage(normalizeCodexPluginPackage(fixture()));
    expect(inspected.manifest.components).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "mcp-docs", configurationReference: "config:mcp-docs" }),
        expect.objectContaining({ id: "skill-review", contentReference: "content:skill-review" }),
      ]),
    );
    expect(inspected.configurationReferences).toEqual({ "mcp-docs": ".mcp.json" });
    expect(inspected.contentReferences).toEqual({ "skill-review": "skills/review/SKILL.md" });
  });
});
