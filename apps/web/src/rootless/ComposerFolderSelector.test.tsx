import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ComposerFolderSelector } from "./ComposerFolderSelector";
import type {
  ComposerFolderEntry,
  ComposerFolderSelection,
} from "@octant/contracts/rootless-thread";
import type { ProjectId } from "@octant/contracts/projects";

const entries: ComposerFolderEntry[] = [
  {
    kind: "saved-project",
    projectId: "00000000-0000-0000-0000-000000000001" as ProjectId,
    displayName: "My Project",
    rootPath: "/home/user/project",
  },
  { kind: "add-folder" },
  { kind: "no-folder" },
];

const noFolderSelection: ComposerFolderSelection = { kind: "no-folder" };
const projectSelection: ComposerFolderSelection = {
  kind: "project",
  projectId: "00000000-0000-0000-0000-000000000001" as ProjectId,
  displayName: "My Project",
};

describe("ComposerFolderSelector", () => {
  it("renders with no-folder selection", () => {
    render(
      <ComposerFolderSelector
        entries={entries}
        selection={noFolderSelection}
        onSelect={() => {}}
        onAddFolder={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Folder: No folder" })).toBeVisible();
  });

  it("renders with project selection", () => {
    render(
      <ComposerFolderSelector
        entries={entries}
        selection={projectSelection}
        onSelect={() => {}}
        onAddFolder={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Folder: My Project" })).toBeVisible();
  });

  it("renders disabled state", () => {
    render(
      <ComposerFolderSelector
        entries={entries}
        selection={noFolderSelection}
        onSelect={() => {}}
        onAddFolder={() => {}}
        disabled
      />,
    );
    expect(screen.getByRole("button", { name: "Folder: No folder" })).toBeDisabled();
  });

  it("has correct ARIA attributes", () => {
    render(
      <ComposerFolderSelector
        entries={entries}
        selection={noFolderSelection}
        onSelect={() => {}}
        onAddFolder={() => {}}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Folder: No folder" });
    expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("searches saved Projects while retaining Add local folder and No folder", async () => {
    const user = userEvent.setup();
    render(
      <ComposerFolderSelector
        entries={entries}
        selection={noFolderSelection}
        onSelect={() => {}}
        onAddFolder={() => {}}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Folder: No folder" }));
    const search = screen.getByRole("combobox", { name: "Search folders" });
    expect(search).toHaveFocus();
    await user.type(search, "missing");

    expect(screen.queryByRole("option", { name: /My Project/ })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Add local folder…" })).toBeVisible();
    expect(screen.getByRole("option", { name: "No folder" })).toBeVisible();
  });

  it("supports arrow-key selection and restores focus on Escape", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ComposerFolderSelector
        entries={entries}
        selection={noFolderSelection}
        onSelect={onSelect}
        onAddFolder={() => {}}
      />,
    );

    const trigger = screen.getByRole("button", { name: "Folder: No folder" });
    await user.click(trigger);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledWith(entries[0]);

    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
  });
});
