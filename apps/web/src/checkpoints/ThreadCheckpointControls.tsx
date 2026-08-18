import type { ThreadCheckpoint } from "@octant/contracts/thread-checkpoints";
import { Flag, RotateCcw } from "lucide-react";
import { useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";

export interface ThreadCheckpointControlsProps {
  /** The checkpoint already marked on this turn, when there is one. */
  readonly checkpoint?: ThreadCheckpoint;
  readonly busy: boolean;
  readonly defaultLabel: string;
  readonly onMark: (label: string) => void;
  readonly onForget: () => void;
  readonly onRestore: (title: string) => void;
}

/**
 * The checkpoint affordance on one message: mark this point, or take the thread
 * up again from a point already marked.
 *
 * Restoring says what it does — it starts a second thread — because the word
 * "restore" elsewhere means putting files back in place. Nothing here is
 * undone: the thread this control sits in keeps every message it has.
 */
export function ThreadCheckpointControls(props: ThreadCheckpointControlsProps) {
  const [marking, setMarking] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [label, setLabel] = useState(props.defaultLabel);
  const [title, setTitle] = useState("");

  if (props.checkpoint === undefined) {
    if (marking) {
      return (
        <div className="thread-checkpoints" role="group" aria-label="Mark a checkpoint">
          <input
            aria-label="Checkpoint name"
            className="thread-checkpoints__input"
            maxLength={120}
            onChange={(event) => setLabel(event.target.value)}
            value={label}
          />
          <OctantButton
            disabled={props.busy || label.trim().length === 0}
            onClick={() => {
              props.onMark(label.trim());
              setMarking(false);
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
              setMarking(false);
              setLabel(props.defaultLabel);
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
    return (
      <div className="thread-checkpoints">
        <OctantButton
          disabled={props.busy}
          onClick={() => setMarking(true)}
          size="sm"
          type="button"
          variant="ghost"
        >
          <Flag aria-hidden="true" size={12} strokeWidth={1.8} />
          Checkpoint
        </OctantButton>
      </div>
    );
  }

  const checkpoint = props.checkpoint;
  return (
    <div className="thread-checkpoints" role="group" aria-label="Checkpoint">
      <span className="thread-checkpoints__label">
        <Flag aria-hidden="true" size={12} strokeWidth={1.8} />
        {checkpoint.label}
        {checkpoint.restoreCount === 0
          ? null
          : ` · taken up ${checkpoint.restoreCount === 1 ? "once" : `${String(checkpoint.restoreCount)} times`}`}
      </span>
      {restoring ? (
        <>
          <input
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
              props.onRestore(title.trim().length === 0 ? checkpoint.label : title.trim());
              setRestoring(false);
              setTitle("");
            }}
            size="sm"
            type="button"
            variant="secondary"
          >
            Start the new thread
          </OctantButton>
          <OctantButton
            disabled={props.busy}
            onClick={() => setRestoring(false)}
            size="sm"
            type="button"
            variant="ghost"
          >
            Cancel
          </OctantButton>
        </>
      ) : (
        <>
          <OctantButton
            disabled={props.busy}
            onClick={() => setRestoring(true)}
            size="sm"
            type="button"
            variant="ghost"
          >
            <RotateCcw aria-hidden="true" size={12} strokeWidth={1.8} />
            Restore from here
          </OctantButton>
          <OctantButton
            disabled={props.busy}
            onClick={props.onForget}
            size="sm"
            type="button"
            variant="ghost"
          >
            Forget
          </OctantButton>
        </>
      )}
    </div>
  );
}
