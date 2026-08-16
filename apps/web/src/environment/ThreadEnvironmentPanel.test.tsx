import {
  decodeEnvironmentCompactIdentity,
  decodeEnvironmentPresentationState,
  decodeWorkspaceTabId,
  type EnvironmentPresentationState,
} from "@octant/contracts";
import { LOCAL_HOST_ID } from "@octant/contracts";
import { defaultEnvironmentPresentationState } from "@octant/domain/shell-policy";
import { fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ThreadEnvironmentPanel } from "./ThreadEnvironmentPanel";

const tabId = decodeWorkspaceTabId("30000000-0000-4000-8000-00000000000a");

const identity = decodeEnvironmentCompactIdentity({
  host: LOCAL_HOST_ID,
  label: "Local",
  detail: "feature/name",
  status: "available",
});

function baseState(): EnvironmentPresentationState {
  return decodeEnvironmentPresentationState({
    byTab: [],
    byMode: { chat: "hidden", work: "floating", code: "pinned" },
  });
}

describe("ThreadEnvironmentPanel", () => {
  it("renders a reveal control when the effective presentation is hidden", () => {
    const onChange = vi.fn();
    render(
      <ThreadEnvironmentPanel
        identity={identity}
        mode="chat"
        presentation={baseState()}
        tabId={tabId}
        onChangePresentation={onChange}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Show environment for Local feature/name" }),
    ).toBeVisible();
    expect(screen.getByText("feature/name")).toBeVisible();
    expect(screen.getByText("available")).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("reveals as floating and then pins, dispatching the tab override", async () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <ThreadEnvironmentPanel
        identity={identity}
        mode="code"
        presentation={baseState()}
        tabId={tabId}
        onChangePresentation={onChange}
      />,
    );
    // code default is pinned, so we first float to verify floating render
    expect(screen.getByLabelText("Environment for Local")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Float environment" }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...baseState(),
      byTab: [{ tabId, presentation: "floating", pinnedWidth: 360 }],
    });

    const floated: EnvironmentPresentationState = {
      ...baseState(),
      byTab: [{ tabId, presentation: "floating", pinnedWidth: 360 }],
    };
    rerender(
      <ThreadEnvironmentPanel
        identity={identity}
        mode="code"
        presentation={floated}
        tabId={tabId}
        onChangePresentation={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Pin environment" }));
    // Pinning back to the code-mode default clears the tab override.
    expect(onChange).toHaveBeenLastCalledWith({
      ...baseState(),
      byTab: [],
    });
  });

  it("hides from the floating panel via Escape", () => {
    const onChange = vi.fn();
    const floated: EnvironmentPresentationState = {
      ...baseState(),
      byTab: [{ tabId, presentation: "floating", pinnedWidth: 360 }],
    };
    render(
      <ThreadEnvironmentPanel
        identity={identity}
        mode="code"
        presentation={floated}
        tabId={tabId}
        onChangePresentation={onChange}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Environment for Local" });
    dialog.focus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onChange).toHaveBeenLastCalledWith({
      ...baseState(),
      byTab: [{ tabId, presentation: "hidden", pinnedWidth: 360 }],
    });
  });

  it("clears the tab override when returning to the mode default", () => {
    const onChange = vi.fn();
    const overridden: EnvironmentPresentationState = {
      ...baseState(),
      byTab: [{ tabId, presentation: "floating", pinnedWidth: 360 }],
    };
    render(
      <ThreadEnvironmentPanel
        identity={identity}
        mode="work"
        presentation={overridden}
        tabId={tabId}
        onChangePresentation={onChange}
      />,
    );
    // work default is floating, so pinning then floating should clear the override
    fireEvent.click(screen.getByRole("button", { name: "Pin environment" }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...baseState(),
      byTab: [{ tabId, presentation: "pinned", pinnedWidth: 360 }],
    });
  });

  it("does not render descriptor-only capability labels as dead controls", () => {
    const floated: EnvironmentPresentationState = {
      ...baseState(),
      byTab: [{ tabId, presentation: "floating", pinnedWidth: 360 }],
    };
    render(
      <ThreadEnvironmentPanel
        identity={identity}
        mode="code"
        presentation={floated}
        tabId={tabId}
        onChangePresentation={vi.fn()}
      />,
    );
    expect(screen.queryByText("Confined root")).not.toBeInTheDocument();
    expect(screen.queryByText("No root")).not.toBeInTheDocument();
    expect(screen.queryByText("Git")).not.toBeInTheDocument();
    expect(screen.queryByText("Changes")).not.toBeInTheDocument();
  });

  it("does not mutate the default presentation state", () => {
    const baseline = defaultEnvironmentPresentationState();
    const onChange = vi.fn();
    render(
      <ThreadEnvironmentPanel
        identity={identity}
        mode="code"
        presentation={baseline}
        tabId={tabId}
        onChangePresentation={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Float environment" }));
    expect(baseline.byTab).toHaveLength(0);
  });

  it("focuses the floating panel on mount for keyboard restore", () => {
    const floated: EnvironmentPresentationState = {
      ...baseState(),
      byTab: [{ tabId, presentation: "floating", pinnedWidth: 360 }],
    };
    render(
      <ThreadEnvironmentPanel
        identity={identity}
        mode="code"
        presentation={floated}
        tabId={tabId}
        onChangePresentation={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Environment for Local" });
    expect(document.activeElement).toBe(dialog);
  });

  it("hides from the pinned panel via the hide button", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <ThreadEnvironmentPanel
        identity={identity}
        mode="code"
        presentation={baseState()}
        tabId={tabId}
        onChangePresentation={onChange}
      />,
    );
    await user.click(screen.getByRole("button", { name: "Hide environment" }));
    expect(onChange).toHaveBeenLastCalledWith({
      ...baseState(),
      byTab: [{ tabId, presentation: "hidden", pinnedWidth: 360 }],
    });
  });

  it("resizes the pinned rail by dragging the separator, committing only on release", () => {
    const onChange = vi.fn();
    render(
      <ThreadEnvironmentPanel
        identity={identity}
        mode="code"
        presentation={baseState()}
        tabId={tabId}
        onChangePresentation={onChange}
      />,
    );
    const separator = screen.getByRole("separator");
    fireEvent.mouseDown(separator, { clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 420 });
    // No commit during the drag — only a local preview.
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.mouseUp(window);
    // Dragging left by 80px increases width by 80 (trailing rail on the right).
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({
      ...baseState(),
      byTab: [{ tabId, presentation: "pinned", pinnedWidth: 440 }],
    });
  });

  it("clamps resize widths to the domain minimum", () => {
    const onChange = vi.fn();
    render(
      <ThreadEnvironmentPanel
        identity={identity}
        mode="code"
        presentation={baseState()}
        tabId={tabId}
        onChangePresentation={onChange}
      />,
    );
    const separator = screen.getByRole("separator");
    // Drag far right to shrink below the minimum; the commit should be clamped.
    fireEvent.mouseDown(separator, { clientX: 500 });
    fireEvent.mouseMove(window, { clientX: 1000 });
    fireEvent.mouseUp(window);
    expect(onChange).toHaveBeenCalledTimes(1);
    const committed = onChange.mock.calls[0]?.[0];
    expect(committed?.byTab[0]?.pinnedWidth).toBeGreaterThanOrEqual(240);
  });

  it("presents a saved pinned Environment as a contained overlay on narrow web viewports", () => {
    const styles = readFileSync(resolve(process.cwd(), "src/styles.css"), "utf8");
    expect(styles).toMatch(
      /\.thread-environment-panel \{[^}]*background: var\(--octant-surface-raised\);/,
    );
    expect(styles).toMatch(
      /@media \(max-width: 680px\)[\s\S]*\.thread-environment-wrapper--pinned \.thread-environment-panel--pinned[\s\S]*position: absolute;[\s\S]*inset: 8px;[\s\S]*width: auto !important;/,
    );
    expect(styles).toMatch(
      /@media \(max-width: 680px\)[\s\S]*\.thread-environment-wrapper--pinned \.thread-environment-panel__resizer[\s\S]*display: none;/,
    );
  });
});
