import type { CodeNewThreadWorkspace } from "@octant/contracts/projects";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { expectPopupUnmoved } from "../../test/popupRect.test-support";
import { CodeWhereControl, type CodeWhereControlProps } from "./CodeWhereControl";

function Harness(
  props: Partial<CodeWhereControlProps> & {
    readonly initial?: CodeNewThreadWorkspace;
    readonly onChosen?: (workspace: CodeNewThreadWorkspace) => void;
  },
) {
  const [workspace, setWorkspace] = useState<CodeNewThreadWorkspace>(
    props.initial ?? "current-checkout",
  );
  const { initial: _initial, onChosen, ...rest } = props;
  return (
    <CodeWhereControl
      baseBranchPicker={<button type="button">Start from: main</button>}
      branch="main"
      onWorkspaceChange={(next) => {
        onChosen?.(next);
        setWorkspace(next);
      }}
      projectRoot="~/Dev/auroradocs"
      sourceControl={<p>Source settings</p>}
      workspace={workspace}
      worktreeBranch="octant/fix-login"
      {...rest}
    />
  );
}

const chip = () => screen.getByRole("button", { name: /^Where this thread works/ });
const panel = () => document.querySelector(".code-where__panel") as HTMLElement;

describe("CodeWhereControl", () => {
  it("says the branch on the chip, and a new worktree and where it starts once chosen", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(chip()).toHaveTextContent("main");
    expect(chip()).not.toHaveTextContent("This checkout");

    await user.click(chip());
    await user.click(screen.getByRole("radio", { name: /New worktree/ }));
    expect(chip()).toHaveTextContent("New worktree · from main");
  });

  it("is a plain menu: the two choices, the branch, the subfolder, and Remember", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        remembered={{ value: "current-checkout", onChange: vi.fn() }}
        subfolder={<input aria-label="Subfolder field" />}
      />,
    );
    await user.click(chip());
    const menu = within(panel());
    expect(menu.getByText("Where this thread works")).toBeVisible();
    expect(menu.getByRole("radio", { name: /This checkout/ })).toHaveTextContent("on main");
    expect(menu.getByRole("radio", { name: /This checkout/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    // This checkout says the branch it is on; there is nothing to choose.
    expect(menu.getByText("Branch")).toBeVisible();
    expect(menu.queryByRole("button", { name: "Start from: main" })).toBeNull();
    expect(menu.getByRole("button", { name: /^Subfolder/ })).toHaveTextContent("Whole folder");
    expect(menu.getByRole("checkbox", { name: "Remember for this Project" })).toBeVisible();
    expect(menu.getByRole("button", { name: /Worktree options/ })).toBeDisabled();
    // The folder's path is the choice's tooltip, not a line of its own.
    expect(menu.getByRole("radio", { name: /This checkout/ })).toHaveAttribute(
      "title",
      "~/Dev/auroradocs",
    );
  });

  it("swaps the branch row for where a worktree starts without moving the menu, and starts nothing by choosing", async () => {
    const user = userEvent.setup();
    const onChosen = vi.fn();
    render(<Harness onChosen={onChosen} />);
    await user.click(chip());
    await expectPopupUnmoved(panel(), async () => {
      await user.click(screen.getByRole("radio", { name: /New worktree/ }));
    });
    expect(onChosen).toHaveBeenCalledExactlyOnceWith("managed-worktree");
    expect(screen.getByRole("button", { name: "Start from: main" })).toBeVisible();
    expect(screen.getByRole("button", { name: /Worktree options/ })).toBeEnabled();
  });

  it("opens the worktree's own settings in a dialog that names the branch it makes", async () => {
    const user = userEvent.setup();
    render(<Harness initial="managed-worktree" />);
    await user.click(chip());
    await user.click(screen.getByRole("button", { name: /Worktree options/ }));
    const dialog = await screen.findByRole("dialog", { name: "Worktree options" });
    expect(dialog).toHaveTextContent("octant/fix-login");
    expect(within(dialog).getByText("Source settings")).toBeVisible();
    await user.click(within(dialog).getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("dialog", { name: "Worktree options" })).toBeNull();
    // The row that opened the dialog sits in a menu that has closed, so the
    // keyboard comes back to the chip instead of to nothing.
    expect(chip()).toHaveFocus();
  });

  it("moves the choice with the arrow keys, closes on Escape and returns focus to the chip", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(chip());
    screen.getByRole("radio", { name: /This checkout/ }).focus();
    await user.keyboard("{ArrowDown}");
    expect(screen.getByRole("radio", { name: /New worktree/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.keyboard("{Escape}");
    expect(chip()).toHaveAttribute("aria-expanded", "false");
    expect(chip()).toHaveFocus();
  });

  it("says in words when the subfolder is refused, and edits it in a pop-out beside its row", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        subfolder={<input aria-label="Subfolder field" defaultValue="../out" />}
        subfolderName="../out"
        subfolderValid={false}
      />,
    );
    expect(chip()).toHaveTextContent("subfolder not usable");
    await user.click(chip());
    const row = screen.getByRole("button", { name: /^Subfolder/ });
    expect(row).toHaveTextContent("Not usable");
    await user.click(row);
    expect(await screen.findByLabelText("Subfolder field")).toBeVisible();
  });

  it("offers Remember for this Project only where it can be recorded, and records the choice", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<Harness initial="managed-worktree" />);
    await user.click(chip());
    expect(screen.queryByRole("checkbox", { name: "Remember for this Project" })).toBeNull();

    rerender(
      <Harness initial="managed-worktree" remembered={{ value: "current-checkout", onChange }} />,
    );
    await user.click(screen.getByRole("checkbox", { name: "Remember for this Project" }));
    expect(onChange).toHaveBeenCalledWith("managed-worktree");
  });
});
