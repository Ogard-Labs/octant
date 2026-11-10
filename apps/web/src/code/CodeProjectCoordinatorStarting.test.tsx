import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { decodeProjectId } from "@octant/contracts";
import { describe, expect, it, vi } from "vitest";
import { chooseSelectFieldOption } from "../test/chooseSelectFieldOption.test-support";
import { CodeProjectCoordinatorStarting } from "./CodeProjectCoordinatorStarting";

const projectId = decodeProjectId("10000000-0000-4000-8000-000000000001");
const otherProjectId = decodeProjectId("10000000-0000-4000-8000-000000000002");

function controller(settings: Record<string, unknown>) {
  const updateSettings = vi.fn(async () => true);
  return {
    updateSettings,
    controller: {
      status: "ready" as const,
      updateSettings,
      bootstrap: {
        settings: {
          defaultExecutionPolicy: "approval-gated",
          defaultPermissionPersistence: "current-session",
          version: 1,
          updatedAt: "2026-11-10T12:00:00.000Z",
          ...settings,
        },
      },
    } as never,
  };
}

describe("CodeProjectCoordinatorStarting", () => {
  it("gives this Project its own Starting workers choice and keeps other Projects' choices", async () => {
    const { controller: code, updateSettings } = controller({
      coordinatorStartingByProject: { [otherProjectId]: "start-without-asking" },
    });
    render(<CodeProjectCoordinatorStarting controller={code} projectId={projectId} />);
    const choice = screen.getByRole("combobox", { name: "Starting workers in this Project" });
    expect(choice).toHaveTextContent("Use Settings (Start without asking)");

    await chooseSelectFieldOption(userEvent.setup(), choice, "Propose for approval");

    expect(updateSettings).toHaveBeenCalledWith({
      defaultExecutionPolicy: "approval-gated",
      defaultPermissionPersistence: "current-session",
      coordinatorStartingByProject: {
        [otherProjectId]: "start-without-asking",
        [projectId]: "propose-for-approval",
      },
    });
  });

  it("removes this Project's entry when it goes back to Use Settings", async () => {
    const { controller: code, updateSettings } = controller({
      coordinatorStarting: "propose-for-approval",
      coordinatorStartingByProject: { [projectId]: "start-without-asking" },
    });
    render(<CodeProjectCoordinatorStarting controller={code} projectId={projectId} />);
    const choice = screen.getByRole("combobox", { name: "Starting workers in this Project" });
    expect(choice).toHaveTextContent("Start without asking");

    await chooseSelectFieldOption(userEvent.setup(), choice, "Use Settings (Propose for approval)");

    expect(updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({ coordinatorStartingByProject: {} }),
    );
  });
});
