import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Surface, SurfaceEmpty, SurfaceHeader, SurfaceSection } from "./SurfaceHeader";

describe("Surface", () => {
  it("names every reader route with one landmark, one title, and one way back", () => {
    const onBack = vi.fn();
    render(
      <Surface ariaLabel="Inbox">
        <SurfaceHeader
          onBack={onBack}
          subtitle="What is waiting on you, across every mode."
          title="Inbox"
        />
      </Surface>,
    );

    expect(screen.getByRole("region", { name: "Inbox" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Inbox" })).toHaveClass("oct-title");
    screen.getByRole("button", { name: "Back to workspace" }).click();
    expect(onBack).toHaveBeenCalledOnce();
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
