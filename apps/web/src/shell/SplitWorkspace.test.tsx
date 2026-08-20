import type { WorkspaceLayoutNode } from "@octant/contracts/shell";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { splitCallbacks, splitLayout } from "../App.test-fixtures";
import { SplitWorkspace, type SplitWorkspaceProps } from "./SplitWorkspace";

const firstGroup = {
  kind: "group" as const,
  nodeId: "00000000-0000-4000-8000-000000000921" as never,
  groupId: "00000000-0000-4000-8000-000000000922" as never,
  activeTabId: "00000000-0000-4000-8000-000000000923" as never,
  tabs: [
    {
      kind: "welcome" as const,
      id: "00000000-0000-4000-8000-000000000923" as never,
      mode: "code" as const,
      title: "Conversation",
    },
  ],
};

const secondGroup = {
  kind: "group" as const,
  nodeId: "00000000-0000-4000-8000-000000000924" as never,
  groupId: "00000000-0000-4000-8000-000000000925" as never,
  activeTabId: "00000000-0000-4000-8000-000000000926" as never,
  tabs: [
    {
      kind: "welcome" as const,
      id: "00000000-0000-4000-8000-000000000926" as never,
      mode: "code" as const,
      title: "Files",
    },
  ],
};

const layout: WorkspaceLayoutNode = {
  kind: "split",
  nodeId: "00000000-0000-4000-8000-000000000927" as never,
  orientation: "horizontal",
  ratio: 0.5 as never,
  first: firstGroup,
  second: secondGroup,
};

function callbacks(): Omit<SplitWorkspaceProps, "layout" | "renderTab"> {
  return {
    focusedGroupId: firstGroup.groupId,
    mode: "code",
    onActivate: vi.fn(),
    onClearFocus: vi.fn(),
    onClose: vi.fn(),
    onCommitResize: vi.fn(),
    onFocus: vi.fn(),
    onDropTab: vi.fn(),
    onMove: vi.fn(),
    onPreviewResize: vi.fn(),
    onReorder: vi.fn(),
    onSplit: vi.fn(),
    totalWorkspaceGroupCount: 4,
  };
}

describe("SplitWorkspace", () => {
  it("marks focused panes and puts pane operations in a keyboard disclosure", async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    const { container } = render(
      <SplitWorkspace {...handlers} layout={layout} renderTab={(tab) => tab.title} />,
    );

    expect(screen.getByRole("region", { name: "Tab group: Conversation" })).toHaveAttribute(
      "data-focused",
      "true",
    );
    expect(container.querySelector(".workspace-group__actions")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show all groups" })).not.toBeInTheDocument();

    const paneActions = screen.getByRole("button", { name: "Pane actions for Conversation" });
    await user.click(paneActions);
    expect(screen.getByRole("button", { name: "Show all groups" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Move active tab to next group" }));
    expect(handlers.onMove).toHaveBeenCalledWith(
      firstGroup.groupId,
      secondGroup.groupId,
      firstGroup.activeTabId,
      1,
    );
    expect(paneActions).toHaveFocus();
  });

  it("restores pane-action focus when moving a tab remounts the destination group", async () => {
    const user = userEvent.setup();
    const handlers = callbacks();
    const movedLayout: WorkspaceLayoutNode = {
      ...secondGroup,
      activeTabId: firstGroup.activeTabId,
      tabs: [...secondGroup.tabs, firstGroup.tabs[0]!],
    };

    function StatefulWorkspace() {
      const [currentLayout, setCurrentLayout] = useState<WorkspaceLayoutNode>(layout);
      return (
        <SplitWorkspace
          {...handlers}
          layout={currentLayout}
          onMove={() => setCurrentLayout(movedLayout)}
          renderTab={(tab) => tab.title}
        />
      );
    }

    render(<StatefulWorkspace />);
    const paneActions = screen.getByRole("button", { name: "Pane actions for Conversation" });
    await user.click(paneActions);
    await user.click(screen.getByRole("button", { name: "Move active tab to next group" }));

    expect(screen.getByRole("button", { name: "Pane actions for Conversation" })).toHaveFocus();
  });

  it("keeps the splitter keyboard-operable inside a quiet hit target", () => {
    const handlers = callbacks();
    const { container } = render(
      <SplitWorkspace {...handlers} layout={layout} renderTab={(tab) => tab.title} />,
    );

    const resize = screen.getByRole("slider", { name: "Resize split" });
    expect(resize.closest("label")).toHaveClass("workspace-split__resize");
    fireEvent.change(resize, { target: { value: "0.6" } });
    fireEvent.keyUp(resize, { key: "ArrowRight", target: { value: "0.6" } });
    expect(handlers.onPreviewResize).toHaveBeenCalledWith(layout.nodeId, 0.6);
    expect(handlers.onCommitResize).toHaveBeenCalledWith(layout.nodeId, 0.6);
    expect(screen.getAllByRole("region", { name: /Tab group:/ })).toHaveLength(2);
    expect(screen.getAllByRole("slider", { name: "Resize split" })).toHaveLength(1);
    const firstPanel = screen.getAllByRole("tabpanel")[0]!;
    expect(firstPanel).toHaveAttribute("id", `workspace-panel-${firstGroup.activeTabId}`);
    expect(firstPanel).toHaveAttribute(
      "aria-labelledby",
      `workspace-tab-${firstGroup.activeTabId}`,
    );
    expect(container.querySelector(".workspace-group--contextual")).not.toBeInTheDocument();
    expect(container.querySelector(".workspace-split--contextual")).not.toBeInTheDocument();
    expect(screen.queryByText("Environment")).not.toBeInTheDocument();
  });

  it("measures repeated pointer resizes against the full split instead of the narrow gutter", () => {
    const handlers = callbacks();
    render(<SplitWorkspace {...handlers} layout={layout} renderTab={(tab) => tab.title} />);

    const split = screen.getByRole("group", { name: "horizontal workspace split" });
    const resize = screen.getByRole("slider", { name: "Resize split" }).closest("label")!;
    Object.assign(split, { getBoundingClientRect: () => rect(0, 0, 800, 600) });
    Object.assign(resize, {
      hasPointerCapture: vi.fn(() => true),
      releasePointerCapture: vi.fn(),
      setPointerCapture: vi.fn(),
    });

    fireEvent.pointerDown(resize, { button: 0, clientX: 400, pointerId: 41 });
    fireEvent.pointerMove(resize, { clientX: 520, pointerId: 41 });
    expect(handlers.onPreviewResize).toHaveBeenLastCalledWith(layout.nodeId, 0.65);
    fireEvent.pointerUp(resize, { clientX: 520, pointerId: 41 });
    expect(handlers.onCommitResize).toHaveBeenLastCalledWith(layout.nodeId, 0.65);

    fireEvent.pointerDown(resize, { button: 0, clientX: 520, pointerId: 42 });
    fireEvent.pointerMove(resize, { clientX: 360, pointerId: 42 });
    expect(handlers.onPreviewResize).toHaveBeenLastCalledWith(layout.nodeId, 0.45);
    fireEvent.pointerUp(resize, { clientX: 360, pointerId: 42 });
    expect(handlers.onCommitResize).toHaveBeenLastCalledWith(layout.nodeId, 0.45);
  });

  it("restores the committed ratio on Escape and permits a fresh resize", () => {
    const handlers = callbacks();
    render(<SplitWorkspace {...handlers} layout={layout} renderTab={(tab) => tab.title} />);

    const split = screen.getByRole("group", { name: "horizontal workspace split" });
    const resize = screen.getByRole("slider", { name: "Resize split" }).closest("label")!;
    Object.assign(split, { getBoundingClientRect: () => rect(0, 0, 800, 600) });

    fireEvent.pointerDown(resize, { button: 0, clientX: 400, pointerId: 43 });
    fireEvent.pointerMove(resize, { clientX: 520, pointerId: 43 });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(handlers.onPreviewResize).toHaveBeenLastCalledWith(layout.nodeId, 0.5);
    expect(handlers.onCommitResize).not.toHaveBeenCalled();

    fireEvent.pointerDown(resize, { button: 0, clientX: 400, pointerId: 44 });
    fireEvent.pointerMove(resize, { clientX: 480, pointerId: 44 });
    fireEvent.pointerUp(resize, { clientX: 480, pointerId: 44 });
    expect(handlers.onCommitResize).toHaveBeenCalledOnce();
    expect(handlers.onCommitResize).toHaveBeenCalledWith(layout.nodeId, 0.6);
  });

  it("disables edge docking when the workspace-wide group limit is reached", () => {
    const handlers = callbacks();
    const { container } = render(
      <SplitWorkspace
        {...handlers}
        layout={layout}
        renderTab={(tab) => tab.title}
        totalWorkspaceGroupCount={8}
      />,
    );

    expect(
      container.querySelector(`[data-workspace-group-id="${secondGroup.groupId}"]`),
    ).toHaveAttribute("data-workspace-can-split", "false");
  });

  it("starts after the pointer threshold and commits one directional drop", () => {
    const { focusedGroupId: _focusedGroupId, ...handlers } = callbacks();
    const { container } = render(
      <SplitWorkspace {...handlers} layout={layout} renderTab={(tab) => tab.title} />,
    );
    const root = container.querySelector<HTMLElement>(".workspace-root")!;
    const groups = container.querySelectorAll<HTMLElement>(".workspace-group");
    const strips = container.querySelectorAll<HTMLElement>(".workspace-tabs");
    const tabs = container.querySelectorAll<HTMLElement>(".workspace-tab");
    Object.assign(root, { getBoundingClientRect: () => rect(0, 0, 800, 600) });
    Object.assign(groups[0]!, { getBoundingClientRect: () => rect(0, 0, 400, 600) });
    Object.assign(groups[1]!, { getBoundingClientRect: () => rect(400, 0, 400, 600) });
    Object.assign(strips[0]!, { getBoundingClientRect: () => rect(0, 0, 400, 34) });
    Object.assign(strips[1]!, { getBoundingClientRect: () => rect(400, 0, 400, 34) });
    Object.assign(tabs[0]!, {
      getBoundingClientRect: () => rect(0, 0, 100, 34),
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
    });
    Object.assign(tabs[1]!, { getBoundingClientRect: () => rect(400, 0, 100, 34) });

    fireEvent.pointerDown(tabs[0]!, { button: 0, clientX: 50, clientY: 16, pointerId: 7 });
    fireEvent.pointerMove(tabs[0]!, { clientX: 53, clientY: 18, pointerId: 7 });
    expect(handlers.onDropTab).not.toHaveBeenCalled();
    fireEvent.pointerMove(tabs[0]!, { clientX: 410, clientY: 300, pointerId: 7 });
    expect(screen.getByRole("status")).toHaveTextContent(/dock conversation left/i);
    fireEvent.pointerUp(tabs[0]!, { clientX: 410, clientY: 300, pointerId: 7 });

    expect(handlers.onDropTab).toHaveBeenCalledOnce();
    expect(handlers.onDropTab).toHaveBeenCalledWith({
      kind: "edge",
      sourceGroupId: firstGroup.groupId,
      targetGroupId: secondGroup.groupId,
      tabId: firstGroup.activeTabId,
      edge: "left",
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("cancels an active tab drag on Escape without committing", () => {
    const { focusedGroupId: _focusedGroupId, ...handlers } = callbacks();
    const { container } = render(
      <SplitWorkspace {...handlers} layout={layout} renderTab={(tab) => tab.title} />,
    );
    const root = container.querySelector<HTMLElement>(".workspace-root")!;
    const groups = container.querySelectorAll<HTMLElement>(".workspace-group");
    const strips = container.querySelectorAll<HTMLElement>(".workspace-tabs");
    const tabs = container.querySelectorAll<HTMLElement>(".workspace-tab");
    Object.assign(root, { getBoundingClientRect: () => rect(0, 0, 800, 600) });
    Object.assign(groups[0]!, { getBoundingClientRect: () => rect(0, 0, 400, 600) });
    Object.assign(groups[1]!, { getBoundingClientRect: () => rect(400, 0, 400, 600) });
    Object.assign(strips[0]!, { getBoundingClientRect: () => rect(0, 0, 400, 34) });
    Object.assign(strips[1]!, { getBoundingClientRect: () => rect(400, 0, 400, 34) });
    Object.assign(tabs[0]!, {
      getBoundingClientRect: () => rect(0, 0, 100, 34),
      setPointerCapture: vi.fn(),
      releasePointerCapture: vi.fn(),
    });
    Object.assign(tabs[1]!, { getBoundingClientRect: () => rect(400, 0, 100, 34) });

    fireEvent.pointerDown(tabs[0]!, { button: 0, clientX: 50, clientY: 16, pointerId: 8 });
    fireEvent.pointerMove(tabs[0]!, { clientX: 600, clientY: 300, pointerId: 8 });
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.pointerUp(tabs[0]!, { clientX: 600, clientY: 300, pointerId: 8 });

    expect(handlers.onDropTab).not.toHaveBeenCalled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("renders orientation and preview ratio as geometry and commits resize only on release", () => {
    const callbacks = splitCallbacks();
    const { rerender } = render(
      <SplitWorkspace {...callbacks} layout={splitLayout()} renderTab={(tab) => tab.title} />,
    );
    const horizontal = screen.getByRole("group", { name: "horizontal workspace split" });
    expect(horizontal).toHaveStyle({
      display: "grid",
      gridTemplateColumns: "minmax(0, 0.3fr) auto minmax(0, 0.7fr)",
      height: "100%",
      minHeight: "0",
      minWidth: "0",
      width: "100%",
    });

    const resize = screen.getByRole("slider", { name: "Resize split" });
    expect(resize).toHaveClass("workspace-split__resize-input");
    expect(resize.closest("label")).toHaveClass("workspace-split__resize");
    fireEvent.change(resize, { target: { value: "0.7" } });
    expect(callbacks.onPreviewResize).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000610",
      0.7,
    );
    expect(callbacks.onCommitResize).not.toHaveBeenCalled();

    rerender(
      <SplitWorkspace
        {...callbacks}
        layout={splitLayout("vertical", 0.6)}
        renderTab={(tab) => tab.title}
      />,
    );
    const vertical = screen.getByRole("group", { name: "vertical workspace split" });
    expect(vertical).toHaveStyle({
      display: "grid",
      gridTemplateRows: "minmax(0, 0.6fr) auto minmax(0, 0.4fr)",
    });
    Object.assign(vertical, {
      getBoundingClientRect: () => ({ height: 600, left: 0, top: 0, width: 800 }),
    });
    const verticalResize = screen.getByRole("slider", { name: "Resize split" }).closest("label")!;
    fireEvent.pointerDown(verticalResize, { button: 0, clientY: 360, pointerId: 51 });
    fireEvent.pointerMove(verticalResize, { clientY: 420, pointerId: 51 });
    fireEvent.pointerUp(verticalResize, { clientY: 420, pointerId: 51 });
    expect(callbacks.onCommitResize).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000610",
      0.7,
    );
  });

  it("wires rendered tab, split, move, resize, and focus controls", async () => {
    const user = userEvent.setup();
    const callbacks = splitCallbacks();
    render(<SplitWorkspace {...callbacks} layout={splitLayout()} renderTab={(tab) => tab.title} />);

    const closeSecond = screen.getByRole("button", { name: "Close Second" });
    expect(screen.getByRole("tab", { name: "Second" })).toHaveClass("workspace-tab");
    expect(closeSecond).toHaveClass("workspace-tab__action");
    expect(screen.queryByRole("button", { name: "Move Second left" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Split Second below" })).not.toBeInTheDocument();
    closeSecond.focus();
    await user.keyboard("{Enter}");
    expect(callbacks.onClose).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000612",
      "00000000-0000-4000-8000-000000000614",
    );
    await user.click(screen.getByRole("button", { name: "Tab actions for Second" }));
    await user.click(screen.getByRole("button", { name: "Move Second left" }));
    expect(callbacks.onReorder).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000612",
      "00000000-0000-4000-8000-000000000614",
      0,
    );
    await user.click(screen.getByRole("button", { name: "Tab actions for Second" }));
    await user.click(screen.getByRole("button", { name: "Split Second below" }));
    expect(callbacks.onSplit).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000612",
      "00000000-0000-4000-8000-000000000614",
      "vertical",
      "after",
    );
    await user.click(screen.getByRole("button", { name: "Pane actions for First" }));
    await user.click(screen.getByRole("button", { name: "Move active tab to next group" }));
    expect(callbacks.onMove).toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Pane actions for First" }));
    await user.click(screen.getByRole("button", { name: "Focus this group" }));
    expect(callbacks.onFocus).toHaveBeenCalledWith("00000000-0000-4000-8000-000000000612");
    fireEvent.change(screen.getByRole("slider", { name: "Resize split" }), {
      target: { value: "0.6" },
    });
    expect(callbacks.onPreviewResize).toHaveBeenCalled();
  });
});

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left,
    right: left + width,
    top,
    width,
    x: left,
    y: top,
    toJSON: () => ({}),
  };
}
