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

    fireEvent.keyDown(window, { key: "e", metaKey: true, shiftKey: true });
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("leaves the Zen chord alone when the Zen plugin is off", () => {
    const onToggle = vi.fn();
    render(
      <ZenRoot
        active={false}
        enabled={false}
        onExit={() => undefined}
        onToggle={onToggle}
        zen={<div>Zen view</div>}
      >
        <div>Ordinary shell</div>
      </ZenRoot>,
    );

    const notHandled = fireEvent.keyDown(window, { key: "e", metaKey: true, shiftKey: true });

    expect(onToggle).not.toHaveBeenCalled();
    expect(notHandled).toBe(true);
  });

  it("stays shut when the page already took the key for a command of its own", () => {
    const onToggle = vi.fn();
    render(
      <ZenRoot active={false} onExit={() => undefined} onToggle={onToggle} zen={<div>Zen</div>}>
        <button type="button">Finished thread</button>
      </ZenRoot>,
    );
    // The Review page listens on the document, so it answers first.
    const takeKey = (event: KeyboardEvent) => event.preventDefault();
    document.addEventListener("keydown", takeKey);

    try {
      fireEvent.keyDown(screen.getByRole("button", { name: "Finished thread" }), {
        key: "e",
        metaKey: true,
        shiftKey: true,
      });
    } finally {
      document.removeEventListener("keydown", takeKey);
    }

    expect(onToggle).not.toHaveBeenCalled();
  });

  it("leaves its chord to the composer instead of opening Zen while someone is typing", () => {
    const onToggle = vi.fn();
    render(
      <ZenRoot active={false} onExit={() => undefined} onToggle={onToggle} zen={<div>Zen</div>}>
        <textarea aria-label="Message" />
      </ZenRoot>,
    );

    // Outside Zen the chord was once taken even in a text field, which threw
    // the window into Zen while someone was typing.
    const pressed = fireEvent.keyDown(screen.getByLabelText("Message"), {
      key: "e",
      metaKey: true,
      shiftKey: true,
    });

    expect(onToggle).not.toHaveBeenCalled();
    // `fireEvent` returns false when the event was cancelled; the key must survive.
    expect(pressed).toBe(true);
  });
});
