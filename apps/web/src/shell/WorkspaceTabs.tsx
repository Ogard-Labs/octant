import type { WorkspaceTab, WorkspaceTabGroup, WorkspaceTabId } from "@octant/contracts/shell";
import { isCanvasTabPinned } from "@octant/domain";
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, MoreHorizontal, Pin, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode, type Ref } from "react";
import { IconButton } from "./IconButton";
import type { WorkspaceTabDragController } from "./useWorkspaceTabDrag";

export interface WorkspaceTabsProps {
  readonly drag?: WorkspaceTabDragController;
  readonly group: WorkspaceTabGroup;
  readonly onActivate: (tabId: WorkspaceTabId) => void;
  readonly onClose: (tabId: WorkspaceTabId) => void;
  readonly onReorder: (tabId: WorkspaceTabId, index: number) => void;
  readonly onSplit: (
    tabId: WorkspaceTabId,
    orientation: "horizontal" | "vertical",
    placement: "before" | "after",
  ) => void;
  readonly onToggleCanvasPin?: (tab: WorkspaceTab) => void;
  readonly renderAccessory?: (tab: WorkspaceTab) => ReactNode;
}

export function WorkspaceTabs(props: WorkspaceTabsProps) {
  const destination = props.drag?.active?.destination;
  const insertionIndex =
    destination !== null &&
    destination !== undefined &&
    (destination.kind === "reorder" || destination.kind === "center") &&
    destination.targetGroupId === props.group.groupId
      ? destination.index
      : undefined;
  return (
    <div
      aria-label="Workspace tabs"
      className="workspace-tabs window-drag-region"
      data-workspace-tab-strip="true"
      role="tablist"
    >
      {props.group.tabs.map((tab, index) => (
        <span className="workspace-tab-slot" key={tab.id}>
          {insertionIndex === index ? (
            <span aria-hidden="true" className="workspace-tab-insertion" />
          ) : null}
          <WorkspaceTabItem {...props} group={props.group} index={index} tab={tab} />
        </span>
      ))}
      {insertionIndex === props.group.tabs.length ? (
        <span aria-hidden="true" className="workspace-tab-insertion" />
      ) : null}
    </div>
  );
}

function WorkspaceTabItem(
  props: Omit<WorkspaceTabsProps, "group"> & {
    readonly group: WorkspaceTabGroup;
    readonly index: number;
    readonly tab: WorkspaceTab;
  },
) {
  return (
    <span className="workspace-tab-item">
      <button
        aria-controls={`workspace-panel-${props.tab.id}`}
        aria-selected={props.group.activeTabId === props.tab.id}
        className="workspace-tab window-no-drag"
        data-workspace-tab-id={props.tab.id}
        id={`workspace-tab-${props.tab.id}`}
        onClick={() => {
          if (props.drag?.consumeSuppressedClick(props.tab.id)) return;
          props.onActivate(props.tab.id);
        }}
        onLostPointerCapture={props.drag?.onPointerCancel}
        onKeyDown={(event) => {
          let nextIndex: number | undefined;
          if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
            nextIndex = (props.index - 1 + props.group.tabs.length) % props.group.tabs.length;
          } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
            nextIndex = (props.index + 1) % props.group.tabs.length;
          } else if (event.key === "Home") {
            nextIndex = 0;
          } else if (event.key === "End") {
            nextIndex = props.group.tabs.length - 1;
          }
          if (nextIndex === undefined) return;
          event.preventDefault();
          const nextTab = props.group.tabs[nextIndex];
          if (nextTab === undefined) return;
          props.onActivate(nextTab.id);
          queueMicrotask(() => document.getElementById(`workspace-tab-${nextTab.id}`)?.focus());
        }}
        onPointerCancel={props.drag?.onPointerCancel}
        onPointerDown={(event) =>
          props.drag?.onPointerDown(event, props.group, props.tab.id, props.index, props.tab.title)
        }
        onPointerMove={props.drag?.onPointerMove}
        onPointerUp={props.drag?.onPointerUp}
        role="tab"
        tabIndex={props.group.activeTabId === props.tab.id ? 0 : -1}
        type="button"
      >
        {isCanvasTabPinned(props.tab) ? (
          <Pin aria-hidden="true" className="workspace-tab__pin" size={12} strokeWidth={1.8} />
        ) : null}
        {props.tab.title}
      </button>
      {props.renderAccessory?.(props.tab)}
      <IconButton
        className="workspace-tab__action"
        icon={X}
        label={`Close ${props.tab.title}`}
        onClick={() => props.onClose(props.tab.id)}
      />
      <TabActions {...props} />
    </span>
  );
}

function TabActions(
  props: Omit<WorkspaceTabsProps, "group" | "onActivate" | "onClose"> & {
    readonly group: WorkspaceTabGroup;
    readonly index: number;
    readonly tab: WorkspaceTab;
  },
) {
  const [open, setOpen] = useState(false);
  const disclosureId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const firstAction = useRef<HTMLButtonElement>(null);
  const canMoveLeft = props.index > 0;
  const canMoveRight = props.index < props.group.tabs.length - 1;

  useEffect(() => {
    if (open) firstAction.current?.focus();
  }, [open]);

  function close(): void {
    setOpen(false);
    queueMicrotask(() => trigger.current?.focus());
  }

  function select(action: () => void): void {
    action();
    close();
  }

  return (
    <span className="workspace-tab__actions">
      <IconButton
        aria-controls={disclosureId}
        aria-expanded={open}
        className="workspace-tab__action"
        icon={MoreHorizontal}
        label={`Tab actions for ${props.tab.title}`}
        onClick={() => setOpen((current) => !current)}
        ref={trigger}
      />
      {open ? (
        <span
          className="workspace-disclosure workspace-tab__disclosure"
          id={disclosureId}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            close();
          }}
        >
          {canMoveLeft ? (
            <DisclosureAction
              buttonRef={firstAction}
              icon={ArrowLeft}
              label={`Move ${props.tab.title} left`}
              onClick={() => select(() => props.onReorder(props.tab.id, props.index - 1))}
            />
          ) : null}
          {canMoveRight ? (
            <DisclosureAction
              {...(canMoveLeft ? {} : { buttonRef: firstAction })}
              icon={ArrowRight}
              label={`Move ${props.tab.title} right`}
              onClick={() => select(() => props.onReorder(props.tab.id, props.index + 1))}
            />
          ) : null}
          {props.group.tabs.length > 1 ? (
            <>
              <DisclosureAction
                {...(canMoveLeft || canMoveRight ? {} : { buttonRef: firstAction })}
                icon={ArrowLeft}
                label={`Split ${props.tab.title} left`}
                onClick={() => select(() => props.onSplit(props.tab.id, "horizontal", "before"))}
              />
              <DisclosureAction
                icon={ArrowRight}
                label={`Split ${props.tab.title} right`}
                onClick={() => select(() => props.onSplit(props.tab.id, "horizontal", "after"))}
              />
              <DisclosureAction
                icon={ArrowUp}
                label={`Split ${props.tab.title} above`}
                onClick={() => select(() => props.onSplit(props.tab.id, "vertical", "before"))}
              />
              <DisclosureAction
                icon={ArrowDown}
                label={`Split ${props.tab.title} below`}
                onClick={() => select(() => props.onSplit(props.tab.id, "vertical", "after"))}
              />
            </>
          ) : null}
          {props.tab.kind === "canvas" && props.onToggleCanvasPin !== undefined ? (
            <DisclosureAction
              icon={Pin}
              label={
                isCanvasTabPinned(props.tab) ? `Unpin ${props.tab.title}` : `Pin ${props.tab.title}`
              }
              onClick={() => select(() => props.onToggleCanvasPin?.(props.tab))}
            />
          ) : null}
        </span>
      ) : null}
    </span>
  );
}

function DisclosureAction(props: {
  readonly buttonRef?: Ref<HTMLButtonElement>;
  readonly icon: typeof ArrowLeft;
  readonly label: string;
  readonly onClick: () => void;
}) {
  const Icon = props.icon;
  return (
    <button
      className="workspace-disclosure__action window-no-drag"
      onClick={props.onClick}
      ref={props.buttonRef}
      type="button"
    >
      <Icon aria-hidden="true" size={14} strokeWidth={1.8} />
      <span>{props.label}</span>
    </button>
  );
}
