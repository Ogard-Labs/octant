import type { ChatThreadNavigationItem } from "../shell/navigationModel";
import {
  THREAD_ROW_MENU_INLINE_PULL_REQUESTS,
  threadRowPullRequestDestinations,
  type ThreadRowPullRequestDestination,
} from "./threadRowPullRequests";
import { threadRowRestState } from "./threadRowRest";
import {
  Archive,
  BellRing,
  Check,
  CircleCheck,
  Clock,
  Copy,
  Download,
  Ellipsis,
  ExternalLink,
  EyeOff,
  Flag,
  Forward,
  GitPullRequest,
  FolderInput,
  Hash,
  Mail,
  MailOpen,
  Pencil,
  Pin,
  PinOff,
  RotateCcw,
} from "../ui/icons";
import {
  OctantContextMenuContent,
  OctantContextMenuGroup,
  OctantContextMenuItem,
  OctantContextMenuSeparator,
  OctantContextMenuSub,
  OctantContextMenuSubContent,
  OctantContextMenuSubTrigger,
} from "../ui/base/OctantContextMenu";
import { resolveSnoozePresets } from "@octant/domain";

import type { ReactNode } from "react";
import type { IconComponent } from "../ui/icons";
import type { ThreadRowActions } from "./ThreadRowMenu";

/*
 * The thread row's right-click menu, kept out of the window's first load: a
 * row draws it once its menu opens, and the module loads right after the first
 * load, before anyone can right-click (`ProjectThreadList`).
 */

function PullRequestMenuItems(props: {
  readonly destinations: ReadonlyArray<ThreadRowPullRequestDestination>;
}) {
  return props.destinations.map((destination) => (
    <OctantContextMenuItem
      className="thread-row-context-menu__item"
      key={destination.key}
      label={destination.label}
      onClick={destination.run}
    >
      <MenuContent icon={destination.key.startsWith("pr-github:") ? ExternalLink : GitPullRequest}>
        {destination.label}
      </MenuContent>
    </OctantContextMenuItem>
  ));
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
  /**
   * The coordinator items, drawn by the row from `ThreadRowMenu`, where the
   * pane menu shares them; absent where the row offers none.
   */
  readonly coordinatorItems?: ReactNode;
}) {
  const threadId = props.thread.navigationId ?? props.thread.threadId;
  const { pinned, closed, reopenLabel, snoozed } = threadRowRestState(props.thread);
  const pullRequestDestinations = threadRowPullRequestDestinations(props.thread, props.actions);
  const hasPlacementActions =
    props.actions.onPinInPane !== undefined ||
    props.actions.onPinThread !== undefined ||
    props.actions.onStartRenameThread !== undefined;
  const hasCoordinatorActions = props.coordinatorItems !== undefined;
  const readStateAction =
    props.thread.unread === true
      ? props.actions.onMarkThreadRead
      : props.actions.onMarkThreadUnread;
  const hasLifecycleActions =
    readStateAction !== undefined ||
    (closed ? props.actions.onReopenThread : props.actions.onCompleteThread) !== undefined ||
    (props.thread.markedDone !== true && props.actions.onMarkThreadDone !== undefined) ||
    (snoozed ? props.actions.onWakeThread : props.actions.onSnoozeThread) !== undefined;
  return (
    <OctantContextMenuContent
      aria-label={`Actions for ${props.thread.title}`}
      className="thread-row-context-menu"
    >
      {hasPlacementActions ? (
        <OctantContextMenuGroup>
          {props.actions.onPinInPane === undefined ? null : (
            <OctantContextMenuItem
              className="thread-row-context-menu__item"
              label="Pin in pane"
              onClick={() => props.actions.onPinInPane?.(threadId)}
            >
              <MenuContent icon={Pin}>Pin in pane</MenuContent>
            </OctantContextMenuItem>
          )}
          {props.actions.onPinThread === undefined ? null : (
            <OctantContextMenuItem
              className="thread-row-context-menu__item"
              label={pinned ? "Unpin" : "Pin"}
              onClick={() => props.actions.onPinThread?.(threadId, !pinned)}
            >
              <MenuContent icon={pinned ? PinOff : Pin}>{pinned ? "Unpin" : "Pin"}</MenuContent>
            </OctantContextMenuItem>
          )}
          {props.actions.onStartRenameThread === undefined ? null : (
            <OctantContextMenuItem
              className="thread-row-context-menu__item"
              label="Rename"
              onClick={() => props.actions.onStartRenameThread?.(threadId)}
            >
              <MenuContent icon={Pencil}>Rename</MenuContent>
            </OctantContextMenuItem>
          )}
        </OctantContextMenuGroup>
      ) : null}
      {hasLifecycleActions ? (
        <>
          {hasPlacementActions ? <OctantContextMenuSeparator /> : null}
          <OctantContextMenuGroup>
            {/* A row offers the one read-state action that would change the
                thread: marking it with the state it is already in would render
                as present and inert. */}
            {props.thread.unread === true ? (
              props.actions.onMarkThreadRead === undefined ? null : (
                <OctantContextMenuItem
                  className="thread-row-context-menu__item"
                  label="Mark as read"
                  onClick={() => props.actions.onMarkThreadRead?.(threadId)}
                >
                  <MenuContent icon={MailOpen}>Mark as read</MenuContent>
                </OctantContextMenuItem>
              )
            ) : props.actions.onMarkThreadUnread === undefined ? null : (
              <OctantContextMenuItem
                className="thread-row-context-menu__item"
                label="Mark as unread"
                onClick={() => props.actions.onMarkThreadUnread?.(threadId)}
              >
                <MenuContent icon={Mail}>Mark as unread</MenuContent>
              </OctantContextMenuItem>
            )}
            {props.thread.markedDone === true ||
            props.actions.onMarkThreadDone === undefined ? null : (
              <OctantContextMenuItem
                className="thread-row-context-menu__item"
                label="Mark done"
                onClick={() => props.actions.onMarkThreadDone?.(threadId)}
              >
                <MenuContent icon={CircleCheck}>Mark done</MenuContent>
              </OctantContextMenuItem>
            )}
            {closed ? (
              props.actions.onReopenThread === undefined ? null : (
                <OctantContextMenuItem
                  className="thread-row-context-menu__item"
                  label={reopenLabel}
                  onClick={() => props.actions.onReopenThread?.(threadId)}
                >
                  <MenuContent icon={RotateCcw}>{reopenLabel}</MenuContent>
                </OctantContextMenuItem>
              )
            ) : props.actions.onCompleteThread === undefined ? null : (
              <OctantContextMenuItem
                className="thread-row-context-menu__item"
                label="Settle"
                onClick={() => props.actions.onCompleteThread?.(threadId)}
              >
                <MenuContent icon={Check}>Settle</MenuContent>
              </OctantContextMenuItem>
            )}
            {snoozed ? (
              props.actions.onWakeThread === undefined ? null : (
                <OctantContextMenuItem
                  className="thread-row-context-menu__item"
                  label="Wake"
                  onClick={() => props.actions.onWakeThread?.(threadId)}
                >
                  <MenuContent icon={RotateCcw}>Wake</MenuContent>
                </OctantContextMenuItem>
              )
            ) : props.actions.onSnoozeThread === undefined ? null : (
              <OctantContextMenuSub>
                <OctantContextMenuSubTrigger
                  className="thread-row-context-menu__item"
                  label="Snooze"
                >
                  <MenuContent icon={Clock}>Snooze</MenuContent>
                </OctantContextMenuSubTrigger>
                <OctantContextMenuSubContent className="thread-row-context-menu">
                  {resolveSnoozePresets(new Date()).map((preset) => (
                    <OctantContextMenuItem
                      className="thread-row-context-menu__item thread-row-context-menu__snooze-item"
                      key={preset.id}
                      label={preset.label}
                      onClick={() => props.actions.onSnoozeThread?.(threadId, preset.until)}
                    >
                      <MenuContent icon={BellRing}>
                        <span className="thread-row-context-menu__snooze-label">
                          {preset.label}
                        </span>
                        <span className="thread-row-context-menu__snooze-when">
                          {preset.whenLabel}
                        </span>
                      </MenuContent>
                    </OctantContextMenuItem>
                  ))}
                </OctantContextMenuSubContent>
              </OctantContextMenuSub>
            )}
          </OctantContextMenuGroup>
        </>
      ) : null}
      {pullRequestDestinations.length === 0 ? null : (
        <>
          <OctantContextMenuSeparator />
          <OctantContextMenuGroup>
            {/* Every destination the hover card offers is here too, because
                the menu is where keyboard and touch reach them. A thread with
                more than a few pull requests lists them one level down. */}
            {(props.thread.pullRequests?.items.length ?? 0) <=
            THREAD_ROW_MENU_INLINE_PULL_REQUESTS ? (
              <PullRequestMenuItems destinations={pullRequestDestinations} />
            ) : (
              <OctantContextMenuSub>
                <OctantContextMenuSubTrigger
                  className="thread-row-context-menu__item"
                  label="Pull requests"
                >
                  <MenuContent icon={GitPullRequest}>Pull requests</MenuContent>
                </OctantContextMenuSubTrigger>
                <OctantContextMenuSubContent className="thread-row-context-menu">
                  <PullRequestMenuItems destinations={pullRequestDestinations} />
                </OctantContextMenuSubContent>
              </OctantContextMenuSub>
            )}
          </OctantContextMenuGroup>
        </>
      )}
      {/* The rarer actions sit one level down so the list a person scans on
          every right-click stays short; Copy needs nothing from the host, so
          the submenu always has at least one item. */}
      <OctantContextMenuSeparator />
      <OctantContextMenuGroup>
        <OctantContextMenuSub>
          <OctantContextMenuSubTrigger className="thread-row-context-menu__item" label="More">
            <MenuContent icon={Ellipsis}>More</MenuContent>
          </OctantContextMenuSubTrigger>
          <OctantContextMenuSubContent className="thread-row-context-menu">
            {props.actions.onAttachAsContext === undefined ? null : (
              <OctantContextMenuItem
                className="thread-row-context-menu__item"
                label="Attach as context"
                onClick={() => props.actions.onAttachAsContext?.(threadId, props.thread.title)}
              >
                <MenuContent icon={Hash}>Attach as context</MenuContent>
              </OctantContextMenuItem>
            )}
            {props.thread.followUp === true ? (
              props.actions.onCompleteFollowUp === undefined ? null : (
                <OctantContextMenuItem
                  className="thread-row-context-menu__item"
                  label="Complete follow-up"
                  onClick={() => props.actions.onCompleteFollowUp?.(threadId)}
                >
                  <MenuContent icon={Check}>Complete follow-up</MenuContent>
                </OctantContextMenuItem>
              )
            ) : props.actions.onMarkFollowUp === undefined ? null : (
              <OctantContextMenuItem
                className="thread-row-context-menu__item"
                label="Mark for follow-up"
                onClick={() => props.actions.onMarkFollowUp?.(threadId)}
              >
                <MenuContent icon={Flag}>Mark for follow-up</MenuContent>
              </OctantContextMenuItem>
            )}
            <OctantContextMenuSub>
              <OctantContextMenuSubTrigger className="thread-row-context-menu__item" label="Copy">
                <MenuContent icon={Copy}>Copy</MenuContent>
              </OctantContextMenuSubTrigger>
              <OctantContextMenuSubContent className="thread-row-context-menu">
                <OctantContextMenuItem
                  className="thread-row-context-menu__item"
                  label="Copy title"
                  onClick={() => void copyText(props.thread.title)}
                >
                  <MenuContent icon={Copy}>Copy title</MenuContent>
                </OctantContextMenuItem>
                <OctantContextMenuItem
                  className="thread-row-context-menu__item"
                  label="Copy thread ID"
                  onClick={() => void copyText(String(props.thread.threadId))}
                >
                  <MenuContent icon={Copy}>Copy thread ID</MenuContent>
                </OctantContextMenuItem>
              </OctantContextMenuSubContent>
            </OctantContextMenuSub>
            {props.actions.onMoveToProject === undefined ||
            props.actions.canMoveToProject?.(threadId) === false ? null : (
              <OctantContextMenuItem
                className="thread-row-context-menu__item"
                label="Move to Project…"
                onClick={() =>
                  props.actions.onMoveToProject?.(
                    String(props.thread.threadId),
                    props.thread.title,
                    props.thread.projectId,
                  )
                }
              >
                <MenuContent icon={FolderInput}>Move to Project…</MenuContent>
              </OctantContextMenuItem>
            )}
            {props.actions.onExportThread === undefined ? null : (
              <OctantContextMenuItem
                className="thread-row-context-menu__item"
                label="Export…"
                onClick={() =>
                  props.actions.onExportThread?.(String(props.thread.threadId), props.thread.title)
                }
              >
                <MenuContent icon={Download}>Export…</MenuContent>
              </OctantContextMenuItem>
            )}
            {props.actions.onHandOffThread === undefined ? null : (
              <OctantContextMenuItem
                className="thread-row-context-menu__item"
                label="Hand off…"
                onClick={() =>
                  props.actions.onHandOffThread?.(String(props.thread.threadId), props.thread.title)
                }
              >
                <MenuContent icon={Forward}>Hand off…</MenuContent>
              </OctantContextMenuItem>
            )}
            {hasCoordinatorActions ? (
              <>
                <OctantContextMenuSeparator />
                {props.coordinatorItems}
              </>
            ) : null}
            {props.actions.onLeaveNoTrace === undefined ? null : (
              <>
                {hasCoordinatorActions ? <OctantContextMenuSeparator /> : null}
                <OctantContextMenuItem
                  className="thread-row-context-menu__item"
                  label="Leave no trace in memory"
                  onClick={() =>
                    props.actions.onLeaveNoTrace?.(
                      String(props.thread.threadId),
                      props.thread.title,
                    )
                  }
                >
                  <MenuContent icon={EyeOff}>Leave no trace in memory</MenuContent>
                </OctantContextMenuItem>
              </>
            )}
          </OctantContextMenuSubContent>
        </OctantContextMenuSub>
      </OctantContextMenuGroup>
      {props.actions.onArchiveThread === undefined ? null : (
        <>
          <OctantContextMenuSeparator />
          <OctantContextMenuItem
            className="thread-row-context-menu__item"
            destructive
            label="Archive"
            onClick={() => props.actions.onArchiveThread?.(threadId)}
          >
            <MenuContent icon={Archive}>Archive</MenuContent>
          </OctantContextMenuItem>
        </>
      )}
    </OctantContextMenuContent>
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

function MenuContent(props: { readonly icon: IconComponent; readonly children: ReactNode }) {
  const Icon = props.icon;
  return (
    <>
      <span aria-hidden="true" className="thread-row-context-menu__icon">
        <Icon size={16} />
      </span>
      <span className="thread-row-context-menu__item-label">{props.children}</span>
    </>
  );
}
