import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CodeWorktreeRef } from "@octant/contracts/code";
import { CodeBranchSelector } from "./CodeBranchSelector";

const refs: ReadonlyArray<CodeWorktreeRef> = [
  { name: "development", kind: "local", isCurrent: true },
  { name: "feature/model-picker", kind: "local", hasWorktree: true },
  { name: "origin/development", kind: "remote", remoteName: "origin" },
  { name: "origin/main", kind: "remote", remoteName: "origin" },
] as never;

describe("CodeBranchSelector", () => {
  it("opens a searchable ref list from the trigger and reports the selection", async () => {
    const user = userEvent.setup();
    const onSelectRef = vi.fn();
    const onOpen = vi.fn();
    render(
      <CodeBranchSelector
        branch="development"
        onOpen={onOpen}
        onSelectRef={onSelectRef}
        refs={refs}
        remoteName="origin"
        startFromOrigin
        startFromOriginAvailable
        onStartFromOriginChange={() => undefined}
      />,
    );

    expect(screen.getByRole("button", { name: "Base branch" })).toHaveTextContent(
      "From origin/development",
    );
    await user.click(screen.getByRole("button", { name: "Base branch" }));
    expect(onOpen).toHaveBeenCalled();

    const menu = await screen.findByRole("dialog", { name: "Choose base branch" });
    expect(within(menu).getByRole("option", { name: "developmentcurrent" })).toBeVisible();
    expect(
      within(menu).getByRole("option", { name: "feature/model-pickerworktree" }),
    ).toBeVisible();

    await user.type(within(menu).getByRole("searchbox", { name: "Search refs" }), "main");
    expect(within(menu).queryByRole("option", { name: /feature/ })).not.toBeInTheDocument();
    await user.click(within(menu).getByRole("option", { name: "origin/mainorigin" }));

    expect(onSelectRef).toHaveBeenCalledWith(refs[3]);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("labels the trigger with the local branch when not starting from origin", () => {
    render(
      <CodeBranchSelector
        branch="development"
        onSelectRef={() => undefined}
        refs={refs}
        startFromOrigin={false}
      />,
    );
    expect(screen.getByRole("button", { name: "Base branch" })).toHaveTextContent(
      "From development",
    );
  });

  it("disables the start-from-origin switch when no usable remote exists", async () => {
    const user = userEvent.setup();
    render(
      <CodeBranchSelector
        branch="development"
        onSelectRef={() => undefined}
        onStartFromOriginChange={() => undefined}
        refs={refs}
        startFromOrigin={false}
        startFromOriginAvailable={false}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Base branch" }));
    expect(
      await screen.findByRole("switch", { name: "Start from origin in selector" }),
    ).toHaveAttribute("data-disabled");
  });
});
