import type { ChatTurnId } from "@octant/contracts/chat";
import { useEffect, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantTextarea } from "../ui/base/OctantTextarea";

export interface ChatTurnEditorProps {
  readonly turnId: ChatTurnId;
  /** The message as it currently stands; the editor opens with it. */
  readonly initialPrompt: string;
  readonly busy?: boolean;
  readonly onCancel: () => void;
  /** Called with the revised prompt. The server decides whether it is allowed. */
  readonly onSubmit: (turnId: ChatTurnId, prompt: string) => void;
}

/**
 * Inline editor for one user message in the transcript.
 *
 * The editor only collects a revised prompt: it makes no claim about whether
 * the edit is permitted, and it never mutates the transcript it is rendered
 * into. Accepting sends an `edit-chat-turn` command carrying the thread's
 * expected version, and the server decides.
 */
export function ChatTurnEditor(props: ChatTurnEditorProps) {
  const [draft, setDraft] = useState(props.initialPrompt);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // The editor is mounted per turn and unmounted on cancel, so focusing on
  // mount puts the caret at the end of the message being revised exactly once.
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea === null) return;
    textarea.focus();
    textarea.setSelectionRange(textarea.value.length, textarea.value.length);
  }, []);

  const trimmed = draft.trim();
  const unchanged = trimmed === props.initialPrompt.trim();
  const submittable = trimmed.length > 0 && !unchanged && props.busy !== true;

  return (
    <form
      aria-label="Edit your message"
      className="chat-transcript__editor"
      onSubmit={(event) => {
        event.preventDefault();
        if (!submittable) return;
        props.onSubmit(props.turnId, trimmed);
      }}
    >
      <label className="sr-only" htmlFor={`chat-turn-editor-${props.turnId}`}>
        Edit your message
      </label>
      <OctantTextarea
        disabled={props.busy === true}
        id={`chat-turn-editor-${props.turnId}`}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            props.onCancel();
            return;
          }
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && submittable) {
            event.preventDefault();
            props.onSubmit(props.turnId, trimmed);
          }
        }}
        ref={textareaRef}
        rows={3}
        value={draft}
      />
      <p className="chat-transcript__editor-note">
        Running this revision continues the conversation from here. Later messages stay in this
        thread&rsquo;s history but leave the conversation.
      </p>
      <div className="chat-transcript__editor-actions">
        <OctantButton disabled={!submittable} size="sm" type="submit">
          Save and run
        </OctantButton>
        <OctantButton
          disabled={props.busy === true}
          onClick={props.onCancel}
          size="sm"
          type="button"
          variant="secondary"
        >
          Cancel
        </OctantButton>
      </div>
    </form>
  );
}
