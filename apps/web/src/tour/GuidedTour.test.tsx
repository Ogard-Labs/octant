import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GuidedTour, type GuidedTourProps } from "./GuidedTour";
import {
  GUIDED_TOUR_STORAGE_KEY,
  openGuidedTour,
  readGuidedTourRecord,
  resetGuidedTour,
} from "./guidedTourState";

/** jsdom lays nothing out, so a control is "on screen" once it is given a box. */
function draw(element: Element, box: { x: number; y: number; width: number; height: number }) {
  element.getBoundingClientRect = () =>
    ({
      ...box,
      left: box.x,
      top: box.y,
      right: box.x + box.width,
      bottom: box.y + box.height,
      toJSON: () => ({}),
    }) as DOMRect;
}

function Window(props: GuidedTourProps & { readonly withTools?: boolean }) {
  const { withTools = false, ...tour } = props;
  return (
    <>
      <button aria-label="New chat" ref={placed(box(240, 8, 28, 28))} type="button" />
      <nav aria-label="Projects" ref={placed(box(52, 56, 312, 600))}>
        <div className="project-nav__toolbar" ref={placed(box(52, 56, 312, 32))} />
      </nav>
      {withTools ? (
        <div aria-label="Tools" ref={placed(box(700, 4, 196, 36))} role="toolbar" />
      ) : null}
      <div className="composer" ref={placed(box(392, 600, 1024, 114))} />
      <button aria-label="Settings" ref={placed(box(6, 700, 32, 32))} type="button" />
      <button aria-label="Account menu, Test" type="button">
        Opener
      </button>
      <GuidedTour {...tour} />
    </>
  );
}

function placed(rect: { x: number; y: number; width: number; height: number }) {
  return (element: Element | null) => {
    if (element !== null) draw(element, rect);
  };
}

function box(x: number, y: number, width: number, height: number) {
  return { x, y, width, height };
}

const label = () => screen.getByText(/^\d of \d · /).textContent;

describe("GuidedTour", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    globalThis.localStorage.clear();
    resetGuidedTour();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("is offered once after first-run setup is answered, skipping a step whose control is not on screen", () => {
    const { rerender } = render(<Window blocked={false} firstRunStatus="pending" />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(globalThis.localStorage.getItem(GUIDED_TOUR_STORAGE_KEY)).toBe("due");

    rerender(<Window blocked={false} firstRunStatus="completed" />);

    // The Tools step has no control in this window, so four steps remain, in order.
    expect(label()).toBe("1 of 4 · New thread");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(label()).toBe("2 of 4 · Projects");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(label()).toBe("3 of 4 · Composer");
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(label()).toBe("4 of 4 · Settings");
    fireEvent.click(screen.getByRole("button", { name: "Done" }));

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(readGuidedTourRecord()).toBe("seen");
    rerender(<Window blocked={false} firstRunStatus="completed" />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("rings the row of Project controls and sets the card beside it, level with the ring", () => {
    render(<Window blocked={false} firstRunStatus="completed" />);
    act(() => openGuidedTour());
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(label()).toBe("2 of 4 · Projects");

    const ring = document.querySelector<HTMLElement>(".guided-tour__ring");
    const card = screen.getByRole("dialog", { name: "Projects keep work together" });
    // The ring stands 4px off the 312x32 row, not off the 600px-tall panel.
    expect(ring?.style.top).toBe("52px");
    expect(ring?.style.height).toBe("40px");
    // The card sits right of the sidebar with its top on the ring's top.
    expect(card.style.left).toBe("378px");
    expect(card.style.top).toBe("52px");
  });

  it("keeps the card centred on the control for the other steps", () => {
    render(<Window blocked={false} firstRunStatus="completed" />);
    act(() => openGuidedTour());
    const card = screen.getByRole("dialog", { name: "Start work in a new thread" });
    // Below the 28px New chat button, centred on it (a card with no measured width sits at its centre).
    expect(card.style.top).toBe("50px");
    expect(card.style.left).toBe("254px");
  });

  it("includes the Tools step when its buttons are drawn", () => {
    render(<Window blocked={false} firstRunStatus="completed" withTools />);
    act(() => openGuidedTour());

    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(label()).toBe("3 of 5 · Tools");
  });

  it("is never offered to an installation that answered first-run setup before the tour existed", () => {
    render(<Window blocked={false} firstRunStatus="completed" />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("waits while another surface needs the person", () => {
    globalThis.localStorage.setItem(GUIDED_TOUR_STORAGE_KEY, "due");
    const { rerender } = render(<Window blocked firstRunStatus="skipped" />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    rerender(<Window blocked={false} firstRunStatus="skipped" />);
    expect(screen.getByRole("dialog", { name: "Start work in a new thread" })).toBeInTheDocument();
  });

  it("moves with the arrow keys, closes on Escape and returns focus to where it was", () => {
    render(<Window blocked={false} firstRunStatus="completed" />);
    const opener = screen.getByRole("button", { name: "Account menu, Test" });
    opener.focus();

    act(() => openGuidedTour());
    expect(screen.getByRole("button", { name: "Next" })).toHaveFocus();

    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(label()).toBe("2 of 4 · Projects");
    fireEvent.keyDown(screen.getByRole("button", { name: "Next" }), { key: "ArrowLeft" });
    expect(label()).toBe("1 of 4 · New thread");

    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
    expect(readGuidedTourRecord()).toBe("seen");
  });
});
