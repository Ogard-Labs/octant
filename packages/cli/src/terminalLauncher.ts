import { runMcpCliCommand, type McpCommandPorts } from "./mcpCommand";

/**
 * The `octant` the desktop app puts on a Code thread terminal's `PATH` while
 * that terminal holds a Browser grant. It runs `octant mcp` and nothing else.
 * The full command manages hosts, Projects, and agents through the data
 * directory and the desktop bridge secret, which carry the owner's authority;
 * a terminal is never lent either, so the commands that need them are not
 * shipped here at all.
 */
export const TERMINAL_LAUNCHER_USAGE = [
  "octant (the Octant app's terminal launcher)",
  "",
  "This octant comes with the Octant app and is on a Code thread terminal's PATH",
  "only while the terminal is allowed to use the Browser. It runs one command:",
  "",
  "  octant mcp    a stdio MCP server that lends a provider CLI the thread's Browser",
  "",
  "Run `octant mcp --help` for more.",
  "",
].join("\n");

export async function runTerminalLauncher(
  argv: ReadonlyArray<string>,
  ports: McpCommandPorts,
): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "mcp") return await runMcpCliCommand(rest, ports);
  if (command === "--help" && rest.length === 0) {
    ports.stdout.write(TERMINAL_LAUNCHER_USAGE);
    return 0;
  }
  ports.stderr.write(TERMINAL_LAUNCHER_USAGE);
  return 1;
}
