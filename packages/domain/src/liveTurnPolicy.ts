import {
  MAX_LIVE_STEP_ARGUMENT_LENGTH,
  MAX_LIVE_STEP_TOOL_LENGTH,
  type ProviderRuntimeEvent,
  type ThreadLiveStep,
} from "@octant/contracts";
import { redactDiagnosticText } from "./diagnosticsPolicy";

/**
 * What a running turn is doing, folded from the normalized runtime events every
 * provider produces, so no driver or surface keeps its own account.
 *
 * The state holds only redacted, bounded text: whatever a provider put in a
 * command or a path is cleaned when the event is observed, before anything is
 * stored or projected, so no later reader can forget to do it.
 */
export interface LiveTurnState {
  readonly startedAt: string;
  /** The latest tool activity. It stays until a newer tool starts. */
  readonly tool?: { readonly tool: string; readonly argument?: string };
  /** The turn is parked on the person. The next sign of progress ends it. */
  readonly waiting?: "approval" | "user-input";
}

export function startLiveTurn(startedAt: string): LiveTurnState {
  return { startedAt };
}

/** Events that show the agent is moving again, which ends a wait on the person. */
const RESUMING_KINDS: ReadonlySet<ProviderRuntimeEvent["kind"]> = new Set([
  "text-delta",
  "reasoning-delta",
  "tool-start",
  "tool-progress",
  "tool-success",
  "tool-failure",
]);

export function observeLiveTurn(state: LiveTurnState, event: ProviderRuntimeEvent): LiveTurnState {
  const resumed =
    state.waiting !== undefined && RESUMING_KINDS.has(event.kind) ? withoutWaiting(state) : state;
  switch (event.kind) {
    case "tool-start": {
      const tool = boundedLabel(event.toolName, MAX_LIVE_STEP_TOOL_LENGTH);
      if (tool === undefined) return resumed;
      const argument =
        event.argument === undefined ? undefined : summarizeStepArgument(event.argument);
      return { ...resumed, tool: { tool, ...(argument === undefined ? {} : { argument }) } };
    }
    case "tool-request": {
      // An app-managed tool call: the name says enough, and its JSON input is
      // the model's own content, which never belongs on a navigation row.
      const tool = boundedLabel(event.toolName, MAX_LIVE_STEP_TOOL_LENGTH);
      return tool === undefined ? resumed : { ...resumed, tool: { tool } };
    }
    case "approval-request":
      return { ...resumed, waiting: "approval" };
    case "user-input-request":
      return { ...resumed, waiting: "user-input" };
    default:
      return resumed;
  }
}

function withoutWaiting(state: LiveTurnState): LiveTurnState {
  const { waiting: _ended, ...rest } = state;
  return rest;
}

/** The step a navigation row shows: a wait outranks the last tool. */
export function liveTurnStep(state: LiveTurnState): ThreadLiveStep | undefined {
  if (state.waiting !== undefined) return { kind: "waiting", reason: state.waiting };
  if (state.tool === undefined) return undefined;
  return {
    kind: "tool",
    tool: state.tool.tool,
    ...(state.tool.argument === undefined ? {} : { argument: state.tool.argument }),
  };
}

/**
 * Token shapes a command can carry as literals, beyond what the diagnostics
 * redaction knows. Environment-style assignments (`API_TOKEN=...`) and flag
 * values are the common way a shell command carries one, and the diagnostics
 * rules miss them because an underscore joins the keyword to its prefix.
 */
const SECRET_NAME = "[A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?)[A-Za-z0-9_]*";
const STEP_REDACTIONS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  {
    pattern: new RegExp(`\\b(${SECRET_NAME})=(?:"[^"]*"|'[^']*'|\\S+)`, "gi"),
    replacement: "$1=[redacted]",
  },
  {
    pattern:
      /(--?(?:[a-z-]*(?:token|password|passwd|secret|api-?key|auth|credentials?))(?:=|\s+))(?:"[^"]*"|'[^']*'|\S+)/gi,
    replacement: "$1[redacted]",
  },
  {
    pattern:
      /\b(?:gh[opusr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})\b/g,
    replacement: "[redacted]",
  },
];

/**
 * An absolute path not glued to a longer word or URL. The first character
 * before it must be a boundary, so `a/b`, `s/x/y/`, and `https://host/path`
 * are left alone while `cat /etc/hosts` and `--out=/tmp/x` are caught.
 */
const ABSOLUTE_POSIX_PATH = /(?<![A-Za-z0-9_.~:%/…-])\/[^\s'"`;|&<>()]*/g;
const ABSOLUTE_WINDOWS_PATH = /(?<![A-Za-z0-9_])[A-Za-z]:\\[^\s'"`;|&<>()]*/g;

/**
 * A shell command a provider runs through a login shell arrives as
 * `/bin/zsh -lc '<command>'`. The person asked for the inner command, and the
 * wrapper only adds noise, so a lone wrapper is removed. Anything that does not
 * look exactly like that is left as it is.
 */
const SHELL_WRAPPER =
  /^\s*(?:\S*\/)?(?:ba|z|da|fi)?sh\s+-[a-z]*c\s+(?:'([\s\S]*)'|"([\s\S]*)")\s*$/;

function unwrapShellInvocation(command: string): string {
  const match = SHELL_WRAPPER.exec(command);
  if (match === null) return command;
  if (match[1] !== undefined) return match[1].replaceAll("'\\''", "'");
  return match[2] ?? command;
}

function pathLeaf(path: string): string {
  const leaf = path
    .split(/[\\/]/)
    .filter((segment) => segment.length > 0)
    .at(-1);
  return leaf === undefined ? "…" : `…/${leaf}`;
}

/**
 * One redacted, bounded line describing what a tool was asked to do.
 *
 * Only the first line survives and a heredoc body never does, because a
 * command that writes a file carries the file's contents in the lines after
 * it. Secrets are replaced, then every absolute path collapses to its last
 * segment, so a checkout location or a home directory never leaves the host.
 * What is left is cut to a fixed length. Returns nothing when nothing remains.
 */
export function summarizeStepArgument(
  raw: string,
  limit: number = MAX_LIVE_STEP_ARGUMENT_LENGTH,
): string | undefined {
  let line = unwrapShellInvocation(raw).split(/\r?\n/, 1)[0] ?? "";
  const heredoc = line.indexOf("<<");
  if (heredoc >= 0) line = line.slice(0, heredoc);
  for (const rule of STEP_REDACTIONS) line = line.replace(rule.pattern, rule.replacement);
  // Paths first: a home directory collapses to its last segment, which says
  // more than the diagnostics rule's blanket replacement would.
  line = line.replace(ABSOLUTE_WINDOWS_PATH, pathLeaf).replace(ABSOLUTE_POSIX_PATH, pathLeaf);
  line = redactDiagnosticText(line).text;
  return boundedLabel(line, limit);
}

function boundedLabel(value: string, limit: number): string | undefined {
  const collapsed = value.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return undefined;
  const points = Array.from(collapsed);
  if (points.length <= limit) return collapsed;
  return `${points
    .slice(0, limit - 1)
    .join("")
    .trimEnd()}…`;
}
