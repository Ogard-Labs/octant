import type { ApprovalOutsideContent, ThreadExternalContentSource } from "@octant/contracts";

/** What a source shows as when the host records a label nobody has named yet. */
export const UNNAMED_OUTSIDE_SOURCE = "Other outside content";

/**
 * Plain words for the source labels the host records. Its services write a
 * fixed label for what they bring in; an app-managed tool's successful result
 * is recorded under the tool's own name; an extension tool is recorded as one
 * label for all of them. A label with no words here shows as
 * {@link UNNAMED_OUTSIDE_SOURCE}, never as the raw identifier.
 */
const SOURCE_WORDS: Readonly<Record<string, string>> = {
  "agent-message": "A message from another agent",
  "browser-observation": "Pages seen in the browser",
  "browser-page": "A browser page sent as feedback",
  canvas: "A Canvas written by another thread",
  "chat-branch": "The thread this was branched or restored from",
  "code-fork": "The thread this was forked or restored from",
  "follow-up": "The thread that suggested this one",
  "fork-merge-back": "Changes merged back from a fork",
  "github-issue": "A GitHub issue",
  "github-issues": "GitHub issues",
  "github-pull-requests": "GitHub pull requests",
  "github-projects": "GitHub projects",
  "linear-issue": "A Linear issue",
  "mcp-tool": "Results from connected tools",
  "planner-proposal": "The planner thread that proposed this one",
  "runtime-hosted-tool": "Tools the model's provider ran on its own servers",
  "runtime-web-fetch": "Web pages the provider fetched with its own tools",
  "runtime-web-search": "Web searches the provider ran with its own tools",
  "product-feedback-comment": "A comment sent as feedback",
  "sibling-thread": "Other threads in this Project",
  "side-chat": "The thread this side chat is about",
  "simulator-screen": "A simulator screen sent as feedback",
  "subagent-result": "A subagent's result",
  "thread-mention": "A thread mentioned in a message",
  octant_agent_message: "A message from another agent",
  octant_agents: "Results from helper agents",
  octant_android: "The Android emulator",
  octant_apple: "Apple builds, the iOS Simulator, and paired devices",
  octant_board: "The Project's work board",
  octant_browser: "Pages seen in the browser",
  octant_canvas: "A Canvas document",
  octant_computer: "Apps on your desktop",
  octant_create_image: "A generated image",
  octant_github: "GitHub issues, pull requests and projects",
  octant_offer_side_task: "A side task offer",
  octant_propose_thread: "A proposed thread",
  octant_side_chat_list_files: "Files listed for a side chat",
  octant_side_chat_read_file: "A file read for a side chat",
  octant_side_chat_search_files: "A file search for a side chat",
  octant_terminal: "Terminal output",
  octant_thread_message: "A reply from another thread",
  octant_web_research: "Web research",
  // The harness's own tools. Only some bring in outside content, but a name
  // the catalog does not know taints, so each has words.
  read: "Files read",
  grep: "File searches",
  glob: "File listings",
  bash: "Command output",
  edit: "File edits",
  write: "File writes",
  "web-fetch": "Web pages",
  "web-search": "Web search results",
  "todo-write": "The task list",
  "context-remaining": "The context estimate",
  "journal-lookup": "Earlier messages of this conversation",
  "second-opinion": "A second opinion from another model",
  delegate: "A helper agent's reply",
  "ask-user": "Your answer to a question",
  goal: "The thread's goal",
  "goal-check": "A goal check",
};

// The Zen assistant's tools share one prefix and one meaning.
const ZEN_PREFIX = "octant_zen_";
// A synced artifact's label names the computer it came from, in words.
const SYNCED_PREFIX = "Synced from ";

export function describeSource(label: string): string {
  const named = Object.hasOwn(SOURCE_WORDS, label) ? SOURCE_WORDS[label] : undefined;
  if (named !== undefined) return named;
  if (label.startsWith(ZEN_PREFIX)) return "Results from the Zen assistant";
  if (label.startsWith(SYNCED_PREFIX))
    return `An artifact synced from ${label.slice(SYNCED_PREFIX.length)}`;
  return UNNAMED_OUTSIDE_SOURCE;
}

/**
 * How many times a source was read and when, in words. `formatTime` turns a
 * recorded time into the client's own wording; a time it cannot read is left
 * out rather than shown raw.
 */
export function describeOutsideContentReads(
  source: ThreadExternalContentSource,
  formatTime: (at: string | undefined) => string | undefined,
): string {
  const reads = source.ingestionCount === 1 ? "Read once" : `Read ${source.ingestionCount} times`;
  const first = formatTime(source.firstIngestedAt);
  const last = formatTime(source.lastIngestedAt);
  if (first === undefined && last === undefined) return reads;
  if (source.ingestionCount === 1 || first === last) return `${reads}, ${last ?? first}`;
  return [
    reads,
    first === undefined ? undefined : `first ${first}`,
    last === undefined ? undefined : `last ${last}`,
  ]
    .filter((part) => part !== undefined)
    .join(", ");
}

export const APPROVAL_OUTSIDE_CONTENT_REASON =
  "This thread took in outside content, so this call is approved once. Check that it is something you asked for.";

/**
 * The words every approval prompt shows ahead of its answer controls when the
 * thread is marked: why it asks, each source that marked the thread, and how
 * many more the list leaves out. One definition so the web, phone and
 * terminal prompts cannot say different things.
 */
export function approvalOutsideContentLines(
  outsideContent: ApprovalOutsideContent,
  formatTime: (at: string | undefined) => string | undefined,
): {
  readonly reason: string;
  readonly rows: ReadonlyArray<{
    readonly sourceLabel: string;
    readonly name: string;
    readonly reads: string;
  }>;
  readonly more: string | undefined;
} {
  const unnamed = outsideContent.sourceCount - outsideContent.sources.length;
  return {
    reason: APPROVAL_OUTSIDE_CONTENT_REASON,
    rows: outsideContent.sources.map((source) => ({
      sourceLabel: source.sourceLabel,
      name: describeSource(source.sourceLabel),
      reads: describeOutsideContentReads(source, formatTime),
    })),
    more:
      unnamed <= 0
        ? undefined
        : unnamed === 1
          ? "and 1 more source"
          : `and ${unnamed} more sources`,
  };
}
