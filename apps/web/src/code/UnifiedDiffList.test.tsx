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
    });
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
  Object.defineProperty(scroller, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(0, 0, 720, height),
  });
  document.body.append(scroller);
  return {
    scroller,
    cleanup: () => {
      scroller.remove();
    },
  };
}
