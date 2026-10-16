import type { ThreadCheckpoint } from "@octant/contracts/thread-checkpoints";
import { Flag } from "lucide-react";
import { useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { turnMenuTrigger, useFocusAfterTurnMenuCloses } from "../transcript/turnPanelFocus";
import { OctantInput } from "../ui/base/OctantInput";

export interface ThreadCheckpointControlsProps {
  /** The checkpoint already marked on this turn, when there is one. */
  readonly checkpoint?: ThreadCheckpoint;
  readonly busy: boolean;
  readonly defaultLabel: string;
  /** Present while the user is naming a new marker or the thread a restore starts. */
  readonly draft?: "mark" | "restore";
  readonly onCancelDraft: () => void;
  readonly onMark: (label: string) => void;
  readonly onRestore: (title: string) => void;
}

/**
 * The checkpoint that is already on this message, and the short naming form
 * for marking or restoring. The gestures that open those forms live in the
 * turn's action menu: an unmarked turn shows nothing here, so the transcript
 * is not a row of Checkpoint buttons.
 *
 * Restoring says what it does — it starts a second thread — because the word
 * "restore" elsewhere means putting files back in place. Nothing here is
 * undone: the thread this control sits in keeps every message it has.
 */
export function ThreadCheckpointControls(props: ThreadCheckpointControlsProps) {
  const [label, setLabel] = useState(props.defaultLabel);
  const [title, setTitle] = useState("");
  const root = useRef<HTMLDivElement>(null);
  useFocusAfterTurnMenuCloses(root, "input", props.draft !== undefined);
  // The form unmounts when it ends; without a new owner focus would fall to
  // the document body, so it goes back to the turn's menu that opened it.
  const leaveForm = () => turnMenuTrigger(root.current)?.focus();

  if (props.checkpoint === undefined) {
    if (props.draft !== "mark") return null;
    return (
      <div className="thread-checkpoints" ref={root} role="group" aria-label="Mark a checkpoint">
        <OctantInput
          aria-label="Checkpoint name"
          className="thread-checkpoints__input"
          maxLength={120}
          onChange={(event) => setLabel(event.target.value)}
          value={label}
        />
        <OctantButton
          disabled={props.busy || label.trim().length === 0}
          onClick={() => {
            leaveForm();
            props.onMark(label.trim());
            props.onCancelDraft();
          }}
          size="sm"
          type="button"
          variant="secondary"
        >
          Mark
        </OctantButton>
        <OctantButton
          disabled={props.busy}
          onClick={() => {
            leaveForm();
            setLabel(props.defaultLabel);
            props.onCancelDraft();
          }}
          size="sm"
          type="button"
          variant="ghost"
        >
          Cancel
        </OctantButton>
      </div>
    );
  }

  const checkpoint = props.checkpoint;
  return (
    <div className="thread-checkpoints" ref={root} role="group" aria-label="Checkpoint">
      <span className="thread-checkpoints__label">
        <Flag aria-hidden="true" size={12} strokeWidth={1.8} />
        {checkpoint.label}
        {checkpoint.restoreCount === 0
          ? null
          : ` · taken up ${checkpoint.restoreCount === 1 ? "once" : `${String(checkpoint.restoreCount)} times`}`}
      </span>
      {props.draft === "restore" ? (
        <>
          <OctantInput
            aria-label="New thread name"
            className="thread-checkpoints__input"
            maxLength={200}
            onChange={(event) => setTitle(event.target.value)}
            placeholder={checkpoint.label}
            value={title}
          />
          <OctantButton
            disabled={props.busy}
            onClick={() => {
              leaveForm();
              props.onRestore(title.trim().length === 0 ? checkpoint.label : title.trim());
              setTitle("");
              props.onCancelDraft();
            }}
            size="sm"
            type="button"
            variant="secondary"
          >
            Start the new thread
          </OctantButton>
          <OctantButton
            disabled={props.busy}
            onClick={() => {
              leaveForm();
              setTitle("");
              props.onCancelDraft();
            }}
            size="sm"
            type="button"
            variant="ghost"
          >
            Cancel
          </OctantButton>
        </>
      ) : null}
    </div>
  );
}
