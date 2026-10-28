import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { decodeCanvasBlock, type CanvasDeckBlock } from "@octant/contracts/canvas";
import { describe, expect, it } from "vitest";
import { CanvasDocument } from "../CanvasDocument";
import { canvasFixture } from "../test-fixtures";

const base = { schemaVersion: canvasFixture.schemaVersion };
const chart = decodeCanvasBlock({
  ...base,
  blockId: "signups",
  kind: "chart",
  chartType: "line",
  series: [{ seriesId: "s", label: "Signups", points: [{ x: "Q1", y: 3 }] }],
});
const mockup = decodeCanvasBlock({
  ...base,
  blockId: "screen",
  kind: "mockup",
  device: "phone",
  title: "Search",
  nodes: [{ nodeId: "window", component: "window", label: "Search" }],
});
const decodedDeck = decodeCanvasBlock({
  ...base,
  blockId: "deck",
  kind: "deck",
  title: "Launch deck",
  slides: [
    { slideId: "a", blockId: "screen", notes: "Open with the search." },
    { slideId: "b", blockId: "signups" },
  ],
});
if (decodedDeck.kind !== "deck") throw new Error("expected a deck");
const deck: CanvasDeckBlock = decodedDeck;

describe("deck", () => {
  it("lists its slides with the presenter's notes and never draws a placed block twice", () => {
    render(<CanvasDocument definition={{ ...canvasFixture, blocks: [chart, mockup, deck] }} />);
    const section = screen.getByRole("region", { name: "Launch deck, deck" });
    expect(within(section).getByText("2 slides")).toBeInTheDocument();
    expect(within(section).getByText("Open with the search.")).toBeInTheDocument();
    // The deck places its blocks, so the chart and mockup read only here.
    expect(screen.queryAllByRole("region", { name: /Signups/ })).toHaveLength(0);
  });

  it("presents the slides across blocks and moves with the arrows", async () => {
    const user = userEvent.setup();
    render(<CanvasDocument definition={{ ...canvasFixture, blocks: [chart, mockup, deck] }} />);
    await user.click(screen.getByRole("button", { name: /Present/ }));
    const player = screen.getByRole("dialog", { name: "Presenting Launch deck" });
    expect(within(player).getByText("1 / 2")).toBeInTheDocument();
    expect(within(player).getByRole("tree", { name: "Search" })).toBeInTheDocument();
    // The first slide's notes, once the presenter turns them on.
    await user.click(screen.getByRole("button", { name: "Notes" }));
    expect(within(player).getByText("Open with the search.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Next slide" }));
    expect(within(player).getByText("2 / 2")).toBeInTheDocument();
    // The second slide is the data block, drawn as itself.
    expect(within(player).getByText("Signups")).toBeInTheDocument();
  });
});
