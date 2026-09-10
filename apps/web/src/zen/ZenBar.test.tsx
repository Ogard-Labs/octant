import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { ZenBar } from "./ZenBar";

describe("ZenBar", () => {
  it("carries four destinations and the way out, and nothing else", () => {
    const onExit = vi.fn();
    const onHide = vi.fn();
    render(
      <ZenBar
        collapsed={false}
        onExit={onExit}
        onHide={onHide}
        onOpenAdd={() => undefined}
        onOpenAppearance={() => undefined}
        onOpenNavigator={() => undefined}
        onOpenThreads={() => undefined}
      />,
    );

    const bar = screen.getByRole("toolbar", { name: "Navigator Bar" });
    // The bar held nine controls, a model label, and a prompt field, on a
    // surface whose whole point is that there is little on it.
    expect(
      within(bar)
        .getAllByRole("button")
        .map((button) => button.textContent),
    ).toEqual(["Hide Navigator bar", "Threads", "Add", "Navigator", "Appearance", "Exit Zen"]);
    // Asking lives in the Navigator panel, which has the same field and shows
    // the answer; the bar's copy meant asking in one place and reading in
    // another.
    expect(within(bar).queryByRole("textbox")).not.toBeInTheDocument();

    fireEvent.click(within(bar).getByRole("button", { name: "Exit Zen" }));
    expect(onExit).toHaveBeenCalledOnce();
    fireEvent.click(within(bar).getByRole("button", { name: "Hide Navigator bar" }));
    expect(onHide).toHaveBeenCalledOnce();
  });

  it("collapses to a pill that still exits Zen", () => {
    const onExit = vi.fn();
    const onExpand = vi.fn();
    render(<ZenBar collapsed onExit={onExit} onExpand={onExpand} />);

    expect(screen.queryByRole("toolbar", { name: "Navigator Bar" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show Navigator bar" }));
    expect(onExpand).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Exit Zen" }));
    expect(onExit).toHaveBeenCalledOnce();
  });

  it("marks a destination this window cannot reach rather than hiding it", () => {
    render(
      <ZenBar
        collapsed={false}
        onExit={() => undefined}
        onHide={() => undefined}
        onOpenAdd={() => undefined}
        onOpenThreads={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: "Threads" })).not.toHaveAttribute("aria-disabled");
    expect(screen.getByRole("button", { name: "Appearance" })).toHaveAttribute("aria-disabled");
  });
});
