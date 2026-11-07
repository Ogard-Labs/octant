import type { Stats } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import {
  AGENT_PLUGINS_MCP_SCHEMA,
  AGENT_PLUGINS_PLUGIN_SCHEMA,
  AgentPluginsError,
  loadAgentPluginFromEntries,
  type AgentPluginsPackageEntry,
} from "@octant/plugin-host/agent-plugins";
import {
  DEBUG_ADAPTER_PACKAGE_DOCUMENT_PATH,
  LANGUAGE_SERVER_PACKAGE_DOCUMENT_PATH,
  OUTSIDE_PROVIDER_DRIVER_DOCUMENT_PATH,
} from "@octant/plugin-api";

/**
 * `octant plugin create` and `octant plugin check`: writing a plugin on this
 * computer before anyone installs it.
 *
 * Neither command talks to the host or installs anything. `create` writes a
 * starter Agent Plugins folder; `check` reads a folder with the same walk
 * rules and the same shared loader the host uses when a person imports a
 * local folder, so a folder that passes here is one the import accepts.
 * Installing, trusting, and enabling stay in the Octant window.
 */

/**
 * One name serves as the plugin's name and its first skill's folder, so it
 * must satisfy both: the skill rule is the stricter of the two (no dots).
 */
const STARTER_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const STARTER_NAME_MAX = 64;

// The host's folder import bounds (`agentPluginFilesystem.ts`); a folder over
// them is refused there, so it is refused here too.
const MAXIMUM_ENTRIES = 4_096;
const MAXIMUM_FILE_BYTES = 16 * 1_024 * 1_024;
const MAXIMUM_TOTAL_BYTES = 128 * 1_024 * 1_024;

const PACKAGE_DOCUMENT_PATHS = [
  LANGUAGE_SERVER_PACKAGE_DOCUMENT_PATH,
  OUTSIDE_PROVIDER_DRIVER_DOCUMENT_PATH,
  DEBUG_ADAPTER_PACKAGE_DOCUMENT_PATH,
] as const;

export type PluginStarterResult =
  | { readonly status: "created"; readonly folder: string; readonly files: ReadonlyArray<string> }
  | { readonly status: "refused"; readonly message: string };

export interface PluginStarterInput {
  readonly name: string;
  /** The folder the plugin folder is created in. */
  readonly parent: string;
  /** A remote MCP server the plugin connects to over Streamable HTTP. */
  readonly mcpUrl?: string;
}

export async function createPluginStarter(input: PluginStarterInput): Promise<PluginStarterResult> {
  const { name } = input;
  if (!STARTER_NAME.test(name) || name.length > STARTER_NAME_MAX) {
    return {
      status: "refused",
      message:
        "A plugin name uses lowercase letters, digits, and single hyphens between them, up to 64 characters (for example meeting-notes).",
    };
  }
  if (input.mcpUrl !== undefined) {
    const refusal = mcpAddressRefusal(input.mcpUrl);
    if (refusal !== undefined) return { status: "refused", message: refusal };
  }

  const folder = resolve(input.parent, name);
  try {
    // Not recursive: an existing folder, even an empty one, is refused rather
    // than written into, so nothing a person already has is overwritten.
    await mkdir(folder);
  } catch (error) {
    return {
      status: "refused",
      message: isErrorCode(error, "EEXIST")
        ? `${folder} already exists. Choose another name or folder.`
        : `${folder} could not be created.`,
    };
  }

  const files = starterFiles(name, input.mcpUrl);
  try {
    for (const [path, content] of files) {
      const target = join(folder, ...path.split("/"));
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, { flag: "wx" });
    }
  } catch {
    // The folder is the one this call made; leave nothing half-written.
    await rm(folder, { recursive: true, force: true });
    return { status: "refused", message: `The files in ${folder} could not be written.` };
  }
  return { status: "created", folder, files: files.map(([path]) => path).sort() };
}

function starterFiles(
  name: string,
  mcpUrl: string | undefined,
): ReadonlyArray<readonly [string, string]> {
  const manifest = {
    $schema: AGENT_PLUGINS_PLUGIN_SCHEMA,
    name,
    version: "0.1.0",
    description: `Describe what ${name} adds, in one sentence.`,
  };
  const skill = [
    "---",
    `name: ${name}`,
    "description: Say when an agent should use this skill. The agent reads this line to decide, so name the task and the words a person would use.",
    "---",
    "",
    `# ${name}`,
    "",
    "Write the instructions the agent follows when it uses this skill.",
    "Plain steps work best: what to look at first, what to produce, and what to avoid.",
    "",
  ].join("\n");
  const files: Array<readonly [string, string]> = [
    ["plugin.json", `${JSON.stringify(manifest, null, 2)}\n`],
    [`skills/${name}/SKILL.md`, skill],
    ["README.md", starterReadme(name, mcpUrl !== undefined)],
  ];
  if (mcpUrl !== undefined) {
    const mcp = {
      $schema: AGENT_PLUGINS_MCP_SCHEMA,
      mcpServers: { [name]: { type: "streamable-http", url: mcpUrl } },
    };
    files.push(["mcp.json", `${JSON.stringify(mcp, null, 2)}\n`]);
  }
  return files;
}

function starterReadme(name: string, hasMcp: boolean): string {
  return [
    `# ${name}`,
    "",
    "An Agent Plugins 1.0.0 package for Octant.",
    "",
    "- `plugin.json` names the plugin and its version.",
    `- \`skills/${name}/SKILL.md\` is a skill: instructions an agent loads when its description matches the task. Add more skills as more folders under \`skills/\`; each folder name must match the \`name\` in its \`SKILL.md\`.`,
    hasMcp
      ? "- `mcp.json` connects the plugin to an MCP server, which gives agents its tools."
      : "- Add an `mcp.json` to give agents an MCP server's tools.",
    "",
    "Check the folder before you add it:",
    "",
    "```sh",
    "octant plugin check .",
    "```",
    "",
    "Then add it in Octant: Settings › Skills & Extensions › Marketplace › Import local Agent Plugin…",
    "The plugin arrives untrusted and switched off. Trust it and switch it on there.",
    "",
  ].join("\n");
}

function mcpAddressRefusal(address: string): string | undefined {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return `${address} is not a web address.`;
  }
  if (url.username !== "" || url.password !== "") {
    return "An MCP address cannot carry a user name or password; Octant asks for sign-in when it connects.";
  }
  const local =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol === "https:" || (url.protocol === "http:" && local)) return undefined;
  return "An MCP address must use https, or http to this computer.";
}

export interface PluginCheckProblem {
  readonly severity: "error" | "warning";
  readonly message: string;
}

export type PluginCheckComponent =
  | { readonly kind: "skill"; readonly name: string }
  | { readonly kind: "mcp-server"; readonly name: string };

export type PluginCheckResult =
  | {
      readonly status: "valid";
      readonly name: string;
      readonly version: string | undefined;
      readonly components: ReadonlyArray<PluginCheckComponent>;
      readonly problems: ReadonlyArray<PluginCheckProblem>;
    }
  | { readonly status: "invalid"; readonly problems: ReadonlyArray<PluginCheckProblem> };

export async function checkPluginFolder(folder: string): Promise<PluginCheckResult> {
  const read = await readFolder(folder);
  if (read.status === "refused") {
    return { status: "invalid", problems: [{ severity: "error", message: read.message }] };
  }
  const problems: PluginCheckProblem[] = [...read.warnings];
  // The host reads a folder holding one of these documents as that kind of
  // package, and refuses one holding two (`pluginDirectoryLoader.ts`), so
  // the plugin beside it would never be imported as a plugin.
  const documents = PACKAGE_DOCUMENT_PATHS.filter((path) =>
    read.entries.some((entry) => entry.kind === "file" && entry.path === path),
  );
  if (documents.length > 0) {
    return {
      status: "invalid",
      problems: [
        ...problems,
        {
          severity: "error",
          message: `${documents.join(" and ")} makes Octant read this folder as a different kind of package. Remove it to import the folder as a plugin.`,
        },
      ],
    };
  }
  let loaded;
  try {
    loaded = loadAgentPluginFromEntries(read.entries);
  } catch (error) {
    if (!(error instanceof AgentPluginsError)) throw error;
    return {
      status: "invalid",
      problems: [...problems, { severity: "error", message: error.message }],
    };
  }
  for (const diagnostic of loaded.diagnostics) {
    // The loader treats a plugin with nothing to load as a warning; the host
    // refuses to install one, so it is an error here.
    const severity =
      diagnostic.severity === "error" || diagnostic.code === "component-missing"
        ? "error"
        : "warning";
    problems.push({ severity, message: diagnostic.message });
  }
  // The host skips a local command that is not a file in the package
  // (`agentPluginIngestion.ts`); an author should hear that before importing.
  for (const server of loaded.servers) {
    if (server.type !== "stdio" || !server.command.startsWith("./")) continue;
    const entryPoint = server.command.slice(2);
    if (!read.entries.some((entry) => entry.kind === "file" && entry.path === entryPoint)) {
      problems.push({
        severity: "error",
        message: `MCP server ${server.name} runs ${server.command}, which is not in the folder.`,
      });
    }
  }
  if (problems.some((problem) => problem.severity === "error")) {
    return { status: "invalid", problems };
  }
  return {
    status: "valid",
    name: loaded.manifest.name,
    version: loaded.manifest.version,
    components: [
      ...loaded.skills.map((skill) => ({ kind: "skill" as const, name: skill.name })),
      ...loaded.servers.map((server) => ({ kind: "mcp-server" as const, name: server.name })),
    ],
    problems,
  };
}

type FolderRead =
  | {
      readonly status: "read";
      readonly entries: ReadonlyArray<AgentPluginsPackageEntry>;
      readonly warnings: ReadonlyArray<PluginCheckProblem>;
    }
  | { readonly status: "refused"; readonly message: string };

/** The host's folder walk, without its file-identity checks: this reads only to report. */
async function readFolder(folder: string): Promise<FolderRead> {
  let root: string;
  try {
    root = await realpath(resolve(folder));
    if (!(await lstat(root)).isDirectory()) {
      return { status: "refused", message: `${folder} is not a folder.` };
    }
  } catch {
    return { status: "refused", message: `${folder} could not be opened.` };
  }
  try {
    return await walkFolder(root);
  } catch (error) {
    // A folder the person cannot read (or a file removed mid-walk) is a
    // reason to report, not to crash the command.
    const at = errorPath(error);
    const where =
      at === undefined
        ? "Part of the folder"
        : relative(root, at).split(sep).join("/") || "The folder";
    return { status: "refused", message: `${where} could not be read.` };
  }
}

async function walkFolder(root: string): Promise<FolderRead> {
  const entries: AgentPluginsPackageEntry[] = [];
  const warnings: PluginCheckProblem[] = [];
  let count = 0;
  let total = 0;
  const pending = [root];
  for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
    const children = await readdir(current, { withFileTypes: true });
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      // Git history beside a checkout's files is never package content.
      if (child.name === ".git") continue;
      const absolute = join(current, child.name);
      const path = relative(root, absolute).split(sep).join("/");
      count += 1;
      if (count > MAXIMUM_ENTRIES) {
        return {
          status: "refused",
          message: `The folder holds more than ${MAXIMUM_ENTRIES} entries.`,
        };
      }
      const stats: Stats = await lstat(absolute);
      if (stats.isSymbolicLink()) {
        let target: string;
        try {
          target = await realpath(absolute);
        } catch {
          return { status: "refused", message: `${path} is a link that leads nowhere.` };
        }
        if (!isWithin(root, target)) {
          return { status: "refused", message: `${path} links outside the plugin folder.` };
        }
        warnings.push({
          severity: "warning",
          message: `${path} is a link; Octant leaves links out of a plugin.`,
        });
        continue;
      }
      if (stats.isDirectory()) {
        entries.push({ path, kind: "directory" });
        pending.push(absolute);
        continue;
      }
      if (!stats.isFile()) {
        return { status: "refused", message: `${path} is neither a file nor a folder.` };
      }
      if (stats.size > MAXIMUM_FILE_BYTES) {
        return { status: "refused", message: `${path} is larger than 16 MiB.` };
      }
      total += stats.size;
      if (total > MAXIMUM_TOTAL_BYTES) {
        return { status: "refused", message: "The folder's files add up to more than 128 MiB." };
      }
      entries.push({ path, kind: "file", content: await readFile(absolute) });
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return { status: "read", entries, warnings };
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

function errorPath(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("path" in error)) return undefined;
  return typeof error.path === "string" ? error.path : undefined;
}

function isErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export interface RunPluginAuthoringCommandInput {
  readonly command:
    | { readonly action: "create"; readonly name: string; readonly mcpUrl?: string }
    | { readonly action: "check"; readonly folder: string };
  readonly cwd: string;
  readonly stdout: { readonly write: (chunk: string) => unknown };
  readonly stderr: { readonly write: (chunk: string) => unknown };
}

export async function runPluginAuthoringCommand(
  input: RunPluginAuthoringCommandInput,
): Promise<number> {
  const { command, cwd, stdout, stderr } = input;
  if (command.action === "create") {
    const created = await createPluginStarter({
      name: command.name,
      parent: cwd,
      ...(command.mcpUrl === undefined ? {} : { mcpUrl: command.mcpUrl }),
    });
    if (created.status === "refused") {
      stderr.write(`${created.message}\n`);
      return 1;
    }
    stdout.write(`Created ${created.folder}\n`);
    for (const file of created.files) stdout.write(`  ${file}\n`);
    stdout.write(
      `Edit the files, then run: octant plugin check ${relative(cwd, created.folder) || "."}\n`,
    );
    return 0;
  }

  const checked = await checkPluginFolder(resolve(cwd, command.folder));
  for (const problem of checked.problems) {
    (problem.severity === "error" ? stderr : stdout).write(
      `${problem.severity === "error" ? "error" : "warning"}  ${problem.message}\n`,
    );
  }
  if (checked.status === "invalid") {
    stderr.write("Fix the errors above before you import this folder as an Agent Plugin.\n");
    return 1;
  }
  stdout.write(`${checked.name} ${checked.version ?? "(no version)"}\n`);
  for (const component of checked.components) {
    stdout.write(
      `  ${component.kind === "skill" ? "skill     " : "MCP server"}  ${component.name}\n`,
    );
  }
  stdout.write(
    "Octant can import this folder: Settings › Skills & Extensions › Marketplace › Import local Agent Plugin…\n",
  );
  return 0;
}
