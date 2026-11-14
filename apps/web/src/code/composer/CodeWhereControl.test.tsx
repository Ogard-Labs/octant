import type { CodeNewThreadWorkspace } from "@octant/contracts/projects";
import { render, screen } from "@testing-library/react";
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
      baseBranchPicker={<button type="button">Base branch</button>}
      branch="main"
      onWorkspaceChange={(next) => {
        onChosen?.(next);
        setWorkspace(next);
      }}
      projectRoot="~/Dev/auroradocs"
      workspace={workspace}
      worktreeBranch="octant/fix-login"
      {...rest}
    />
  );
}

const chip = () => screen.getByRole("button", { name: /^Where this thread works/ });

describe("CodeWhereControl", () => {
  it("reads the branch and the place on one chip for each choice", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    expect(chip()).toHaveTextContent("main · This checkout");

    await user.click(chip());
    await user.click(screen.getByRole("radio", { name: /New worktree/ }));
    expect(chip()).toHaveTextContent("octant/fix-login · New worktree");
  });

  it("names the Project folder and the current branch under This checkout", async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(chip());
    expect(screen.getByRole("heading", { name: "Where should this thread work?" })).toBeVisible();
    expect(screen.getByRole("radio", { name: /This checkout/ })).toHaveTextContent(
      "~/Dev/auroradocs · on main",
    );
    expect(screen.getByRole("radio", { name: /This checkout/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  it("keeps the worktree rows laid out and out of reach until a new worktree is chosen, and starts nothing by choosing", async () => {
    const user = userEvent.setup();
    const onChosen = vi.fn();
    render(<Harness onChosen={onChosen} />);
    await user.click(chip());
    const base = screen.getByRole("button", { name: "Base branch" });
    expect(base.closest("[inert]")).not.toBeNull();

    await expectPopupUnmoved(document.querySelector(".code-where__panel") as Element, async () => {
      await user.click(screen.getByRole("radio", { name: /New worktree/ }));
    });
    expect(onChosen).toHaveBeenCalledExactlyOnceWith("managed-worktree");
    expect(base.closest("[inert]")).toBeNull();
    expect(screen.getByText("octant/fix-login")).toBeVisible();
    expect(screen.getByText("(auto)")).toBeVisible();
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

  it("holds the subfolder row and says in words when the subfolder is refused", async () => {
    const user = userEvent.setup();
    render(
      <Harness
        subfolder={
          <label>
            Subfolder <input defaultValue="." />
          </label>
        }
        subfolderName="../out"
        subfolderValid={false}
      />,
    );
    expect(chip()).toHaveTextContent("subfolder not usable");
    await user.click(chip());
    expect(screen.getByLabelText("Subfolder")).toBeVisible();
  });

  it("offers Remember for this Project only where it can be recorded, and records the choice", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(<Harness initial="managed-worktree" />);
    await user.click(chip());
    expect(screen.queryByRole("switch", { name: "Remember for this Project" })).toBeNull();

    rerender(
      <Harness initial="managed-worktree" remembered={{ value: "current-checkout", onChange }} />,
    );
    await user.click(screen.getByRole("switch", { name: "Remember for this Project" }));
    expect(onChange).toHaveBeenCalledWith("managed-worktree");
  });
});
