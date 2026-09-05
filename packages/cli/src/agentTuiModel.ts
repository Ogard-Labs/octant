import type { NativeHarnessSessionView } from "@octant/contracts";
import type { AgentThreadSnapshot } from "./agentThread";
import { BUILT_IN_THEME_PRESET_IDS, resolveThemePresetTokens } from "@octant/theme";

/**
 * What the terminal UI shows, computed from the same thread and harness
 * views the app renders. Pure, so the screen only lays it out.
 */
export interface TuiPalette {
  readonly background: string;
  readonly surface: string;
  readonly border: string;
  readonly text: string;
  readonly textSecondary: string;
  readonly muted: string;
  readonly accent: string;
  readonly you: string;
  readonly success: string;
  readonly warning: string;
  readonly danger: string;
}

export type TuiThemeId = (typeof BUILT_IN_THEME_PRESET_IDS)[number];

export function isTuiThemeId(value: string): value is TuiThemeId {
  return (BUILT_IN_THEME_PRESET_IDS as ReadonlyArray<string>).includes(value);
}

/** The app's theme tokens, projected onto the handful of roles a terminal can show. */
export function paletteFor(themeId: TuiThemeId | undefined, mode: "light" | "dark"): TuiPalette {
  const tokens = resolveThemePresetTokens(themeId, mode);
  const token = (id: string, fallback: string) => tokens[id] ?? fallback;
  return {
    background: token("app-background", mode === "dark" ? "#151515" : "#fafaf9"),
    surface: token("workspace", mode === "dark" ? "#171717" : "#ffffff"),
    border: token("border", mode === "dark" ? "#2a2a2a" : "#e4e4e4"),
    text: token("text-primary", mode === "dark" ? "#f0f0f0" : "#1b1b1b"),
    textSecondary: token("text-secondary", mode === "dark" ? "#a3a3a3" : "#525252"),
    muted: token("text-muted", mode === "dark" ? "#737373" : "#8a8a8a"),
    accent: token("accent", mode === "dark" ? "#d4b483" : "#8a6d3b"),
    you: token("palette-pink", "#d78fa5"),
    success: token("success-text", "#4ea36a"),
    warning: token("warning-text", "#c9a227"),
    danger: token("danger-text", "#d25f5f"),
  };
}

export interface TuiToolLine {
  readonly name: string;
  readonly summary: string;
  readonly status: "ok" | "refused" | "failed";
  readonly duration: string;
  /** A unified diff for an edit or write, the output tail for a command. */
  readonly detail?: string;
  readonly filetype?: string;
}

export interface TuiLeadActions {
  readonly toolCalls: number;
  readonly edits: number;
  readonly failed: number;
  readonly route: string;
  readonly model: string;
  readonly duration: string;
  readonly stopReason: string;
  /** The last calls, newest last; `toolCalls` counts what came before too. */
  readonly tools: ReadonlyArray<TuiToolLine>;
}

export interface TuiTask {
  readonly title: string;
  readonly status: "pending" | "in-progress" | "blocked" | "completed" | "cancelled";
}

export function toolLines(
  calls: ReadonlyArray<{
    readonly name: string;
    readonly summary: string;
    readonly status: "ok" | "refused" | "failed";
    readonly durationMs: number;
    readonly detail?: string | undefined;
  }>,
): ReadonlyArray<TuiToolLine> {
  return calls.map((call) => {
    const summary = call.summary.startsWith(`${call.name}: `)
      ? call.summary.slice(call.name.length + 2)
      : call.summary === call.name
        ? ""
        : call.summary;
    const extension = /\.([a-z0-9]+)$/i.exec(summary)?.[1]?.toLowerCase();
    return {
      name: call.name,
      summary,
      status: call.status,
      duration: formatMs(call.durationMs),
      ...(call.detail === undefined ? {} : { detail: call.detail }),
      ...(extension === undefined ? {} : { filetype: FILETYPES[extension] ?? extension }),
    };
  });
}

const FILETYPES: Readonly<Record<string, string>> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  md: "markdown",
  json: "json",
  css: "css",
  html: "html",
  py: "python",
  rs: "rust",
  go: "go",
  sh: "bash",
  yml: "yaml",
  yaml: "yaml",
};

export function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/** The thread's work items as the tasks panel shows them: current first, done counted. */
export function tasksFrom(thread: AgentThreadSnapshot | undefined): {
  readonly done: number;
  readonly total: number;
  readonly items: ReadonlyArray<TuiTask>;
} {
  const items = [...(thread?.workItems ?? [])]
    .sort((a, b) => a.position - b.position)
    .map((item) => ({ title: item.title, status: item.status }));
  const done = items.filter((item) => item.status === "completed").length;
  const open = items.filter((item) => item.status !== "completed" && item.status !== "cancelled");
  return { done, total: items.length, items: open };
}

export type TuiTranscriptEntry =
  | { readonly kind: "you"; readonly at: string; readonly text: string }
  | {
      readonly kind: "lead";
      readonly at: string;
      readonly text: string;
      readonly outcome: string;
      readonly actions?: TuiLeadActions;
      /** Calls of a turn still running, newest last. */
      readonly live?: ReadonlyArray<TuiToolLine>;
    };

export function formatClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

export function formatDuration(startIso: string, endIso: string): string {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * The conversation as you / lead turns. Each lead turn carries the harness
 * record of the same turn when there is one: the records are appended once
 * per completed lead turn, so the last records line up with the last turns.
 */
export function transcriptFrom(
  thread: AgentThreadSnapshot | undefined,
  session: NativeHarnessSessionView | null | undefined,
): ReadonlyArray<TuiTranscriptEntry> {
  if (thread === undefined) return [];
  const records = session?.turns ?? [];
  const isDone = (outcome: string) =>
    outcome !== "queued" && outcome !== "streaming" && outcome !== "waiting";
  const completed = thread.turns.filter((turn) => isDone(turn.outcome));
  const offset = completed.length - records.length;
  const entries: TuiTranscriptEntry[] = [];
  let completedIndex = 0;
  for (const turn of thread.turns) {
    entries.push({ kind: "you", at: formatClock(turn.at), text: turn.prompt });
    const done = isDone(turn.outcome);
    const record = done ? records[completedIndex - offset] : undefined;
    if (done) completedIndex += 1;
    const live =
      !done && session !== null && session !== undefined ? (session.activeTools ?? []) : [];
    entries.push({
      kind: "lead",
      at: formatClock(turn.replyAt),
      text: turn.reply,
      outcome: turn.outcome,
      ...(record === undefined
        ? {}
        : {
            actions: {
              toolCalls: record.toolCalls,
              edits: (record.tools ?? []).filter(
                (call) => call.name === "edit" || call.name === "write",
              ).length,
              failed: (record.tools ?? []).filter((call) => call.status !== "ok").length,
              route: record.route.kind,
              model: "candidate" in record.route ? String(record.route.candidate.modelId) : "—",
              duration: formatDuration(record.startedAt, record.endedAt),
              stopReason: record.stopReason,
              tools: toolLines(record.tools ?? []),
            },
          }),
      ...(live.length === 0 ? {} : { live: toolLines(live) }),
    });
  }
  return entries;
}

/** One line for the footer: what the run is doing and what it has cost in turns. */
export function statusLineFrom(
  thread: AgentThreadSnapshot | undefined,
  session: NativeHarnessSessionView | null | undefined,
): string {
  const parts: string[] = [];
  if (session !== null && session !== undefined) {
    parts.push(session.session.status);
    parts.push(String(session.session.lead.modelId));
    parts.push(`${session.session.turnsRun} turns`);
    if (session.session.cutovers > 0) parts.push(`${session.session.cutovers} context cuts`);
    const usage = session.turns.reduce(
      (sum, turn) => ({
        input: sum.input + turn.usage.inputTokens,
        output: sum.output + turn.usage.outputTokens,
      }),
      { input: 0, output: 0 },
    );
    if (usage.input > 0) parts.push(`${compact(usage.input)} in · ${compact(usage.output)} out`);
    const cost = session.turns.reduce((sum, turn) => sum + (turn.usage.costUsd ?? 0), 0);
    if (cost > 0) parts.push(`$${cost.toFixed(2)}`);
  } else if (thread !== undefined) {
    parts.push(thread.modelId);
    parts.push(`${thread.turns.length} turns`);
  }
  return parts.join(" · ");
}

function compact(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}
