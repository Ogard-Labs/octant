import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ZenRoot } from "./ZenRoot";

describe("ZenRoot", () => {
  it("renders the Zen surface instead of the shell children when active", () => {
    render(
      <ZenRoot active onExit={() => undefined} onToggle={() => undefined} zen={<div>Zen view</div>}>
        <div>Ordinary shell</div>
      </ZenRoot>,
    );

    expect(screen.getByText("Zen view")).toBeInTheDocument();
    expect(screen.getByText("Ordinary shell").closest(".zen-root__shell")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });

  it("keeps the ordinary shell visible when Zen is inactive", () => {
    render(
      <ZenRoot
        active={false}
        onExit={() => undefined}
        onToggle={() => undefined}
        zen={<div>Zen view</div>}
      >
        <div>Ordinary shell</div>
      </ZenRoot>,
    );

    expect(screen.getByText("Ordinary shell")).toBeInTheDocument();
    expect(screen.queryByText("Zen view")).not.toBeInTheDocument();
  });

  it("toggles Zen with the dedicated keyboard shortcut", () => {
    const onToggle = vi.fn();
    render(
      <ZenRoot active onExit={() => undefined} onToggle={onToggle} zen={<div>Zen view</div>}>
        <div>Ordinary shell</div>
      </ZenRoot>,
    );

    fireEvent.keyDown(window, { key: "z", metaKey: true, shiftKey: true });
    expect(onToggle).toHaveBeenCalledOnce();
  });
});
