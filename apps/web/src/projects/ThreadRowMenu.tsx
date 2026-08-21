import { ContextMenu as ContextMenuPrimitive } from "@base-ui/react/context-menu";
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

/**
 * The right-click menu for one thread row.
 *
 * Copy is always offered because it needs nothing from the host, and it is the
 * one answer that works even when a thread's own commands are unavailable.
 */
export function ThreadRowMenu(props: {
  readonly actions: ThreadRowActions;
  readonly thread: ChatThreadNavigationItem;
}) {
  const threadId = props.thread.navigationId ?? props.thread.threadId;
  const pinned = props.thread.pinned === true;
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Positioner className="z-50 window-no-drag">
        <ContextMenuPrimitive.Popup className="window-no-drag z-50 min-w-48 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md outline-none">
          <ContextMenuPrimitive.Group>
            <ContextMenuPrimitive.GroupLabel className="truncate px-2 py-1.5 text-xs text-muted-foreground">
              {props.thread.title}
            </ContextMenuPrimitive.GroupLabel>
          </ContextMenuPrimitive.Group>
          {props.actions.onPinInPane === undefined ? null : (
            <ContextMenuPrimitive.Item
              className={MENU_ITEM_CLASS}
              closeOnClick
              label="Pin in pane"
              onClick={() => props.actions.onPinInPane?.(threadId)}
            >
              Pin in pane
            </ContextMenuPrimitive.Item>
          )}
          {props.actions.onPinThread === undefined ? null : (
            <ContextMenuPrimitive.Item
              className={MENU_ITEM_CLASS}
              closeOnClick
              label={pinned ? "Unpin" : "Pin"}
              onClick={() => props.actions.onPinThread?.(threadId, !pinned)}
            >
              {pinned ? "Unpin" : "Pin"}
            </ContextMenuPrimitive.Item>
          )}
          {props.actions.onStartRenameThread === undefined ? null : (
            <ContextMenuPrimitive.Item
              className={MENU_ITEM_CLASS}
              closeOnClick
              label="Rename"
              onClick={() => props.actions.onStartRenameThread?.(threadId)}
            >
              Rename
            </ContextMenuPrimitive.Item>
          )}
          {/* A row offers the one read-state action that would change the
              thread: marking it with the state it is already in would render
              as present and inert. An unread thread used to get neither. */}
          {props.thread.unread === true ? (
            props.actions.onMarkThreadRead === undefined ? null : (
              <ContextMenuPrimitive.Item
                className={MENU_ITEM_CLASS}
                closeOnClick
                label="Mark as read"
                onClick={() => props.actions.onMarkThreadRead?.(threadId)}
              >
                Mark as read
              </ContextMenuPrimitive.Item>
            )
          ) : props.actions.onMarkThreadUnread === undefined ? null : (
            <ContextMenuPrimitive.Item
              className={MENU_ITEM_CLASS}
              closeOnClick
              label="Mark as unread"
              onClick={() => props.actions.onMarkThreadUnread?.(threadId)}
            >
              Mark as unread
            </ContextMenuPrimitive.Item>
          )}
          {/* The row offers the follow-up action that would change the thread,
              the same rule the read-state pair above follows. This is the only
              place the mark can be set now that the thread carries no header
              band of its own. */}
          {props.thread.followUp === true ? (
            props.actions.onCompleteFollowUp === undefined ? null : (
              <ContextMenuPrimitive.Item
                className={MENU_ITEM_CLASS}
                closeOnClick
                label="Complete follow-up"
                onClick={() => props.actions.onCompleteFollowUp?.(threadId)}
              >
                Complete follow-up
              </ContextMenuPrimitive.Item>
            )
          ) : props.actions.onMarkFollowUp === undefined ? null : (
            <ContextMenuPrimitive.Item
              className={MENU_ITEM_CLASS}
              closeOnClick
              label="Mark for follow-up"
              onClick={() => props.actions.onMarkFollowUp?.(threadId)}
            >
              Mark for follow-up
            </ContextMenuPrimitive.Item>
          )}
          <ContextMenuPrimitive.Separator className="my-1 h-px bg-border" />
          <ContextMenuPrimitive.Item
            className={MENU_ITEM_CLASS}
            closeOnClick
            label="Copy title"
            onClick={() => void copyText(props.thread.title)}
          >
            Copy title
          </ContextMenuPrimitive.Item>
          <ContextMenuPrimitive.Item
            className={MENU_ITEM_CLASS}
            closeOnClick
            label="Copy thread ID"
            onClick={() => void copyText(String(props.thread.threadId))}
          >
            Copy thread ID
          </ContextMenuPrimitive.Item>
          {props.actions.onExportThread === undefined ? null : (
            <ContextMenuPrimitive.Item
              className={MENU_ITEM_CLASS}
              closeOnClick
              label="Export…"
              onClick={() =>
                props.actions.onExportThread?.(String(props.thread.threadId), props.thread.title)
              }
            >
              Export…
            </ContextMenuPrimitive.Item>
          )}
          {props.actions.onArchiveThread === undefined ? null : (
            <>
              <ContextMenuPrimitive.Separator className="my-1 h-px bg-border" />
              <ContextMenuPrimitive.Item
                className={MENU_ITEM_CLASS}
                closeOnClick
                label="Archive"
                onClick={() => props.actions.onArchiveThread?.(threadId)}
              >
                Archive
              </ContextMenuPrimitive.Item>
            </>
          )}
        </ContextMenuPrimitive.Popup>
      </ContextMenuPrimitive.Positioner>
    </ContextMenuPrimitive.Portal>
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
