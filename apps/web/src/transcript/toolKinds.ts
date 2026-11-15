/**
 * What kind of work a tool call is, read from the name the provider gave it.
 * Providers name the same act differently ("Bash", "shell", "command_execution"),
 * so the kind is a best reading and `other` is an honest answer: it draws the
 * generic tool mark and no count word of its own.
 */
export type ToolKind = "command" | "read" | "edit" | "search" | "web" | "mcp" | "agent" | "other";

function compact(toolName: string): string {
  return toolName
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

export function toolKind(toolName: string): ToolKind {
  const raw = toolName.trim().toLowerCase();
  const name = compact(toolName);
  if (raw.startsWith("mcp__") || raw.startsWith("mcp_") || raw === "provider-tool") return "mcp";
  if (name.includes("web") || name === "fetch" || name.includes("browser")) return "web";
  if (name === "task" || name === "agent" || name.includes("subagent")) return "agent";
  if (
    name === "bash" ||
    name === "shell" ||
    name === "exec" ||
    name === "terminal" ||
    name.includes("command") ||
    name === "runcommand"
  ) {
    return "command";
  }
  if (name === "grep" || name === "glob" || name.includes("search") || name === "find") {
    return "search";
  }
  if (
    name === "read" ||
    name === "view" ||
    name === "cat" ||
    name === "readfile" ||
    name.startsWith("read")
  ) {
    return "read";
  }
  if (name.includes("edit") || name.includes("write") || name.includes("patch")) return "edit";
  if (name === "strreplace" || name === "createfile" || name === "deletefile") return "edit";
  return "other";
}

const INTERNAL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)+$/;

/**
 * The words a person reads for a tool. A kebab-case name is one of the host's
 * own internal kinds ("provider-tool"), never a name a tool chose, so it is
 * spoken as words; the provider's own display names pass through unchanged.
 */
export function toolDisplayName(toolName: string): string {
  const name = toolName.trim();
  if (name.startsWith("mcp__")) {
    const [, server, ...tool] = name.split("__");
    if (server !== undefined && tool.length > 0) {
      return `${tool.join(" ").replace(/_/g, " ")} (${server})`;
    }
  }
  if (INTERNAL_NAME.test(name)) {
    const words = name.replace(/-/g, " ");
    return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
  }
  return name;
}

/** "Thought for 12s", or "Thought briefly" under a second. */
export function thinkingDurationLabel(durationMs: number | undefined): string {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) return "Thinking";
  if (durationMs < 1_000) return "Thought briefly";
  const seconds = Math.round(durationMs / 1_000);
  if (seconds < 60) return `Thought for ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `Thought for ${minutes}m` : `Thought for ${minutes}m ${rest}s`;
}
