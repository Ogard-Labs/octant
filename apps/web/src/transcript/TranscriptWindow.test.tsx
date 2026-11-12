import { WorkspaceViewStateContext, type WorkspaceViewStore } from "../shell/workspaceViewState";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect, useState, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { TranscriptWindow } from "./TranscriptWindow";

// Indexing a 1,000-row history takes about 3 s on a loaded laptop and went past
// 5 s on merge-queue runners, failing tests that only check Find completes.
// Stay under the package's 15 s test timeout.
const FIND_INDEXED_WITHIN_MS = 12_000;

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

  it("restores a persisted reading position after the first page arrives without following new output", async () => {
    let width = 0;
    const store: WorkspaceViewStore = {
      read: () => ({ kind: "transcript", offset: 640, following: false, firstKey: "row-0", width }),
      write: vi.fn(),
    };
    function Example() {
      const [loaded, setLoaded] = useState(false);
      return (
        <WorkspaceViewStateContext.Provider value={store}>
          <button onClick={() => setLoaded(true)}>Load kept transcript</button>
          <TranscriptWindow
            items={loaded ? rows(100) : []}
            itemKey={(item) => item.id}
            renderItem={(item) => <button>{item.label}</button>}
            restoreKey="persisted-async"
          />
        </WorkspaceViewStateContext.Provider>
      );
    }
    render(<Example />);
    width = scroller().clientWidth;
    fireEvent.click(screen.getByRole("button", { name: "Load kept transcript" }));
    await waitFor(() => expect(scroller().scrollTop).toBe(640));
    fireEvent.scroll(scroller());
    // The DOM offset can settle before the virtualizer commits its React range.
    await waitFor(() => {
      expect(scroller().scrollTop).toBe(640);
      expect(screen.getByRole("button", { name: "Row 8" })).toBeVisible();
      expect(screen.queryByRole("button", { name: "Row 99" })).not.toBeInTheDocument();
    });
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

  describe("a one-time jump target", () => {
    function jump(revealKey: string | undefined, onRevealed: (key: string) => void) {
      return (
        <TranscriptWindow
          itemKey={(item: Row) => item.id}
          items={rows(1000)}
          listLabel="Transcript"
          onRevealed={onRevealed}
          renderItem={(item) => <button type="button">{item.label}</button>}
          restoreKey="jump-target"
          {...(revealKey === undefined ? {} : { revealKey })}
        />
      );
    }

    it("reveals the same row again when it is asked for again after being dropped", async () => {
      const onRevealed = vi.fn();
      const { rerender } = render(jump("row-500", onRevealed));
      expect(await screen.findByRole("button", { name: "Row 500" })).toBeVisible();
      await waitFor(() => expect(onRevealed).toHaveBeenCalledOnce());

      // The owner drops the spent target and the reader scrolls away.
      rerender(jump(undefined, onRevealed));
      scroller().scrollTop = 0;
      fireEvent.scroll(scroller());
      await waitFor(() => {
        expect(screen.queryByRole("button", { name: "Row 500" })).not.toBeInTheDocument();
      });

      // The same search hit is chosen again.
      rerender(jump("row-500", onRevealed));
      expect(await screen.findByRole("button", { name: "Row 500" })).toBeVisible();
      await waitFor(() => expect(onRevealed).toHaveBeenCalledTimes(2));
    });

    it("spends the target when the list goes away while the reveal settles", async () => {
      const onRevealed = vi.fn();
      const { unmount } = render(jump("row-500", onRevealed));
      expect(onRevealed).not.toHaveBeenCalled();

      unmount();

      await waitFor(() => expect(onRevealed).toHaveBeenCalledWith("row-500"));
    });

    it("does not spend the target while the frame has no size yet", async () => {
      const onRevealed = vi.fn();
      const height = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(0);
      try {
        render(jump("row-500", onRevealed));
        await new Promise((resolve) => setTimeout(resolve, 1_700));
        expect(onRevealed).not.toHaveBeenCalled();
      } finally {
        height.mockRestore();
      }
    });
  });

  it("keeps a long transcript windowed when Find opens and while it searches", async () => {
    renderWindow(rows(1000));
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    const input = await screen.findByRole("textbox", { name: "Find in thread" });
    expect(mountedCount()).toBeLessThan(80);
    fireEvent.change(input, { target: { value: "Row 500" } });
    expect(mountedCount()).toBeLessThan(80);
    expect(
      await screen.findByText("1 of 1", {}, { timeout: FIND_INDEXED_WITHIN_MS }),
    ).toBeInTheDocument();
    expect(mountedCount()).toBeLessThan(80);
    expect(screen.getByRole("button", { name: "Row 500" })).toBeInTheDocument();
  });

  it("cancels an unfinished search when Find closes", async () => {
    renderWindow(rows(10000));
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = await screen.findByRole("textbox", { name: "Find in thread" });
    fireEvent.change(input, { target: { value: "Row 500" } });
    expect(screen.getByText("Searching…")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Escape" });
    await waitFor(() => expect(mountedCount()).toBeLessThan(32));
    expect(screen.queryByRole("textbox", { name: "Find in thread" })).not.toBeInTheDocument();
  });

  it("finishes indexing while streamed rows continue to refresh", async () => {
    function StreamingThread() {
      const [items, setItems] = useState(() => rows(1000));
      useEffect(() => {
        const timer = setInterval(
          () => setItems((current) => current.map((item) => ({ ...item }))),
          20,
        );
        return () => clearInterval(timer);
      }, []);
      return (
        <TranscriptWindow
          items={items}
          itemKey={(item) => item.id}
          renderItem={(item) => <button type="button">{item.label}</button>}
          restoreKey="streaming-find"
        />
      );
    }
    render(<StreamingThread />);
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = await screen.findByRole("textbox", { name: "Find in thread" });
    fireEvent.change(input, { target: { value: "Row 500" } });
    expect(
      await screen.findByText("1 of 1", {}, { timeout: FIND_INDEXED_WITHIN_MS }),
    ).toBeInTheDocument();
    expect(mountedCount()).toBeLessThan(80);
  });

  it("reuses indexed text for a new query without mounting the history again", async () => {
    renderWindow(rows(1000));
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = await screen.findByRole("textbox", { name: "Find in thread" });
    fireEvent.change(input, { target: { value: "Row 500" } });
    expect(
      await screen.findByText("1 of 1", {}, { timeout: FIND_INDEXED_WITHIN_MS }),
    ).toBeInTheDocument();
    fireEvent.change(input, { target: { value: "Row 600" } });
    expect(screen.queryByText("Searching…")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Row 600" })).toBeInTheDocument();
    expect(mountedCount()).toBeLessThan(80);
  });

  it("opens a find bar that counts matches across rows that were off-window", async () => {
    renderWindow(rows(1000));
    fireEvent.keyDown(window, { key: "f", metaKey: true });

    const input = await screen.findByRole("textbox", { name: "Find in thread" });
    fireEvent.change(input, { target: { value: "row 5" } });

    // Row 5, 50-59, 500-599.
    expect(
      await screen.findByText("1 of 111", {}, { timeout: FIND_INDEXED_WITHIN_MS }),
    ).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("2 of 111")).toBeInTheDocument();
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    fireEvent.keyDown(input, { key: "Enter", shiftKey: true });
    expect(screen.getByText("111 of 111")).toBeInTheDocument();
  });

  it("says when nothing matches and keeps rows windowed on close", async () => {
    renderWindow(rows(1000));
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    const input = await screen.findByRole("textbox", { name: "Find in thread" });
    fireEvent.change(input, { target: { value: "no such text" } });
    expect(
      await screen.findByText("No matches", {}, { timeout: FIND_INDEXED_WITHIN_MS }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(mountedCount()).toBeLessThan(80);
    });

    fireEvent.keyDown(input, { key: "Escape" });

    await waitFor(() => {
      expect(mountedCount()).toBeLessThan(80);
    });
    expect(screen.queryByRole("textbox", { name: "Find in thread" })).not.toBeInTheDocument();
  });

  it("opens the find bar from a composer that sits outside the transcript's column", async () => {
    render(
      <section aria-label="Thread workspace">
        <div>
          <TranscriptWindow
            itemKey={(item: Row) => item.id}
            items={rows(10)}
            listLabel="Transcript"
            renderItem={(item: Row) => <button type="button">{item.label}</button>}
            restoreKey="thread-a"
          />
        </div>
        <textarea aria-label="Message" />
      </section>,
    );

    fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), {
      key: "f",
      metaKey: true,
    });

    expect(await screen.findByRole("textbox", { name: "Find in thread" })).toBeInTheDocument();
  });

  it("finds a phrase that spans inline formatting but not a block boundary", async () => {
    const items: ReadonlyArray<Row> = [{ id: "a", label: "x" }];
    render(
      <TranscriptWindow
        itemKey={(item: Row) => item.id}
        items={items}
        listLabel="Transcript"
        renderItem={() => (
          <div>
            <p>
              The <strong>plan</strong> is ready
            </p>
            <p>Second</p>
          </div>
        )}
        restoreKey="thread-a"
      />,
    );
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    const input = await screen.findByRole("textbox", { name: "Find in thread" });

    fireEvent.change(input, { target: { value: "the plan is" } });
    expect(
      await screen.findByText("1 of 1", {}, { timeout: FIND_INDEXED_WITHIN_MS }),
    ).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "readysecond" } });
    expect(
      await screen.findByText("No matches", {}, { timeout: FIND_INDEXED_WITHIN_MS }),
    ).toBeInTheDocument();
  });

  it("refreshes matches when a disclosure opens or closes", async () => {
    render(
      <TranscriptWindow
        items={rows(1)}
        itemKey={(item) => item.id}
        restoreKey="disclosure-find"
        renderItem={() => (
          <details>
            <summary>Thinking</summary>
            <p>Hidden phrase</p>
          </details>
        )}
      />,
    );
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = await screen.findByRole("textbox", { name: "Find in thread" });
    fireEvent.change(input, { target: { value: "hidden phrase" } });
    expect(
      await screen.findByText("No matches", {}, { timeout: FIND_INDEXED_WITHIN_MS }),
    ).toBeInTheDocument();
    const disclosure = screen.getByText("Thinking").closest("details");
    if (disclosure === null) throw new Error("expected disclosure");
    disclosure.open = true;
    fireEvent(disclosure, new Event("toggle"));
    expect(await screen.findByText("1 of 1")).toBeInTheDocument();
    disclosure.open = false;
    fireEvent(disclosure, new Event("toggle"));
    expect(await screen.findByText("No matches")).toBeInTheDocument();
  });

  it("reveals the only match again when navigation wraps to the same index", async () => {
    renderWindow(rows(1));
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = await screen.findByRole("textbox", { name: "Find in thread" });
    fireEvent.change(input, { target: { value: "Row 0" } });
    expect(await screen.findByText("1 of 1")).toBeInTheDocument();
    const reveal = vi.fn();
    screen.getByRole("button", { name: "Row 0" }).scrollIntoView = reveal;
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(reveal).toHaveBeenCalled());
  });

  it("keeps a manually opened disclosure mounted until it closes", async () => {
    render(
      <TranscriptWindow
        items={rows(1000)}
        itemKey={(item) => item.id}
        align="start"
        restoreKey="manual-disclosure"
        renderItem={(item) => (
          <details>
            <summary>{item.label}</summary>
            <p>Visible detail</p>
          </details>
        )}
      />,
    );
    const disclosure = screen.getByText("Row 0").closest("details");
    if (disclosure === null) throw new Error("expected disclosure");
    disclosure.open = true;
    fireEvent(disclosure, new Event("toggle"));
    scroller().scrollTop = 40000;
    fireEvent.scroll(scroller());
    await waitFor(() =>
      expect(
        [...document.querySelectorAll<HTMLElement>("[data-transcript-row]")].some(
          (row) => Number(row.dataset.index) > 100,
        ),
      ).toBe(true),
    );
    expect(screen.getByText("Row 0")).toBeInTheDocument();
    disclosure.open = false;
    fireEvent(disclosure, new Event("toggle"));
    await waitFor(() => expect(screen.queryByText("Row 0")).not.toBeInTheDocument());
  });

  it("releases indexing rows whose disclosures start open", async () => {
    render(
      <TranscriptWindow
        items={rows(1000)}
        itemKey={(item) => item.id}
        restoreKey="open-details-find"
        renderItem={(item) => (
          <details open>
            <summary>{item.label}</summary>
            <p>Visible detail {item.id}.</p>
          </details>
        )}
      />,
    );
    fireEvent.keyDown(window, { key: "f", ctrlKey: true });
    const input = await screen.findByRole("textbox", { name: "Find in thread" });
    fireEvent.change(input, { target: { value: "detail row-500." } });
    expect(
      await screen.findByText("1 of 1", {}, { timeout: FIND_INDEXED_WITHIN_MS }),
    ).toBeInTheDocument();
    expect(mountedCount()).toBeLessThan(80);
  });

  it("leaves Cmd-F to the code editor and terminal", () => {
    renderWindow(rows(10));
    const editor = document.createElement("div");
    editor.className = "monaco-editor";
    document.body.append(editor);
    fireEvent.keyDown(editor, { key: "f", metaKey: true });
    editor.remove();
    expect(screen.queryByRole("textbox", { name: "Find in thread" })).not.toBeInTheDocument();
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

  it("does not announce an older row that a removed last row exposes", () => {
    function Harness() {
      const [items, setItems] = useState(() => rows(5));
      return (
        <div>
          <button onClick={() => setItems((current) => current.slice(0, -1))} type="button">
            Remove last
          </button>
          <TranscriptWindow
            announceItem={(item) => item.label}
            itemKey={(item) => item.id}
            items={items}
            listLabel="Transcript"
            renderItem={(item) => <button type="button">{item.label}</button>}
            restoreKey="remove-last"
          />
        </div>
      );
    }

    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Remove last" }));
    expect(liveRegion()).toBeEmptyDOMElement();
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

  describe("when earlier rows are added above", () => {
    function rowsFrom(first: number, count: number): ReadonlyArray<Row> {
      return Array.from({ length: count }, (_, offset) => ({
        id: `row-${String(first + offset)}`,
        label: `Row ${String(first + offset)}`,
      }));
    }

    function PrependHarness(props: { readonly onAnnounce?: (item: Row) => string }) {
      const [items, setItems] = useState(() => rowsFrom(100, 100));
      return (
        <div>
          <button
            onClick={() => setItems((current) => [...rowsFrom(70, 30), ...current])}
            type="button"
          >
            Load earlier
          </button>
          <TranscriptWindow
            {...(props.onAnnounce === undefined ? {} : { announceItem: props.onAnnounce })}
            estimateSize={80}
            itemKey={(item) => item.id}
            items={items}
            listLabel="Transcript"
            renderItem={(item) => <button type="button">{item.label}</button>}
            restoreKey="prepend"
          />
        </div>
      );
    }

    function rowTop(label: string): number {
      const row = screen.getByRole("button", { name: label }).closest("[data-transcript-row]");
      if (!(row instanceof HTMLElement)) throw new Error(`expected a row for ${label}`);
      return translateY(row) - scroller().scrollTop;
    }

    it("keeps the row the reader was on in place", async () => {
      render(<PrependHarness />);
      scroller().scrollTop = 800;
      fireEvent.scroll(scroller());
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Row 110" })).toBeInTheDocument();
      });
      const before = rowTop("Row 110");

      fireEvent.click(screen.getByRole("button", { name: "Load earlier" }));

      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Row 110" })).toBeInTheDocument();
      });
      expect(rowTop("Row 110")).toBe(before);
      expect(screen.queryByRole("button", { name: "Row 70" })).not.toBeInTheDocument();
    });

    it("does not announce them as a new message", async () => {
      render(<PrependHarness onAnnounce={(item) => item.label} />);
      scroller().scrollTop = 800;
      fireEvent.scroll(scroller());

      fireEvent.click(screen.getByRole("button", { name: "Load earlier" }));

      await waitFor(() => {
        expect(list().style.height).toBe(`${String(130 * 80)}px`);
      });
      expect(liveRegion()).toBeEmptyDOMElement();
    });
  });

  it("opens at the end when the remembered rows are no longer the first rows", async () => {
    const first = renderWindow(rows(100), { restoreKey: "reopened" });
    scroller().scrollTop = 640;
    fireEvent.scroll(scroller());
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Row 8" })).toBeVisible();
    });
    first.unmount();

    // The thread reopens on its newest page: the rows the offset was measured
    // against are gone from the top, so the offset no longer means anything.
    renderWindow(rows(130).slice(30), { restoreKey: "reopened" });

    // 100 rows of 80px: the end is past 7000px, the remembered offset was 640.
    await waitFor(() => {
      expect(scroller().scrollTop).toBeGreaterThan(7000);
    });
  });
});
