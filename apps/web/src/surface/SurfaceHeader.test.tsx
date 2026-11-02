import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Surface, SurfaceEmpty, SurfaceHeader, SurfaceSection } from "./SurfaceHeader";

describe("Surface", () => {
  it("says an empty column is empty more quietly than an empty page", () => {
    const { rerender } = render(<SurfaceEmpty title="No threads" />);
    // A page with nothing on it: the sentence is the only thing to read.
    expect(screen.getByText("No threads")).toHaveClass("oct-row-label");

    rerender(<SurfaceEmpty title="No threads" tone="lane" />);
    // One empty column beside full ones: the same sentence in the same ink
    // shouted louder than the real cards next to it.
    expect(screen.getByText("No threads")).toHaveClass("oct-meta");
    expect(screen.getByRole("status")).toHaveAttribute("data-tone", "lane");
  });

  it("names every reader route with one landmark, one title, and one way back", () => {
    const onBack = vi.fn();
    render(
      <Surface ariaLabel="Inbox">
        <SurfaceHeader onBack={onBack} title="Inbox" />
      </Surface>,
    );

    expect(screen.getByRole("region", { name: "Inbox" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Inbox" })).toHaveClass("oct-page-title");
    screen.getByRole("button", { name: "Back to workspace" }).click();
    expect(onBack).toHaveBeenCalledOnce();
  });

  it("opens on one toolbar row: Back leads, then the title, and actions take the trailing edge", () => {
    render(
      <SurfaceHeader
        actions={<button type="button">Refresh</button>}
        detail="3 finished threads"
        onBack={vi.fn()}
        title="To review"
      />,
    );

    const back = screen.getByRole("button", { name: "Back to workspace" });
    const heading = screen.getByRole("heading", { level: 1, name: "To review" });
    const refresh = screen.getByRole("button", { name: "Refresh" });
    expect(back.compareDocumentPosition(heading)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(heading.compareDocumentPosition(refresh)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // The name is the tooltip too, because the control shows only a glyph.
    expect(back).toHaveAttribute("title", "Back to workspace");
    expect(back).not.toHaveTextContent("Back");
    expect(screen.getByText("3 finished threads")).toHaveClass("oct-meta");
  });

  it("keeps boards on the full width while lists keep the reading measure", () => {
    const { container } = render(
      <Surface ariaLabel="Threads" measure="wide">
        <SurfaceEmpty detail="Create one to see it here." title="No threads yet" />
      </Surface>,
    );

    expect(container.querySelector(".surface")).toHaveClass("surface--wide");
    expect(screen.getByRole("status")).toHaveTextContent("No threads yet");
  });

  it("can use navigation as the surface landmark", () => {
    render(
      <Surface ariaLabel="Projects" landmark="nav">
        <SurfaceHeader title="Projects" />
      </Surface>,
    );

    expect(screen.getByRole("navigation", { name: "Projects" })).toBeInTheDocument();
  });

  it("labels a section with the shared hairline heading", () => {
    render(
      <SurfaceSection label="Needs you" note="Nothing is waiting.">
        <ul className="surface-list" />
      </SurfaceSection>,
    );

    expect(screen.getByRole("heading", { level: 2, name: "Needs you" })).toHaveClass(
      "oct-section-label",
    );
  });
});
