import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Plus, X } from "../ui/icons";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { moveWithinTabList } from "../ui/base/radioGroupKeys";
import { IconButton } from "./IconButton";

/**
 * The tab strip a panel draws: Files' open files, the Browser's pages. The
 * dock's tool row shares the same `.content-tab` recipe. It is a tablist whose
 * arrows, Home and End move between tabs, a row that scrolls sideways without
 * a scrollbar, and it keeps the selected tab in view by moving only its own
 * scroll position, so the pane and the page never scroll to follow a tab.
 */
export function PanelTabStrip(props: {
  readonly label: string;
  readonly children: ReactNode;
  /** The selected tab's id, so the strip can bring it into view. */
  readonly selectedId: string | undefined;
  readonly className?: string;
  readonly newTabLabel?: string;
  readonly onNewTab?: () => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = strip.current;
    const tab = node?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (node === null || node === undefined || tab === null || tab === undefined) return;
    revealInStrip(node, tab.closest<HTMLElement>(".content-tab") ?? tab);
  }, [props.selectedId]);
  return (
    <div
      aria-label={props.label}
      className={`panel-tabs${props.className === undefined ? "" : ` ${props.className}`}`}
      onKeyDown={moveWithinTabList}
      ref={strip}
      role="tablist"
    >
      {props.children}
      {props.onNewTab === undefined ? null : (
        <IconButton
          className="panel-tabs__new"
          icon={Plus}
          label={props.newTabLabel ?? "New tab"}
          onClick={props.onNewTab}
        />
      )}
    </div>
  );
}

/** Scrolls `node` sideways just far enough to show `tab`, and nothing else. */
export function revealInStrip(node: HTMLElement, tab: HTMLElement): void {
  const strip = node.getBoundingClientRect();
  const box = tab.getBoundingClientRect();
  if (box.left < strip.left) node.scrollLeft += box.left - strip.left;
  else if (box.right > strip.right) node.scrollLeft += box.right - strip.right;
}

export function PanelTab(props: {
  readonly id: string;
  readonly label: string;
  /** A leading mark; a file tab has none and shows its name alone. */
  readonly icon?: ReactNode;
  readonly selected: boolean;
  /** The one tab the next open replaces: drawn in italics. */
  readonly preview?: boolean;
  /** Unsaved edits: a dot stands in the close slot until the tab is hovered. */
  readonly dirty?: boolean;
  readonly roving: boolean;
  readonly title?: string;
  readonly closeLabel?: string;
  readonly onSelect: () => void;
  /** Absent leaves the tab without a close control and without the close keys. */
  readonly onClose?: () => void;
  readonly onKeep?: () => void;
}) {
  const onClose = props.onClose;
  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (onClose === undefined) return;
    const cmdW = event.key.toLowerCase() === "w" && event.metaKey && !event.shiftKey;
    if (event.key === "Delete" || event.key === "Backspace" || cmdW) {
      event.preventDefault();
      onClose();
    }
  }
  function onAuxClick(event: MouseEvent<HTMLElement>) {
    if (event.button !== 1 || onClose === undefined) return;
    event.preventDefault();
    onClose();
  }
  return (
    <span
      className="content-tab panel-tab"
      data-dirty={props.dirty === true ? "true" : undefined}
      data-preview={props.preview === true ? "true" : undefined}
      onAuxClick={onAuxClick}
      // A middle press would otherwise start the platform's autoscroll.
      onMouseDown={(event) => {
        if (event.button === 1) event.preventDefault();
      }}
      role="presentation"
    >
      <OctantButton
        aria-selected={props.selected}
        className="content-tab__select border-0 bg-transparent text-inherit hover:bg-transparent focus-visible:bg-transparent aria-expanded:bg-transparent data-active:bg-transparent data-active:text-inherit window-no-drag"
        data-panel-tab={props.id}
        onClick={props.onSelect}
        onDoubleClick={props.onKeep}
        onKeyDown={onKeyDown}
        role="tab"
        size="sm"
        tabIndex={props.roving ? 0 : -1}
        {...(props.title === undefined ? {} : { title: props.title })}
        type="button"
        variant="ghost"
      >
        {props.icon ?? null}
        <span className="content-tab__label">{props.label}</span>
        {props.preview === true ? <span className="sr-only">, preview</span> : null}
        {props.dirty === true ? <span className="sr-only">, unsaved changes</span> : null}
      </OctantButton>
      {onClose === undefined ? null : (
        <>
          {props.dirty === true ? (
            <span aria-hidden="true" className="content-tab__dirty" data-testid="tab-dirty-dot" />
          ) : null}
          <OctantIconButton
            className="content-tab__close text-muted-foreground"
            label={props.closeLabel ?? `Close ${props.label}`}
            onClick={onClose}
          >
            <X aria-hidden="true" size={12} />
          </OctantIconButton>
        </>
      )}
    </span>
  );
}
