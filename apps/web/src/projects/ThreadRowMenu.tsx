import type { CoordinatorWorkerLevel, ThreadBoardPullRequestIdentity } from "@octant/contracts";
import { COORDINATOR_WORKER_LEVELS } from "./coordinatorChoices";
import type { ChatThreadNavigationItem } from "../shell/navigationModel";
import { BellRing, Gauge, Network, RotateCw, type IconComponent } from "../ui/icons";
import type { ReactNode } from "react";
import {
  OctantContextMenuCheckboxItem,
  OctantContextMenuGroup,
  OctantContextMenuItem,
  OctantContextMenuLabel,
  OctantContextMenuSub,
  OctantContextMenuSubContent,
  OctantContextMenuSubTrigger,
} from "../ui/base/OctantContextMenu";

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
   * Settles a finished thread, filing it under Settled without archiving it.
   * Paired with {@link onReopenThread}: the menu offers whichever of the two
   * would change the thread. Absent when the host cannot put threads away.
   */
  readonly onCompleteThread?: (threadId: string) => void;
  readonly onReopenThread?: (threadId: string) => void;
  /**
   * Marks a Code thread Done as the person's override of its delivery target;
   * {@link onReopenThread} undoes it. Absent where the host has no such mark
   * to set from a row, such as Chat and Work rows.
   */
  readonly onMarkThreadDone?: (threadId: string) => void;
  /**
   * Hides the thread until the ISO wake time. Paired with
   * {@link onWakeThread} the same way. Absent when the host cannot snooze.
   */
  readonly onSnoozeThread?: (threadId: string, until: string) => void;
  readonly onWakeThread?: (threadId: string) => void;
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
  /** Absent when no hand-off client resolves for this window. */
  readonly onHandOffThread?: (threadId: string, title: string) => void;
  /**
   * Keeps the thread out of person memory: nothing is learned from it and
   * what was is forgotten. Undone in Settings › Memory. Absent when this
   * window cannot change memory.
   */
  readonly onLeaveNoTrace?: (threadId: string, title: string) => void;
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
  /**
   * Attaches this thread as read-only context on the focused composer, the
   * same mention a drop would add. Absent when no composer can receive it.
   */
  readonly onAttachAsContext?: (threadId: string, title: string) => void;
  /** Absent when the host cannot accept a list pin. */
  readonly onPinThread?: (threadId: string, pinned: boolean) => void;
  /**
   * Opens one of the row's exact linked pull requests in the read-only Review
   * dock. Absent when this window has no Review dock to open it in.
   */
  readonly onOpenPullRequest?: (identity: ThreadBoardPullRequestIdentity) => void;
  /**
   * Opens the same pull request on github.com in the default browser. Absent
   * when no external route is offered, which also hides Cmd-click.
   */
  readonly onOpenPullRequestOnGithub?: (identity: ThreadBoardPullRequestIdentity) => void;
  /** Asks the list to open its rename field; the list owns the commit. */
  readonly onStartRenameThread?: (threadId: string) => void;
  /**
   * Opens the choice of Project to file a Work or Code thread into. The row's
   * Project id is passed so the dialog can compare folders. Absent when the
   * host cannot move this kind of thread.
   */
  readonly onMoveToProject?: (
    threadId: string,
    title: string,
    projectId: string | undefined,
  ) => void;
  /**
   * Whether this row's kind can move at all. A list that mixes kinds sets it so
   * a row of a kind with no move never offers an item that would do nothing.
   */
  readonly canMoveToProject?: (threadId: string) => boolean;
  /**
   * Make coordinator and Stop coordinating (docs/design/coordinator-threads.md).
   * Never offered on a worker, which the host refuses as a coordinator. Absent
   * where the host has no coordinators, such as Chat and Work rows.
   */
  readonly onSetCoordinator?: (
    threadId: string,
    coordinator: boolean,
    /** Fixes every worker's level; read only while making a coordinator. */
    workerLevel?: CoordinatorWorkerLevel,
  ) => void;
  /** Opens a running coordinator's limits. Absent where the host has no coordinators. */
  readonly onEditCoordinatorBounds?: (threadId: string) => void;
  /** The thread's Wake when a message arrives switch, in Code and Work. Absent in Chat. */
  readonly onSetMessageWake?: (threadId: string, wake: boolean) => void;
  /** Whether this row's kind has the message wake, in a list that mixes kinds. */
  readonly canSetMessageWake?: (threadId: string) => boolean;
  /** A worker's Wake for coordinator switch, offered only on a worker. */
  readonly onSetCoordinatorWake?: (threadId: string, wake: boolean) => void;
  /** The thread's Continue after restart switch, in every mode. */
  readonly onSetRestartContinuation?: (threadId: string, continueAfterRestart: boolean) => void;
}

export function threadRowMenuIsEmpty(actions: ThreadRowActions | undefined): boolean {
  if (actions === undefined) return true;
  return (
    actions.onArchiveThread === undefined &&
    actions.onCompleteThread === undefined &&
    actions.onReopenThread === undefined &&
    actions.onMarkThreadDone === undefined &&
    actions.onSnoozeThread === undefined &&
    actions.onWakeThread === undefined &&
    actions.onCompleteFollowUp === undefined &&
    actions.onMarkFollowUp === undefined &&
    actions.onExportThread === undefined &&
    actions.onHandOffThread === undefined &&
    actions.onLeaveNoTrace === undefined &&
    actions.onMarkThreadRead === undefined &&
    actions.onMarkThreadUnread === undefined &&
    actions.onPinInPane === undefined &&
    actions.onAttachAsContext === undefined &&
    actions.onPinThread === undefined &&
    actions.onOpenPullRequest === undefined &&
    actions.onOpenPullRequestOnGithub === undefined &&
    actions.onStartRenameThread === undefined &&
    actions.onMoveToProject === undefined &&
    actions.onSetCoordinator === undefined &&
    actions.onEditCoordinatorBounds === undefined &&
    actions.onSetMessageWake === undefined &&
    actions.onSetCoordinatorWake === undefined &&
    actions.onSetRestartContinuation === undefined
  );
}

export type ThreadCoordinatorActions = Pick<
  ThreadRowActions,
  | "onSetCoordinator"
  | "onEditCoordinatorBounds"
  | "onSetMessageWake"
  | "onSetCoordinatorWake"
  | "onSetRestartContinuation"
>;

/**
 * The coordinator items a Code thread's menu offers, in the row menu and the
 * thread pane's header menu alike (docs/design/workspace.md#coordinators).
 * A worker belongs to the coordinator that started it and never becomes one,
 * so it offers the worker's own switch in place of the role. The designated
 * planner coordinates because of its designation, which a person removes
 * from the Project overview, so the role item would do nothing there.
 */
function coordinatorMenuChoices(
  thread: ChatThreadNavigationItem,
  actions: ThreadCoordinatorActions & Pick<ThreadRowActions, "canSetMessageWake">,
) {
  const worker = thread.coordinatorThreadId !== undefined;
  return {
    role: worker || thread.planner === true ? undefined : actions.onSetCoordinator,
    // The designated planner holds no bounds of its own: it is not a
    // coordinator on its record, and the host refuses bounds for it.
    bounds:
      thread.coordinator === true && thread.planner !== true
        ? actions.onEditCoordinatorBounds
        : undefined,
    messageWake:
      actions.canSetMessageWake?.(thread.navigationId ?? thread.threadId) === false
        ? undefined
        : actions.onSetMessageWake,
    coordinatorWake: worker ? actions.onSetCoordinatorWake : undefined,
    restartContinuation: actions.onSetRestartContinuation,
  };
}

export function threadCoordinatorMenuOffers(
  thread: ChatThreadNavigationItem,
  actions: ThreadCoordinatorActions & Pick<ThreadRowActions, "canSetMessageWake">,
): boolean {
  const choices = coordinatorMenuChoices(thread, actions);
  return (
    choices.role !== undefined ||
    choices.bounds !== undefined ||
    choices.messageWake !== undefined ||
    choices.coordinatorWake !== undefined ||
    choices.restartContinuation !== undefined
  );
}

export function ThreadCoordinatorMenuItems(props: {
  readonly thread: ChatThreadNavigationItem;
  readonly actions: ThreadCoordinatorActions & Pick<ThreadRowActions, "canSetMessageWake">;
}) {
  const threadId = props.thread.navigationId ?? props.thread.threadId;
  const { role, bounds, messageWake, coordinatorWake, restartContinuation } =
    coordinatorMenuChoices(props.thread, props.actions);
  const coordinator = props.thread.coordinator === true;
  return (
    <OctantContextMenuGroup>
      {role === undefined ? null : coordinator ? (
        <OctantContextMenuItem
          className="thread-row-context-menu__item"
          label="Stop coordinating"
          onClick={() => role(threadId, false)}
        >
          <MenuContent icon={Network}>Stop coordinating</MenuContent>
        </OctantContextMenuItem>
      ) : (
        // The level its workers start at is fixed only while the thread is
        // made a coordinator, so the choice the New coordinator draft offers
        // is offered here too.
        <OctantContextMenuSub>
          <OctantContextMenuSubTrigger
            className="thread-row-context-menu__item"
            label="Make coordinator"
          >
            <MenuContent icon={Network}>Make coordinator</MenuContent>
          </OctantContextMenuSubTrigger>
          {/* The full sentences overran a submenu at 420px, so the shared
              start of each choice is the group's heading. */}
          <OctantContextMenuSubContent className="thread-row-context-menu">
            <OctantContextMenuGroup>
              <OctantContextMenuLabel>Workers start at</OctantContextMenuLabel>
              {COORDINATOR_WORKER_LEVELS.map((choice) => (
                <OctantContextMenuItem
                  className="thread-row-context-menu__item"
                  key={choice.id}
                  label={choice.label}
                  onClick={() => role(threadId, true, choice.level)}
                >
                  <span className="thread-row-context-menu__item-label">{choice.menuLabel}</span>
                </OctantContextMenuItem>
              ))}
            </OctantContextMenuGroup>
          </OctantContextMenuSubContent>
        </OctantContextMenuSub>
      )}
      {bounds === undefined ? null : (
        <OctantContextMenuItem
          className="thread-row-context-menu__item"
          label="Coordinator limits…"
          onClick={() => bounds(threadId)}
        >
          <MenuContent icon={Gauge}>Coordinator limits…</MenuContent>
        </OctantContextMenuItem>
      )}
      {messageWake === undefined ? null : (
        <OctantContextMenuCheckboxItem
          checked={props.thread.messageWake === true}
          className="thread-row-context-menu__item"
          label="Wake when a message arrives"
          onCheckedChange={(checked) => messageWake(threadId, checked)}
        >
          <MenuContent icon={BellRing}>Wake when a message arrives</MenuContent>
        </OctantContextMenuCheckboxItem>
      )}
      {coordinatorWake === undefined ? null : (
        <OctantContextMenuCheckboxItem
          checked={props.thread.coordinatorWakeOff !== true}
          className="thread-row-context-menu__item"
          label="Wake for coordinator"
          onCheckedChange={(checked) => coordinatorWake(threadId, checked)}
        >
          <MenuContent icon={BellRing}>Wake for coordinator</MenuContent>
        </OctantContextMenuCheckboxItem>
      )}
      {restartContinuation === undefined ? null : (
        <OctantContextMenuCheckboxItem
          checked={props.thread.restartContinuationOff !== true}
          className="thread-row-context-menu__item"
          label="Continue after restart"
          onCheckedChange={(checked) => restartContinuation(threadId, checked)}
        >
          <MenuContent icon={RotateCw}>Continue after restart</MenuContent>
        </OctantContextMenuCheckboxItem>
      )}
    </OctantContextMenuGroup>
  );
}

export function MenuContent(props: { readonly icon: IconComponent; readonly children: ReactNode }) {
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
