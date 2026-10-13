import { NATIVE_HARNESS_TOOL_NAMES } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import { describeSource, UNNAMED_OUTSIDE_SOURCE } from "./outsideContentSources";

/**
 * Every label the host records as the source of outside content: the fixed
 * ones its services write, the app-managed tools whose successful results are
 * recorded under their own name, and the Octant tool names behind them. A
 * source added to the host without words here shows as "Other outside
 * content", so add it to this list and to `outsideContentSources.ts` together.
 */
const RECORDED_LABELS: ReadonlyArray<string> = [
  "agent-message",
  "browser-observation",
  "browser-page",
  "code-fork",
  "fork-merge-back",
  "github-issue",
  "github-issues",
  "github-pull-requests",
  "github-projects",
  "linear-issue",
  "mcp-tool",
  "product-feedback-comment",
  "simulator-screen",
  "subagent-result",
  "Synced from Studio laptop",
  ...NATIVE_HARNESS_TOOL_NAMES,
  "octant_agent_message",
  "octant_agents",
  "octant_android",
  "octant_apple",
  "octant_board",
  "octant_browser",
  "octant_canvas",
  "octant_computer",
  "octant_create_image",
  "octant_github",
  "octant_offer_side_task",
  "octant_propose_thread",
  "octant_side_chat_list_files",
  "octant_side_chat_read_file",
  "octant_side_chat_search_files",
  "octant_terminal",
  "octant_thread_message",
  "octant_web_research",
  "octant_zen_search_threads",
  "octant_zen_pin_thread",
];

describe("outside content source names", () => {
  it.each(RECORDED_LABELS)("names %s in plain words", (label) => {
    const words = describeSource(label);
    expect(words).not.toBe(UNNAMED_OUTSIDE_SOURCE);
    expect(words).not.toMatch(/octant_|[a-z]+-[a-z]+/);
  });

  it("never shows a label nobody has named as its raw identifier", () => {
    expect(describeSource("octant_something_new")).toBe(UNNAMED_OUTSIDE_SOURCE);
    expect(describeSource("brand-new-source")).toBe("Other outside content");
  });
});
