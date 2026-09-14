import type { CodeFileMetadata } from "@octant/contracts/code";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  CodeFileExplorer,
  MAX_CODE_FILE_EXPLORER_ENTRIES,
  type CodeFileExplorerEntry,
} from "./CodeFileExplorer";

describe("CodeFileExplorer", () => {
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

  it("caps oversized projections and reports that the visible tree is incomplete", () => {
    const many = Array.from({ length: MAX_CODE_FILE_EXPLORER_ENTRIES + 1 }, (_, index) =>
      file(`generated/file-${String(index).padStart(4, "0")}.txt`),
    );
    render(<CodeFileExplorer entries={many} onOpenFile={vi.fn()} />);

    expect(screen.getByRole("status")).toHaveTextContent(
      `Showing the first ${MAX_CODE_FILE_EXPLORER_ENTRIES.toLocaleString()}`,
    );
    expect(screen.getAllByRole("treeitem")).toHaveLength(MAX_CODE_FILE_EXPLORER_ENTRIES);
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

  it("keeps relative path context when basenames are duplicated", () => {
    render(
      <CodeFileExplorer
        entries={[file("src/index.ts"), file("test/index.ts")]}
        onOpenFile={vi.fn()}
      />,
    );

    expect(screen.getByRole("treeitem", { name: /src\/index\.ts/ })).toBeVisible();
    expect(screen.getByRole("treeitem", { name: /test\/index\.ts/ })).toBeVisible();
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
});

function entries(): ReadonlyArray<CodeFileExplorerEntry> {
  return [
    { kind: "directory", path: "src" as never },
    file("src/index.ts"),
    file("assets/asset.bin", "binary"),
    file("logs/large.log", "oversized"),
    {
      kind: "file",
      fileId: "10000000-0000-4000-8000-000000000004" as never,
      path: "missing.txt" as never,
      availability: { status: "unavailable", reason: "The file no longer exists." },
    },
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
