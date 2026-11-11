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
function fixture(answer: OwnerActionResult, automatic = false, work = false) {
  const refused = async () => ({ status: "refused", kind: "unsupported" }) as const;
  const changePosture = vi.fn(async () => answer);
  const listPostures = vi.fn(
    async () =>
      ({
        status: "done",
        body: {
          status: "read",
          targets: [
            work
              ? {
                  title: "Work task",
                  posture: {
                    subject: { kind: "work-thread", threadId: target.posture.subject.threadId },
                    posture: "ask-first",
                    version: target.posture.version,
                  },
                }
              : { ...target, posture: { ...target.posture, autoApprove: automatic } },
          ],
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
  it("offers only Work's four levels and sends its exact target and version without Code persistence", async () => {
    const { spoke, changePosture } = fixture({ status: "done", body: {} }, false, true);
    const user = userEvent.setup();
    render(<OwnerPostureSection spokes={[spoke]} />);
    await user.click(screen.getByRole("button", { name: "Refresh access levels" }));
    await user.click(screen.getByLabelText("Recovery target"));
    await user.click(await screen.findByRole("option", { name: "Work thread: Work task" }));
    await user.click(screen.getByLabelText("Requested level"));
    await screen.findByRole("option", { name: "Auto" });
    expect(screen.queryByRole("option", { name: "Plan (read only)" })).toBeNull();
    expect(screen.getAllByRole("option")).toHaveLength(4);
    await user.click(screen.getByRole("option", { name: "Auto" }));
    await user.click(screen.getByRole("button", { name: "Apply level" }));
    expect(changePosture).toHaveBeenCalledWith({
      subject: { kind: "work-thread", threadId: target.posture.subject.threadId },
      expectedVersion: target.posture.version,
      posture: "auto",
    });
    expect(screen.queryByRole("button", { name: "Apply level" })).toBeNull();
  });
  it("shows the current automatic reviewer without granting a new one", async () => {
    const { spoke } = fixture({ status: "done", body: {} }, true);
    const user = userEvent.setup();
    render(<OwnerPostureSection spokes={[spoke]} />);
    await user.click(screen.getByRole("button", { name: "Refresh access levels" }));
    await user.click(screen.getByLabelText("Recovery target"));
    await user.click(await screen.findByRole("option", { name: "Thread: Release task" }));
    expect(screen.getByText("Current level: Auto")).toBeVisible();
    expect(screen.getByLabelText("Requested level")).toHaveTextContent("Auto");
  });

  it("shows current and requested levels and sends the authoritative version, then requires a fresh reading", async () => {
    const { spoke, changePosture, listPostures } = fixture({ status: "done", body: {} });
    const user = userEvent.setup();
    render(<OwnerPostureSection spokes={[spoke]} />);
    await user.click(screen.getByRole("button", { name: "Refresh access levels" }));
    await user.click(screen.getByLabelText("Recovery target"));
    await user.click(await screen.findByRole("option", { name: "Thread: Release task" }));
    expect(screen.getByText("Current level: Ask first")).toBeVisible();
    await user.click(screen.getByLabelText("Requested level"));
    await user.click(await screen.findByRole("option", { name: "Full access" }));
    await user.click(screen.getByRole("button", { name: "Apply level" }));
    expect(changePosture).toHaveBeenCalledWith({
      subject: target.posture.subject,
      expectedVersion: target.posture.version,
      posture: "full-access",
      persistence: "project-default",
    });
    expect(screen.queryByRole("button", { name: "Apply level" })).toBeNull();
    expect(listPostures).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("status")).toHaveTextContent("Level changed");
  });
  it("explains a changed target and discards its spent reading instead of retrying the write", async () => {
    const { spoke, changePosture } = fixture({ status: "refused", kind: "posture-stale" });
    const user = userEvent.setup();
    render(<OwnerPostureSection spokes={[spoke]} />);
    await user.click(screen.getByRole("button", { name: "Refresh access levels" }));
    await user.click(screen.getByLabelText("Recovery target"));
    await user.click(await screen.findByRole("option", { name: "Thread: Release task" }));
    await user.click(screen.getByLabelText("Requested level"));
    await user.click(await screen.findByRole("option", { name: "Plan (read only)" }));
    await user.click(screen.getByRole("button", { name: "Apply level" }));
    expect(screen.getByRole("status")).toHaveTextContent("Refresh its level");
    expect(changePosture).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("Recovery target")).toBeNull();
  });
});

describe("owner wake switches", () => {
  const wakeReading = (coordinatorWake?: boolean) => ({
    threadId: target.posture.subject.threadId,
    messageWake: false,
    ...(coordinatorWake === undefined ? {} : { coordinatorWake }),
    version: "c".repeat(64),
  });
  function wakeFixture(change: OwnerActionResult, coordinatorWake?: boolean) {
    const base = fixture({ status: "done", body: {} });
    const readThreadWake = vi.fn(
      async (): Promise<OwnerActionResult> => ({
        status: "done",
        body: { status: "read", wake: wakeReading(coordinatorWake) },
      }),
    );
    const changeThreadWake = vi.fn(async (): Promise<OwnerActionResult> => change);
    const spoke: OwnerSpoke = {
      ...base.spoke,
      client: { ...base.spoke.client, readThreadWake, changeThreadWake },
    };
    return { spoke, readThreadWake, changeThreadWake };
  }
  async function openWake(spoke: OwnerSpoke) {
    const user = userEvent.setup();
    render(<OwnerPostureSection spokes={[spoke]} />);
    await user.click(screen.getByRole("button", { name: "Refresh access levels" }));
    await user.click(screen.getByLabelText("Recovery target"));
    await user.click(await screen.findByRole("option", { name: "Thread: Release task" }));
    await user.click(screen.getByRole("button", { name: "Read wake switches" }));
    return user;
  }

  it("shows a worker's two switches and changes one against the reading shown, then drops it", async () => {
    const { spoke, readThreadWake, changeThreadWake } = wakeFixture(
      { status: "done", body: {} },
      true,
    );
    const user = await openWake(spoke);
    expect(readThreadWake).toHaveBeenCalledWith(target.posture.subject.threadId);
    expect(await screen.findByText("Wake when a message arrives: Off")).toBeVisible();
    expect(screen.getByText("Wake for coordinator: On")).toBeVisible();
    expect(screen.queryByText(/coordinator role/i)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Turn off Wake for coordinator" }));
    expect(changeThreadWake).toHaveBeenCalledWith({
      threadId: target.posture.subject.threadId,
      expectedVersion: "c".repeat(64),
      switch: "coordinator-wake",
      wake: false,
    });
    expect(screen.queryByRole("button", { name: /Turn (on|off)/ })).toBeNull();
    expect(screen.getByText(/Wake for coordinator is off/)).toBeVisible();
  });

  it("offers only Wake when a message arrives on a thread that is not a worker", async () => {
    const { spoke } = wakeFixture({ status: "done", body: {} });
    await openWake(spoke);
    expect(
      await screen.findByRole("button", { name: "Turn on Wake when a message arrives" }),
    ).toBeVisible();
    expect(screen.queryByText(/Wake for coordinator/)).toBeNull();
  });

  it.each([
    ["wake-stale", "Read its wake switches again"],
    ["not-a-worker", "not a coordinator's worker"],
    ["not-found", "no longer active"],
    ["refused", "needs its own fresh unlock"],
    ["own-unlock-required", "needs its own unlock"],
  ])("explains a %s refusal without retrying the change", async (kind, text) => {
    const { spoke, changeThreadWake } = wakeFixture({ status: "refused", kind }, true);
    const user = await openWake(spoke);
    await user.click(
      await screen.findByRole("button", { name: "Turn on Wake when a message arrives" }),
    );
    expect(screen.getByText(new RegExp(text))).toBeVisible();
    expect(changeThreadWake).toHaveBeenCalledTimes(1);
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
  await user.click(screen.getByLabelText("Recovery target"));
  await user.click(await screen.findByRole("option", { name: "Thread: Current task" }));
  await user.click(screen.getByLabelText("Requested level"));
  await user.click(await screen.findByRole("option", { name: "Full access" }));
}

describe("owner recovery across host changes", () => {
  it("can refresh the first computer when its roster arrives after mount", async () => {
    const { spoke, listPostures } = fixture({ status: "done", body: {} });
    const user = userEvent.setup();
    const view = render(<OwnerPostureSection spokes={[]} />);
    view.rerender(<OwnerPostureSection spokes={[spoke]} />);
    const refresh = screen.getByRole("button", { name: "Refresh access levels" });
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
      await user.click(screen.getByRole("button", { name: "Refresh access levels" }));
      if (replacement === "member") view.rerender(<OwnerPostureSection spokes={[]} />);
      view.rerender(<OwnerPostureSection spokes={[next.spoke]} />);
      expect(screen.getByRole("button", { name: "Refresh access levels" })).toBeEnabled();
      await user.click(screen.getByRole("button", { name: "Refresh access levels" }));
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
      await user.click(screen.getByRole("button", { name: "Apply level" }));
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
    await user.click(screen.getByRole("button", { name: "Refresh access levels" }));
    await user.click(screen.getByLabelText("Recovery target"));
    await user.click(await screen.findByRole("option", { name: "Thread: Release task" }));
    view.rerender(<OwnerPostureSection spokes={[next.spoke]} />);
    expect(screen.queryByText("Current level: Ask first")).toBeNull();
    expect(screen.queryByRole("button", { name: "Apply level" })).toBeNull();
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
    await user.click(screen.getByRole("button", { name: "Refresh access levels" }));
    await chooseCurrent(user);
    await user.click(screen.getByRole("button", { name: "Apply level" }));
    view.rerender(<OwnerPostureSection spokes={[next.spoke]} />);
    expect(screen.getByRole("button", { name: "Refresh access levels" })).toBeEnabled();
    await user.click(screen.getByRole("button", { name: "Refresh access levels" }));
    await chooseCurrent(user);
    await act(async () => {
      pending.resolve({ status: "done", body: {} });
    });
    expect(screen.getByRole("button", { name: "Apply level" })).toBeEnabled();
    expect(screen.queryByText(/Level changed/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Apply level" }));
    expect(next.changePosture).toHaveBeenCalledWith(
      expect.objectContaining({ expectedVersion: "b".repeat(64) }),
    );
  });
});
