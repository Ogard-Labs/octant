import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ZenBar } from "./ZenBar";

describe("ZenBar", () => {
  it("exposes Navigator Bar controls and Exit Zen", () => {
    const onExit = vi.fn();
    const onHide = vi.fn();
    render(
      <ZenBar
        collapsed={false}
        onAskNavigatorAssistant={() => undefined}
        onExit={onExit}
        onHide={onHide}
        onOpenAppearance={() => undefined}
        onOpenActivity={() => undefined}
        onOpenAdd={() => undefined}
        onOpenThreads={() => undefined}
        onOpenWidgets={() => undefined}
      />,
    );

    expect(screen.getByRole("toolbar", { name: "Navigator Bar" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Exit Zen" }));
    expect(onExit).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Hide Navigator Bar" }));
    expect(onHide).toHaveBeenCalledOnce();
  });

  it("collapses to a pill that still exits Zen", () => {
    const onExit = vi.fn();
    const onExpand = vi.fn();
    render(<ZenBar collapsed onExit={onExit} onExpand={onExpand} />);

    expect(screen.queryByRole("toolbar", { name: "Navigator Bar" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Show Navigator Bar" }));
    expect(onExpand).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Exit Zen" }));
    expect(onExit).toHaveBeenCalledOnce();
  });

  it("enables manual capability controls when handlers are available", () => {
    render(
      <ZenBar
        collapsed={false}
        onAskNavigatorAssistant={() => undefined}
        onExit={() => undefined}
        onHide={() => undefined}
        onOpenAppearance={() => undefined}
        onOpenActivity={() => undefined}
        onOpenAdd={() => undefined}
        onOpenThreads={() => undefined}
        onOpenWidgets={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: "Threads" })).not.toHaveAttribute("aria-disabled");
    expect(screen.getByRole("button", { name: "Widgets" })).not.toHaveAttribute("aria-disabled");
  });
});
