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

  it("steps through focus spaces only while Zen is showing", () => {
    const onCycleSpace = vi.fn();
    const root = (active: boolean) => (
      <ZenRoot
        active={active}
        onCycleSpace={onCycleSpace}
        onExit={() => undefined}
        onToggle={() => undefined}
        zen={<div>Zen</div>}
      >
        <div>Shell</div>
      </ZenRoot>
    );
    const press = (key: string) => fireEvent.keyDown(window, { key, metaKey: true, altKey: true });
    const view = render(root(false));

    // `fireEvent` returns true when nothing cancelled the event.
    expect(press("]")).toBe(true);
    expect(onCycleSpace).not.toHaveBeenCalled();

    view.rerender(root(true));
    expect(press("]")).toBe(false);
    expect(press("[")).toBe(false);
    expect(onCycleSpace.mock.calls).toEqual([[1], [-1]]);
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

  it("still answers inside Zen when a focused card also used the key", () => {
    const onToggle = vi.fn();
    const onCycleSpace = vi.fn();
    render(
      <ZenRoot
        active
        onCycleSpace={onCycleSpace}
        onExit={() => undefined}
        onToggle={onToggle}
        zen={
          <button onKeyDown={(event) => event.preventDefault()} type="button">
            Card
          </button>
        }
      >
        <div>Shell</div>
      </ZenRoot>,
    );
    const card = screen.getByRole("button", { name: "Card" });

    fireEvent.keyDown(card, { key: "]", metaKey: true, altKey: true });
    fireEvent.keyDown(card, { key: "e", metaKey: true, shiftKey: true });

    expect(onCycleSpace).toHaveBeenCalledExactlyOnceWith(1);
    expect(onToggle).toHaveBeenCalledOnce();
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
