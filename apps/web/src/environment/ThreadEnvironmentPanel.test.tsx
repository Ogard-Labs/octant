import {
  decodeEnvironmentCompactIdentity,
  decodeEnvironmentPresentationState,
  decodeWorkspaceTabId,
  type EnvironmentPresentationState,
} from "@octant/contracts";
import { LOCAL_HOST_ID } from "@octant/contracts";
import { defaultEnvironmentPresentationState } from "@octant/domain/shell-policy";
import { fireEvent, render, screen } from "@testing-library/react";
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
    byMode: { chat: "hidden", work: "floating", code: "floating" },
  });
}

describe("the thread environment panel", () => {
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
      screen.getByRole("button", { name: "Show environment panel for Local feature/name" }),
    ).toBeVisible();
    expect(screen.getByText("feature/name")).toBeVisible();
    expect(screen.getByText("available")).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("returns the same panel after hiding it and revealing it again", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const { rerender } = render(
      <ThreadEnvironmentPanel
        identity={identity}
        mode="code"
        presentation={baseState()}
        tabId={tabId}
        onChangePresentation={onChange}
      >
        <p>Checkout facts</p>
      </ThreadEnvironmentPanel>,
    );
    expect(screen.getByText("Checkout facts")).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Hide environment panel" }));
    const hidden: EnvironmentPresentationState = {
      ...baseState(),
      byTab: [{ tabId, presentation: "hidden" }],
    };
    expect(onChange).toHaveBeenLastCalledWith(hidden);

    rerender(
      <ThreadEnvironmentPanel
        identity={identity}
        mode="code"
        presentation={hidden}
        tabId={tabId}
        onChangePresentation={onChange}
      >
        <p>Checkout facts</p>
      </ThreadEnvironmentPanel>,
    );
    expect(screen.queryByText("Checkout facts")).not.toBeInTheDocument();

    // Revealing returns to the code-mode default, so the tab override clears.
    await user.click(
      screen.getByRole("button", { name: "Show environment panel for Local feature/name" }),
    );
    expect(onChange).toHaveBeenLastCalledWith({ ...baseState(), byTab: [] });

    rerender(
      <ThreadEnvironmentPanel
        identity={identity}
        mode="code"
        presentation={baseState()}
        tabId={tabId}
        onChangePresentation={onChange}
      >
        <p>Checkout facts</p>
      </ThreadEnvironmentPanel>,
    );
    expect(screen.getByText("Checkout facts")).toBeVisible();
  });

  it("hides the floating panel via Escape", () => {
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
    const dialog = screen.getByRole("dialog", { name: "Environment for Local" });
    dialog.focus();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(onChange).toHaveBeenLastCalledWith({
      ...baseState(),
      byTab: [{ tabId, presentation: "hidden" }],
    });
  });

  it("clears the tab override when returning to the mode default", () => {
    const onChange = vi.fn();
    const overridden: EnvironmentPresentationState = {
      ...baseState(),
      byTab: [{ tabId, presentation: "hidden" }],
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
    // The work default is floating, so revealing drops the override entirely.
    fireEvent.click(
      screen.getByRole("button", { name: "Show environment panel for Local feature/name" }),
    );
    expect(onChange).toHaveBeenLastCalledWith({ ...baseState(), byTab: [] });
  });

  it("does not render descriptor-only capability labels as dead controls", () => {
    render(
      <ThreadEnvironmentPanel
        identity={identity}
        mode="code"
        presentation={baseState()}
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
    render(
      <ThreadEnvironmentPanel
        identity={identity}
        mode="code"
        presentation={baseline}
        tabId={tabId}
        onChangePresentation={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide environment panel" }));
    expect(baseline.byTab).toHaveLength(0);
  });

  it("focuses the floating panel on mount for keyboard restore", () => {
    render(
      <ThreadEnvironmentPanel
        identity={identity}
        mode="code"
        presentation={baseState()}
        tabId={tabId}
        onChangePresentation={vi.fn()}
      />,
    );
    const dialog = screen.getByRole("dialog", { name: "Environment for Local" });
    expect(document.activeElement).toBe(dialog);
  });

  it("offers no way to dock the panel into the thread row", () => {
    render(
      <ThreadEnvironmentPanel
        identity={identity}
        mode="code"
        presentation={baseState()}
        tabId={tabId}
        onChangePresentation={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Pin environment" })).not.toBeInTheDocument();
    expect(screen.queryByRole("separator")).not.toBeInTheDocument();
  });
});
