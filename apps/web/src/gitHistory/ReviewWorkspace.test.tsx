import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { decodeCodeThreadId } from "@octant/contracts/code";
import { decodeUtcTimestamp } from "@octant/contracts/events";
import type { AgentRunReviewResponse } from "@octant/contracts";
import { resultPacketFixture } from "../agents/agentActivityFixtures";
import { DockReviewTool } from "../shell/DockReviewTool";
import { ReviewWorkspace } from "./ReviewWorkspace";

vi.mock("../shell/DockReviewTool", () => ({
  DockReviewTool: vi.fn(() => <button>Discard local changes</button>),
}));

const metadata = {
  capturedAt: decodeUtcTimestamp("2026-10-04T10:00:00.000Z"),
  baseTree: "a".repeat(40),
  resultTree: "b".repeat(40),
  changedPaths: ["src/parser.ts", "image.png", "new.txt"],
  truncated: true,
};
const packet = resultPacketFixture({
  review: metadata,
  files: { status: "recorded", items: [], reviewStatus: "available" },
});
const threadId = decodeCodeThreadId(String(packet.parentThreadId));
const diff = [
  "diff --git a/src/parser.ts b/src/parser.ts",
  "--- a/src/parser.ts",
  "+++ b/src/parser.ts",
  "@@ -1 +1 @@",
  "-previous generation",
  "+captured child change",
  "diff --git a/image.png b/image.png",
  "Binary files a/image.png and b/image.png differ",
  "",
].join("\n");

function available(
  generation = packet.generation,
): Extract<AgentRunReviewResponse, { readonly status: "available" }> {
  return {
    runId: packet.runId,
    parentThreadId: packet.parentThreadId,
    generation,
    status: "available",
    snapshot: { ...metadata, diff },
  };
}

describe("saved child review", () => {
  it("opens only the requested captured file and keeps all partial and binary changes reachable", async () => {
    const user = userEvent.setup();
    const review = vi.fn(async () => available());
    const onOpenFile = vi.fn();
    const view = render(
      <ReviewWorkspace
        threadId={threadId}
        agentRunClient={{ review }}
        requestedAgentReview={{ packet, filePath: "src/parser.ts" }}
        onOpenFile={onOpenFile}
      />,
    );
    expect(await screen.findByRole("table", { name: "Diff for src/parser.ts" })).toHaveTextContent(
      "captured child change",
    );
    expect(screen.getByRole("heading", { name: "Generation 1 changes" })).toBeVisible();
    expect(screen.getByText(/This captured comparison is partial/)).toBeVisible();
    expect(review).toHaveBeenCalledWith(packet.runId, 1);
    await user.click(screen.getByText("Attribution", { selector: "summary" }));
    const attribution = screen.getByRole("group", { name: "Review attribution" });
    expect(attribution).toHaveTextContent(packet.runId);
    expect(attribution).toHaveTextContent("/workspace/child");
    expect(attribution).toHaveTextContent(metadata.baseTree);
    await user.click(screen.getByRole("button", { name: "All captured changes" }));
    expect(screen.getByRole("region", { name: "image.png" })).toHaveTextContent(
      "without a textual diff",
    );
    expect(screen.getByText(/new.txt.*has no retained diff/)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: /^(Open|Discard|Stage|Commit)/ }),
    ).not.toBeInTheDocument();
    expect(DockReviewTool).not.toHaveBeenCalled();
    expect(onOpenFile).not.toHaveBeenCalled();
    view.rerender(
      <ReviewWorkspace
        threadId={threadId}
        agentRunClient={{ review }}
        requestedAgentReview={{ packet, filePath: "src/parser.ts" }}
      />,
    );
    expect(screen.getByRole("table", { name: "Diff for src/parser.ts" })).toBeVisible();
    expect(screen.queryByRole("region", { name: "image.png" })).not.toBeInTheDocument();
  });

  it.each(["missing client method", "unavailable capture", "wrong generation"])(
    "shows %s without substituting the live checkout",
    async (scenario) => {
      const response: AgentRunReviewResponse =
        scenario === "wrong generation"
          ? available(2)
          : {
              runId: packet.runId,
              parentThreadId: packet.parentThreadId,
              generation: 1,
              status: "unavailable",
            };
      const review = vi.fn(async () => response);
      render(
        <ReviewWorkspace
          threadId={threadId}
          agentRunClient={scenario === "missing client method" ? {} : { review }}
          requestedAgentReview={{ packet }}
        />,
      );
      expect(await screen.findByText("Saved review unavailable.")).toBeVisible();
      expect(screen.queryByText("captured child change")).not.toBeInTheDocument();
      expect(DockReviewTool).not.toHaveBeenCalled();
    },
  );

  it("drops a slow earlier generation and explains a reported file missing from the capture", async () => {
    let resolveFirst: ((response: AgentRunReviewResponse) => void) | undefined;
    const first = new Promise<AgentRunReviewResponse>((resolve) => {
      resolveFirst = resolve;
    });
    const secondPacket = { ...packet, generation: 2 };
    const review = vi.fn(async (_runId, generation) => (generation === 1 ? first : available(2)));
    const view = render(
      <ReviewWorkspace
        threadId={threadId}
        agentRunClient={{ review }}
        requestedAgentReview={{ packet }}
      />,
    );
    view.rerender(
      <ReviewWorkspace
        threadId={threadId}
        agentRunClient={{ review }}
        requestedAgentReview={{ packet: secondPacket, filePath: "unreported.ts" }}
      />,
    );
    expect(await screen.findByText(/unreported.ts.*not in this captured comparison/)).toBeVisible();
    await act(async () => {
      resolveFirst?.({
        ...available(),
        snapshot: { ...metadata, diff: diff.replace("captured child change", "obsolete content") },
      });
    });
    const saved = screen.getByRole("region", { name: "Saved child review" });
    expect(within(saved).getByRole("heading", { name: "Generation 2 changes" })).toBeVisible();
    expect(saved).not.toHaveTextContent("obsolete content");
    expect(DockReviewTool).not.toHaveBeenCalled();
  });
});
