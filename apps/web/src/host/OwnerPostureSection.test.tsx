import { describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { OwnerSpoke, OwnerActionResult } from "@octant/client-runtime";
import { OwnerPostureSection } from "./OwnerPostureSection";
const target = {
  title: "Release task",
  posture: {
    subject: { kind: "code-thread", threadId: "50000000-0000-4000-8000-000000000001" },
    posture: "approval-gated",
    persistence: "current-session",
    version: "a".repeat(64),
  },
};
function fixture(answer: OwnerActionResult, automatic = false) {
  const refused = async () => ({ status: "refused", kind: "unsupported" }) as const;
  const changePosture = vi.fn(async () => answer);
  const listPostures = vi.fn(
    async () =>
      ({
        status: "done",
        body: {
          status: "read",
          targets: [{ ...target, posture: { ...target.posture, autoApprove: automatic } }],
        },
      }) as const,
  );
  const spoke: OwnerSpoke = {
    memberId: "host",
    name: "Home Mac",
    client: {
      alerts: refused,
      heldMembers: refused,
      dismissAlert: refused,
      removeFromAlert: refused,
      setConfirmNewMembers: refused,
      confirmNewMember: refused,
      listPostures,
      changePosture,
    },
  };
  return { spoke, changePosture, listPostures };
}
describe("owner Code recovery controls", () => {
  it("shows the current automatic reviewer without granting a new one", async () => {
    const { spoke } = fixture({ status: "done", body: {} }, true);
    const user = userEvent.setup();
    render(<OwnerPostureSection spokes={[spoke]} />);
    await user.click(screen.getByRole("button", { name: "Refresh Code levels" }));
    await user.click(screen.getByLabelText("Code recovery target"));
    await user.click(await screen.findByRole("option", { name: "Thread: Release task" }));
    expect(screen.getByText("Current level: Auto")).toBeVisible();
    expect(screen.getByLabelText("Requested Code level")).toHaveTextContent("Auto");
  });

  it("shows current and requested levels and sends the authoritative version, then requires a fresh reading", async () => {
    const { spoke, changePosture, listPostures } = fixture({ status: "done", body: {} });
    const user = userEvent.setup();
    render(<OwnerPostureSection spokes={[spoke]} />);
    await user.click(screen.getByRole("button", { name: "Refresh Code levels" }));
    await user.click(screen.getByLabelText("Code recovery target"));
    await user.click(await screen.findByRole("option", { name: "Thread: Release task" }));
    expect(screen.getByText("Current level: Ask first")).toBeVisible();
    await user.click(screen.getByLabelText("Requested Code level"));
    await user.click(await screen.findByRole("option", { name: "Full access" }));
    await user.click(screen.getByRole("button", { name: "Apply Code level" }));
    expect(changePosture).toHaveBeenCalledWith({
      subject: target.posture.subject,
      expectedVersion: target.posture.version,
      posture: "full-access",
      persistence: "project-default",
    });
    expect(screen.queryByRole("button", { name: "Apply Code level" })).toBeNull();
    expect(listPostures).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("Level changed");
  });
  it("explains a changed target and discards its spent reading instead of retrying the write", async () => {
    const { spoke, changePosture } = fixture({ status: "refused", kind: "posture-stale" });
    const user = userEvent.setup();
    render(<OwnerPostureSection spokes={[spoke]} />);
    await user.click(screen.getByRole("button", { name: "Refresh Code levels" }));
    await user.click(screen.getByLabelText("Code recovery target"));
    await user.click(await screen.findByRole("option", { name: "Thread: Release task" }));
    await user.click(screen.getByLabelText("Requested Code level"));
    await user.click(await screen.findByRole("option", { name: "Plan (read only)" }));
    await user.click(screen.getByRole("button", { name: "Apply Code level" }));
    expect(screen.getByRole("status")).toHaveTextContent("Refresh its level");
    expect(changePosture).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("Code recovery target")).toBeNull();
  });
});

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error("Promise not initialized");
  };
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function currentHost(memberId = "host") {
  const next = fixture({ status: "done", body: {} });
  const currentTarget = {
    ...target,
    title: "Current task",
    posture: { ...target.posture, version: "b".repeat(64) },
  };
  next.listPostures.mockResolvedValue({
    status: "done",
    body: {
      status: "read",
      targets: [{ ...currentTarget, posture: { ...currentTarget.posture, autoApprove: false } }],
    },
  });
  return { ...next, spoke: { ...next.spoke, memberId }, currentTarget };
}

async function chooseCurrent(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByLabelText("Code recovery target"));
  await user.click(await screen.findByRole("option", { name: "Thread: Current task" }));
  await user.click(screen.getByLabelText("Requested Code level"));
  await user.click(await screen.findByRole("option", { name: "Full access" }));
}

describe("owner recovery across host changes", () => {
  it("can refresh the first computer when its roster arrives after mount", async () => {
    const { spoke, listPostures } = fixture({ status: "done", body: {} });
    const user = userEvent.setup();
    const view = render(<OwnerPostureSection spokes={[]} />);
    view.rerender(<OwnerPostureSection spokes={[spoke]} />);
    const refresh = screen.getByRole("button", { name: "Refresh Code levels" });
    expect(refresh).toBeEnabled();
    await user.click(refresh);
    expect(listPostures).toHaveBeenCalledTimes(1);
  });

  it.each(["member", "client"] as const)(
    "discards a late reading after the %s is replaced and applies only the fresh reading",
    async (replacement) => {
      const old = fixture({ status: "done", body: {} });
      const pending = deferred<Awaited<ReturnType<typeof old.listPostures>>>();
      old.listPostures.mockReturnValueOnce(pending.promise);
      const next = currentHost(replacement === "member" ? "other-host" : old.spoke.memberId);
      const user = userEvent.setup();
      const view = render(<OwnerPostureSection spokes={[old.spoke]} />);
      await user.click(screen.getByRole("button", { name: "Refresh Code levels" }));
      if (replacement === "member") view.rerender(<OwnerPostureSection spokes={[]} />);
      view.rerender(<OwnerPostureSection spokes={[next.spoke]} />);
      expect(screen.getByRole("button", { name: "Refresh Code levels" })).toBeEnabled();
      await user.click(screen.getByRole("button", { name: "Refresh Code levels" }));
      await act(async () => {
        pending.resolve({
          status: "done",
          body: {
            status: "read",
            targets: [{ ...target, posture: { ...target.posture, autoApprove: false } }],
          },
        });
      });
      await chooseCurrent(user);
      await user.click(screen.getByRole("button", { name: "Apply Code level" }));
      expect(old.changePosture).not.toHaveBeenCalled();
      expect(next.changePosture).toHaveBeenCalledWith(
        expect.objectContaining({ expectedVersion: "b".repeat(64) }),
      );
    },
  );

  it("drops a selected snapshot when the same member receives a replacement client", async () => {
    const old = fixture({ status: "done", body: {} });
    const next = currentHost();
    const user = userEvent.setup();
    const view = render(<OwnerPostureSection spokes={[old.spoke]} />);
    await user.click(screen.getByRole("button", { name: "Refresh Code levels" }));
    await user.click(screen.getByLabelText("Code recovery target"));
    await user.click(await screen.findByRole("option", { name: "Thread: Release task" }));
    view.rerender(<OwnerPostureSection spokes={[next.spoke]} />);
    expect(screen.queryByText("Current level: Ask first")).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply Code level" })).toBeNull();
    expect(old.changePosture).not.toHaveBeenCalled();
    expect(next.changePosture).not.toHaveBeenCalled();
  });

  it("does not let an old apply completion clear a replacement client's fresh selection", async () => {
    const old = currentHost();
    const next = currentHost();
    const pending = deferred<OwnerActionResult>();
    old.changePosture.mockImplementationOnce(() => pending.promise);
    const user = userEvent.setup();
    const view = render(<OwnerPostureSection spokes={[old.spoke]} />);
    await user.click(screen.getByRole("button", { name: "Refresh Code levels" }));
    await chooseCurrent(user);
    await user.click(screen.getByRole("button", { name: "Apply Code level" }));
    view.rerender(<OwnerPostureSection spokes={[next.spoke]} />);
    expect(screen.getByRole("button", { name: "Refresh Code levels" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Refresh Code levels" }));
    await chooseCurrent(user);
    await act(async () => {
      pending.resolve({ status: "done", body: {} });
    });
    expect(screen.getByRole("button", { name: "Apply Code level" })).toBeEnabled();
    expect(screen.queryByText(/Level changed/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Apply Code level" }));
    expect(next.changePosture).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: "b".repeat(64) }),
    );
  });
});
