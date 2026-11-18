import { useEffect, useRef, useState, useLayoutEffect } from "react";
import type { CodeLanguageEditPreview } from "@octant/contracts/code-language";
import type { CodeLanguageEditOutcome } from "./useCodeLanguageServices";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantCollapsible } from "../ui/base/OctantCollapsible";

/** Explicit preparation never writes; the existing editor save route owns each reviewed write. */
export function CodeEditPreviews(props: {
  /** Which preparation the person asked for in the editor's menu. */
  readonly intent: "rename" | "quick-fixes";
  readonly onDismiss: () => void;
  readonly text: string;
  readonly writable: boolean;
  readonly prepare: (
    query: { readonly kind: "rename"; readonly newName: string } | { readonly kind: "quick-fixes" },
  ) => Promise<CodeLanguageEditOutcome | undefined>;
  readonly apply: (preview: CodeLanguageEditPreview) => Promise<string>;
  readonly onOpenExternal?: () => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [result, setResult] = useState<CodeLanguageEditOutcome>();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string>();
  const active = useRef(false);
  const nameField = useRef<HTMLInputElement>(null);
  const currentText = useRef(props.text);
  currentText.current = props.text;
  useLayoutEffect(() => {
    setResult(undefined);
  }, [props.text]);
  const prepare = async (query: Parameters<typeof props.prepare>[0]) => {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setNotice(undefined);
    setResult(undefined);
    try {
      const text = props.text;
      const answer = await props.prepare(query);
      if (currentText.current === text) setResult(answer);
    } catch {
      setNotice("The host did not answer. Prepare the changes again.");
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    if (props.intent === "quick-fixes") void prepare({ kind: "quick-fixes" });
    else nameField.current?.focus();
    // Asked once, when the menu item opens this panel.
  }, []);
  const apply = async (preview: CodeLanguageEditPreview) => {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setResult(undefined);
    try {
      setNotice(await props.apply(preview));
    } catch {
      setNotice(
        "The save outcome could not be confirmed. Check the files before preparing changes again; nothing is retried automatically.",
      );
    } finally {
      active.current = false;
      setBusy(false);
    }
  };
  return (
    <section
      className="code-editor-pane__references"
      aria-label="Reviewed code changes"
      onKeyDown={(event) => {
        if (event.key === "Escape" && result !== undefined) {
          event.preventDefault();
          event.stopPropagation();
          setResult(undefined);
          nameField.current?.focus();
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          props.onDismiss();
        }
      }}
    >
      <div className="code-editor-pane__reference-actions">
        {props.intent === "rename" ? (
          <>
            <OctantInput
              ref={nameField}
              aria-label="New symbol name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              disabled={busy}
            />
            <OctantButton
              type="button"
              size="sm"
              variant="ghost"
              disabled={busy || name.trim().length === 0 || name.length > 256}
              onClick={() => void prepare({ kind: "rename", newName: name.trim() })}
            >
              Preview rename
            </OctantButton>
          </>
        ) : null}
        <OctantButton type="button" size="sm" variant="ghost" onClick={props.onDismiss}>
          Close changes
        </OctantButton>
      </div>
      {busy ? <p role="status">Checking changes…</p> : null}
      {notice === undefined ? null : <p role="status">{notice}</p>}
      {result?.status === "edit-previews" ? (
        <>
          {result.previews.length === 0 ? (
            <p role="status">No supported edit-only fixes were returned.</p>
          ) : null}
          {result.previews.map((preview, index) => (
            <div key={index}>
              <strong>{preview.title}</strong>
              <p className="oct-meta">
                Review every file. Saves stop at the first conflict; earlier successful saves
                remain.
              </p>
              {preview.files.map((file) => (
                <OctantCollapsible key={file.path} summary={file.path}>
                  <p>Before</p>
                  <pre>{file.before}</pre>
                  <p>After</p>
                  <pre>{file.after}</pre>
                </OctantCollapsible>
              ))}
              <OctantButton
                type="button"
                size="sm"
                variant="secondary"
                disabled={busy || !props.writable || preview.files.length === 0}
                onClick={() => void apply(preview)}
              >
                Apply reviewed changes
              </OctantButton>
              {!props.writable ? (
                <p className="oct-meta">
                  Plan can preview; applying changes needs write authority.
                </p>
              ) : null}
            </div>
          ))}
        </>
      ) : result === undefined ? null : (
        <p role="status">
          {result.status === "unsupported"
            ? "This server does not report support for this action."
            : result.status === "edit-unavailable"
              ? `Changes cannot be prepared: ${result.reason}. Save drafts or narrow the change and try again.`
              : result.message}
        </p>
      )}
      {result !== undefined &&
      result.status !== "edit-previews" &&
      props.onOpenExternal !== undefined ? (
        <OctantButton
          type="button"
          size="sm"
          variant="ghost"
          onClick={() =>
            void props
              .onOpenExternal?.()
              .catch(() => setNotice("The external editor could not be opened."))
          }
        >
          Open externally
        </OctantButton>
      ) : null}
    </section>
  );
}
