import type { CodeFileMetadata } from "@octant/contracts/code";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CodeFileExplorer,
  MAX_CODE_FILE_EXPLORER_ENTRIES,
  type CodeFileExplorerEntry,
} from "./CodeFileExplorer";
import { DockBarContext, type DockBarItem } from "../shell/dockBarControls";

const codeStylesheet = readFileSync(resolve(import.meta.dirname, "../styles/code.css"), "utf8");
const dockStylesheet = readFileSync(resolve(import.meta.dirname, "../styles/dock.css"), "utf8");
const systemStylesheet = readFileSync(resolve(import.meta.dirname, "../styles/octant.css"), "utf8");

describe("CodeFileExplorer", () => {
  it("hands Refresh up to its tile's bar and keeps only the filter in its own row", async () => {
    const onRefresh = vi.fn();
    const handed: (ReadonlyArray<DockBarItem> | undefined)[] = [];
    render(
      <DockBarContext.Provider
        value={{ placement: "tiled", set: (_owner, items) => handed.push(items) }}
      >
        <CodeFileExplorer entries={entries()} onOpenFile={vi.fn()} onRefresh={onRefresh} />
      </DockBarContext.Provider>,
    );
    expect(screen.queryByRole("button", { name: "Refresh files" })).not.toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Filter files" })).toBeInTheDocument();
    const refresh = handed.at(-1)?.[0];
    expect(refresh).toMatchObject({ kind: "button", label: "Refresh files" });
    if (refresh?.kind === "button") refresh.onSelect();
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("renders authoritative relative paths and opens an available file from the keyboard", async () => {
    const onOpenFile = vi.fn();
    render(
      <CodeFileExplorer
        entries={entries()}
        onOpenFile={onOpenFile}
        selectedPath={"src/index.ts" as never}
      />,
    );

    const tree = screen.getByRole("tree", { name: "Repository files" });
    expect(within(tree).getByRole("treeitem", { name: "src" })).toHaveAttribute("aria-level", "1");
    const selected = within(tree).getByRole("treeitem", { name: /index.ts/ });
    expect(selected).toHaveAttribute("aria-selected", "true");
    await userEvent.setup().type(selected, "{enter}");
    expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ path: "src/index.ts" }));
    expect(tree).not.toHaveTextContent("/Users/");
  });

  it("keeps Refresh beside the filter in the one row when the tool stands alone", () => {
    const handed: (ReadonlyArray<DockBarItem> | undefined)[] = [];
    render(
      <DockBarContext.Provider
        value={{ placement: "alone", set: (_owner, items) => handed.push(items) }}
      >
        <CodeFileExplorer entries={entries()} onOpenFile={vi.fn()} onRefresh={vi.fn()} />
      </DockBarContext.Provider>,
    );
    expect(screen.getByRole("button", { name: "Refresh files" })).toBeInTheDocument();
    expect(handed.at(-1)).toEqual([]);
  });

  it("filters the bounded projection and labels binary, oversized, and unavailable files honestly", async () => {
    render(<CodeFileExplorer entries={entries()} onOpenFile={vi.fn()} />);

    await userEvent.setup().type(screen.getByRole("searchbox", { name: "Filter files" }), "asset");
    expect(screen.getByRole("treeitem", { name: /asset.bin/ })).toHaveTextContent(
      "Binary · read-only",
    );
    expect(screen.queryByRole("treeitem", { name: /index.ts/ })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter files" }), {
      target: { value: "large" },
    });
    expect(screen.getByRole("treeitem", { name: /large.log/ })).toHaveTextContent(
      "Oversized · read-only",
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter files" }), {
      target: { value: "missing" },
    });
    const unavailable = screen.getByRole("treeitem", { name: /missing.txt/ });
    expect(unavailable).toHaveTextContent("Unavailable");
    expect(unavailable).toBeDisabled();
  });

  it("caps oversized projections and reports that the visible tree is incomplete", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: MAX_CODE_FILE_EXPLORER_ENTRIES + 1 }, (_, index) =>
      file(`generated/file-${String(index).padStart(4, "0")}.txt`),
    );
    await withTreeViewportHeight(280, async () => {
      render(<CodeFileExplorer entries={many} onOpenFile={vi.fn()} />);

      expect(screen.getByRole("status")).toHaveTextContent(
        `Showing the first ${MAX_CODE_FILE_EXPLORER_ENTRIES.toLocaleString()}`,
      );
      const renderedRows = screen.getAllByRole("treeitem");
      expect(renderedRows.length).toBeGreaterThan(0);
      expect(renderedRows.length).toBeLessThan(50);

      renderedRows[0]?.focus();
      await user.keyboard("{End}");
      expect(screen.getByRole("treeitem", { name: /file-0999\.txt/ })).toHaveFocus();
      expect(screen.queryByRole("treeitem", { name: /file-1000\.txt/ })).not.toBeInTheDocument();
    });
  });

  it("virtualizes large trees to bounded DOM rows and navigates across offscreen rows", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 500 }, (_, index) =>
      file(`src/module-${String(index).padStart(3, "0")}.ts`),
    );
    await withTreeViewportHeight(280, async () => {
      render(<CodeFileExplorer entries={many} onOpenFile={vi.fn()} />);

      const initialRows = screen.getAllByRole("treeitem");
      expect(initialRows.length).toBeGreaterThan(0);
      expect(initialRows.length).toBeLessThan(50);
      expect(screen.queryByRole("treeitem", { name: /module-499\.ts/ })).not.toBeInTheDocument();

      initialRows[0]?.focus();
      await user.keyboard("{End}");
      expect(screen.getByRole("treeitem", { name: /module-499\.ts/ })).toHaveFocus();
      expect(screen.getAllByRole("treeitem").length).toBeLessThan(50);

      const tree = screen.getByRole("tree");
      expect(tree.firstElementChild).toHaveStyle({ height: `${String(500 * 28)}px` });
      tree.scrollTop = 500 * 28 - 280;
      fireEvent.scroll(tree);
      expect(screen.queryByRole("treeitem", { name: /module-000\.ts/ })).not.toBeInTheDocument();
    });
  });

  it("searches the complete authoritative projection before capping visible matches", async () => {
    const many = Array.from({ length: MAX_CODE_FILE_EXPLORER_ENTRIES }, (_, index) =>
      file(`generated/file-${String(index).padStart(4, "0")}.txt`),
    );
    const target = file("src/only-after-cap.ts");
    render(<CodeFileExplorer entries={[...many, target]} onOpenFile={vi.fn()} />);

    await userEvent
      .setup()
      .type(screen.getByRole("searchbox", { name: "Filter files" }), "only-after-cap");

    expect(screen.getByRole("treeitem", { name: /src\/only-after-cap\.ts/ })).toBeVisible();
  });

  it("names the folder for each file when two visible basenames match", () => {
    render(
      <CodeFileExplorer
        entries={[file("src/index.ts"), file("test/index.ts"), file("src/only.ts")]}
        onOpenFile={vi.fn()}
      />,
    );

    const source = screen.getByRole("treeitem", { name: "src/index.ts" });
    expect(within(source).getByText("src")).toBeVisible();
    const test = screen.getByRole("treeitem", { name: "test/index.ts" });
    expect(within(test).getByText("test")).toBeVisible();
    // The unique basename keeps the tree's own folder above it; only the
    // rows that cannot be told apart spend the width on the hint.
    expect(
      within(screen.getByRole("treeitem", { name: "src/only.ts" })).queryByText("src"),
    ).toBeNull();
  });

  it("counts duplicate basenames from the rows on screen", async () => {
    const user = userEvent.setup();
    render(
      <CodeFileExplorer
        entries={[
          { kind: "directory", path: "src" as never },
          file("src/index.ts"),
          { kind: "directory", path: "test" as never },
          file("test/index.ts"),
        ]}
        onOpenFile={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("treeitem", { name: "src" }));
    const source = screen.getByRole("treeitem", { name: "src/index.ts" });
    expect(within(source).queryByText("src")).toBeNull();

    await user.click(screen.getByRole("treeitem", { name: "test" }));
    expect(within(source).getByText("src")).toBeVisible();
    expect(
      within(screen.getByRole("treeitem", { name: "test/index.ts" })).getByText("test"),
    ).toBeVisible();
  });

  it("keeps a reachable tab stop when the first visible row cannot open", () => {
    render(
      <CodeFileExplorer
        entries={[unavailable("gone.txt"), file("src/index.ts")]}
        onOpenFile={vi.fn()}
      />,
    );

    const gone = screen.getByRole("treeitem", { name: /gone\.txt/ });
    expect(gone).toBeDisabled();
    // A disabled button cannot take focus, so the stop passes to the next
    // row instead of leaving the tree with none.
    expect(screen.getByRole("treeitem", { name: "src/index.ts" })).toHaveAttribute("tabindex", "0");
  });

  it("steps over an unavailable file from the arrow keys, Home, and End", async () => {
    const user = userEvent.setup();
    render(
      <CodeFileExplorer
        entries={[
          file("src/a.ts"),
          unavailable("src/b.ts"),
          file("src/c.ts"),
          unavailable("src/d.ts"),
          file("src/e.ts"),
        ]}
        onOpenFile={vi.fn()}
      />,
    );

    const first = screen.getByRole("treeitem", { name: "src/a.ts" });
    const third = screen.getByRole("treeitem", { name: "src/c.ts" });
    const last = screen.getByRole("treeitem", { name: "src/e.ts" });

    first.focus();
    await user.keyboard("{ArrowDown}");
    expect(third).toHaveFocus();
    await user.keyboard("{ArrowDown}");
    expect(last).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(third).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(first).toHaveFocus();
    await user.keyboard("{End}");
    expect(last).toHaveFocus();
    await user.keyboard("{Home}");
    expect(first).toHaveFocus();
  });

  it("collapses nested folders and expands them as a real repository tree", async () => {
    const user = userEvent.setup();
    render(
      <CodeFileExplorer
        entries={[
          { kind: "directory", path: "src" as never },
          { kind: "directory", path: "src/lib" as never },
          file("src/lib/format.ts"),
        ]}
        onOpenFile={vi.fn()}
      />,
    );

    expect(screen.getByRole("treeitem", { name: "src" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("treeitem", { name: "src/lib" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("treeitem", { name: "src" }));
    expect(screen.getByRole("treeitem", { name: "src/lib" })).toBeVisible();
    expect(screen.queryByRole("treeitem", { name: /format\.ts/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole("treeitem", { name: "src/lib" }));
    expect(screen.getByRole("treeitem", { name: /src\/lib\/format\.ts/ })).toBeVisible();
    expect(screen.queryByText("Available")).not.toBeInTheDocument();
  });

  it("names an empty checkout instead of reporting a filter that is not set", () => {
    render(<CodeFileExplorer entries={[]} onOpenFile={vi.fn()} />);

    expect(screen.getByText("This checkout has no files to list.")).toBeVisible();
    expect(screen.queryByText(/No files match/)).not.toBeInTheDocument();
  });

  it("names the query when a filter matches nothing", async () => {
    render(<CodeFileExplorer entries={entries()} onOpenFile={vi.fn()} />);

    await userEvent
      .setup()
      .type(screen.getByRole("searchbox", { name: "Filter files" }), "zzz-nothing");

    expect(screen.getByText("No files match “zzz-nothing”.")).toBeVisible();
  });

  it("shows which folder held a filtered match and keeps the whole path on the row", async () => {
    const path = "packages/provider-sdk/src/drivers/normalized-runtime-event-adapter.ts";
    render(<CodeFileExplorer entries={[file(path)]} onOpenFile={vi.fn()} />);

    await userEvent
      .setup()
      .type(screen.getByRole("searchbox", { name: "Filter files" }), "drivers");

    const row = screen.getByRole("treeitem", { name: path });
    expect(within(row).getByText("drivers")).toBeVisible();
    expect(row).toHaveAttribute("title", path);
  });

  it("labels a long file with its whole path so the truncated name can be resolved", () => {
    const path = "packages/provider-sdk/src/drivers/normalized-runtime-event-adapter.ts";
    render(<CodeFileExplorer entries={[file(path)]} onOpenFile={vi.fn()} />);

    const row = screen.getByRole("treeitem", { name: path });
    expect(row).toHaveAttribute("title", path);
    expect(row).toHaveTextContent("normalized-runtime-event-adapter.ts");
  });

  it("expands, collapses, and walks the tree from the arrow keys", async () => {
    const user = userEvent.setup();
    render(
      <CodeFileExplorer
        entries={[
          { kind: "directory", path: "src" as never },
          { kind: "directory", path: "src/lib" as never },
          file("src/lib/format.ts"),
        ]}
        onOpenFile={vi.fn()}
      />,
    );

    const source = screen.getByRole("treeitem", { name: "src" });
    // The tree is one tab stop: the row that holds focus is the only one Tab
    // returns to, and the arrow keys move between rows from there.
    expect(source).toHaveAttribute("tabindex", "0");

    source.focus();
    await user.keyboard("{ArrowRight}");
    expect(source).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{ArrowRight}");
    const library = screen.getByRole("treeitem", { name: "src/lib" });
    expect(library).toHaveFocus();
    await user.keyboard("{ArrowRight}");
    expect(library).toHaveAttribute("aria-expanded", "true");
    await user.keyboard("{ArrowDown}");
    const format = screen.getByRole("treeitem", { name: /src\/lib\/format\.ts/ });
    expect(format).toHaveFocus();
    expect(format).toHaveAttribute("tabindex", "0");
    expect(source).toHaveAttribute("tabindex", "-1");
    await user.keyboard("{ArrowLeft}");
    expect(library).toHaveFocus();
    await user.keyboard("{ArrowLeft}");
    expect(library).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("treeitem", { name: /format\.ts/ })).not.toBeInTheDocument();
  });

  it("keeps a padded head bar where no right-dock rail applies", () => {
    // The bottom panel renders the same tool without the right dock's rail
    // (dock.css), so the head must carry its own bar rather than collapse to
    // the bare 30px search field: that is what lost its padding and hairline.
    const head = ruleBody(codeStylesheet, ".code-file-explorer__head");
    expect(head).toMatch(/min-height:\s*44px/);
    expect(head).toMatch(/padding:\s*var\(--oct-space-2\) 12px/);
    expect(head).toMatch(/border-bottom:\s*1px solid var\(--oct-border\)/);
  });

  it("keeps the docked head at the rail height: 4px, the 30px field, then 3px and the hairline, centred", () => {
    // The head's minimum height is the rail's; the 30px field is centred in it,
    // and the 3px below plus the hairline keep a plain 4px from overflowing it.
    expect(systemStylesheet).toMatch(/--oct-rail-pad-end:\s*calc\(var\(--oct-space-1\) - 1px\)/);
    expect(dockStylesheet).toMatch(
      /padding:\s*4px var\(--oct-space-3\) var\(--oct-rail-pad-end\);/,
    );
    expect(codeStylesheet).toMatch(/\.code-file-explorer__search input \{[^}]*height:\s*30px/);
  });

  it("keeps focus on a folder when expanding or collapsing crosses the virtualization threshold", async () => {
    const user = userEvent.setup();
    const topFiles = Array.from({ length: 39 }, (_, index) =>
      file(`file-${String(index).padStart(2, "0")}.ts`),
    );
    const expandedChildren = Array.from({ length: 5 }, (_, index) =>
      file(`big/child-${String(index).padStart(2, "0")}.ts`),
    );
    await withTreeViewportHeight(280, async () => {
      render(
        <CodeFileExplorer
          entries={[{ kind: "directory", path: "big" as never }, ...expandedChildren, ...topFiles]}
          onOpenFile={vi.fn()}
        />,
      );

      const folder = screen.getByRole("treeitem", { name: "big" });
      folder.focus();
      expect(folder).toHaveFocus();

      await user.keyboard("{ArrowRight}");
      expect(screen.getByRole("treeitem", { name: "big" })).toBe(folder);
      expect(folder).toHaveAttribute("aria-expanded", "true");
      expect(folder).toHaveFocus();

      await user.keyboard("{ArrowLeft}");
      expect(screen.getByRole("treeitem", { name: "big" })).toBe(folder);
      expect(folder).toHaveAttribute("aria-expanded", "false");
      expect(folder).toHaveFocus();
    });
  });

  it("sets aria-posinset and aria-setsize within each sibling group", () => {
    render(
      <CodeFileExplorer
        entries={[
          { kind: "directory", path: "src" as never },
          file("src/a.ts"),
          file("src/b.ts"),
          file("README.md"),
        ]}
        onOpenFile={vi.fn()}
        selectedPath={"src/a.ts" as never}
      />,
    );

    const src = screen.getByRole("treeitem", { name: "src" });
    expect(src).toHaveAttribute("aria-posinset", "1");
    expect(src).toHaveAttribute("aria-setsize", "2");

    const readme = screen.getByRole("treeitem", { name: "README.md" });
    expect(readme).toHaveAttribute("aria-posinset", "2");
    expect(readme).toHaveAttribute("aria-setsize", "2");

    const childA = screen.getByRole("treeitem", { name: "src/a.ts" });
    expect(childA).toHaveAttribute("aria-posinset", "1");
    expect(childA).toHaveAttribute("aria-setsize", "2");

    const childB = screen.getByRole("treeitem", { name: "src/b.ts" });
    expect(childB).toHaveAttribute("aria-posinset", "2");
    expect(childB).toHaveAttribute("aria-setsize", "2");
  });

  it("measures rows taller than the 28px minimum so adjacent rows do not overlap", async () => {
    const getBoundingClientRect = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function mockRowRect() {
      if (this instanceof HTMLElement && this.dataset.index === "0") {
        return new DOMRect(0, 0, 300, 44);
      }
      if (this instanceof HTMLElement && this.getAttribute("role") === "treeitem") {
        return new DOMRect(0, 0, 300, 28);
      }
      return getBoundingClientRect.call(this);
    };
    const many = Array.from({ length: 50 }, (_, index) =>
      file(`src/row-${String(index).padStart(2, "0")}.ts`),
    );
    try {
      await withTreeViewportHeight(280, async () => {
        render(<CodeFileExplorer entries={many} onOpenFile={vi.fn()} />);
        const secondRow = screen.getByRole("treeitem", { name: /row-01\.ts/ });
        expect(secondRow).toHaveStyle({ transform: "translateY(44px)" });
      });
    } finally {
      Element.prototype.getBoundingClientRect = getBoundingClientRect;
    }
  });
});

function entries(): ReadonlyArray<CodeFileExplorerEntry> {
  return [
    { kind: "directory", path: "src" as never },
    file("src/index.ts"),
    file("assets/asset.bin", "binary"),
    file("logs/large.log", "oversized"),
    unavailable("missing.txt"),
  ];
}

function file(
  path: string,
  readOnlyReason?: "binary" | "oversized",
): Extract<CodeFileExplorerEntry, { readonly kind: "file" }> {
  const metadata = {
    identity: { device: "1", inode: path },
    byteLength: readOnlyReason === "oversized" ? 6 * 1024 * 1024 : 12,
    modifiedNanoseconds: "1",
    digest: "a".repeat(64),
  } as CodeFileMetadata;
  return {
    kind: "file",
    fileId: "10000000-0000-4000-8000-000000000001" as never,
    path: path as never,
    availability:
      readOnlyReason === undefined
        ? { status: "available", metadata }
        : { status: "read-only", metadata, reason: readOnlyReason },
  };
}

function unavailable(path: string): Extract<CodeFileExplorerEntry, { readonly kind: "file" }> {
  return {
    kind: "file",
    fileId: "10000000-0000-4000-8000-000000000004" as never,
    path: path as never,
    availability: { status: "unavailable", reason: "The file no longer exists." },
  };
}

async function withTreeViewportHeight(height: number, run: () => Promise<void>): Promise<void> {
  const offsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
  const clientHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientHeight");
  Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
    configurable: true,
    get() {
      if (this instanceof HTMLElement && this.classList.contains("code-file-explorer__tree")) {
        return height;
      }
      return offsetHeight?.get?.call(this) ?? 0;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", {
    configurable: true,
    get() {
      if (this instanceof HTMLElement && this.classList.contains("code-file-explorer__tree")) {
        return height;
      }
      return clientHeight?.get?.call(this) ?? 0;
    },
  });
  try {
    await run();
  } finally {
    if (offsetHeight === undefined) {
      Reflect.deleteProperty(HTMLElement.prototype, "offsetHeight");
    } else {
      Object.defineProperty(HTMLElement.prototype, "offsetHeight", offsetHeight);
    }
    if (clientHeight === undefined) {
      Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
    } else {
      Object.defineProperty(HTMLElement.prototype, "clientHeight", clientHeight);
    }
  }
}

function ruleBody(css: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "s"));
  return match?.[1] ?? "";
}
