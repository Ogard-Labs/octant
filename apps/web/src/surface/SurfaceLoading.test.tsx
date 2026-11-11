import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SurfaceLoading } from "./SurfaceLoading";

describe("SurfaceLoading", () => {
  it("draws a page's title bar and rows in the page's own frame and says what is opening", () => {
    const { container } = render(<SurfaceLoading label="Opening Inbox" />);

    // The words are what assistive technology hears; nothing else is read.
    const status = screen.getByRole("status", { name: "Opening Inbox" });
    expect(status).toHaveTextContent("Opening Inbox…");
    expect(status).toHaveClass("surface", "surface--wide");

    // The outline stands where the page will: the same inner frame, a bar in
    // the header's place and rows under it, all skipped by a screen reader.
    const frame = container.querySelector(".surface__inner");
    expect(frame).toHaveAttribute("aria-hidden", "true");
    expect(frame?.querySelector(".surface-header .skeleton")).not.toBeNull();
    expect(frame?.querySelectorAll(".surface-loading__row")).toHaveLength(5);
  });

  it("keeps the reading measure for a page that reads in a column", () => {
    render(<SurfaceLoading label="Opening usage" measure="reading" />);

    expect(screen.getByRole("status", { name: "Opening usage" })).not.toHaveClass("surface--wide");
  });
});
