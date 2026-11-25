import { useState, type ReactNode } from "react";
import { ProjectMark } from "../projects/ProjectMark";
import { ThreadRowInfoCard } from "../projects/ThreadRowInfoCard";
import { threadRowState, type ThreadRowStateReading } from "../projects/threadRowState";
import type { ThreadRowActions } from "../projects/ThreadRowMenu";
import { threadRowActivity } from "../shell/navigationModel";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantPopover } from "../ui/base/OctantPopover";
import { Hash } from "../ui/icons";
import { useThreadReferences, type ThreadReference } from "./useThreadReferences";
import { threadModeLabel } from "./threadModeLabel";
import "../composer/composer-chip.css";
import "./thread-reference.css";

/** The card holds no row menu: pull requests and issues read as facts in it. */
const NO_ROW_ACTIONS: ThreadRowActions = {};

export interface ThreadReferenceAction {
  readonly label: string;
  readonly onSelect: () => void;
  readonly disabled?: boolean;
}

export interface ThreadReferenceChipProps {
  readonly threadId: string;
  /** The name as the text around the chip writes it. */
  readonly title: string;
  /**
   * What the host said of a thread this window does not list. A listed thread
   * says more, and says it live.
   */
  readonly fallback?: { readonly mode: "chat" | "work" | "code"; readonly placement: string };
  /** What naming the thread here lets the agent do: in two words, and in a sentence. */
  readonly access?: string;
  readonly receipt?: string;
  /** The host refused the thread: the reason shows and no fact about it does. */
  readonly unavailableReason?: string;
  readonly actions?: ReadonlyArray<ThreadReferenceAction>;
  /**
   * `chip` stands in text as one unit; `link` is the bare name in a sentence,
   * and the name alone for a thread this window does not list.
   */
  readonly look?: "chip" | "link";
}

function liveState(reference: ThreadReference | undefined): ThreadRowStateReading["state"] {
  if (reference === undefined) return undefined;
  const { state } = threadRowState({
    activity: threadRowActivity(reference.thread),
    unread: false,
    woke: false,
    startedAt: reference.thread.turnStartedAt,
  });
  return state;
}

/**
 * A thread named in text: its Project's mark, its title, and a dot while it
 * works or waits on the person. Hovering it shows the thread's card; pressing
 * it, by pointer, touch or key, opens the same card with focus in it, so the
 * card's actions are reachable without a pointer.
 */
export function ThreadReferenceChip(props: ThreadReferenceChipProps) {
  const references = useThreadReferences();
  const [open, setOpen] = useState(false);
  const unavailable = props.unavailableReason;
  const reference = unavailable === undefined ? references.find(props.threadId) : undefined;
  if (props.look === "link" && reference === undefined) return <>{props.title}</>;
  const state = liveState(reference);
  const place =
    unavailable !== undefined
      ? undefined
      : reference !== undefined
        ? [threadModeLabel(reference.mode), reference.projectName]
        : props.fallback === undefined
          ? undefined
          : [threadModeLabel(props.fallback.mode), props.fallback.placement];
  const label = [
    `Thread: ${props.title}`,
    ...(unavailable === undefined ? [] : [`Unavailable: ${unavailable}`]),
    ...(place ?? []),
    ...(state === undefined ? [] : [state.text]),
    ...(unavailable === undefined ? [props.access] : []),
  ]
    .filter((part) => part !== undefined)
    .join(", ");
  const openThread = references.open;
  const actions: ReadonlyArray<ThreadReferenceAction> = [
    ...(reference === undefined || openThread === undefined
      ? []
      : [{ label: "Open thread", onSelect: () => openThread(reference) }]),
    ...(props.actions ?? []),
  ];
  const mark: ReactNode =
    reference?.projectName === undefined || reference.thread.projectId === undefined ? (
      <Hash aria-hidden="true" size={12} />
    ) : (
      <ProjectMark name={reference.projectName} projectId={reference.thread.projectId} />
    );
  return (
    <OctantPopover
      className="thread-reference-card"
      onOpenChange={setOpen}
      open={open}
      openOnHover
      side="top"
      sideOffset={8}
      title="Thread details"
      trigger={
        props.look === "link" ? (
          <span className="thread-reference-link__title">{props.title}</span>
        ) : (
          <>
            {mark}
            <span className="composer-chip__text">{props.title}</span>
            {state === undefined ? null : (
              <span
                aria-hidden="true"
                className="thread-reference-dot"
                data-status={state.status}
              />
            )}
          </>
        )
      }
      triggerClassName={
        props.look === "link" ? "thread-reference-link" : "composer-chip__button thread-reference"
      }
      triggerDataAttributes={unavailable === undefined ? {} : { "data-unavailable": "true" }}
      triggerLabel={label}
    >
      {unavailable !== undefined ? (
        <p className="thread-reference-card__notice">{`Unavailable: ${unavailable}. Nothing from it is included.`}</p>
      ) : reference !== undefined ? (
        <ThreadRowInfoCard
          actions={NO_ROW_ACTIONS}
          {...(reference.lineageParentTitle === undefined
            ? {}
            : { lineageParentTitle: reference.lineageParentTitle })}
          projectName={reference.projectName}
          thread={reference.thread}
        />
      ) : (
        <ThreadRowInfoCard
          actions={NO_ROW_ACTIONS}
          projectName={
            props.fallback === undefined
              ? undefined
              : `${threadModeLabel(props.fallback.mode)} · ${props.fallback.placement}`
          }
          thread={{ threadId: props.threadId, title: props.title }}
        />
      )}
      {props.receipt === undefined || unavailable !== undefined ? null : (
        <p className="thread-reference-card__receipt">{props.receipt}</p>
      )}
      {actions.length === 0 ? null : (
        <div className="thread-reference-card__actions">
          {actions.map((action) => (
            <OctantButton
              disabled={action.disabled === true}
              key={action.label}
              onClick={() => {
                setOpen(false);
                action.onSelect();
              }}
              size="xs"
              type="button"
              variant="secondary"
            >
              {action.label}
            </OctantButton>
          ))}
        </div>
      )}
    </OctantPopover>
  );
}
