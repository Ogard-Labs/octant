import { NATIVE_HARNESS_TOOL_NAMES } from "@octant/contracts";
import { describe, expect, it } from "vitest";
import {
  approvalOutsideContentLines,
  APPROVAL_OUTSIDE_CONTENT_REASON,
  describeSource,
  UNNAMED_OUTSIDE_SOURCE,
} from "./outsideContentSources";

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
  "canvas",
  "chat-branch",
  "code-fork",
  "follow-up",
  "fork-merge-back",
  "github-issue",
  "github-issues",
  "github-pull-requests",
  "github-projects",
  "linear-issue",
  "mcp-tool",
  "planner-proposal",
  "runtime-hosted-tool",
  "runtime-web-fetch",
  "runtime-web-search",
  "product-feedback-comment",
  "sibling-thread",
  "side-chat",
  "simulator-screen",
  "subagent-result",
  "thread-mention",
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
  "octant_propose_routine",
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

describe("approval outside content lines", () => {
  const source = (sourceLabel: string, ingestionCount: number) => ({
    sourceLabel,
    ingestionCount,
    firstIngestedAt: "2026-08-10T11:00:00.000Z",
    lastIngestedAt: "2026-08-10T11:30:00.000Z",
  });
  const at = (time: string | undefined) =>
    time?.startsWith("2026-08-10T11:0") ? "11:00" : "11:30";

  it("names each source with its reads and counts the sources the list leaves out", () => {
    const lines = approvalOutsideContentLines(
      { sourceCount: 4, sources: [source("web-fetch", 2), source("bash", 1)] } as never,
      at,
    );
    expect(lines.reason).toBe(APPROVAL_OUTSIDE_CONTENT_REASON);
    expect(lines.rows.map((row) => [row.name, row.reads])).toEqual([
      ["Web pages", "Read 2 times, first 11:00, last 11:30"],
      ["Command output", "Read once, 11:30"],
    ]);
    expect(lines.more).toBe("and 2 more sources");
  });

  it("says nothing more when every source is listed, and leaves out a time it cannot read", () => {
    const lines = approvalOutsideContentLines(
      { sourceCount: 1, sources: [source("web-fetch", 3)] } as never,
      () => undefined,
    );
    expect(lines.rows[0]?.reads).toBe("Read 3 times");
    expect(lines.more).toBeUndefined();
  });
});
