import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
    await user.selectOptions(
      screen.getByLabelText("Code recovery target"),
      JSON.stringify(target.posture.subject),
    );
    expect(screen.getByText("Current level: Auto")).toBeVisible();
    expect(screen.getByRole("option", { name: "Auto", selected: true })).toBeVisible();
  });

  it("shows current and requested levels and sends the authoritative version, then requires a fresh reading", async () => {
    const { spoke, changePosture, listPostures } = fixture({ status: "done", body: {} });
    const user = userEvent.setup();
    render(<OwnerPostureSection spokes={[spoke]} />);
    await user.click(screen.getByRole("button", { name: "Refresh Code levels" }));
    await user.selectOptions(
      screen.getByLabelText("Code recovery target"),
      JSON.stringify(target.posture.subject),
    );
    expect(screen.getByText("Current level: Ask first")).toBeVisible();
    await user.selectOptions(screen.getByLabelText("Requested Code level"), "full-access");
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
    await user.selectOptions(
      screen.getByLabelText("Code recovery target"),
      JSON.stringify(target.posture.subject),
    );
    await user.selectOptions(screen.getByLabelText("Requested Code level"), "plan");
    await user.click(screen.getByRole("button", { name: "Apply Code level" }));
    expect(screen.getByRole("status")).toHaveTextContent("Refresh its level");
    expect(changePosture).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("Code recovery target")).toBeNull();
  });
});
