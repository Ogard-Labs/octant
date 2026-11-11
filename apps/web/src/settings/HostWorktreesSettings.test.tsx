import type { HostWorktreeScan, RemoveHostWorktreeResult } from "@octant/contracts/disk-cleanup";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { HostWorktreesSettings } from "./HostWorktreesSettings";

const hash = "a".repeat(40);
const scanned: HostWorktreeScan = {
  kind: "host-worktrees",
  scannedAt: "2026-11-11T12:00:00.000Z" as HostWorktreeScan["scannedAt"] & string,
  complete: true,
  problems: [],
  repositories: [
    {
      path: "/home/me/code/app",
      worktrees: [
        {
          path: "/home/me/.agent/worktrees/feature",
          branch: "feature",
          detached: false,
          locked: false,
          missing: false,
          delivered: false,
          sizeBytes: 2 * 1024 * 1024,
          sizeComplete: true,
        },
        {
          path: "/home/me/.agent/worktrees/gone",
          branch: "gone",
          detached: false,
          locked: false,
          missing: true,
          delivered: true,
        },
      ],
    },
  ],
};

function client(answers: ReadonlyArray<RemoveHostWorktreeResult>) {
  const queue = [...answers];
  const removeWorktree = vi.fn(
    async () => queue.shift() ?? { kind: "host-worktree-removed" as const },
  );
  return {
    removeWorktree,
    fake: {
      worktrees: vi.fn(async () => scanned),
      scanWorktrees: vi.fn(async () => scanned),
      removeWorktree,
      xcodeBuildData: vi.fn(),
      removeXcodeBuildData: vi.fn(),
    },
  };
}

describe("HostWorktreesSettings", () => {
  it("lists other tools' worktrees by repository with what each holds", async () => {
    render(<HostWorktreesSettings client={client([]).fake} />);
    expect(await screen.findByText("feature")).toBeVisible();
    expect(screen.getByText(/Has commits only here/u)).toBeVisible();
    expect(screen.getByText(/Folder is gone/u)).toBeVisible();
    expect(screen.getByRole("button", { name: "Forget" })).toBeVisible();
  });

  it("asks about commits only on the branch, then sends back exactly those it showed", async () => {
    const user = userEvent.setup();
    const { fake, removeWorktree } = client([
      {
        kind: "host-worktree-needs-confirmation",
        reason: "unpushed-commits",
        commits: [{ hash, subject: "only here" }],
        commitCount: 1,
      },
      { kind: "host-worktree-removed" },
    ]);
    render(<HostWorktreesSettings client={fake} />);
    const row = (await screen.findByText("feature")).closest("[data-setting-id]");
    if (!(row instanceof HTMLElement)) throw new Error("expected the worktree's row");
    await user.click(within(row).getByRole("button", { name: "Remove" }));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove worktree" }),
    );

    const asked = await screen.findByRole("dialog");
    expect(within(asked).getByText(/only here/u)).toBeVisible();
    await user.click(within(asked).getByRole("button", { name: "Remove worktree" }));
    await waitFor(() =>
      expect(removeWorktree).toHaveBeenLastCalledWith({
        repositoryPath: "/home/me/code/app",
        worktreePath: "/home/me/.agent/worktrees/feature",
        confirmed: true,
        confirmedCommits: [hash],
      }),
    );
  });

  it("asks once, then removes every merged or gone worktree and says how many stayed", async () => {
    const user = userEvent.setup();
    const { fake, removeWorktree } = client([{ kind: "host-worktree-forgotten" }]);
    render(<HostWorktreesSettings client={fake} />);
    await user.click(await screen.findByRole("button", { name: "Remove 1 merged or gone" }));
    // It asks first, as a single removal does: ignored files go with each folder.
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/ignored files/u)).toBeVisible();
    expect(removeWorktree).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Remove worktrees" }));
    await waitFor(() => expect(removeWorktree).toHaveBeenCalledOnce());
    expect(await screen.findByText("Removed 1 worktree.")).toBeVisible();
  });
});
