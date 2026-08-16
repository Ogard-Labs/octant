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

    await userEvent.setup().type(screen.getByRole("searchbox", { name: "Search files" }), "asset");
    expect(screen.getByRole("treeitem", { name: /asset.bin/ })).toHaveTextContent(
      "Binary · read-only",
    );
    expect(screen.queryByRole("treeitem", { name: /index.ts/ })).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search files" }), {
      target: { value: "large" },
    });
    expect(screen.getByRole("treeitem", { name: /large.log/ })).toHaveTextContent(
      "Oversized · read-only",
    );

    fireEvent.change(screen.getByRole("searchbox", { name: "Search files" }), {
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
      .type(screen.getByRole("searchbox", { name: "Search files" }), "only-after-cap");

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
