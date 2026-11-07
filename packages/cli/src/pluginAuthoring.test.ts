import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkPluginFolder, createPluginStarter } from "./pluginAuthoring";

let workspace: string;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), "octant-plugin-authoring-"));
});

afterEach(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("plugin starter", () => {
  it("creates a skill plugin that its own check accepts", async () => {
    const created = await createPluginStarter({ name: "meeting-notes", parent: workspace });
    expect(created.status).toBe("created");
    if (created.status !== "created") return;
    expect(created.files).toEqual(["README.md", "plugin.json", "skills/meeting-notes/SKILL.md"]);

    const checked = await checkPluginFolder(created.folder);
    expect(checked).toMatchObject({
      status: "valid",
      name: "meeting-notes",
      version: "0.1.0",
      components: [{ kind: "skill", name: "meeting-notes" }],
    });
  });

  it("adds a remote MCP server when an address is given", async () => {
    const created = await createPluginStarter({
      name: "crm",
      parent: workspace,
      mcpUrl: "https://mcp.example.com/mcp",
    });
    expect(created.status).toBe("created");
    if (created.status !== "created") return;
    expect(created.files).toContain("mcp.json");
    const mcp = JSON.parse(await readFile(join(created.folder, "mcp.json"), "utf8"));
    expect(mcp.mcpServers.crm).toEqual({
      type: "streamable-http",
      url: "https://mcp.example.com/mcp",
    });

    const checked = await checkPluginFolder(created.folder);
    expect(checked.status).toBe("valid");
    if (checked.status !== "valid") return;
    expect(checked.components).toContainEqual({ kind: "mcp-server", name: "crm" });
  });

  it("refuses an MCP address that is not https or this computer", async () => {
    const created = await createPluginStarter({
      name: "crm",
      parent: workspace,
      mcpUrl: "http://mcp.example.com/mcp",
    });
    expect(created).toMatchObject({ status: "refused" });
  });

  it("refuses to write over a folder that already exists", async () => {
    await mkdir(join(workspace, "taken"));
    await writeFile(join(workspace, "taken", "notes.txt"), "mine");
    const created = await createPluginStarter({ name: "taken", parent: workspace });
    expect(created).toMatchObject({ status: "refused" });
    expect(await readFile(join(workspace, "taken", "notes.txt"), "utf8")).toBe("mine");
  });

  it("refuses a name a plugin and its skill folder cannot both carry", async () => {
    for (const name of ["Meeting", "a.b", "two--dashes", "-lead", "x".repeat(65), "../up"]) {
      expect(await createPluginStarter({ name, parent: workspace })).toMatchObject({
        status: "refused",
      });
    }
  });
});

describe("plugin check", () => {
  it("fails a folder whose only skill names a different folder", async () => {
    const created = await createPluginStarter({ name: "notes", parent: workspace });
    if (created.status !== "created") throw new Error("starter was not created");
    await writeFile(
      join(created.folder, "skills", "notes", "SKILL.md"),
      "---\nname: other\ndescription: Something.\n---\nBody\n",
    );
    const checked = await checkPluginFolder(created.folder);
    expect(checked.status).toBe("invalid");
    expect(checked.problems.map((problem) => problem.message).join("\n")).toContain(
      "does not contribute",
    );
  });

  it("fails a folder with no plugin.json", async () => {
    const checked = await checkPluginFolder(workspace);
    expect(checked).toMatchObject({
      status: "invalid",
      problems: [{ severity: "error", message: "plugin.json is required at the plugin root." }],
    });
  });

  it("fails a local MCP command that is not in the folder", async () => {
    const created = await createPluginStarter({ name: "tools", parent: workspace });
    if (created.status !== "created") throw new Error("starter was not created");
    await writeFile(
      join(created.folder, "mcp.json"),
      JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: { tools: { type: "stdio", command: "./server.mjs" } },
      }),
    );
    const checked = await checkPluginFolder(created.folder);
    expect(checked.status).toBe("invalid");
    expect(checked.problems).toContainEqual({
      severity: "error",
      message: "MCP server tools runs ./server.mjs, which is not in the folder.",
    });
  });

  it("leaves out git history and links inside the folder, as Octant does", async () => {
    const created = await createPluginStarter({ name: "notes", parent: workspace });
    if (created.status !== "created") throw new Error("starter was not created");
    await mkdir(join(created.folder, ".git"));
    await writeFile(join(created.folder, ".git", "HEAD"), "ref: refs/heads/main\n");
    await symlink("README.md", join(created.folder, "LINKED.md"));
    const checked = await checkPluginFolder(created.folder);
    expect(checked.status).toBe("valid");
    expect(checked.problems).toContainEqual({
      severity: "warning",
      message: "LINKED.md is a link; Octant leaves links out of a plugin.",
    });
  });

  it("refuses a link that leaves the folder", async () => {
    const created = await createPluginStarter({ name: "notes", parent: workspace });
    if (created.status !== "created") throw new Error("starter was not created");
    await symlink(tmpdir(), join(created.folder, "outside"));
    const checked = await checkPluginFolder(created.folder);
    expect(checked).toMatchObject({
      status: "invalid",
      problems: [{ severity: "error", message: "outside links outside the plugin folder." }],
    });
  });

  it("fails a plugin beside a document that makes Octant read it as another package", async () => {
    const created = await createPluginStarter({ name: "notes", parent: workspace });
    if (created.status !== "created") throw new Error("starter was not created");
    await writeFile(join(created.folder, "octant-language-server.json"), "{}");
    const checked = await checkPluginFolder(created.folder);
    expect(checked.status).toBe("invalid");
    expect(checked.problems.map((problem) => problem.message).join("\n")).toContain(
      "octant-language-server.json makes Octant read this folder as a different kind of package",
    );
  });

  it("reports a part of the folder it cannot read instead of failing", async () => {
    const created = await createPluginStarter({ name: "notes", parent: workspace });
    if (created.status !== "created") throw new Error("starter was not created");
    const locked = join(created.folder, "locked");
    await mkdir(locked);
    await chmod(locked, 0);
    try {
      const checked = await checkPluginFolder(created.folder);
      expect(checked).toMatchObject({
        status: "invalid",
        problems: [{ severity: "error", message: "locked could not be read." }],
      });
    } finally {
      await chmod(locked, 0o700);
    }
  });
});
