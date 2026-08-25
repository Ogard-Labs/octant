import type { AgentProfile, ExecutionResolutionReceipt } from "@octant/contracts/agent-profile";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ExecutionProfileWorkflow } from "./ExecutionProfileWorkflow";
import type { ExecutionProfileController } from "./useExecutionProfileController";

const profile: AgentProfile = {
  id: "00000000-0000-4000-8000-000000000002" as never,
  displayName: "Code reviewer",
  description: "Read-only review defaults",
  approvedSkillIds: [],
  toolConstraints: [],
  modelConstraints: [],
  defaultExecutionPolicy: "plan",
  defaultPermissionPersistence: "current-session",
  compatibleModes: ["code"],
  version: 1 as never,
  createdAt: "2026-07-28T12:00:00.000Z" as never,
  updatedAt: "2026-07-28T12:00:00.000Z" as never,
};

const receipt: ExecutionResolutionReceipt = {
  providerInstanceId: "00000000-0000-4000-8000-000000000001" as never,
  modelId: "gpt-5" as never,
  profileId: profile.id,
  hostId: "local" as never,
  executionPolicy: "plan",
  permissionPersistence: "current-session",
  effectivePermissions: {
    filesystem: false,
    shell: false,
    git: false,
    network: false,
    tools: false,
    subagents: false,
  },
  source: "one-off-override",
  fallbackChain: ["one-off-override", "project-default", "mode-default", "user-default"],
  downgradeReasons: [],
};

function controller(
  overrides: Partial<ExecutionProfileController> = {},
): ExecutionProfileController {
  return {
    profiles: [profile],
    entries: [
      {
        providerInstanceId: receipt.providerInstanceId,
        providerDisplayName: "OpenAI",
        modelId: receipt.modelId,
        modelDisplayName: "GPT-5",
        profileId: profile.id,
        profileDisplayName: profile.displayName,
        hostId: receipt.hostId,
        hostLabel: "This Mac",
        executionPolicy: "plan",
        effectivePermissions: receipt.effectivePermissions,
      },
    ],
    selectedEntry: undefined,
    selectedProfile: profile,
    receipt,
    mode: "code",
    scope: { scopeKind: "mode", scopeRef: "code" },
    status: "resolved",
    busy: false,
    message: undefined,
    selectEntry: vi.fn(),
    selectProfile: vi.fn(),
    createProfile: vi.fn(async () => undefined),
    updateProfile: vi.fn(async () => undefined),
    deleteProfile: vi.fn(async () => undefined),
    reload: vi.fn(async () => undefined),
    ...overrides,
  } as ExecutionProfileController;
}

describe("ExecutionProfileWorkflow", () => {
  it("shows provider, model, profile, host, permissions, and resolution receipt", async () => {
    const user = userEvent.setup();
    render(<ExecutionProfileWorkflow controller={controller()} variant="composer" />);

    expect(screen.getByRole("button", { name: "Execution profile: Code reviewer" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Execution profile: Code reviewer" }));
    expect(screen.getAllByText("OpenAI").length).toBeGreaterThan(0);
    expect(screen.getAllByText("GPT-5").length).toBeGreaterThan(0);
    expect(screen.getAllByText("This Mac").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Read-only").length).toBeGreaterThan(0);
    expect(screen.getByText("One-off override")).toBeVisible();
    expect(
      screen.getByText(/one-off override → Project default → mode default → user default/i),
    ).toBeVisible();
  });

  it("closes the composer popover on Escape and returns focus to the trigger", async () => {
    const user = userEvent.setup();
    render(<ExecutionProfileWorkflow controller={controller()} variant="composer" />);
    const trigger = screen.getByRole("button", { name: "Execution profile: Code reviewer" });

    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "Execution profile options" })).toBeVisible();

    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Execution profile options" })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("closes the composer popover on an outside pointer press", async () => {
    const user = userEvent.setup();
    render(
      <div>
        <button type="button">Outside</button>
        <ExecutionProfileWorkflow controller={controller()} variant="composer" />
      </div>,
    );

    await user.click(screen.getByRole("button", { name: "Execution profile: Code reviewer" }));
    expect(screen.getByRole("dialog", { name: "Execution profile options" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("dialog", { name: "Execution profile options" })).toBeNull();
  });

  it("keeps the composer popover open while the pointer goes down inside it", async () => {
    const user = userEvent.setup();
    render(<ExecutionProfileWorkflow controller={controller()} variant="composer" />);

    await user.click(screen.getByRole("button", { name: "Execution profile: Code reviewer" }));
    const popover = screen.getByRole("dialog", { name: "Execution profile options" });

    fireEvent.pointerDown(
      screen.getByRole("searchbox", { name: "Search providers, models, and profiles" }),
    );
    expect(popover).toBeVisible();
  });

  it("brings the composer popover back when a profile dialog it opened is dismissed", async () => {
    const user = userEvent.setup();
    render(<ExecutionProfileWorkflow controller={controller()} variant="composer" />);

    await user.click(screen.getByRole("button", { name: "Execution profile: Code reviewer" }));
    expect(screen.getByRole("dialog", { name: "Execution profile options" })).toBeVisible();

    // The form is a sibling that portals out of the popup, so the press that
    // opens it reads as a press outside — and closing on that would leave the
    // reader with nothing behind the form they opened from the list.
    await user.click(screen.getByRole("button", { name: "Create profile" }));
    await screen.findByRole("dialog", { name: /profile/i });
    await user.keyboard("{Escape}");

    expect(screen.getByRole("dialog", { name: "Execution profile options" })).toBeVisible();
  });

  it("shows actionable unsupported resolution reasons", () => {
    render(
      <ExecutionProfileWorkflow
        controller={controller({
          status: "unsupported",
          message:
            "Model is not allowed by the profile's model constraints. Choose another provider, model, or profile.",
        })}
        variant="settings"
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("Model is not allowed");
    expect(screen.getByRole("alert")).toHaveTextContent("Choose another provider");
  });

  it("exposes create, edit, and guarded delete actions in settings", async () => {
    const user = userEvent.setup();
    const value = controller();
    render(<ExecutionProfileWorkflow controller={value} variant="settings" />);

    await user.click(screen.getByRole("button", { name: "Create profile" }));
    expect(await screen.findByRole("dialog", { name: "Create execution profile" })).toBeVisible();
    await user.type(screen.getByRole("textbox", { name: "Profile name" }), "Researcher");
    await user.click(screen.getByRole("button", { name: "Save new profile" }));
    expect(value.createProfile).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "Researcher" }),
    );

    await user.click(screen.getByRole("button", { name: "Edit Code reviewer" }));
    const name = await screen.findByRole("textbox", { name: "Profile name" });
    await user.clear(name);
    await user.type(name, "Focused reviewer");
    await user.click(screen.getByRole("button", { name: "Save profile changes" }));
    expect(value.updateProfile).toHaveBeenCalledWith(
      expect.objectContaining({ displayName: "Focused reviewer" }),
    );

    await user.click(screen.getByRole("button", { name: "Delete Code reviewer" }));
    expect(await screen.findByText("Delete this profile? This cannot be undone.")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Confirm delete Code reviewer" }));
    expect(value.deleteProfile).toHaveBeenCalledWith(profile);
  });
});
