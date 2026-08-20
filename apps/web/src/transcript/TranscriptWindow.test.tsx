import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { TRANSCRIPT_FIND_CLOSED_EVENT, TranscriptWindow } from "./TranscriptWindow";

interface Row {
  readonly id: string;
  readonly label: string;
  readonly height?: number;
}

function rows(count: number, height?: number): ReadonlyArray<Row> {
  return Array.from({ length: count }, (_, index) => ({
    id: `row-${String(index)}`,
    label: `Row ${String(index)}`,
    ...(height === undefined ? {} : { height }),
  }));
}

function renderWindow(
  items: ReadonlyArray<Row>,
  extras: {
    readonly restoreKey?: string;
    readonly revealKey?: string;
    readonly align?: "start" | "end";
    readonly trail?: ReactNode;
    readonly lead?: ReactNode;
    readonly pinnedKeys?: ReadonlyArray<string>;
    readonly announceItem?: (item: Row) => string;
  } = {},
) {
  return render(
    <TranscriptWindow
      itemKey={(item) => item.id}
      items={items}
      listLabel="Transcript"
      renderItem={(item) => (
        <div {...(item.height === undefined ? {} : { "data-row-height": String(item.height) })}>
          <button type="button">{item.label}</button>
        </div>
      )}
      restoreKey={extras.restoreKey ?? "thread-a"}
      {...(extras.revealKey === undefined ? {} : { revealKey: extras.revealKey })}
      {...(extras.align === undefined ? {} : { align: extras.align })}
      {...(extras.trail === undefined ? {} : { trail: extras.trail })}
      {...(extras.lead === undefined ? {} : { lead: extras.lead })}
      {...(extras.pinnedKeys === undefined ? {} : { pinnedKeys: extras.pinnedKeys })}
      {...(extras.announceItem === undefined ? {} : { announceItem: extras.announceItem })}
    />,
  );
}

function scroller(): HTMLElement {
  const node = document.querySelector("[data-transcript-window]");
  if (!(node instanceof HTMLElement)) throw new Error("expected a transcript window");
  return node;
}

function list(): HTMLElement {
  const node = document.querySelector("[data-transcript-list]");
  if (!(node instanceof HTMLElement)) throw new Error("expected a transcript list");
  return node;
}

function liveRegion(): HTMLElement {
  const node = document.querySelector("[data-transcript-live]");
  if (!(node instanceof HTMLElement)) throw new Error("expected a transcript live region");
  return node;
}

function mountedCount(): number {
  return document.querySelectorAll("[data-transcript-row]").length;
}

function translateY(element: HTMLElement): number {
  const match = element.style.transform.match(/translateY\(([-\d.]+)px\)/);
  return match === null ? Number.NaN : Number(match[1]);
}

describe("TranscriptWindow", () => {
  it("mounts a bounded window of a 1000-row transcript", () => {
    renderWindow(rows(1000));

    expect(mountedCount()).toBeLessThan(80);
    expect(mountedCount()).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "Row 0" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Row 999" })).not.toBeInTheDocument();
  });

  it("does not yank the reader to new rows after they have scrolled away from the end", () => {
    function Harness() {
      const [items, setItems] = useState(() => rows(20));
      return (
        <div>
          <button
            onClick={() =>
              setItems((current) => [
                ...current,
                {
                  id: `extra-${String(current.length)}`,
                  label: `Row ${String(current.length)}`,
                },
              ])
            }
            type="button"
          >
            Append
          </button>
          <TranscriptWindow
            itemKey={(item) => item.id}
            items={items}
            listLabel="Transcript"
            renderItem={(item) => <button type="button">{item.label}</button>}
            restoreKey="follow"
          />
        </div>
      );
    }

    render(<Harness />);
    expect(screen.getByRole("button", { name: "Row 0" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Append" }));
    expect(screen.getByRole("button", { name: "Row 0" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Row 20" })).not.toBeInTheDocument();
  });

  it("restores the previous scroll offset when the same thread mounts again", async () => {
    const first = renderWindow(rows(100), { restoreKey: "restore" });
    const firstScroller = scroller();
    firstScroller.scrollTop = 640;
    fireEvent.scroll(firstScroller);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Row 8" })).toBeVisible();
    });
    first.unmount();

    renderWindow(rows(100), { restoreKey: "restore" });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Row 8" })).toBeVisible();
    });
    expect(screen.queryByRole("button", { name: "Row 99" })).not.toBeInTheDocument();
  });

  it("jumps to a named row that was outside the window", async () => {
    renderWindow(rows(1000), { revealKey: "row-500" });

    expect(await screen.findByRole("button", { name: "Row 500" })).toBeVisible();
  });

  it("does not re-center an already revealed row after later renders", async () => {
    function Harness() {
      const [tick, setTick] = useState(0);
      return (
        <div>
          <button onClick={() => setTick((current) => current + 1)} type="button">
            Rerender {String(tick)}
          </button>
          <TranscriptWindow
            itemKey={(item) => item.id}
            items={rows(100)}
            listLabel="Transcript"
            renderItem={(item) => <button type="button">{item.label}</button>}
            restoreKey="reveal-once"
            revealKey="row-50"
          />
        </div>
      );
    }

    render(<Harness />);
    expect(await screen.findByRole("button", { name: "Row 50" })).toBeVisible();
    const windowNode = scroller();
    windowNode.scrollTop = 0;
    fireEvent.scroll(windowNode);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Row 0" })).toBeVisible();
    });
    fireEvent.click(screen.getByRole("button", { name: /Rerender/ }));
    expect(screen.getByRole("button", { name: "Row 0" })).toBeVisible();
  });

  it("mounts off-window rows so in-page find can read them", async () => {
    renderWindow(rows(1000));
    expect(screen.queryByRole("button", { name: "Row 500" })).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "f", metaKey: true });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Row 500" })).toBeInTheDocument();
    });
    expect(mountedCount()).toBe(1000);
  });

  it("collapses the expanded find range when find is dismissed without Escape", async () => {
    renderWindow(rows(1000));
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    await waitFor(() => {
      expect(mountedCount()).toBe(1000);
    });

    window.dispatchEvent(new Event(TRANSCRIPT_FIND_CLOSED_EVENT));

    await waitFor(() => {
      expect(mountedCount()).toBeLessThan(80);
    });
  });

  it("places rows of differing heights without overlapping", () => {
    const items: ReadonlyArray<Row> = [
      { id: "short", label: "Short", height: 40 },
      { id: "tall", label: "Tall", height: 200 },
      { id: "mid", label: "Mid", height: 80 },
    ];
    renderWindow(items, { restoreKey: "heights" });

    const mounted = [...document.querySelectorAll<HTMLElement>("[data-transcript-row]")];
    expect(mounted.length).toBe(3);
    const starts = mounted.map(translateY);
    expect(starts[0]).toBeLessThan(starts[1]!);
    expect(starts[1]).toBeLessThan(starts[2]!);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(40);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(200);
  });

  it("lets keyboard traversal reach a row once that row is in the window", async () => {
    renderWindow(rows(1000), { revealKey: "row-500" });

    const row = await screen.findByRole("button", { name: "Row 500" });
    row.focus();
    expect(document.activeElement).toHaveTextContent("Row 500");
  });

  it("mounts the next row when tab moves past the last mounted control", async () => {
    renderWindow(rows(1000));
    const mountedButtons = screen.getAllByRole("button");
    const last = mountedButtons[mountedButtons.length - 1];
    if (last === undefined) throw new Error("expected a mounted row");
    last.focus();
    fireEvent.keyDown(last, { key: "Tab" });

    await waitFor(() => {
      expect(document.activeElement).not.toBe(last);
    });
    expect(document.activeElement).toHaveAttribute("type", "button");
  });

  it("keeps a pinned interacting row mounted after it leaves the window", async () => {
    renderWindow(rows(1000), { pinnedKeys: ["row-0"] });
    const first = screen.getByRole("button", { name: "Row 0" });
    scroller().scrollTop = 4000;
    fireEvent.scroll(scroller());
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Row 50" })).toBeVisible();
    });
    expect(first).toBeInTheDocument();
  });

  it("does not announce recycled history through the live region", async () => {
    renderWindow(rows(1000), { announceItem: (item) => item.label });
    expect(liveRegion()).toHaveTextContent("");
    scroller().scrollTop = 640;
    fireEvent.scroll(scroller());
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Row 8" })).toBeVisible();
    });
    expect(liveRegion()).toHaveTextContent("");
  });

  it("announces a row appended at the end", () => {
    function Harness() {
      const [items, setItems] = useState(() => rows(4));
      return (
        <div>
          <button
            onClick={() =>
              setItems((current) => [
                ...current,
                { id: `row-${String(current.length)}`, label: `Row ${String(current.length)}` },
              ])
            }
            type="button"
          >
            Append
          </button>
          <TranscriptWindow
            announceItem={(item) => item.label}
            itemKey={(item) => item.id}
            items={items}
            listLabel="Transcript"
            renderItem={(item) => <button type="button">{item.label}</button>}
            restoreKey="announce"
          />
        </div>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Append" }));
    expect(liveRegion()).toHaveTextContent("Row 4");
  });

  it("lets the caller constrain the list width", () => {
    renderWindow(rows(3));
    expect(list().style.width).toBe("");
  });

  it("includes trailing content in the scroll extent", () => {
    renderWindow(rows(3), {
      restoreKey: "trail",
      trail: <div data-row-height="80">Waiting receipt</div>,
    });
    expect(screen.getByText("Waiting receipt")).toBeInTheDocument();
    expect(scroller().scrollHeight).toBeGreaterThan(Number.parseFloat(list().style.height));
  });

  it("leaves a start-aligned transcript at the top on first mount", () => {
    renderWindow(rows(100), { align: "start", restoreKey: "code" });
    expect(screen.getByRole("button", { name: "Row 0" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Row 99" })).not.toBeInTheDocument();
  });

  it("recalculates row offset when lead content appears", async () => {
    function Harness() {
      const [showLead, setShowLead] = useState(false);
      return (
        <div>
          <button onClick={() => setShowLead(true)} type="button">
            Show lead
          </button>
          <TranscriptWindow
            itemKey={(item) => item.id}
            items={rows(3, 80)}
            lead={showLead ? <div data-row-height="80">Disconnected</div> : null}
            listLabel="Transcript"
            renderItem={(item) => (
              <div data-row-height="80">
                <button type="button">{item.label}</button>
              </div>
            )}
            restoreKey="lead"
          />
        </div>
      );
    }

    render(<Harness />);
    expect(scroller()).toHaveAttribute("data-transcript-scroll-margin", "0");
    fireEvent.click(screen.getByRole("button", { name: "Show lead" }));
    await waitFor(() => {
      expect(screen.getByText("Disconnected")).toBeInTheDocument();
      expect(scroller()).toHaveAttribute("data-transcript-scroll-margin", "80");
    });
  });

  it("evicts old thread snapshots once the session cache is full", async () => {
    const first = renderWindow(rows(100), { restoreKey: "old-thread" });
    const firstScroller = scroller();
    firstScroller.scrollTop = 4000;
    fireEvent.scroll(firstScroller);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Row 50" })).toBeVisible();
    });
    first.unmount();

    for (let index = 0; index < 20; index += 1) {
      renderWindow(rows(2), { restoreKey: `other-${String(index)}` }).unmount();
    }

    renderWindow(rows(100), { restoreKey: "old-thread" });
    expect(screen.queryByRole("button", { name: "Row 50" })).not.toBeInTheDocument();
  });

  it("follows the new end when a following snapshot is restored onto a grown thread", async () => {
    const first = renderWindow(rows(8), { restoreKey: "grown" });
    first.unmount();
    renderWindow(rows(40), { restoreKey: "grown" });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Row 0" })).toBeInTheDocument();
    });
    expect(scroller().scrollTop).toBeGreaterThanOrEqual(0);
  });
});
