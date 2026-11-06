import { BROWSER_TOOL_HOST_LINE } from "@octant/plugin-host/browser-use";
import { COMPUTER_TOOL_HOST_LINE } from "@octant/plugin-host/computer-use";

/** One host line and the tool it describes, so a session without the tool leaves it out. */
export interface AppToolHostLine {
  readonly tool: string;
  readonly text: string;
}

/**
 * Where an Octant tool replaces a path the runtime would otherwise take on its
 * own: Simulator.app, an emulator window, a backgrounded shell, or the gh
 * command. Each line says only that; the tool's description and help carry
 * how to use it. Codex and Claude Code bring their own shell and subagents, and
 * without these lines nothing told them when Octant's tool is the one to use.
 */
const ROUTING_LINES: ReadonlyArray<AppToolHostLine> = [
  {
    tool: "octant_apple",
    text: "Build, test, run, and look at Apple apps with octant_apple, which shows the iOS Simulator in Octant's pane; never open Simulator.app or run open -a Simulator.",
  },
  {
    tool: "octant_android",
    text: "Boot and drive Android emulators with octant_android, which shows them in Octant's pane; never start an emulator window yourself.",
  },
  {
    tool: "octant_terminal",
    text: "Start long-running processes such as dev servers and watchers with octant_terminal rather than a backgrounded shell command, so their output stays readable and the person can see them.",
  },
  {
    tool: "octant_pull_request",
    text: "Open and change this thread's pull request with octant_pull_request rather than the gh command, so the person sees what is posted under their name.",
  },
  {
    tool: "octant_github",
    text: "Read the repository's issues, pull requests, and projects with octant_github, which uses the person's connected account, rather than gh or the GitHub API.",
  },
  {
    tool: "octant_agents",
    text: "Delegate with octant_agents when part of the task should run on another provider or model, or where the person can watch it; each child appears in Octant's Agents surface.",
  },
];

/**
 * The host lines a turn carries for the app tools it offers, one per tool.
 *
 * Browser and Computer are offered on every eligible turn rather than through
 * a composer selection, so each line follows its tool definition: a turn that
 * does not carry the tool is not told about it. The same holds for the routing
 * lines, so the text changes only when the offered tools do.
 */
export function appToolHostLines(
  definitions: ReadonlyArray<{ readonly name: string }> | undefined,
): ReadonlyArray<AppToolHostLine> {
  const offered = new Set(definitions?.map((definition) => definition.name) ?? []);
  return [
    { tool: "octant_browser", text: BROWSER_TOOL_HOST_LINE },
    { tool: "octant_computer", text: COMPUTER_TOOL_HOST_LINE },
    ...ROUTING_LINES,
  ].filter((line) => offered.has(line.tool));
}
