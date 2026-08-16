import type { ZenNotesElementPayload } from "@octant/contracts/zen";
import { useEffect, useRef, useState } from "react";

const AUTOSAVE_DELAY_MS = 400;

export interface ZenNotesProps {
  readonly element: ZenNotesElementPayload;
  readonly onSave?: (
    elementId: ZenNotesElementPayload["elementId"],
    content: string,
    expectedWidgetVersion: ZenNotesElementPayload["widgetVersion"],
  ) => Promise<void>;
}

export function ZenNotes({ element, onSave }: ZenNotesProps) {
  const [draft, setDraft] = useState(element.content);
  const [status, setStatus] = useState<"saved" | "saving" | "error">("saved");
  const lastSaved = useRef(element.content);
  const saveSequence = useRef(0);

  useEffect(() => {
    if (status !== "saved" || draft !== lastSaved.current) return;
    lastSaved.current = element.content;
    setDraft(element.content);
  }, [draft, element.content, element.widgetVersion, status]);

  useEffect(() => {
    if (draft === lastSaved.current || onSave === undefined) return;
    const sequence = ++saveSequence.current;
    const timer = window.setTimeout(() => {
      void onSave(element.elementId, draft, element.widgetVersion).then(
        () => {
          if (sequence !== saveSequence.current) return;
          lastSaved.current = draft;
          setStatus("saved");
        },
        () => {
          if (sequence !== saveSequence.current) return;
          setStatus("error");
        },
      );
    }, AUTOSAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [draft, element.elementId, element.widgetVersion, onSave]);

  const title = element.title ?? "Notes";
  const statusLabel = `${title} save status`;

  return (
    <div className="zen-notes">
      <textarea
        aria-label={`${title} content`}
        className="zen-notes__editor window-no-drag"
        disabled={element.locked}
        onChange={(event) => {
          setDraft(event.currentTarget.value);
          setStatus("saving");
        }}
        spellCheck
        value={draft}
      />
      {status === "error" ? (
        <p
          aria-label={statusLabel}
          className="zen-widget-status zen-widget-status--error"
          role="alert"
        >
          Save failed. Your draft is still here; edit it to retry.
        </p>
      ) : (
        <p aria-label={statusLabel} aria-live="polite" className="zen-widget-status" role="status">
          {status === "saving" ? "Saving…" : "Saved"}
        </p>
      )}
    </div>
  );
}
