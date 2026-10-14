import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LoadEarlierMessages } from "./LoadEarlierMessages";

describe("LoadEarlierMessages", () => {
  it("loads the page before on request", () => {
    const onLoad = vi.fn();
    render(<LoadEarlierMessages onLoad={onLoad} state="idle" />);

    fireEvent.click(screen.getByRole("button", { name: "Load earlier messages" }));

    expect(onLoad).toHaveBeenCalledOnce();
  });

  it("keeps focus on the control while the page loads and ignores a second press", () => {
    const onLoad = vi.fn();
    render(<LoadEarlierMessages onLoad={onLoad} state="loading" />);
    const button = screen.getByRole("button", { name: "Loading earlier messages" });

    fireEvent.click(button);

    expect(button).toHaveAttribute("aria-disabled", "true");
    expect(onLoad).not.toHaveBeenCalled();
  });

  it("says a page failed and offers to try again", () => {
    const onLoad = vi.fn();
    render(<LoadEarlierMessages onLoad={onLoad} state="failed" />);

    expect(screen.getByText("Earlier messages could not be loaded.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(onLoad).toHaveBeenCalledOnce();
  });

  it("says when nothing earlier is left", () => {
    render(<LoadEarlierMessages onLoad={vi.fn()} state="none-left" />);

    expect(screen.getByText("No earlier messages")).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
