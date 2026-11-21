import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { UnifiedDiffList } from "./UnifiedDiffList";
import { parseUnifiedDiff } from "./unifiedDiff";

describe("UnifiedDiffList", () => {
  it("renders small diffs directly with headers, gaps, and line actions", () => {
    const onOpenFile = vi.fn();
    const onSelectLine = vi.fn();
    const files = parseUnifiedDiff(
      [
        "diff --git a/src/example.ts b/src/example.ts",
        "--- a/src/example.ts",
        "+++ b/src/example.ts",
        "@@ -1,1 +1,1 @@",
        "-const oldOne = 1;",
        "+const newOne = 1;",
        "@@ -10,1 +10,1 @@",
        "-const oldTwo = 2;",
        "+const newTwo = 2;",
        "",
      ].join("\n"),
    );

    render(<UnifiedDiffList files={files} onOpenFile={onOpenFile} onSelectLine={onSelectLine} />);

    expect(screen.getByRole("region", { name: "src/example.ts" })).toBeVisible();
    expect(screen.getByText("8 unchanged lines")).toBeVisible();
    screen.getByRole("button", { name: "Open" }).click();
    expect(onOpenFile).toHaveBeenCalledWith("src/example.ts");

    screen.getByRole("button", { name: "Comment on src/example.ts modified line 10" }).click();
    expect(onSelectLine).toHaveBeenCalledWith({
      path: "src/example.ts",
      side: "modified",
      line: 10,
      text: "const newTwo = 2;",
    });
  });

  it("keeps a line number's button from setting the row's height", () => {
    const files = parseUnifiedDiff(
      [
        "diff --git a/a.ts b/a.ts",
        "--- a/a.ts",
        "+++ b/a.ts",
        "@@ -1,1 +1,1 @@",
        "-a",
        "+b",
        "",
      ].join("\n"),
    );
    render(<UnifiedDiffList files={files} onSelectLine={vi.fn()} />);
    const number = screen.getByRole("button", { name: "Comment on a.ts modified line 1" });
    expect(number).toHaveClass("h-auto");
  });

  it("renders non-selectable end-of-file newline notices in position so adding and removing a final newline stay distinct", () => {
    const onSelectLine = vi.fn();
    const files = parseUnifiedDiff(
      [
        "diff --git a/add-eof.txt b/add-eof.txt",
        "--- a/add-eof.txt",
        "+++ b/add-eof.txt",
        "@@ -1 +1 @@",
        "-hello",
        "\\ No newline at end of file",
        "+hello",
        "diff --git a/remove-eof.txt b/remove-eof.txt",
        "--- a/remove-eof.txt",
        "+++ b/remove-eof.txt",
        "@@ -1 +1 @@",
        "-hello",
        "+hello",
        "\\ No newline at end of file",
      ].join("\n"),
    );

    render(<UnifiedDiffList files={files} onSelectLine={onSelectLine} />);

    const addedSection = screen.getByRole("region", { name: "add-eof.txt" });
    const addedRows = Array.from(addedSection.querySelectorAll("tbody tr"));
    expect(addedRows.map((row) => row.className)).toEqual([
      "unified-diff__line",
      "unified-diff__meta",
      "unified-diff__line",
    ]);
    expect(addedRows[1]).toHaveTextContent("No newline at end of file");
    expect(addedRows[1]?.getAttribute("data-kind")).toBe("removed");
    expect(within(addedRows[1] as HTMLElement).queryByRole("button")).not.toBeInTheDocument();

    const removedSection = screen.getByRole("region", { name: "remove-eof.txt" });
    const removedRows = Array.from(removedSection.querySelectorAll("tbody tr"));
    expect(removedRows.map((row) => row.className)).toEqual([
      "unified-diff__line",
      "unified-diff__line",
      "unified-diff__meta",
    ]);
    expect(removedRows[2]).toHaveTextContent("No newline at end of file");
    expect(removedRows[2]?.getAttribute("data-kind")).toBe("added");
    fireEvent.click(removedRows[2] as HTMLElement);
    expect(onSelectLine).not.toHaveBeenCalled();
  });

  it("renders creation and deletion mode badges and honest empty-file copy without hiding binary additions", () => {
    const files = parseUnifiedDiff(
      [
        "diff --git a/scripts/empty.sh b/scripts/empty.sh",
        "new file mode 100755",
        "index 0000000..e69de29",
        "diff --git a/obsolete.txt b/obsolete.txt",
        "deleted file mode 100644",
        "index e69de29..0000000",
        "diff --git a/scripts/start.sh b/scripts/start.sh",
        "new file mode 100755",
        "index 0000000..abcdef1",
        "--- /dev/null",
        "+++ b/scripts/start.sh",
        "@@ -0,0 +1 @@",
        "+#!/bin/sh",
        "diff --git a/assets/new.png b/assets/new.png",
        "new file mode 100644",
        "index 0000000..1234567",
        "Binary files /dev/null and b/assets/new.png differ",
      ].join("\n"),
    );

    render(<UnifiedDiffList files={files} onOpenFile={vi.fn()} />);

    const emptyAdded = screen.getByRole("region", { name: "scripts/empty.sh" });
    expect(within(emptyAdded).getByText("new mode 100755")).toBeVisible();
    expect(within(emptyAdded).getByText("added")).toBeVisible();
    expect(within(emptyAdded).getByText("Empty file added.")).toBeVisible();

    const emptyDeleted = screen.getByRole("region", { name: "obsolete.txt" });
    expect(within(emptyDeleted).getByText("deleted mode 100644")).toBeVisible();
    expect(within(emptyDeleted).getByText("deleted")).toBeVisible();
    expect(within(emptyDeleted).getByText("Empty file deleted.")).toBeVisible();
    expect(within(emptyDeleted).queryByRole("button", { name: "Open" })).not.toBeInTheDocument();

    const executableAdded = screen.getByRole("region", { name: "scripts/start.sh" });
    expect(within(executableAdded).getByText("new mode 100755")).toBeVisible();
    expect(within(executableAdded).getByText("added")).toBeVisible();
    expect(within(executableAdded).getByText("#!/bin/sh")).toBeVisible();

    const binaryAdded = screen.getByRole("region", { name: "assets/new.png" });
    expect(within(binaryAdded).getByText("new mode 100644")).toBeVisible();
    expect(within(binaryAdded).getByText("added")).toBeVisible();
    expect(
      within(binaryAdded).getByText(
        "This file changed without a textual diff, so there is nothing to compare.",
      ),
    ).toBeVisible();
  });

  it("renders deleted mode and empty deleted copy for an empty deleted file whose path contains spaces", () => {
    const files = parseUnifiedDiff(
      [
        "diff --git a/my file.txt b/my file.txt",
        "deleted file mode 100644",
        "index e69de29..0000000",
      ].join("\n"),
    );

    render(<UnifiedDiffList files={files} onOpenFile={vi.fn()} />);

    const deletedSection = screen.getByRole("region", { name: "my file.txt" });
    expect(within(deletedSection).getByText("deleted mode 100644")).toBeVisible();
    expect(within(deletedSection).queryByText(/new mode/i)).not.toBeInTheDocument();
    expect(within(deletedSection).getByText("deleted")).toBeVisible();
    expect(within(deletedSection).getByText("Empty file deleted.")).toBeVisible();
    expect(within(deletedSection).queryByRole("button", { name: "Open" })).not.toBeInTheDocument();
  });

  it("omits Open and Provider checkpoint buttons when a diff file has a non-UTF-8 path", () => {
    const files = parseUnifiedDiff(
      [
        'diff --git "a/file-\\303.txt" "b/file-\\303.txt"',
        '--- "a/file-\\303.txt"',
        '+++ "b/file-\\303.txt"',
        "@@ -1 +1 @@",
        "-a",
        "+b",
        'diff --git "a/file-\\357\\277\\275.txt" "b/file-\\357\\277\\275.txt"',
        '--- "a/file-\\357\\277\\275.txt"',
        '+++ "b/file-\\357\\277\\275.txt"',
        "@@ -1 +1 @@",
        "-c",
        "+d",
      ].join("\n"),
    );

    render(<UnifiedDiffList files={files} onOpenFile={vi.fn()} onReadProviderFile={vi.fn()} />);

    const invalidSection = screen.getByRole("region", { name: "file-\\303.txt" });
    expect(within(invalidSection).queryByRole("button", { name: "Open" })).not.toBeInTheDocument();
    expect(
      within(invalidSection).queryByRole("button", { name: "Provider checkpoint" }),
    ).not.toBeInTheDocument();

    const validSection = screen.getByRole("region", { name: "file-\uFFFD.txt" });
    expect(within(validSection).getByRole("button", { name: "Open" })).toBeVisible();
    expect(within(validSection).getByRole("button", { name: "Provider checkpoint" })).toBeVisible();
  });

  it("virtualizes large single-file diffs to bounded DOM rows while scrolling", () => {
    const lines = Array.from(
      { length: 600 },
      (_, index) => `+const line_${String(index)} = ${String(index)};`,
    );
    const files = parseUnifiedDiff(
      [
        "diff --git a/src/huge.ts b/src/huge.ts",
        "--- /dev/null",
        "+++ b/src/huge.ts",
        "@@ -0,0 +1,600 @@",
        ...lines,
        "",
      ].join("\n"),
    );

    const { scroller, cleanup } = createScrollContainer(400);
    try {
      render(<UnifiedDiffList files={files} />, { container: scroller });

      const initialRows = scroller.querySelectorAll("tr.unified-diff__line");
      expect(initialRows.length).toBeGreaterThan(0);
      expect(initialRows.length).toBeLessThan(80);
      expect(screen.getByRole("region", { name: "src/huge.ts" })).toBeVisible();
      expect(screen.getByText("const line_0 = 0;")).toBeVisible();
      expect(screen.queryByText("const line_599 = 599;")).not.toBeInTheDocument();

      scroller.scrollTop = 6_000;
      fireEvent.scroll(scroller);

      const scrolledRows = scroller.querySelectorAll("tr.unified-diff__line");
      expect(scrolledRows.length).toBeGreaterThan(0);
      expect(scrolledRows.length).toBeLessThan(80);
      expect(screen.getByRole("region", { name: "src/huge.ts" })).toBeVisible();
      expect(screen.queryByText("const line_0 = 0;")).not.toBeInTheDocument();
    } finally {
      cleanup();
    }
  });

  it("virtualizes multi-file diffs so only visible file sections mount", () => {
    const raw = Array.from({ length: 50 }, (_, fileIndex) => {
      const prefix = `src/file-${String(fileIndex).padStart(2, "0")}.ts`;
      const chunkLines = Array.from(
        { length: 10 },
        (_, lineIndex) =>
          `+export const v_${String(fileIndex)}_${String(lineIndex)} = ${String(lineIndex)};`,
      );
      return [
        `diff --git a/${prefix} b/${prefix}`,
        "--- /dev/null",
        `+++ b/${prefix}`,
        "@@ -0,0 +1,10 @@",
        ...chunkLines,
      ].join("\n");
    }).join("\n");
    const files = parseUnifiedDiff(`${raw}\n`);

    const { scroller, cleanup } = createScrollContainer(400);
    try {
      render(<UnifiedDiffList files={files} />, { container: scroller });

      const renderedSections = within(scroller).getAllByRole("region");
      expect(renderedSections.length).toBeGreaterThan(0);
      expect(renderedSections.length).toBeLessThan(15);
      expect(screen.queryByRole("region", { name: "src/file-49.ts" })).not.toBeInTheDocument();
    } finally {
      cleanup();
    }
  });

  it("aligns requestedFile jumps across measured headers, binary notices, and inter-file gaps", async () => {
    const raw = Array.from({ length: 35 }, (_, fileIndex) => {
      const prefix = `src/file-${String(fileIndex).padStart(2, "0")}.ts`;
      if (fileIndex === 2) {
        return [
          `diff --git a/${prefix} b/${prefix}`,
          `Binary files a/${prefix} and b/${prefix} differ`,
        ].join("\n");
      }
      const chunkLines = Array.from(
        { length: 4 },
        (_, lineIndex) =>
          `+export const v_${String(fileIndex)}_${String(lineIndex)} = ${String(lineIndex)};`,
      );
      return [
        `diff --git a/${prefix} b/${prefix}`,
        "--- /dev/null",
        `+++ b/${prefix}`,
        "@@ -0,0 +1,4 @@",
        ...chunkLines,
      ].join("\n");
    }).join("\n");
    const files = parseUnifiedDiff(`${raw}\n`);

    const offsetHeightDescriptor = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "offsetHeight",
    );
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() {
        if (this instanceof HTMLElement) {
          if (this.classList.contains("unified-diff__file-header")) return 50;
          if (this.classList.contains("unified-diff__binary")) return 40;
          if (this.classList.contains("unified-diff__file-gap")) return 16;
          if (this.classList.contains("unified-diff__line")) return 22;
        }
        return offsetHeightDescriptor?.get?.call(this) ?? 0;
      },
    });

    const { scroller, cleanup } = createScrollContainer(400);
    try {
      const { rerender } = render(<UnifiedDiffList files={files} />, { container: scroller });

      const binaryNotice = scroller.querySelector<HTMLElement>("p.unified-diff__binary");
      expect(binaryNotice?.dataset.index).toBeDefined();
      const firstHeader = scroller.querySelector<HTMLElement>("header.unified-diff__file-header");
      expect(firstHeader?.dataset.index).toBeDefined();

      // Measure a couple of files by scrolling past the start before jumping
      // so the virtualizer holds non-estimate header, binary, and gap sizes.
      scroller.scrollTop = 260;
      fireEvent.scroll(scroller);

      rerender(<UnifiedDiffList files={files} requestedFile={{ path: "src/file-30.ts" }} />);
      fireEvent.scroll(scroller);
      // Allow scrollToIndex reconciliation frames after overscan elements report
      // their measured heights before verifying final scroll offset alignment.
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      fireEvent.scroll(scroller);
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
      fireEvent.scroll(scroller);

      const targetSection = screen.getByRole("region", { name: "src/file-30.ts" });
      expect(targetSection).toBeVisible();
      const targetGap = targetSection.previousElementSibling;
      expect(targetGap).toHaveClass("unified-diff__file-gap");
      expect((targetGap as HTMLElement | null)?.dataset.index).toBeDefined();

      // Sum heights of elements preceding file-30 inside the list container
      // (topSpacer plus any overscanned sections/gaps above file-30).
      const listContainer = scroller.querySelector<HTMLElement>(".unified-diff--virtualized");
      expect(listContainer).not.toBeNull();
      let measuredTopOfTarget = 0;
      for (const child of Array.from(listContainer?.children ?? [])) {
        if (child === targetSection) break;
        if (!(child instanceof HTMLElement)) continue;
        if (child.classList.contains("unified-diff__file-gap")) {
          measuredTopOfTarget += child.offsetHeight;
        } else if (child.getAttribute("aria-hidden") === "true") {
          measuredTopOfTarget += Number.parseFloat(child.style.height || "0");
        } else if (child.classList.contains("unified-diff__file")) {
          const header = child.querySelector<HTMLElement>(".unified-diff__file-header");
          measuredTopOfTarget += (header?.offsetHeight ?? 0) + 2;
          for (const tr of child.querySelectorAll<HTMLElement>("tr")) {
            const spacer = tr.querySelector<HTMLElement>(".unified-diff__spacer");
            measuredTopOfTarget +=
              spacer !== null ? Number.parseFloat(spacer.style.height || "0") : tr.offsetHeight;
          }
        }
      }
      expect(measuredTopOfTarget).toBeGreaterThan(2_000);
      expect(Math.abs(scroller.scrollTop - measuredTopOfTarget)).toBeLessThanOrEqual(2);
    } finally {
      if (offsetHeightDescriptor === undefined) {
        Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
      } else {
        Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeightDescriptor);
      }
      cleanup();
    }
  });

  it("refreshes scrollMargin when a preceding collapsible details sibling toggles", async () => {
    const raw = Array.from({ length: 12 }, (_, fileIndex) => {
      const prefix = `src/mod-${String(fileIndex).padStart(2, "0")}.ts`;
      const chunkLines = Array.from(
        { length: 8 },
        (_, lineIndex) =>
          `+export const n_${String(fileIndex)}_${String(lineIndex)} = ${String(lineIndex)};`,
      );
      return [
        `diff --git a/${prefix} b/${prefix}`,
        "--- /dev/null",
        `+++ b/${prefix}`,
        "@@ -0,0 +1,8 @@",
        ...chunkLines,
      ].join("\n");
    }).join("\n");
    const files = parseUnifiedDiff(`${raw}\n`);

    const { scroller, cleanup } = createScrollContainer(400);
    let siblingExpanded = true;
    try {
      const { rerender } = render(
        <>
          <details data-testid="preceding-details" open>
            <summary>Changed summary</summary>
            <div>Details content</div>
          </details>
          <UnifiedDiffList files={files} />
        </>,
        { container: scroller },
      );

      const listEl = scroller.querySelector<HTMLElement>(".unified-diff--virtualized");
      expect(listEl).not.toBeNull();
      if (listEl !== null) {
        Object.defineProperty(listEl, "getBoundingClientRect", {
          configurable: true,
          value: () => new DOMRect(0, siblingExpanded ? 1_200 : 40, 720, 400),
        });
      }

      const details = screen.getByTestId("preceding-details");
      siblingExpanded = false;
      details.removeAttribute("open");
      await Promise.resolve();
      rerender(
        <>
          <details data-testid="preceding-details">
            <summary>Changed summary</summary>
            <div>Details content</div>
          </details>
          <UnifiedDiffList files={files} />
        </>,
      );

      scroller.scrollTop = 1_100;
      fireEvent.scroll(scroller);
      expect(screen.queryByRole("region", { name: "src/mod-00.ts" })).not.toBeInTheDocument();
      expect(screen.getByRole("region", { name: "src/mod-06.ts" })).toBeVisible();
    } finally {
      cleanup();
    }
  });
});

function createScrollContainer(height: number): {
  readonly scroller: HTMLDivElement;
  readonly cleanup: () => void;
} {
  const scroller = document.createElement("div");
  scroller.style.height = `${String(height)}px`;
  scroller.style.overflowY = "auto";
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: height });
  Object.defineProperty(scroller, "offsetHeight", { configurable: true, value: height });
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, value: 20_000 });
  Object.defineProperty(scroller, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(0, 0, 720, height),
  });
  Object.defineProperty(scroller, "scrollTo", {
    configurable: true,
    value: (options: ScrollToOptions | number, y?: number) => {
      scroller.scrollTop = typeof options === "number" ? (y ?? 0) : (options.top ?? 0);
    },
  });
  document.body.append(scroller);
  return {
    scroller,
    cleanup: () => {
      scroller.remove();
    },
  };
}
