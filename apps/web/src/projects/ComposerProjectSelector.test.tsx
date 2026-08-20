import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  ComposerProjectSelector,
  type ComposerProjectEntry,
  type ComposerProjectSelection,
} from "./ComposerProjectSelector";
import type { ProjectId } from "@octant/contracts/projects";

const entries: ComposerProjectEntry[] = [
  {
    kind: "saved-project",
    projectId: "00000000-0000-0000-0000-000000000001" as ProjectId,
    displayName: "My Project",
    rootPath: "/home/user/project",
  },
  { kind: "add-folder" },
];

const projectSelection: ComposerProjectSelection = {
  projectId: "00000000-0000-0000-0000-000000000001" as ProjectId,
  displayName: "My Project",
};

describe("ComposerProjectSelector", () => {
  it("asks for a Project until one is chosen", () => {
    render(
      <ComposerProjectSelector entries={entries} onSelect={() => {}} onAddFolder={() => {}} />,
    );
    expect(screen.getByRole("button", { name: "Project: Choose a Project" })).toBeVisible();
  });

  it("names the chosen Project", () => {
    render(
      <ComposerProjectSelector
        entries={entries}
        selection={projectSelection}
        onSelect={() => {}}
        onAddFolder={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Project: My Project" })).toBeVisible();
  });

  it("refuses interaction while the thread is being created", () => {
    render(
      <ComposerProjectSelector
        entries={entries}
        onSelect={() => {}}
        onAddFolder={() => {}}
        disabled
      />,
    );
    expect(screen.getByRole("button", { name: "Project: Choose a Project" })).toBeDisabled();
  });

  it("announces itself as a listbox trigger that starts closed", () => {
    render(
      <ComposerProjectSelector entries={entries} onSelect={() => {}} onAddFolder={() => {}} />,
    );
    const trigger = screen.getByRole("button", { name: "Project: Choose a Project" });
    expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("keeps the way to add a folder when the search matches no saved Project", async () => {
    const user = userEvent.setup();
    render(
      <ComposerProjectSelector entries={entries} onSelect={() => {}} onAddFolder={() => {}} />,
    );

    await user.click(screen.getByRole("button", { name: "Project: Choose a Project" }));
    const search = screen.getByRole("combobox", { name: "Search Projects" });
    expect(search).toHaveFocus();
    await user.type(search, "missing");

    expect(screen.queryByRole("option", { name: /My Project/ })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Add local folder…" })).toBeVisible();
    // Nothing offers a thread with no Project: the list can only ever name one
    // or create one.
    expect(screen.queryByRole("option", { name: /No folder/ })).not.toBeInTheDocument();
  });

  it("supports arrow-key selection and restores focus on Escape", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <ComposerProjectSelector entries={entries} onSelect={onSelect} onAddFolder={() => {}} />,
    );

    const trigger = screen.getByRole("button", { name: "Project: Choose a Project" });
    await user.click(trigger);
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenCalledWith(entries[0]);

    await user.click(trigger);
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
  });
});
