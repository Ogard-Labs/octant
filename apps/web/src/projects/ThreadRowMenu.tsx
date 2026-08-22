import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { MoreHorizontal } from "lucide-react";
import { useRef } from "react";
import type { ChatThreadNavigationItem } from "../shell/navigationModel";

export const MENU_ITEM_CLASS =
  "window-no-drag relative flex cursor-default items-center rounded-sm px-2 py-1.5 text-sm outline-none select-none data-highlighted:bg-accent data-highlighted:text-accent-foreground";

/**
 * What a thread row can be asked to do without leaving the sidebar.
 *
 * Every action is optional, and an absent one renders no item. A menu that
 * offers what the host cannot carry out reads as a broken feature, so the
 * shorter menu is the honest one — the same rule the pin affordance in the Code
 * sidebar already follows.
 */
export interface ThreadRowActions {
  /** Absent when the host cannot archive this thread. */
  readonly onArchiveThread?: (threadId: string) => void;
  /**
   * Clears the thread's open follow-up. Paired with {@link onMarkFollowUp}: a
   * host that can set the mark can clear it, so the menu offers whichever of
   * the two would change the thread.
   */
  readonly onCompleteFollowUp?: (threadId: string) => void;
  /** Absent when the host cannot record a follow-up on this thread. */
  readonly onMarkFollowUp?: (threadId: string) => void;
  /**
   * Absent when no export client resolves for this window, which is the same
   * test the chat thread-actions menu applies before offering Export.
   */
  readonly onExportThread?: (threadId: string, title: string) => void;
  /** Absent when nothing tracks read state for this thread. */
  readonly onMarkThreadRead?: (threadId: string) => void;
  /** Absent when nothing tracks read state for this thread. */
  readonly onMarkThreadUnread?: (threadId: string) => void;
  /**
   * Places the thread in a new split pane of this window. Absent when the
   * workspace cannot accept a split. Distinct from {@link onPinThread}, which
   * only marks the thread in the list.
   */
  readonly onPinInPane?: (threadId: string) => void;
  /** Absent when the host cannot accept a list pin. */
  readonly onPinThread?: (threadId: string, pinned: boolean) => void;
  /** Asks the list to open its rename field; the list owns the commit. */
  readonly onStartRenameThread?: (threadId: string) => void;
}

export function threadRowMenuIsEmpty(actions: ThreadRowActions | undefined): boolean {
  if (actions === undefined) return true;
  return (
    actions.onArchiveThread === undefined &&
    actions.onCompleteFollowUp === undefined &&
    actions.onMarkFollowUp === undefined &&
    actions.onExportThread === undefined &&
    actions.onMarkThreadRead === undefined &&
    actions.onMarkThreadUnread === undefined &&
    actions.onPinInPane === undefined &&
    actions.onPinThread === undefined &&
    actions.onStartRenameThread === undefined
  );
}

type ThreadMenuEntry =
  | { readonly kind: "label"; readonly label: string }
  | { readonly kind: "separator" }
  | { readonly kind: "item"; readonly label: string; readonly onSelect: () => void };

function threadMenuEntries(
  thread: ChatThreadNavigationItem,
  actions: ThreadRowActions,
): ReadonlyArray<ThreadMenuEntry> {
  const threadId = thread.navigationId ?? thread.threadId;
  const pinned = thread.pinned === true;
  const entries: ThreadMenuEntry[] = [{ kind: "label", label: thread.title }];
  if (actions.onPinInPane !== undefined) {
    entries.push({
      kind: "item",
      label: "Pin in pane",
      onSelect: () => actions.onPinInPane?.(threadId),
    });
  }
  if (actions.onPinThread !== undefined) {
    entries.push({
      kind: "item",
      label: pinned ? "Unpin" : "Pin",
      onSelect: () => actions.onPinThread?.(threadId, !pinned),
    });
  }
  if (actions.onStartRenameThread !== undefined) {
    entries.push({
      kind: "item",
      label: "Rename",
      onSelect: () => actions.onStartRenameThread?.(threadId),
    });
  }
  // A row offers the one read-state action that would change the thread:
  // marking it with the state it is already in would render as present and
  // inert. An unread thread used to get neither.
  if (thread.unread === true) {
    if (actions.onMarkThreadRead !== undefined) {
      entries.push({
        kind: "item",
        label: "Mark as read",
        onSelect: () => actions.onMarkThreadRead?.(threadId),
      });
    }
  } else if (actions.onMarkThreadUnread !== undefined) {
    entries.push({
      kind: "item",
      label: "Mark as unread",
      onSelect: () => actions.onMarkThreadUnread?.(threadId),
    });
  }
  // The row offers the follow-up action that would change the thread, the
  // same rule the read-state pair above follows. This is the only place the
  // mark can be set now that the thread carries no header band of its own.
  if (thread.followUp === true) {
    if (actions.onCompleteFollowUp !== undefined) {
      entries.push({
        kind: "item",
        label: "Complete follow-up",
        onSelect: () => actions.onCompleteFollowUp?.(threadId),
      });
    }
  } else if (actions.onMarkFollowUp !== undefined) {
    entries.push({
      kind: "item",
      label: "Mark for follow-up",
      onSelect: () => actions.onMarkFollowUp?.(threadId),
    });
  }
  entries.push({ kind: "separator" });
  entries.push({ kind: "item", label: "Copy title", onSelect: () => void copyText(thread.title) });
  if (actions.onExportThread !== undefined) {
    entries.push({
      kind: "item",
      label: "Export…",
      onSelect: () => actions.onExportThread?.(String(thread.threadId), thread.title),
    });
  }
  if (actions.onArchiveThread !== undefined) {
    entries.push({ kind: "separator" });
    entries.push({
      kind: "item",
      label: "Archive",
      onSelect: () => actions.onArchiveThread?.(threadId),
    });
  }
  return entries;
}

/**
 * The right-click menu for one thread row.
 *
 * Copy title is always offered because it needs nothing from the host, and it
 * is the one answer that works even when a thread's own commands are
 * unavailable. Thread identifiers stay off the row and out of the menu.
 */
export function ThreadRowMenu(props: {
  readonly actions: ThreadRowActions;
  readonly thread: ChatThreadNavigationItem;
}) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner className="z-50 window-no-drag">
        <ContextMenuPrimitive.Popup className="window-no-drag z-50 min-w-48 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none">
          {threadMenuEntries(props.thread, props.actions).map((entry, index) =>
            entry.kind === "label" ? (
              <ContextMenuPrimitive.Group key={`label-${entry.label}`}>
                <ContextMenuPrimitive.GroupLabel className="truncate px-2 py-1.5 text-xs text-muted-foreground">
                  {entry.label}
                </ContextMenuPrimitive.GroupLabel>
              </ContextMenuPrimitive.Group>
            ) : entry.kind === "separator" ? (
              <ContextMenuPrimitive.Separator
                className="my-1 h-px bg-border"
                key={`sep-${index}`}
              />
            ) : (
              <ContextMenuPrimitive.Item
                className={MENU_ITEM_CLASS}
                closeOnClick
                key={entry.label}
                label={entry.label}
                onClick={entry.onSelect}
              >
                {entry.label}
              </ContextMenuPrimitive.Item>
            ),
          )}
        </ContextMenuPrimitive.Popup>
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
  );
}

/**
 * The same thread actions, opened from a keyboard-reachable control rather
 * than only a right-click or a hover reveal.
 */
export function ThreadRowActionsMenu(props: {
  readonly actions: ThreadRowActions;
  readonly thread: ChatThreadNavigationItem;
}) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  return (
    <MenuPrimitive.Root>
      <MenuPrimitive.Trigger
        aria-label={`Thread actions for ${props.thread.title}`}
        className="sidebar-navigation__thread-menu window-no-drag inline-flex items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onClick={(event) => event.stopPropagation()}
        ref={triggerRef}
      >
        <MoreHorizontal aria-hidden="true" size={14} strokeWidth={1.8} />
      </MenuPrimitive.Trigger>
      <MenuPrimitive.Portal>
        <MenuPrimitive.Positioner align="end" className="z-50 window-no-drag" sideOffset={4}>
          <MenuPrimitive.Popup
            className="window-no-drag z-50 min-w-44 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none"
            finalFocus={triggerRef}
          >
            {threadMenuEntries(props.thread, props.actions).map((entry, index) =>
              entry.kind === "label" ? (
                <div
                  className="truncate px-2 py-1.5 text-xs text-muted-foreground"
                  key={`label-${entry.label}`}
                >
                  {entry.label}
                </div>
              ) : entry.kind === "separator" ? (
                <MenuPrimitive.Separator className="my-1 h-px bg-border" key={`sep-${index}`} />
              ) : (
                <MenuPrimitive.Item
                  className={MENU_ITEM_CLASS}
                  closeOnClick
                  key={entry.label}
                  label={entry.label}
                  onClick={entry.onSelect}
                >
                  {entry.label}
                </MenuPrimitive.Item>
              ),
            )}
          </MenuPrimitive.Popup>
        </MenuPrimitive.Positioner>
      </MenuPrimitive.Portal>
    </MenuPrimitive.Root>
  );
}

/**
 * Writes to the clipboard when the host exposes one. A host without clipboard
 * access is not an error the reader can act on, so it stays silent — the same
 * shape the conversation export already uses.
 */
async function copyText(value: string): Promise<void> {
  const writeText = globalThis.navigator?.clipboard?.writeText;
  if (typeof writeText !== "function") return;
  try {
    await writeText.call(globalThis.navigator.clipboard, value);
  } catch {
    // The host refused the clipboard; nothing was copied and nothing is claimed.
  }
}
