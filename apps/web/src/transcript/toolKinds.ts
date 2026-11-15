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
  if (name.includes("web") || name.startsWith("fetch") || name.includes("browser")) return "web";
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

const COUNT_WORDS: Readonly<Record<ToolKind, readonly [string, string]>> = {
  command: ["command", "commands"],
  read: ["read", "reads"],
  edit: ["edit", "edits"],
  search: ["search", "searches"],
  web: ["web request", "web requests"],
  mcp: ["connector call", "connector calls"],
  agent: ["subagent", "subagents"],
  other: ["other call", "other calls"],
};

export interface ToolKindCount {
  readonly kind: ToolKind;
  readonly count: number;
}

/** Counts by kind, most frequent first, ties in first-seen order. */
export function countToolKinds(toolNames: ReadonlyArray<string>): ReadonlyArray<ToolKindCount> {
  const counts = new Map<ToolKind, number>();
  for (const name of toolNames) {
    const kind = toolKind(name);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count);
}

/** "11 tool calls: 4 commands, 5 reads, 2 edits" */
export function toolCallsAccessibleName(toolNames: ReadonlyArray<string>): string {
  const total = toolNames.length;
  const head = `${total} ${total === 1 ? "tool call" : "tool calls"}`;
  const parts = countToolKinds(toolNames).map(
    ({ kind, count }) => `${count} ${COUNT_WORDS[kind][count === 1 ? 0 : 1]}`,
  );
  return parts.length === 0 ? head : `${head}: ${parts.join(", ")}`;
}

/** The mark a call carries in a row: the file's name, the command's first line, or the query. */
export function toolPreview(kind: ToolKind, summary: string | undefined): string | undefined {
  const line = summary
    ?.split("\n")
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  if (line === undefined) return undefined;
  if (kind === "read" || kind === "edit") {
    const path = line.replace(/^[A-Za-z]+:\s+/, "");
    if (!/\s/.test(path) && path.includes("/")) return path.slice(path.lastIndexOf("/") + 1);
  }
  return line;
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

/** "420 ms", "3.2 s", "1 m 5 s" — a call's own duration, in meta ink. */
export function callDurationLabel(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.max(0, Math.round(durationMs))} ms`;
  if (durationMs < 10_000) return `${(durationMs / 1_000).toFixed(1)} s`;
  const seconds = Math.round(durationMs / 1_000);
  if (seconds < 60) return `${seconds} s`;
  return `${Math.floor(seconds / 60)} m ${seconds % 60} s`;
}
