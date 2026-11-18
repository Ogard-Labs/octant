import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TurnActions } from "./TurnActions";
import { turnTimeTitle } from "./TurnHeader";

const at = "2026-01-02T03:04:05.000Z";

describe("TurnActions", () => {
  it("shows the time and forks from the latest reply at rest", () => {
    const onFork = vi.fn();
    const { container } = render(
      <TurnActions at={at} copyValue="Answer" latest onFork={onFork} outcome="completed" />,
    );
    expect(container.querySelector(".turn-actions")).toHaveAttribute("data-latest", "true");
    expect(
      screen.getAllByTitle(turnTimeTitle(at) ?? "").some((element) => element.tagName === "TIME"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Fork from here" }));
    expect(onFork).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Copy message" })).toBeInTheDocument();
  });

  it("shows the time of a failed reply", () => {
    render(<TurnActions at={at} latest outcome="failed" />);
    expect(document.querySelector("time")).not.toBeNull();
  });

  it("keeps an older reply's row hover-only but in place", () => {
    const { container } = render(
      <TurnActions at={at} copyValue="Answer" latest={false} outcome="completed" />,
    );
    expect(container.querySelector(".turn-actions")).toHaveAttribute("data-latest", "false");
  });

  it("draws no row while the reply is still working", () => {
    const { container } = render(<TurnActions at={at} latest outcome="running" />);
    expect(container.querySelector(".turn-actions")).toBeNull();
  });

  it("offers to run the reply again where the host supports it", () => {
    const onRegenerate = vi.fn();
    render(<TurnActions latest onRegenerate={onRegenerate} outcome="completed" />);
    fireEvent.click(screen.getByRole("button", { name: "Regenerate response" }));
    expect(onRegenerate).toHaveBeenCalledOnce();
  });
});
