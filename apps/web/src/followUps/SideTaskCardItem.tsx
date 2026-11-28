import { useId, useState } from "react";
import { GitBranch, MessageSquarePlus, X } from "../ui/icons";
import type { SideTask, SideTaskContext } from "@octant/contracts";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton, OctantIconButton } from "../ui/base/OctantButton";
import { OctantCollapsible } from "../ui/base/OctantCollapsible";
import { OctantRadioGroup, OctantRadioGroupItem } from "../ui/base/OctantRadioGroup";
import { LazyThreadReferenceChip } from "../threadReferences/LazyThreadReferenceChip";

export interface SideTaskCardController {
  readonly busy:
    | { readonly id: string; readonly action: "start" | "continue" | "dismiss" | "reporting" }
    | undefined;
  readonly messages: ReadonlyMap<string, string>;
  readonly unconfirmedActions: ReadonlyMap<string, string>;
  readonly deliveries: ReadonlyMap<string, NonNullable<SideTask["continuedDelivery"]>>;
  readonly act: (
    task: SideTask,
    action: "start" | "continue" | "dismiss",
    context?: SideTaskContext,
  ) => void;
  readonly setReporting: (task: SideTask, on: boolean) => void;
  readonly open: (task: SideTask) => void;
}

function wantsWorktree(task: SideTask, context: SideTaskContext): boolean {
  return task.offer.mode === "code" && (task.offer.target === "new-worktree" || context === "fork");
}

export function SideTaskCard(props: {
  readonly task: SideTask;
  readonly running: boolean;
  readonly controller: SideTaskCardController;
}) {
  const { task, controller: value } = props;
  const id = String(task.offer.id);
  const hintId = useId();
  const [chosen, setChosen] = useState<SideTaskContext>();
  const unconfirmedAction = value.unconfirmedActions.get(id);
  const message =
    unconfirmedAction === undefined
      ? value.messages.get(id)
      : `${unconfirmedAction} Waiting for this computer's recorded status before another action is allowed.`;
  const failure =
    message === undefined ? null : (
      <OctantAlert className="side-task__error" tone="danger">
        {message}
      </OctantAlert>
    );

  if (task.status !== "offered") {
    const delivery = task.continuedDelivery ?? value.deliveries.get(id);
    return (
      <div aria-label={`Side task: ${task.offer.title}`} className="side-task-receipt" role="group">
        <p className="side-task-receipt__line">
          <span className="side-task-receipt__title">
            {task.startedThreadId === undefined ? (
              task.offer.title
            ) : (
              <LazyThreadReferenceChip
                look="link"
                threadId={String(task.startedThreadId)}
                title={task.offer.title}
              />
            )}
          </span>
          <span aria-hidden="true"> · </span>
          {task.status === "started" ? (
            <>
              {task.startedWith === "fork" ? "Forked into a new thread" : "Started in a new thread"}
              {task.childState === undefined ? null : (
                <>
                  <span aria-hidden="true"> · </span>
                  {task.childState === "working"
                    ? "Working"
                    : task.childState === "attention"
                      ? "Needs you"
                      : "Finished"}
                </>
              )}
              {task.reporting === undefined || task.startedThreadId === undefined ? null : (
                <>
                  <span aria-hidden="true"> · </span>
                  <OctantButton
                    disabled={value.busy !== undefined || unconfirmedAction !== undefined}
                    onClick={() => value.setReporting(task, task.reporting === "stopped")}
                    size={null}
                    type="button"
                    variant="link"
                  >
                    {task.reporting === "stopped" ? "Resume reporting" : "Stop reporting"}
                  </OctantButton>
                </>
              )}
              {task.startedThreadId === undefined ? null : (
                <>
                  <span aria-hidden="true"> · </span>
                  <OctantButton
                    className="side-task-receipt__open"
                    onClick={() => value.open(task)}
                    size={null}
                    type="button"
                    variant="link"
                  >
                    Open
                  </OctantButton>
                </>
              )}
            </>
          ) : task.status === "continued-here" ? (
            delivery === "unconfirmed" ? (
              "Not sure it was delivered. Check this thread and its queue before sending it yourself."
            ) : delivery === "queued" ? (
              "Queued here, runs after the current reply"
            ) : (
              "Doing it here"
            )
          ) : (
            "Dismissed"
          )}
        </p>
        {failure}
      </div>
    );
  }

  const busyHere = value.busy?.id === id ? value.busy.action : undefined;
  const blocked = value.busy !== undefined || unconfirmedAction !== undefined;
  // A fork needs a settled offering turn, so until then the choice shows fresh.
  const context: SideTaskContext = props.running
    ? "fresh"
    : (chosen ?? task.offer.context ?? "fresh");
  const worktree = wantsWorktree(task, context);
  const destination = worktree
    ? "a new worktree"
    : task.offer.mode === "chat"
      ? "a new chat"
      : "a new thread";
  const newLabel = worktree
    ? "New worktree"
    : task.offer.mode === "chat"
      ? "New chat"
      : "New thread";
  const hint = props.running
    ? "Available when this reply finishes."
    : task.offer.mode === "code"
      ? "Including the conversation starts a new worktree from the files as this reply left them."
      : undefined;
  return (
    <article aria-label={`Side task: ${task.offer.title}`} className="side-task">
      <div className="side-task__head">
        {task.offer.target === "new-worktree" ? (
          <GitBranch aria-hidden="true" size={14} />
        ) : (
          <MessageSquarePlus aria-hidden="true" size={14} />
        )}
        <strong className="side-task__title">{task.offer.title}</strong>
        <OctantIconButton
          disabled={blocked}
          label={`Dismiss ${task.offer.title}`}
          onClick={() => value.act(task, "dismiss")}
          size="icon-xs"
          type="button"
        >
          <X aria-hidden="true" size={12} />
        </OctantIconButton>
      </div>
      <p className="side-task__reason">{task.offer.reason}</p>
      <OctantCollapsible className="side-task__prompt" summary="Prompt">
        <p>{task.offer.prompt}</p>
      </OctantCollapsible>
      <p className="side-task__question">Start this in {destination}, or do it here?</p>
      <OctantRadioGroup<"fresh" | "fork">
        aria-label="What the new thread starts with"
        className="side-task__context"
        onValueChange={setChosen}
        value={context}
      >
        <OctantRadioGroupItem<"fresh" | "fork">
          disabled={blocked}
          size="xs"
          value="fresh"
          variant={context === "fresh" ? "secondary" : "ghost"}
        >
          Fresh
        </OctantRadioGroupItem>
        <OctantRadioGroupItem<"fresh" | "fork">
          {...(hint === undefined ? {} : { "aria-describedby": hintId })}
          disabled={blocked || props.running}
          size="xs"
          value="fork"
          variant={context === "fork" ? "secondary" : "ghost"}
        >
          Include this conversation
        </OctantRadioGroupItem>
      </OctantRadioGroup>
      {hint === undefined ? null : (
        <p className="side-task__hint" id={hintId}>
          {hint}
        </p>
      )}
      <div className="side-task__actions">
        <OctantButton
          disabled={blocked}
          onClick={() => value.act(task, "start", context)}
          size="xs"
          type="button"
        >
          {busyHere === "start" ? "Starting…" : newLabel}
        </OctantButton>
        <OctantButton
          disabled={blocked}
          onClick={() => value.act(task, "continue")}
          size="xs"
          type="button"
          variant="outline"
        >
          {busyHere === "continue" ? "Sending…" : "Do it here"}
        </OctantButton>
      </div>
      {failure}
    </article>
  );
}
