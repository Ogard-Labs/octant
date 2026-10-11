import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CANVAS_SCHEMA_VERSION, decodeCanvasBlock } from "@octant/contracts/canvas";
import { opsDashboardExampleBlocks, releaseHealthBoardExampleBlocks } from "@octant/domain";
import { describe, expect, it, vi } from "vitest";
import { CanvasDocument } from "../CanvasDocument";
import { DashboardBlock } from "./DashboardBlock";
import { canvasFixture } from "../test-fixtures";

const prose = decodeCanvasBlock({
  blockId: "intro",
  schemaVersion: CANVAS_SCHEMA_VERSION,
  kind: "rich-text",
  text: "Morning check.",
});

function cellKinds(region: HTMLElement): ReadonlyArray<string | null> {
  return Array.from(region.querySelectorAll(".canvas-dashboard__cell")).map((cell) =>
    cell.getAttribute("data-block-kind"),
  );
}

describe("dashboard layout", () => {
  it("draws a labelled region whose cells read in the order the dashboard lists them", () => {
    const [board, ...placed] = opsDashboardExampleBlocks;
    if (board === undefined || board.kind !== "dashboard") throw new Error("missing dashboard");
    // Two placed blocks sit before the dashboard; they still read inside it.
    render(
      <CanvasDocument
        definition={{
          ...canvasFixture,
          blocks: [prose, ...placed.slice(0, 2), board, ...placed.slice(2)],
        }}
      />,
    );

    const region = screen.getByRole("region", { name: "Service health" });
    expect(cellKinds(region)).toEqual([
      "metric",
      "metric",
      "metric",
      "status",
      "chart",
      "status",
      "table",
    ]);
    expect(region.querySelector(".canvas-dashboard__grid")).toHaveAttribute("data-columns", "4");
    expect(
      Array.from(region.querySelectorAll(".canvas-dashboard__cell")).map((cell) =>
        cell.getAttribute("data-span"),
      ),
    ).toEqual(["1", "1", "1", "1", "3", "1", "4"]);
    // Each placed block is drawn once, inside the grid.
    expect(screen.getAllByText("Requests per second")).toHaveLength(1);
    expect(within(region).getByText("Requests per second")).toBeVisible();
    // The prose before the dashboard still reads first.
    const prosePosition = screen.getByText("Morning check.").compareDocumentPosition(region);
    expect(prosePosition & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps a placed chart's data table and a placed table's grid reachable by keyboard", async () => {
    const user = userEvent.setup();
    render(
      <CanvasDocument definition={{ ...canvasFixture, blocks: releaseHealthBoardExampleBlocks }} />,
    );
    const region = screen.getByRole("region", { name: "Release 4.2 health" });
    const summary = within(region).getByText("View chart data");
    expect(summary.tagName).toBe("SUMMARY");
    // A summary is focusable by default; jsdom does not toggle one on Enter,
    // so the disclosure is opened the way the chart suite opens it.
    await user.click(summary);
    const data = within(region).getByRole("region", { name: "Chart data" });
    expect(data).toHaveAttribute("tabindex", "0");
    expect(within(data).getByRole("table", { name: "Chart readings" })).toBeVisible();
    expect(within(region).getByText("Crash on login with SSO")).toBeVisible();
  });

  it("offers a comment marker on the dashboard and on every block it places", () => {
    const onOpen = vi.fn();
    render(
      <CanvasDocument
        comments={{ openCounts: new Map(), openRowCounts: new Map(), onOpen }}
        definition={{ ...canvasFixture, blocks: releaseHealthBoardExampleBlocks }}
      />,
    );
    expect(screen.getByRole("button", { name: "Comment on Release 4.2 health" })).toBeVisible();
    const region = screen.getByRole("region", { name: "Release 4.2 health" });
    const blockMarkers = region.querySelectorAll(
      ".canvas-dashboard__cell > .canvas-block > .canvas-block__comment-marker",
    );
    expect(blockMarkers).toHaveLength(releaseHealthBoardExampleBlocks.length - 1);
  });

  it("titles the region at the heading level its surface asks for", () => {
    const { unmount } = render(
      <CanvasDocument definition={{ ...canvasFixture, blocks: releaseHealthBoardExampleBlocks }} />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Release 4.2 health" })).toBeVisible();
    unmount();
    // A shared snapshot nests the document under deeper headings of its own.
    render(
      <DashboardBlock
        cellKey={(block: string) => block}
        cellKind={() => "status"}
        cells={[{ block: "api", span: 1 }]}
        columns={2}
        headingLevel={6}
        renderCell={(block) => <p>{block}</p>}
        title="Snapshot board"
      />,
    );
    expect(screen.getByRole("heading", { level: 6, name: "Snapshot board" })).toBeVisible();
  });
});
