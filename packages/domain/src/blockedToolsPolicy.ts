import type { BlockableToolProvider } from "@octant/contracts/blocked-tools";

/**
 * Codex's own tools its configuration can switch off for one thread: the
 * shell (`features.shell_tool` with `features.unified_exec`), the image view
 * (`features.view_image`) and web search (`web_search = "disabled"`). Codex
 * has no per-name switch for its other built-ins, so only these and its MCP
 * servers' tools are offered.
 */
export const CODEX_BLOCKABLE_TOOLS = ["shell", "view_image", "web_search"] as const;
export type CodexBlockableTool = (typeof CODEX_BLOCKABLE_TOOLS)[number];

/** A tool of one of the provider's own MCP servers, as the person names it: `server__tool`. */
export function mcpServerTool(
  tool: string,
): { readonly server: string; readonly tool: string } | undefined {
  const separator = tool.indexOf("__");
  if (separator < 1) return undefined;
  const server = tool.slice(0, separator);
  const name = tool.slice(separator + 2);
  if (name.length === 0 || name.startsWith("_")) return undefined;
  return { server, tool: name };
}

/**
 * Why a provider cannot keep this tool blocked, or undefined when it can. A
 * block a provider could not enforce is refused when the person adds it, so
 * the list never names a tool that would still run.
 */
export function blockedToolRefusal(
  provider: BlockableToolProvider,
  tool: string,
): string | undefined {
  if (provider !== "codex") return undefined;
  if ((CODEX_BLOCKABLE_TOOLS as ReadonlyArray<string>).includes(tool)) return undefined;
  if (mcpServerTool(tool) !== undefined) return undefined;
  return "Codex can block shell, view_image, web_search, or an MCP server's tool as server__tool.";
}
