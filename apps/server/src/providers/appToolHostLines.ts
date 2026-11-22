import { BROWSER_TOOL_HOST_LINE } from "@octant/plugin-host/browser-use";
import { COMPUTER_TOOL_HOST_LINE } from "@octant/plugin-host/computer-use";

/** One host line and the tool it describes, so a session without the tool leaves it out. */
export interface AppToolHostLine {
  readonly tool: string;
  readonly text: string;
}

/** What the guide reads of an offered tool: its name, and for `octant_threads` its operations. */
export interface OfferedAppTool {
  readonly name: string;
  readonly inputSchema?: unknown;
}

/**
 * When to reach for each first-party Octant tool, one line per tool. Every
 * runtime gets these same lines, Octant Harness and child runs included:
 * Codex and Claude Code bring their own shell, subagents, and habits, and an
 * endpoint model brings nothing, so without a line none of them knew when
 * Octant's tool is the one to use. A line says when, never how: operations,
 * arguments, and approvals live in the tool's description and its `help`. No
 * line may promise or deny an approval that differs by access level.
 */
const GUIDE_LINES: Readonly<Record<string, string>> = {
  octant_agents:
    "Delegate part of the task to a child run with octant_agents, on another provider or model when that suits it better; its capabilities operation lists the targets.",
  octant_android:
    "Boot and drive Android emulators with octant_android, which shows them in Octant's pane; never start an emulator window yourself.",
  octant_apple:
    "Build, test, run, and look at Apple apps with octant_apple, which shows the iOS Simulator in Octant's pane; never open Simulator.app or run open -a Simulator.",
  octant_ask_thread:
    "When the person mentions a Chat thread and wants something from it, ask it with octant_ask_thread and wait for its reply.",
  octant_browser: BROWSER_TOOL_HOST_LINE,
  octant_canvas:
    "When a visualization answers the question (a chart, a few metrics, a small dashboard, a short table, a diagram), draw it inline below your reply with octant_canvas.",
  octant_code:
    "Ask the language server about a saved file with octant_code: its errors, where a name is defined, and where it is used.",
  octant_computer: COMPUTER_TOOL_HOST_LINE,
  octant_create_image:
    "Call octant_create_image when the person asks for a picture instead of drawing it as SVG or HTML. To restyle photos or screenshots, use references, which always need confirmation. Keep SVG for logos, icons, and diagrams.",
  octant_credential:
    "When a registered operation or a saved command needs a credential the person holds, use octant_credential; you never see the value, and it is not a command runner.",
  octant_debug:
    "When you need breakpoints, stepping, or a stopped program's stack and variables, run the checkout's program under octant_debug.",
  octant_github:
    "Read the repository's issues, pull requests, and projects with octant_github, which uses the person's connected account, rather than gh or the GitHub API.",
  octant_look:
    "When you cannot read an image yourself, have octant_look ask the Sees images model to describe it, with your question if you have one.",
  octant_memory:
    "When the person states a durable fact, decision or convention about this Project that its future threads should retain, use octant_memory; keep transient task details in the current thread.",
  octant_offer_side_task:
    "When you notice work outside this request, offer it to the person with octant_offer_side_task instead of doing it.",
  octant_past_threads:
    "When the person refers to earlier work, search what Octant remembers of their earlier threads with octant_past_threads.",
  octant_propose_routine:
    "When something should run on a schedule, set up a routine with octant_propose_routine rather than a cron job or a loop.",
  octant_pull_request:
    "When asked, use octant_pull_request to open or change this thread's pull request, or watch it for checks and reviews instead of polling.",
  octant_report_finished:
    "When this thread's task is finished, use octant_report_finished to give Octant a summary and checks to verify; this does not mark the thread Done.",
  octant_routines:
    "Use octant_routines to see Project routines and runs, ask to pause or archive a routine this thread started, or report the result when a routine started this turn.",
  octant_side_chat_list_files:
    "List the files of the thread this side chat is about with octant_side_chat_list_files.",
  octant_side_chat_read_file:
    "Read one file of the thread this side chat is about with octant_side_chat_read_file.",
  octant_side_chat_search_files:
    "Search the files of the Code thread this side chat is about with octant_side_chat_search_files.",
  octant_terminal:
    "Start long-running processes such as dev servers and watchers with octant_terminal rather than a backgrounded shell command, so their output stays readable and the person can see them.",
  octant_threads:
    "See this Project's other threads, and message them where its operations allow, with octant_threads.",
  octant_transcribe:
    "Transcribe a recording from this thread's folder with octant_transcribe instead of installing speech models; page long transcripts with nextOffset.",
  octant_zen:
    "Read and arrange this Zen space with octant_zen: pin threads, add widgets, move elements.",
};

/**
 * A coordinator's `octant_threads` also starts worker threads. It is the one
 * line with a variant, chosen by whether the offered schema's operations
 * include `start`, so the text changes only when the role does.
 */
const COORDINATOR_THREADS_LINE =
  "As this Project's coordinator, start worker threads with octant_threads, and see and message the Project's other threads with it.";

function offersOperation(tool: OfferedAppTool, operation: string): boolean {
  const schema = tool.inputSchema;
  if (typeof schema !== "object" || schema === null || !("properties" in schema)) return false;
  const properties = schema.properties;
  if (typeof properties !== "object" || properties === null || !("operation" in properties))
    return false;
  const property = properties.operation;
  if (typeof property !== "object" || property === null || !("enum" in property)) return false;
  return Array.isArray(property.enum) && property.enum.includes(operation);
}

function lineFor(tool: OfferedAppTool): string | undefined {
  if (tool.name === "octant_threads" && offersOperation(tool, "start"))
    return COORDINATOR_THREADS_LINE;
  return GUIDE_LINES[tool.name];
}

/**
 * The host lines a turn carries for the first-party tools it offers, one per
 * tool, sorted by name. A tool the turn does not offer gets no line, a turn
 * with no tools gets none, and third-party tools keep their own descriptions,
 * so the text changes only when the offered tools (or a coordinator's role)
 * do and the provider's cached prefix survives.
 */
export function appToolHostLines(
  definitions: ReadonlyArray<OfferedAppTool> | undefined,
): ReadonlyArray<AppToolHostLine> {
  const byName = new Map((definitions ?? []).map((definition) => [definition.name, definition]));
  return [...byName.values()]
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    .flatMap((tool) => {
      const text = lineFor(tool);
      return text === undefined ? [] : [{ tool: tool.name, text }];
    });
}
