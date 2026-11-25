import type { ArchivedWorktreesClient } from "@octant/client-runtime/archived-worktrees-client";
import type {
  CleanedUpWorktree,
  RestoreCleanedUpWorktreeResult,
} from "@octant/contracts/cleaned-up-worktrees";
import { decodeCodeThreadId, decodeProjectId } from "@octant/contracts";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CleanedUpWorktreesSettings } from "./CleanedUpWorktreesSettings";

const threadId = decodeCodeThreadId("79000000-0000-4000-8000-000000000001");
const projectId = decodeProjectId("79000000-0000-4000-8000-000000000002");
const cleaned: CleanedUpWorktree = {
  threadId,
  projectId,
  title: "Fix the sidebar",
  branch: "octant/fix-sidebar",
  path: "/repos/.octant-worktrees/r/t",
  state: "cleaned-up",
};

function client(answer: RestoreCleanedUpWorktreeResult) {
  const listCleanedUp = vi
    .fn<() => Promise<ReadonlyArray<CleanedUpWorktree>>>()
    .mockResolvedValueOnce([cleaned])
    .mockResolvedValue(answer.kind === "cleaned-up-worktree-restored" ? [] : [cleaned]);
  const restore = vi.fn(async () => answer);
  const fake = {
    list: vi.fn(),
    remove: vi.fn(),
    listCleanedUp,
    restore,
  } as never as ArchivedWorktreesClient;
  return { fake, restore, listCleanedUp };
}

describe("CleanedUpWorktreesSettings", () => {
  it("lists a thread whose worktree was cleaned up and says the branch and thread stay", async () => {
    const { fake } = client({ kind: "cleaned-up-worktree-restored", threadId });
    render(
      <CleanedUpWorktreesSettings client={fake} projectNames={new Map([[projectId, "Octant"]])} />,
    );
    expect(await screen.findByText("Fix the sidebar")).toBeVisible();
    expect(screen.getByText("octant/fix-sidebar")).toBeVisible();
    expect(screen.getByText(/takes no new turn until its worktree is restored/u)).toBeVisible();
  });

  it("restores a worktree and drops the row once the host has put it back", async () => {
    const user = userEvent.setup();
    const { fake, restore } = client({ kind: "cleaned-up-worktree-restored", threadId });
    const { container } = render(
      <CleanedUpWorktreesSettings client={fake} projectNames={new Map()} />,
    );
    await user.click(await screen.findByRole("button", { name: "Restore worktree" }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith(threadId));
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("says why the host refused when the branch moved, and keeps the row", async () => {
    const user = userEvent.setup();
    const message =
      "The branch no longer points where the worktree left it, so it was not restored.";
    const { fake } = client({
      kind: "cleaned-up-worktree-refused",
      reason: "branch-changed",
      message,
    });
    render(<CleanedUpWorktreesSettings client={fake} projectNames={new Map()} />);
    await user.click(await screen.findByRole("button", { name: "Restore worktree" }));
    expect(await screen.findByText(message)).toBeVisible();
    expect(screen.getByText("Fix the sidebar")).toBeVisible();
  });

  it("keeps the host's warning visible after the row is gone, until it is dismissed", async () => {
    const user = userEvent.setup();
    const message = "Some files could not be put back. Check the folder before you go on.";
    const fake = {
      list: vi.fn(),
      remove: vi.fn(),
      listCleanedUp: vi
        .fn<() => Promise<ReadonlyArray<CleanedUpWorktree>>>()
        .mockResolvedValueOnce([cleaned])
        .mockResolvedValue([]),
      restore: vi.fn(async () => ({
        kind: "cleaned-up-worktree-refused" as const,
        reason: "files-missing" as const,
        message,
      })),
    } as never as ArchivedWorktreesClient;
    render(<CleanedUpWorktreesSettings client={fake} projectNames={new Map()} />);
    await user.click(await screen.findByRole("button", { name: "Restore worktree" }));
    // The abandoned cleanup is back to a working checkout, so the list is empty.
    await waitFor(() => expect(fake.listCleanedUp).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(message)).toBeVisible();
    expect(screen.queryByText("Fix the sidebar")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByText(message)).not.toBeInTheDocument());
  });

  it("shows nothing when no worktree was cleaned up, and on a host that lists none", async () => {
    const empty = {
      list: vi.fn(),
      remove: vi.fn(),
      listCleanedUp: vi.fn(async () => []),
      restore: vi.fn(),
    } as never as ArchivedWorktreesClient;
    const { container, rerender } = render(
      <CleanedUpWorktreesSettings client={empty} projectNames={new Map()} />,
    );
    await waitFor(() => expect(empty.listCleanedUp).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    rerender(<CleanedUpWorktreesSettings client={undefined} projectNames={new Map()} />);
    expect(container).toBeEmptyDOMElement();
  });
});
