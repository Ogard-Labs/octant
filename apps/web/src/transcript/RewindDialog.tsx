import { useEffect, useRef, useState } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import "./rewind-dialog.css";

export type RewindScope = "conversation" | "files" | "both";

/**
 * The composer after a rewind: the removed message comes back to edit, and a
 * draft the person was already writing stays below it rather than being lost.
 */
export function composerAfterRewind(returned: string, draft: string): string {
  return draft.trim().length === 0 ? returned : `${returned}\n\n${draft}`;
}

/** What putting the files back would change, as the host previewed it. */
export type RewindFilesPreview =
  | { readonly kind: "loading" }
  | {
      readonly kind: "changes";
      readonly paths: ReadonlyArray<string>;
      /** Every path that differs, including those `paths` leaves out. */
      readonly total: number;
    }
  | { readonly kind: "unchanged" }
  /** The sentence says why; the conversation can still be rewound. */
  | { readonly kind: "unavailable"; readonly reason: string };

export interface RewindDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Turns the rewind removes; undefined while the preview is read. */
  readonly removedTurns: number | undefined;
  readonly files: RewindFilesPreview;
  /** How the conversation continues after it, when the host said. */
  readonly rollback?: "native" | "handoff";
  readonly busy: boolean;
  /** Why the preview or the rewind did not go through. */
  readonly message?: string;
  readonly onRewind: (scope: RewindScope) => void;
}

const SCOPE_LABEL: Readonly<Record<RewindScope, string>> = {
  both: "Conversation and files",
  conversation: "Conversation only",
  files: "Files only",
};

/**
 * The one question before a rewind. It says what leaves the conversation and
 * which files would be overwritten before anything happens, and offers only
 * the parts that can be taken back: files that cannot come back leave the
 * conversation as the only choice, with the reason beside it.
 */
export function RewindDialog(props: RewindDialogProps) {
  const filesAvailable = props.files.kind === "changes";
  const scopes: ReadonlyArray<RewindScope> = filesAvailable
    ? ["both", "conversation", "files"]
    : ["conversation"];
  const [scope, setScope] = useState<RewindScope>("both");
  const chosen = scopes.includes(scope) ? scope : "conversation";
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (props.open) setScope("both");
  }, [props.open]);
  const ready = props.removedTurns !== undefined && props.files.kind !== "loading";
  const takesConversation = chosen !== "files";
  const takesFiles = chosen !== "conversation";

  return (
    <OctantDialog
      className="rewind-dialog"
      describedBy="rewind-dialog-detail"
      initialFocus={cancel}
      label="Rewind to here"
      labelledBy="rewind-dialog-title"
      onClose={props.onClose}
      open={props.open}
    >
      <h2 className="rewind-dialog__title" id="rewind-dialog-title">
        Rewind to here
      </h2>
      <p className="oct-row-detail rewind-dialog__detail" id="rewind-dialog-detail">
        {props.removedTurns === undefined
          ? "Reading what this would change…"
          : `This removes ${props.removedTurns === 1 ? "this message and its reply" : `this message and the ${props.removedTurns - 1} after it`} from the conversation. They stop reaching the model, and your message comes back to the composer to edit.`}
      </p>
      {scopes.length > 1 ? (
        <OctantToggleGroup<RewindScope>
          aria-label="What to rewind"
          className="segmented rewind-dialog__scope"
          onValueChange={(value) => {
            const selected = value[0];
            if (selected !== undefined) setScope(selected);
          }}
          value={[chosen]}
        >
          {scopes.map((candidate) => (
            <OctantToggleGroupItem className="segment" key={candidate} value={candidate}>
              {SCOPE_LABEL[candidate]}
            </OctantToggleGroupItem>
          ))}
        </OctantToggleGroup>
      ) : null}
      <section aria-labelledby="rewind-dialog-files" className="rewind-dialog__section">
        <h3 className="oct-section-label" id="rewind-dialog-files">
          Files
        </h3>
        {props.files.kind === "loading" ? (
          <p className="oct-row-detail" role="status">
            Comparing the files with this point…
          </p>
        ) : props.files.kind === "unchanged" ? (
          <p className="oct-row-detail">
            No file differs from this point, so files stay as they are.
          </p>
        ) : props.files.kind === "unavailable" ? (
          <p className="oct-row-detail">{props.files.reason}</p>
        ) : takesFiles ? (
          <>
            <p className="oct-row-detail">
              {props.files.total === 1
                ? "This file goes back to how it was before this message:"
                : `These ${props.files.total} files go back to how they were before this message:`}
            </p>
            <ul className="rewind-dialog__paths">
              {props.files.paths.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
            {props.files.total > props.files.paths.length ? (
              <p className="oct-meta">and {props.files.total - props.files.paths.length} more</p>
            ) : null}
            <p className="oct-meta">Undo restore stays offered afterwards.</p>
          </>
        ) : (
          <p className="oct-row-detail">Files stay as they are.</p>
        )}
      </section>
      {takesConversation && props.rollback !== undefined ? (
        <p className="oct-meta rewind-dialog__rollback">
          {props.rollback === "native"
            ? "The provider continues its own session from the turns you keep."
            : "This provider cannot cut its own session back, so your next message starts a fresh session with the kept turns handed over as text."}
        </p>
      ) : null}
      {props.message === undefined ? null : (
        <OctantAlert className="rewind-dialog__message" tone="danger">
          {props.message}
        </OctantAlert>
      )}
      <footer className="rewind-dialog__actions">
        <OctantButton
          disabled={props.busy}
          onClick={props.onClose}
          ref={cancel}
          size="sm"
          type="button"
          variant="ghost"
        >
          Cancel
        </OctantButton>
        <OctantButton
          disabled={props.busy || !ready}
          onClick={() => props.onRewind(chosen)}
          size="sm"
          type="button"
          variant="destructive"
        >
          {props.busy ? "Rewinding…" : takesFiles ? "Rewind and restore files" : "Rewind"}
        </OctantButton>
      </footer>
    </OctantDialog>
  );
}
