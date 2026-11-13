import type { ThreadMoveThreadStatus } from "@octant/contracts";
import { ArrowRight, Laptop } from "lucide-react";
import { useId, useRef, useState } from "react";
import { OctantAlert } from "../../ui/base/OctantAlert";
import { OctantButton } from "../../ui/base/OctantButton";
import { OctantConfirmDialog } from "../../ui/base/OctantConfirmDialog";
import { OctantDialogPresence } from "../../ui/base/OctantDialogPresence";
import { EnvironmentTile } from "../EnvironmentGroup";
import type { ThreadMoveClient } from "./threadMoveClient";

type Departed = NonNullable<ThreadMoveThreadStatus["departed"]>;

/**
 * The link to the thread on the computer it moved to, in the form an Octant
 * phone opens: a hub member is named by its host id.
 */
export function movedThreadLink(departed: Departed): string {
  const { destinationMemberId, destinationThread } = departed;
  return `octant://hosts/${String(destinationMemberId)}/threads/${destinationThread.mode}/${destinationThread.threadId}`;
}

/**
 * The sentence that names the parts a move could not read and left behind,
 * the first ones by name and the rest counted; undefined when every part
 * travelled. The tombstone and the Moved notice say it the same way.
 */
export function partsLeftBehindSentence(departed: Departed): string | undefined {
  const named = departed.partsLeftBehind ?? [];
  const count = departed.partsLeftBehindCount ?? named.length;
  if (count === 0) return undefined;
  const unnamed = count - named.length;
  const names = named.map((part) => part.name).join(", ");
  return `${count === 1 ? "1 part" : `${String(count)} parts`} could not be read here, so ${count === 1 ? "it" : "they"} did not move: ${names}${unnamed > 0 ? `, and ${String(unnamed)} more` : ""}.`;
}

/**
 * What a moved thread's pane shows on the computer it left, opened from an
 * old link, a notification, or a search: where it went, Open there, and the
 * worktree or Work folder that stayed when it held files the move did not
 * carry. The
 * thread itself was erased here through the ordinary purge. Canonical:
 * docs/design/hub-and-spokes.md "Moving a thread: screens", "Moved", and "Erase on the source".
 */
export function ThreadMoveTombstone(props: {
  readonly departed: Departed;
  /** This computer's name, as the window lists it. */
  readonly hostName: string;
  readonly client: ThreadMoveClient;
  readonly onChanged: () => void;
  readonly writeClipboard?: (text: string) => Promise<void>;
}) {
  const { departed } = props;
  const leftBehind = partsLeftBehindSentence(departed);
  const titleId = useId();
  const [answer, setAnswer] = useState<"opened" | "copied" | "failed" | undefined>(undefined);
  const time = new Date(departed.movedAt).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });

  // Open there opens the thread on the destination's own web app in the
  // person's browser, which admits that browser as it already would, so this
  // computer grants nothing; the desktop reads where it went from the host and
  // the window names only the thread. No window shows another member's thread
  // in place, and the desktop's own `octant://` handler takes only
  // `octant://code/` links, so when the destination serves no web app, or the
  // window has no such door, the link is copied for the phone app instead.
  const copyLink = () => {
    const write = props.writeClipboard ?? ((text: string) => navigator.clipboard.writeText(text));
    write(movedThreadLink(departed)).then(
      () => setAnswer("copied"),
      () => setAnswer("failed"),
    );
  };
  const openThere = () => {
    const open = props.client.openThere;
    if (departed.destinationWebOrigin === undefined || open === undefined) {
      copyLink();
      return;
    }
    open(departed.thread).then(
      (outcome) => (outcome === "opened" ? setAnswer("opened") : copyLink()),
      () => copyLink(),
    );
  };

  return (
    <section aria-labelledby={titleId} className="thread-move-tombstone">
      <div className="thread-move-tombstone__card">
        <p className="thread-move-tombstone__route">
          <span className="thread-move-tombstone__host">
            <EnvironmentTile icon={Laptop} />
            {props.hostName}
          </span>
          <ArrowRight aria-label="to" size={14} />
          <span className="thread-move-tombstone__host">
            <EnvironmentTile icon={Laptop} />
            {departed.destinationName}
          </span>
        </p>
        {departed.keptWorktree === undefined ? null : (
          <KeptWorktree
            client={props.client}
            departed={departed}
            folder={departed.keptWorktree}
            onChanged={props.onChanged}
          />
        )}
        {departed.keptWorktree !== undefined || departed.keptFolder === undefined ? null : (
          <KeptFolder departed={departed} folder={departed.keptFolder} />
        )}
        <h2 className="thread-move-tombstone__title" id={titleId}>
          Moved to {departed.destinationName}
        </h2>
        <p className="thread-move-tombstone__meta">
          {time}
          {departed.changesRemainInCheckout
            ? ". Its changes also remain in this Project's checkout."
            : ""}
          {leftBehind === undefined ? "" : `. ${leftBehind}`}
        </p>
        <div className="thread-move-tombstone__actions">
          <OctantButton onClick={openThere}>Open there</OctantButton>
          <p aria-live="polite" className="thread-move-tombstone__meta">
            {answer === "opened"
              ? `Opened on ${departed.destinationName}'s own page in your browser.`
              : answer === "copied"
                ? `Link copied. This window can't open threads on ${departed.destinationName}; the Octant phone app opens this link.`
                : answer === "failed"
                  ? "The link couldn't be copied."
                  : ""}
          </p>
        </div>
      </div>
    </section>
  );
}

/**
 * The one row a kept worktree adds: the files that stayed with it, and
 * Remove worktree, which asks once. Only a person reaches it; the host
 * removes only the folder this move recorded.
 */
function KeptWorktree(props: {
  readonly departed: Departed;
  readonly folder: string;
  readonly client: ThreadMoveClient;
  readonly onChanged: () => void;
}) {
  const { departed } = props;
  const [asking, setAsking] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [failed, setFailed] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  if (departed.keptWorktreeRemovedAt !== undefined) {
    return (
      <p className="thread-move-tombstone__kept">
        The worktree that stayed on this computer was removed.
      </p>
    );
  }
  const count = departed.keptFileCount ?? departed.keptFiles?.length ?? 0;

  const remove = () => {
    setRemoving(true);
    setFailed(false);
    props.client
      .removeKeptWorktree(String(departed.moveId))
      .then(
        (outcome) => setFailed(outcome.status !== "removed"),
        () => setFailed(true),
      )
      .finally(() => {
        setRemoving(false);
        setAsking(false);
        props.onChanged();
      });
  };

  return (
    <div className="thread-move-tombstone__kept">
      <p>
        The worktree stayed on this computer at{" "}
        <code className="thread-move-tombstone__mono">{props.folder}</code>
        {count === 0 ? "." : ", with what the move didn't carry:"}
      </p>
      <KeptFiles departed={departed} />
      {failed ? (
        <OctantAlert title="The worktree couldn't be removed" tone="warning">
          It is still at that folder, with everything in it.
        </OctantAlert>
      ) : null}
      <OctantButton
        className="thread-move-tombstone__remove"
        disabled={removing}
        onClick={() => setAsking(true)}
        ref={trigger}
        size="sm"
        variant="ghost"
      >
        Remove worktree
      </OctantButton>
      <OctantDialogPresence>
        {asking ? (
          <OctantConfirmDialog
            confirmLabel="Remove worktree"
            destructive
            onCancel={() => setAsking(false)}
            onConfirm={remove}
            pending={removing}
            restoreFocus={trigger}
            title="Remove this worktree?"
          >
            This removes the folder and everything in it from this computer, including the files the
            move didn't carry. They have no other copy. The branch and its remote stay as they are.
          </OctantConfirmDialog>
        ) : null}
      </OctantDialogPresence>
    </div>
  );
}

/**
 * The row a Work thread's kept folder adds: where it is and what in it the
 * move didn't carry. The folder is the person's own, so nothing removes it.
 */
function KeptFolder(props: { readonly departed: Departed; readonly folder: string }) {
  const count = props.departed.keptFileCount ?? props.departed.keptFiles?.length ?? 0;
  return (
    <div className="thread-move-tombstone__kept">
      <p>
        Its folder stayed on this computer at{" "}
        <code className="thread-move-tombstone__mono">{props.folder}</code>
        {count === 0 ? "." : ", with what the move didn't carry:"}
      </p>
      <KeptFiles departed={props.departed} />
    </div>
  );
}

/** What a kept worktree or folder holds that did not move: the first files named, the rest counted. */
function KeptFiles(props: { readonly departed: Departed }) {
  const files = props.departed.keptFiles ?? [];
  const more = (props.departed.keptFileCount ?? files.length) - files.length;
  return (
    <>
      {files.length === 0 ? null : (
        <ul aria-label="Files that stayed" className="thread-move-tombstone__files">
          {files.map((file) => (
            <li className="thread-move-tombstone__mono" key={file}>
              {file}
            </li>
          ))}
        </ul>
      )}
      {more > 0 ? <p>and {String(more)} more</p> : null}
    </>
  );
}
