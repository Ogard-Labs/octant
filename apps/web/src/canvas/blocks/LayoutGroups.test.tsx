import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CANVAS_SCHEMA_VERSION,
  decodeCanvasDefinition,
  type CanvasDefinition,
} from "@octant/contracts/canvas";
import { designBriefExample } from "@octant/domain";
import { CanvasDocument } from "../CanvasDocument";

function brief(): CanvasDefinition {
  return decodeCanvasDefinition({
    schemaVersion: CANVAS_SCHEMA_VERSION,
    title: "Design brief",
    provenance: {
      mode: "chat",
      hostId: "local",
      projectId: "22222222-2222-4222-8222-222222222222",
      threadId: "33333333-3333-4333-8333-333333333333",
      actor: { kind: "local-user", actorId: "55555555-5555-4555-8555-555555555555" },
      providerInstanceId: "44444444-4444-4444-8444-444444444444",
      modelId: "octant-test-model",
      createdAt: "2026-08-01T21:00:00.000Z",
    },
    sourceManifest: [],
    blocks: designBriefExample,
  });
}

function commentRuntime() {
  return {
    openCounts: new Map<string, number>(),
    openRowCounts: new Map<string, ReadonlyMap<string, number>>(),
    onOpen: vi.fn(),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("Canvas tabs and columns", () => {
  it("draws the tabs as a tablist whose arrow keys, Home, and End move the selection", async () => {
    const user = userEvent.setup();
    render(<CanvasDocument definition={brief()} />);
    const tablist = screen.getByRole("tablist", { name: "Sections" });
    const tabs = within(tablist).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Metrics",
      "Core loop",
      "World",
      "Economy",
      "Content",
      "Live ops",
      "Risks",
      "Open questions",
    ]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Daily players");

    tabs[0]?.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("tab", { name: "Core loop" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("tab", { name: "Core loop" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tabpanel")).toHaveTextContent("Encounter?");

    await user.keyboard("{End}{Enter}");
    expect(screen.getByRole("tab", { name: "Open questions" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await user.keyboard("{Home}{Enter}");
    expect(screen.getByRole("tab", { name: "Metrics" })).toHaveAttribute("aria-selected", "true");
  });

  it("draws each named block inside its group once, not again in the block list", () => {
    render(<CanvasDocument definition={brief()} />);
    // The question sits in a tab that is not open, so it is not drawn at all
    // until the reader opens that tab; the metrics are drawn once, as tiles.
    expect(screen.queryByText("Does the keep unlock by level or by story progress?")).toBeNull();
    expect(screen.getAllByText("Daily players")).toHaveLength(1);
    const columns = document.querySelector(".canvas-columns__grid");
    expect(columns).toHaveAttribute("data-tracks", "2");
    expect(screen.getAllByText("Design signs off the loop and the zone map.")).toHaveLength(1);
    expect(columns).toHaveTextContent("Design signs off the loop and the zone map.");
  });

  it("draws a dashboard in a tab as the same labelled grid it is at the top level", () => {
    render(<CanvasDocument definition={brief()} comments={commentRuntime()} />);
    const panel = screen.getByRole("tabpanel");
    const region = within(panel).getByRole("region", { name: "Launch metrics" });
    expect(
      Array.from(region.querySelectorAll(".canvas-dashboard__cell")).map((cell) =>
        cell.getAttribute("data-block-kind"),
      ),
    ).toEqual(["metric", "metric", "metric", "metric"]);
    expect(within(region).getByText("Daily players")).toBeInTheDocument();
    // The dashboard keeps its own comment marker inside the pane.
    expect(within(panel).getByRole("button", { name: "Comment on Launch metrics" })).toBeVisible();
  });

  it("shows the open comments anchored to a tabs or columns block on the group itself", async () => {
    const user = userEvent.setup();
    const comments = commentRuntime();
    comments.openCounts.set("brief", 2);
    render(<CanvasDocument definition={brief()} comments={comments} />);
    await user.click(screen.getByRole("button", { name: "2 open comments on Tabs" }));
    expect(comments.onOpen).toHaveBeenCalledWith("brief");
    await user.click(screen.getByRole("button", { name: "Comment on Columns" }));
    expect(comments.onOpen).toHaveBeenCalledWith("sign-off");
  });

  it("switches tabs without a network call or a journaled revision", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const onSetStatus = vi.fn();
    const onRevise = vi.fn();
    const user = userEvent.setup();
    render(
      <CanvasDocument
        definition={brief()}
        layoutRuntime={{ onRevise }}
        planRuntime={{ onSetStatus }}
      />,
    );
    for (const name of ["World", "Economy", "Open questions", "Metrics"]) {
      await user.click(screen.getByRole("tab", { name }));
    }
    expect(screen.getByRole("tab", { name: "Metrics" })).toHaveAttribute("aria-selected", "true");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(onRevise).not.toHaveBeenCalled();
    expect(onSetStatus).not.toHaveBeenCalled();
  });
});
