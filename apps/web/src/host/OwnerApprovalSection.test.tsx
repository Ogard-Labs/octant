import { describe, expect, it, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OwnerSpoke, OwnerActionResult } from "@octant/client-runtime";
import { OwnerApprovalSection } from "./OwnerApprovalSection";

const target = {
  ownerMemberId: "50000000-0000-4000-8000-000000000005",
  hostMemberId: "50000000-0000-4000-8000-000000000001",
  mode: "work",
  threadId: "50000000-0000-4000-8000-000000000002",
  projectId: "50000000-0000-4000-8000-000000000003",
  requestId: "50000000-0000-4000-8000-000000000004",
  targetVersion: "a".repeat(64),
  actionDigest: "b".repeat(64),
  title: "Fix notes",
  projectName: "My Project",
  action: {
    kind: "file-write",
    tool: "Write",
    input: JSON.stringify({
      file_path: "/fixture/notes",
      content: "complete content including the final line",
    }),
  },
};
function fixture(shell = false) {
  const refused = async () => ({ status: "refused", kind: "unsupported" }) as const;
  const readApprovals = vi.fn<() => Promise<OwnerActionResult>>(async () => ({
    status: "done",
    body: {
      targets: [
        {
          ...target,
          action: shell
            ? {
                kind: "shell",
                tool: "Bash",
                input: JSON.stringify({ command: "printf complete-command-through-final-line" }),
                workingDirectory: "/fixture",
              }
            : target.action,
        },
      ],
      unavailable: 1,
    },
  }));
  const answerApproval = vi.fn(
    async () => ({ status: "done", body: { status: "delivered" } }) as const,
  );
  const spoke: OwnerSpoke = {
    memberId: target.hostMemberId,
    name: "Home host",
    client: {
      alerts: refused,
      heldMembers: refused,
      dismissAlert: refused,
      removeFromAlert: refused,
      setConfirmNewMembers: refused,
      confirmNewMember: refused,
      readApprovals,
      answerApproval,
    },
  };
  return { spoke, readApprovals, answerApproval };
}
describe("owner approval recovery consent", () => {
  it.each([false, true])(
    "shows all file or Shell facts before a one-use answer and clears consumed consent: %s",
    async (shell) => {
      const f = fixture(shell),
        user = userEvent.setup();
      render(<OwnerApprovalSection spokes={[f.spoke]} />);
      expect(f.readApprovals).not.toHaveBeenCalled();
      await user.click(screen.getByRole("button", { name: "Unlock and read approvals" }));
      expect(screen.getByText(/1 waiting request/)).toBeVisible();
      await user.click(screen.getByLabelText("Waiting approval"));
      await user.click(
        await screen.findByRole("option", {
          name: shell ? "Work: Fix notes — Bash" : "Work: Fix notes — Write",
        }),
      );
      expect(
        screen.getByText(
          shell
            ? /complete-command-through-final-line/
            : /complete content including the final line/,
        ),
      ).toBeVisible();
      if (shell) expect(screen.getByText(/Working folder: \/fixture/)).toBeVisible();
      expect(screen.getByText(/Runs on Home host/)).toBeVisible();
      await user.click(screen.getByRole("button", { name: "Allow once" }));
      expect(f.answerApproval).toHaveBeenCalledWith({
        ownerMemberId: target.ownerMemberId,
        hostMemberId: target.hostMemberId,
        mode: target.mode,
        threadId: target.threadId,
        projectId: target.projectId,
        requestId: target.requestId,
        targetVersion: target.targetVersion,
        actionDigest: target.actionDigest,
        approved: true,
      });
      expect(screen.queryByRole("button", { name: "Allow once" })).toBeNull();
      expect(
        screen.queryByText(
          shell
            ? /complete-command-through-final-line/
            : /complete content including the final line/,
        ),
      ).toBeNull();
    },
  );
  it("discards a late private reading when its owner client changes", async () => {
    const old = fixture(),
      next = fixture();
    let finish: (value: OwnerActionResult) => void = () => {};
    old.readApprovals.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const view = render(<OwnerApprovalSection spokes={[old.spoke]} />),
      user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Unlock and read approvals" }));
    view.rerender(<OwnerApprovalSection spokes={[next.spoke]} />);
    await act(async () => finish({ status: "done", body: { targets: [target], unavailable: 0 } }));
    expect(screen.queryByLabelText("Waiting approval")).toBeNull();
    expect(next.answerApproval).not.toHaveBeenCalled();
  });
  it("uses an explicit host link instead of an unavailable action on another origin", () => {
    const f = fixture();
    render(
      <OwnerApprovalSection
        spokes={[{ ...f.spoke, openAt: "https://fixture.invalid/settings" }]}
      />,
    );
    expect(
      screen.getByRole("link", { name: "Open Home host to recover approvals" }),
    ).toHaveAttribute("href", "https://fixture.invalid/settings");
    expect(screen.queryByRole("button", { name: "Unlock and read approvals" })).toBeNull();
  });
});
