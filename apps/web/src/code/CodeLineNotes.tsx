import { useEffect, useId, useState } from "react";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantTextarea } from "../ui/base/OctantTextarea";

/** A changed line the person picked in the diff, with the text shown there. */
export interface CodeLineNoteAnchor {
  readonly path: string;
  readonly side: "original" | "modified";
  readonly line: number;
  readonly text: string;
}

export interface CodeLineNote {
  readonly id: string;
  readonly path: string;
  readonly side: "original" | "modified";
  readonly startLine: number;
  readonly endLine: number;
  readonly excerpt: string;
  readonly text: string;
}

export type CodeLineNotesSendResult =
  | { readonly status: "sent" }
  | { readonly status: "refused"; readonly message: string };

/** Long enough to recognise the line, short enough that a minified line cannot flood the message. */
const EXCERPT_LIMIT = 120;

export function lineNoteExcerpt(text: string): string {
  const line = text.trim();
  return line.length <= EXCERPT_LIMIT ? line : `${line.slice(0, EXCERPT_LIMIT - 1)}…`;
}

function lineNoteAnchorLabel(note: Pick<CodeLineNote, "path" | "side" | "startLine" | "endLine">) {
  const side = note.side === "modified" ? "new" : "old";
  return note.endLine > note.startLine
    ? `${note.path}, ${side} lines ${note.startLine}–${note.endLine}`
    : `${note.path}, ${side} line ${note.startLine}`;
}

/**
 * The one follow-up message a set of line notes becomes. It is plain person
 * text: each anchor, the quoted first line, then the note, numbered in the
 * order the person added them.
 */
export function lineNotesMessage(notes: ReadonlyArray<CodeLineNote>): string {
  const items = notes.map((note, index) =>
    [
      `${index + 1}. ${lineNoteAnchorLabel(note)}`,
      ...(note.excerpt.length === 0 ? [] : [`   > ${note.excerpt}`]),
      ...note.text
        .trim()
        .split("\n")
        .map((line) => `   ${line}`),
    ].join("\n"),
  );
  return ["Notes on the changed lines:", ...items].join("\n\n");
}

interface Draft {
  readonly anchor: Omit<CodeLineNote, "id" | "text" | "endLine">;
  readonly editingId?: string;
  readonly text: string;
  readonly through: string;
}

/**
 * Notes on a turn's changed lines, held here until the person sends them
 * together. They are unsent drafts of this view: nothing is journaled, and
 * sending goes through the thread's ordinary send path.
 */
export function CodeLineNotes(props: {
  readonly anchor?: CodeLineNoteAnchor;
  readonly onSend?: (message: string) => Promise<CodeLineNotesSendResult>;
  /** Why sending is not possible right now; the notes stay either way. */
  readonly sendUnavailable?: string;
}) {
  const [notes, setNotes] = useState<ReadonlyArray<CodeLineNote>>([]);
  const [draft, setDraft] = useState<Draft>();
  const [sending, setSending] = useState(false);
  const [notice, setNotice] = useState<string>();
  const noteFieldId = useId();
  const throughFieldId = useId();

  const anchor = props.anchor;
  useEffect(() => {
    if (anchor === undefined) return;
    setNotice(undefined);
    setDraft({
      anchor: {
        path: anchor.path,
        side: anchor.side,
        startLine: anchor.line,
        excerpt: lineNoteExcerpt(anchor.text),
      },
      text: "",
      through: "",
    });
  }, [anchor]);

  const through = draft === undefined ? undefined : Number(draft.through);
  const throughValid =
    draft !== undefined &&
    (draft.through.trim().length === 0 ||
      (through !== undefined && Number.isInteger(through) && through >= draft.anchor.startLine));

  function saveDraft() {
    if (draft === undefined || draft.text.trim().length === 0 || !throughValid) return;
    const endLine =
      draft.through.trim().length === 0 ? draft.anchor.startLine : Number(draft.through);
    const note: CodeLineNote = {
      ...draft.anchor,
      id: draft.editingId ?? globalThis.crypto.randomUUID(),
      endLine,
      text: draft.text.trim(),
    };
    setNotes((current) =>
      draft.editingId === undefined
        ? [...current, note]
        : current.map((entry) => (entry.id === draft.editingId ? note : entry)),
    );
    setDraft(undefined);
  }

  async function send() {
    if (props.onSend === undefined || notes.length === 0 || sending || editing) return;
    const sent = notes;
    setSending(true);
    setNotice(undefined);
    try {
      const result = await props.onSend(lineNotesMessage(sent));
      if (result.status === "sent") {
        setNotes((current) => current.filter((note) => !sent.includes(note)));
        setNotice(
          sent.length === 1
            ? "Sent 1 note to this thread."
            : `Sent ${sent.length} notes to this thread.`,
        );
      } else setNotice(`${result.message} Your notes are kept.`);
    } catch {
      setNotice("The notes could not be sent. Your notes are kept.");
    } finally {
      setSending(false);
    }
  }

  // Sending mid-edit would send the note's old text and then let Save write
  // the edit into a note that is already gone.
  const editing = draft?.editingId !== undefined;
  const sendHeld = editing
    ? "Save or cancel the note you are editing before sending."
    : props.sendUnavailable;
  const pendingLabel = notes.length === 1 ? "Send 1 note" : `Send ${notes.length} notes`;
  return (
    <section aria-label="Line notes" className="code-line-notes">
      <h3 className="code-line-notes__title">Line notes</h3>
      {draft === undefined ? (
        notes.length === 0 ? (
          <p className="code-line-notes__hint">
            Select a line number in the diff to leave a note. Notes stay here until you send them
            together as one message.
          </p>
        ) : null
      ) : (
        <div className="code-line-notes__form">
          <p className="code-line-notes__anchor">
            {lineNoteAnchorLabel({ ...draft.anchor, endLine: draft.anchor.startLine })}
          </p>
          {draft.anchor.excerpt.length === 0 ? null : (
            <code className="code-line-notes__excerpt">{draft.anchor.excerpt}</code>
          )}
          <label className="code-delivery-pane__field" htmlFor={throughFieldId}>
            Through line (optional)
          </label>
          <OctantInput
            id={throughFieldId}
            inputMode="numeric"
            aria-invalid={!throughValid}
            value={draft.through}
            onChange={(event) => setDraft({ ...draft, through: event.target.value })}
          />
          {throughValid ? null : (
            <p className="code-line-notes__hint" role="status">
              {`Enter a line on the same side, ${draft.anchor.startLine} or later.`}
            </p>
          )}
          <label className="code-delivery-pane__field" htmlFor={noteFieldId}>
            Note
          </label>
          <OctantTextarea
            id={noteFieldId}
            value={draft.text}
            onChange={(event) => setDraft({ ...draft, text: event.target.value })}
          />
          <div className="code-line-notes__actions">
            <OctantButton
              type="button"
              size="sm"
              variant="secondary"
              disabled={draft.text.trim().length === 0 || !throughValid}
              onClick={saveDraft}
            >
              {draft.editingId === undefined ? "Add note" : "Save note"}
            </OctantButton>
            <OctantButton
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setDraft(undefined)}
            >
              Cancel
            </OctantButton>
          </div>
        </div>
      )}
      {notes.length === 0 ? null : (
        <>
          <ul aria-label="Pending notes" className="code-line-notes__list">
            {notes.map((note) => {
              const label = lineNoteAnchorLabel(note);
              return (
                <li key={note.id}>
                  <span className="code-line-notes__anchor">{label}</span>
                  {note.excerpt.length === 0 ? null : (
                    <code className="code-line-notes__excerpt">{note.excerpt}</code>
                  )}
                  <p>{note.text}</p>
                  <div className="code-line-notes__actions">
                    <OctantButton
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={`Edit note on ${label}`}
                      disabled={sending}
                      onClick={() =>
                        setDraft({
                          anchor: {
                            path: note.path,
                            side: note.side,
                            startLine: note.startLine,
                            excerpt: note.excerpt,
                          },
                          editingId: note.id,
                          text: note.text,
                          through: note.endLine > note.startLine ? String(note.endLine) : "",
                        })
                      }
                    >
                      Edit
                    </OctantButton>
                    <OctantButton
                      type="button"
                      size="sm"
                      variant="ghost"
                      aria-label={`Remove note on ${label}`}
                      disabled={sending}
                      onClick={() => {
                        setNotes((current) => current.filter((entry) => entry.id !== note.id));
                        if (draft?.editingId === note.id) setDraft(undefined);
                      }}
                    >
                      Remove
                    </OctantButton>
                  </div>
                </li>
              );
            })}
          </ul>
          <OctantButton
            type="button"
            size="sm"
            variant="default"
            disabled={sending || props.onSend === undefined || sendHeld !== undefined}
            onClick={() => void send()}
          >
            {sending ? "Sending…" : pendingLabel}
          </OctantButton>
          {sendHeld === undefined ? null : (
            <p className="code-line-notes__hint" role="status">
              {sendHeld}
            </p>
          )}
        </>
      )}
      {notice === undefined ? null : <OctantAlert tone="neutral">{notice}</OctantAlert>}
    </section>
  );
}
