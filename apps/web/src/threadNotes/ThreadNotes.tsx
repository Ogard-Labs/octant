import {
  MAX_THREAD_NOTE_LENGTH,
  type ThreadNote,
  type ThreadNotesResult,
  type ThreadRecap,
} from "@octant/contracts";
import type { ThreadNotesClient } from "@octant/client-runtime/thread-notes-client";
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTextarea } from "../ui/base/OctantTextarea";
import "./thread-notes.css";

export type ThreadNotesServices = Pick<
  ThreadNotesClient,
  "notes" | "add" | "edit" | "remove" | "recap"
>;

const ThreadNotesContext = createContext<ThreadNotesServices | undefined>(undefined);

export function ThreadNotesProvider(props: {
  readonly services: ThreadNotesServices | undefined;
  readonly children: ReactNode;
}) {
  return (
    <ThreadNotesContext.Provider value={props.services}>
      {props.children}
    </ThreadNotesContext.Provider>
  );
}

const UNAVAILABLE = "Notes are unavailable right now.";

function messageOf(result: ThreadNotesResult): string | undefined {
  return result.kind === "thread-notes-refused" ? result.message : undefined;
}

/**
 * The thread's recap and the person's own notes, as two rows of its Thread
 * info panel. Both rows are the host's: the recap is read from the thread's
 * transcript when the person opens it, and every note is journaled on the
 * host. A note reaches the agent only when the person inserts it into the
 * message they are writing.
 */
export function ThreadNotesRows(props: {
  readonly threadId: string;
  /** Puts a note's text into this thread's composer; absent, the row offers no insert. */
  readonly onInsert?: ((text: string) => void) | undefined;
}) {
  const services = useContext(ThreadNotesContext);
  if (services === undefined) return null;
  return (
    <>
      <RecapRow services={services} threadId={props.threadId} />
      <NotesRow onInsert={props.onInsert} services={services} threadId={props.threadId} />
    </>
  );
}

function RecapRow(props: { readonly services: ThreadNotesServices; readonly threadId: string }) {
  const { services, threadId } = props;
  const [open, setOpen] = useState(false);
  const [recap, setRecap] = useState<ThreadRecap>();
  const [message, setMessage] = useState<string>();
  const [loading, setLoading] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    setMessage(undefined);
    services.recap(threadId).then(
      (result) => {
        setLoading(false);
        if (result.kind === "thread-recap") setRecap(result.recap);
        else setMessage(messageOf(result) ?? UNAVAILABLE);
      },
      () => {
        setLoading(false);
        setMessage("The recap is unavailable right now.");
      },
    );
  }, [services, threadId]);

  useEffect(() => {
    setRecap(undefined);
  }, [threadId]);

  return (
    <details
      className="thread-recap"
      onToggle={(event) => {
        const nowOpen = event.currentTarget.open;
        setOpen(nowOpen);
        // Read when opened, never in the background: the recap is a reading
        // of the transcript as it stands, and says which message it reaches.
        if (nowOpen) load();
      }}
      open={open}
    >
      <summary>Recap</summary>
      {loading && recap === undefined ? <p>Reading the thread…</p> : null}
      {message === undefined ? null : <p role="alert">{message}</p>}
      {recap === undefined ? null : <RecapFacts recap={recap} />}
      {recap === undefined ? null : (
        <div className="thread-notes__actions">
          <OctantButton disabled={loading} onClick={load} size="sm" type="button" variant="ghost">
            Refresh
          </OctantButton>
        </div>
      )}
    </details>
  );
}

function RecapFacts(props: { readonly recap: ThreadRecap }) {
  const { recap } = props;
  if (recap.asks === 0 && recap.replies === 0) return <p>Nothing has been asked here yet.</p>;
  return (
    <dl className="thread-recap__facts">
      {recap.firstAsk === undefined ? null : (
        <>
          <dt>{recap.truncated ? "Earliest ask read" : "Asked first"}</dt>
          <dd>{recap.firstAsk}</dd>
        </>
      )}
      {recap.latestAsk === undefined || recap.asks < 2 ? null : (
        <>
          <dt>Asked last</dt>
          <dd>{recap.latestAsk}</dd>
        </>
      )}
      {recap.latestReply === undefined ? null : (
        <>
          <dt>Latest reply</dt>
          <dd>{recap.latestReply}</dd>
        </>
      )}
      <dt>Open</dt>
      <dd>
        {recap.awaitingReply
          ? "Your last message has no reply yet."
          : "Nothing waiting on a reply."}
      </dd>
      <dt>Read</dt>
      <dd>
        {`${recap.asks} ${recap.asks === 1 ? "ask" : "asks"}, ${recap.replies} ${
          recap.replies === 1 ? "reply" : "replies"
        }${recap.truncated ? " (newest only)" : ""}`}
        {recap.throughAt === undefined ? null : (
          <>
            {", through "}
            <time dateTime={recap.throughAt}>{formatTime(recap.throughAt)}</time>
          </>
        )}
      </dd>
    </dl>
  );
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function NotesRow(props: {
  readonly services: ThreadNotesServices;
  readonly threadId: string;
  readonly onInsert?: ((text: string) => void) | undefined;
}) {
  const { services, threadId, onInsert } = props;
  const [notes, setNotes] = useState<ReadonlyArray<ThreadNote>>([]);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState<{ readonly id: string; readonly text: string }>();
  const [message, setMessage] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    setNotes([]);
    setEditing(undefined);
    services.notes(threadId).then(
      (result) => {
        if (current && result.kind === "thread-notes") setNotes(result.notes);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [services, threadId]);

  const run = (request: Promise<ThreadNotesResult>, after?: () => void) => {
    setBusy(true);
    setMessage(undefined);
    request.then(
      (result) => {
        setBusy(false);
        if (result.kind === "thread-notes") {
          setNotes(result.notes);
          after?.();
        } else {
          setMessage(messageOf(result) ?? UNAVAILABLE);
        }
      },
      () => {
        setBusy(false);
        setMessage(UNAVAILABLE);
      },
    );
  };

  const trimmed = draft.trim();
  return (
    <details className="thread-notes">
      <summary>
        <span>Notes</span>
        {notes.length === 0 ? null : <span className="thread-info__value">{notes.length}</span>}
      </summary>
      <p>Only you see these. A note goes to the agent only if you insert it in a message.</p>
      {notes.length === 0 ? null : (
        <ul className="thread-notes__list">
          {notes.map((note) =>
            editing !== undefined && editing.id === String(note.id) ? (
              <li key={String(note.id)}>
                <OctantTextarea
                  aria-label="Edit note"
                  maxLength={MAX_THREAD_NOTE_LENGTH}
                  onChange={(event) => setEditing({ id: editing.id, text: event.target.value })}
                  rows={3}
                  value={editing.text}
                />
                <div className="thread-notes__actions">
                  <OctantButton
                    disabled={busy}
                    onClick={() => setEditing(undefined)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Cancel
                  </OctantButton>
                  <OctantButton
                    disabled={busy || editing.text.trim().length === 0}
                    onClick={() =>
                      run(services.edit(threadId, editing.id, editing.text.trim()), () =>
                        setEditing(undefined),
                      )
                    }
                    size="sm"
                    type="button"
                    variant="secondary"
                  >
                    Save
                  </OctantButton>
                </div>
              </li>
            ) : (
              <li key={String(note.id)}>
                <p className="thread-notes__text">{note.text}</p>
                <div className="thread-notes__actions">
                  {onInsert === undefined ? null : (
                    <OctantButton
                      onClick={() => onInsert(note.text)}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      Insert in message
                    </OctantButton>
                  )}
                  <OctantButton
                    disabled={busy}
                    onClick={() => setEditing({ id: String(note.id), text: note.text })}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Edit
                  </OctantButton>
                  <OctantButton
                    disabled={busy}
                    onClick={() => run(services.remove(threadId, String(note.id)))}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    Delete
                  </OctantButton>
                </div>
              </li>
            ),
          )}
        </ul>
      )}
      <OctantTextarea
        aria-label="New note"
        maxLength={MAX_THREAD_NOTE_LENGTH}
        onChange={(event) => setDraft(event.target.value)}
        placeholder="Add a note…"
        rows={2}
        value={draft}
      />
      {message === undefined ? null : <p role="alert">{message}</p>}
      <div className="thread-notes__actions">
        <OctantButton
          disabled={busy || trimmed.length === 0}
          onClick={() => run(services.add(threadId, trimmed), () => setDraft(""))}
          size="sm"
          type="button"
          variant="secondary"
        >
          Add note
        </OctantButton>
      </div>
    </details>
  );
}

/** The draft with a note put after what the person already typed. */
export function draftWithNote(draft: string, note: string): string {
  return draft.trim().length === 0 ? note : `${draft.trimEnd()}\n\n${note}`;
}
