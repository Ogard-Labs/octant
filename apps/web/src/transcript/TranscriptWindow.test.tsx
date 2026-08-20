import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { resetTranscriptScrollMemory, TranscriptWindow } from "./TranscriptWindow";

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
    />,
  );
}

function scroller(): HTMLElement {
  return document.querySelector("[data-transcript-window]")!;
}

function mountedCount(): number {
  return document.querySelectorAll("[data-transcript-row]").length;
}

function translateY(element: HTMLElement): number {
  const match = element.style.transform.match(/translateY\(([-\d.]+)px\)/);
  return match === null ? Number.NaN : Number(match[1]);
}

afterEach(() => {
  resetTranscriptScrollMemory();
});

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

  it("mounts off-window rows so in-page find can read them", async () => {
    renderWindow(rows(1000));
    expect(screen.queryByRole("button", { name: "Row 500" })).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: "f", metaKey: true });

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Row 500" })).toBeInTheDocument();
    });
    expect(mountedCount()).toBe(1000);
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
});
