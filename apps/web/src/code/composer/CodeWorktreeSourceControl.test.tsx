import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type {
  WorktreeRemoteFacts,
  WorktreeSourceResolution,
} from "@octant/domain/code-worktree-source-policy";
import { chooseSelectFieldOption } from "../../test/chooseSelectFieldOption";
import { CodeWorktreeSourceControl } from "./CodeWorktreeSourceControl";

const FULL_SHA = "a1b2c3d4e5f60718293a4b5c6d7e8f9011223344";
const FETCHED_AT = "2026-07-30T08:00:00.000Z";
const now = () => new Date("2026-07-30T08:05:00.000Z");

const originResolution: WorktreeSourceResolution = {
  kind: "origin",
  remoteName: "origin",
  branch: "development",
  resolvedHead: FULL_SHA,
  fetchedAt: FETCHED_AT,
};

function renderControl(
  overrides: Partial<React.ComponentProps<typeof CodeWorktreeSourceControl>> = {},
) {
  const remoteFacts: WorktreeRemoteFacts = { remotes: ["origin"], defaultRemote: "origin" };
  return render(
    <CodeWorktreeSourceControl
      branch="development"
      now={now}
      onStartFromOriginChange={() => {}}
      remoteFacts={remoteFacts}
      resolution={originResolution}
      startFromOrigin
      {...overrides}
    />,
  );
}

describe("CodeWorktreeSourceControl", () => {
  it("renders a default-enabled Start from origin switch with exact operation copy", () => {
    renderControl();
    const control = screen.getByRole("switch", { name: "Start from origin" });
    expect(control).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Fetch and start from origin/development")).toBeDefined();
  });

  it("discloses the exact resolved remote branch and short SHA", () => {
    renderControl();
    expect(screen.getByText("origin/development · a1b2c3d")).toBeDefined();
  });

  it("disables the switch with an explanation when no usable remote exists", () => {
    renderControl({
      remoteFacts: { remotes: [] },
      startFromOrigin: false,
      resolution: { kind: "local", branch: "development", resolvedHead: FULL_SHA },
    });
    const control = screen.getByRole("switch", { name: "Start from origin" });
    expect(control).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText(/No usable remote is configured for this branch/)).toBeDefined();
  });

  it("labels a disabled source as local and warns it may differ from the remote", () => {
    renderControl({
      startFromOrigin: false,
      resolution: {
        kind: "local",
        branch: "development",
        resolvedHead: FULL_SHA,
        remoteName: "origin",
      },
    });
    expect(screen.getByText("Local development · a1b2c3d")).toBeDefined();
    expect(screen.getByText("may differ from origin")).toBeDefined();
  });

  it("notifies when the switch is toggled off", async () => {
    const user = userEvent.setup();
    const onStartFromOriginChange = vi.fn();
    renderControl({ onStartFromOriginChange });
    await user.click(screen.getByRole("switch", { name: "Start from origin" }));
    expect(onStartFromOriginChange).toHaveBeenLastCalledWith(false);
  });

  it("offers remote selection listing the configured remotes", async () => {
    const user = userEvent.setup();
    const onSelectRemote = vi.fn();
    renderControl({
      remoteFacts: { remotes: ["origin", "upstream"], defaultRemote: "origin" },
      onSelectRemote,
      selectedRemote: "origin",
    });
    const remote = screen.getByLabelText("Remote");
    expect(remote).toHaveTextContent("origin");
    await chooseSelectFieldOption(user, remote, "upstream");
    expect(onSelectRemote).toHaveBeenLastCalledWith("upstream");
  });

  it("surfaces actionable failure copy without a silent local fallback", () => {
    renderControl({ resolution: { kind: "failed", reason: "fetch-rejected" } });
    expect(screen.getByText("Fetch failed")).toBeDefined();
    expect(screen.getByText(/credentials/)).toBeDefined();
  });

  it("offers an explicit retry when a fetch fails", async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    renderControl({ onRefresh, resolution: { kind: "failed", reason: "fetch-rejected" } });
    await user.click(screen.getByRole("button", { name: "Retry fetch" }));
    expect(onRefresh).toHaveBeenCalled();
  });
});
