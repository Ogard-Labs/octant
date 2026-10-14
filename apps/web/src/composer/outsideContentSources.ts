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
  "product-feedback-comment": "A comment sent as feedback",
  "sibling-thread": "Other threads in this Project",
  "simulator-screen": "A simulator screen sent as feedback",
  "subagent-result": "A subagent's result",
  octant_agent_message: "A message from another agent",
  octant_agents: "Results from helper agents",
  octant_android: "The Android emulator",
  octant_apple: "Apple builds and the iOS Simulator",
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
