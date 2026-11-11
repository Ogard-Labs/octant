import type {
  ArchivedWorktree,
  RemoveArchivedWorktreeResult,
} from "@octant/contracts/archived-worktrees";
import { decodeCodeThreadId, decodeProjectId } from "@octant/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ArchivedWorktreesSettings } from "./ArchivedWorktreesSettings";

const threadId = decodeCodeThreadId("77000000-0000-4000-8000-000000000001");
const projectId = decodeProjectId("77000000-0000-4000-8000-000000000002");
const worktree: ArchivedWorktree = {
  threadId,
  projectId,
  title: "Fix the sidebar",
  branch: "octant/fix-sidebar",
  path: "/repos/.octant-worktrees/r/t",
  sizeBytes: 3 * 1024 * 1024,
  sizeComplete: true,
};

function client(answer: RemoveArchivedWorktreeResult) {
  const list = vi
    .fn<() => Promise<ReadonlyArray<ArchivedWorktree>>>()
    .mockResolvedValueOnce([worktree])
    .mockResolvedValue(answer.kind === "archived-worktree-removed" ? [] : [worktree]);
  const remove = vi.fn(async () => answer);
  return { list, remove, fake: { list, remove } };
}

describe("ArchivedWorktreesSettings", () => {
  it("lists what an archived thread's worktree holds and where", async () => {
    const { fake } = client({ kind: "archived-worktree-removed", threadId });
    render(
      <ArchivedWorktreesSettings client={fake} projectNames={new Map([[projectId, "Octant"]])} />,
    );
    expect(await screen.findByText("Fix the sidebar")).toBeVisible();
    expect(screen.getByText("octant/fix-sidebar")).toBeVisible();
    expect(screen.getByText("/repos/.octant-worktrees/r/t")).toBeVisible();
    expect(screen.getByText(/3\.0 MB/u)).toBeVisible();
  });

  it("asks before removing a worktree and says the branch stays", async () => {
    const user = userEvent.setup();
    const { fake, remove } = client({ kind: "archived-worktree-removed", threadId });
    render(<ArchivedWorktreesSettings client={fake} projectNames={new Map()} />);
    const row = (await screen.findByText("Fix the sidebar")).closest("[data-setting-id]");
    if (!(row instanceof HTMLElement)) throw new Error("expected the worktree's row");
    await user.click(within(row).getByRole("button", { name: "Remove" }));

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/its commits stay/u)).toBeVisible();
    expect(remove).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Remove worktree" }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith(threadId));
    expect(await screen.findByText("No archived thread keeps a worktree.")).toBeVisible();
  });

  it("says why the host kept a worktree with uncommitted changes", async () => {
    const user = userEvent.setup();
    const { fake } = client({
      kind: "archived-worktree-refused",
      reason: "dirty",
      message: "The worktree has uncommitted changes.",
    });
    render(<ArchivedWorktreesSettings client={fake} projectNames={new Map()} />);
    await user.click(await screen.findByRole("button", { name: "Remove" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove worktree" }),
    );
    expect(await screen.findByText("The worktree has uncommitted changes.")).toBeVisible();
    expect(screen.getByText("Fix the sidebar")).toBeVisible();
  });

  it("tells a paired device the worktrees are managed on the host", () => {
    render(<ArchivedWorktreesSettings client={undefined} projectNames={new Map()} />);
    expect(screen.getByText("Worktrees are managed on the host machine.")).toBeVisible();
  });
});
