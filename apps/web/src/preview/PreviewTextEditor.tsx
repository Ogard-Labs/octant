import { OctantToggleGroup, OctantToggleGroupItem } from "../ui/base/OctantToggleGroup";
import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { PreviewClient } from "@octant/client-runtime/preview-client";
import type { PreviewTarget, PreviewTextReply } from "@octant/contracts/previews";
import { createEditorDraftStore } from "../editor/editorDraftStore";
import { Markdown } from "../markdown/Markdown";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantAlert } from "../ui/base/OctantAlert";

const Editor = lazy(() =>
  import("../code/MonacoEditorAdapter").then((module) => ({ default: module.MonacoEditorAdapter })),
);
const Diff = lazy(() =>
  import("../code/MonacoDiffAdapter").then((module) => ({ default: module.MonacoDiffAdapter })),
);
type Source = Extract<PreviewTextReply, { kind: "ready" | "saved" }>;

/** A preview never supplies editable bytes: source is loaded and authorized separately. */
export function PreviewTextEditor(props: {
  readonly target: PreviewTarget;
  readonly client: PreviewClient;
  readonly children: ReactNode;
}) {
  const [view, setView] = useState<"preview" | "source" | "split">("preview");
  const [source, setSource] = useState<Source>();
  const [draft, setDraft] = useState("");
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const editorSave = useRef<(() => Promise<void>) | undefined>(undefined);
  const [notice, setNotice] = useState<string>();
  const [conflict, setConflict] = useState<Source>();
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const store = useMemo(
    () => createEditorDraftStore(String(props.target.hostId)),
    [props.target.hostId],
  );
  const key = `${props.target.projectId}:${source?.fileKey ?? props.target.opaqueRef}`;
  const markdown = /\.(md|markdown|mdx)$/i.test(props.target.displayName);
  const language = markdown ? "markdown" : languageForName(props.target.displayName);
  const change = (text: string) => {
    setDraft(text);
    draftRef.current = text;
    if (text === source?.text) {
      store.clear(key);
      store.clear(`${key}:base`);
    } else {
      store.write(key, text);
      if (store.read(`${key}:base`) === undefined && source !== undefined)
        store.write(`${key}:base`, source.revision);
    }
    setNotice(store.error?.());
  };
  const load = async () => {
    if (busyRef.current || props.client.text === undefined) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(undefined);
    try {
      const answer = await props.client.text({ target: props.target });
      if (!mounted.current) return;
      if (answer.kind !== "ready" && answer.kind !== "saved") {
        setNotice(`Editing is ${answer.kind}.`);
        return;
      }
      const recoveryKey = `${props.target.projectId}:${answer.fileKey}`;
      const recovered = store.read(recoveryKey);
      const baseline = store.read(`${recoveryKey}:base`);
      setSource(answer);
      setDraft(recovered ?? answer.text);
      if (recovered !== undefined && baseline !== undefined && baseline !== answer.revision)
        setConflict(answer);
      setView("source");
      if (recovered !== undefined) setNotice("Recovered unsaved edits from this device.");
    } catch {
      if (mounted.current) setNotice("The file could not be opened for editing. Try again.");
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const save = async () => {
    if (
      busyRef.current ||
      source === undefined ||
      conflict !== undefined ||
      props.client.text === undefined
    )
      return;
    const text = draftRef.current;
    busyRef.current = true;
    setBusy(true);
    setNotice(undefined);
    try {
      const answer = await props.client.text({
        target: props.target,
        change: { revision: source.revision, text },
      });
      if (!mounted.current) return;
      if (answer.kind === "saved") {
        setSource(answer);
        if (draftRef.current === text) {
          store.clear(key);
          store.clear(`${key}:base`);
        } else store.write(`${key}:base`, answer.revision);
        setNotice(
          store.error?.() ??
            (draftRef.current === text
              ? "Saved"
              : "Saved earlier edits. New edits remain unsaved."),
        );
      } else if (answer.kind === "conflict") {
        const latest = await props.client.text({ target: props.target });
        if (mounted.current && (latest.kind === "ready" || latest.kind === "saved"))
          setConflict(latest);
        if (mounted.current)
          setNotice(
            "The file changed on disk. Your draft is preserved; compare both versions before saving.",
          );
      } else setNotice(`The file was not saved: ${answer.kind}. Your draft is preserved.`);
    } catch {
      if (mounted.current)
        setNotice(
          "The save outcome is unknown. Reopen the file before retrying; your draft is preserved.",
        );
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <section className="code-editor-pane" aria-label={`File ${props.target.displayName}`}>
      <div className="editor-tools">
        <OctantToggleGroup<"preview" | "source" | "split">
          aria-label="File view"
          value={[view]}
          onValueChange={(values) => {
            const next = values[0];
            if (next === undefined) return;
            if (next === "source" && source === undefined) void load();
            else setView(next);
          }}
        >
          <OctantToggleGroupItem value="preview">Preview</OctantToggleGroupItem>
          <OctantToggleGroupItem value="source" disabled={busy}>
            {markdown ? "Source" : "Edit"}
          </OctantToggleGroupItem>
          {markdown && source !== undefined ? (
            <OctantToggleGroupItem value="split">Split</OctantToggleGroupItem>
          ) : null}
        </OctantToggleGroup>
        {source === undefined ? null : (
          <OctantButton
            size="sm"
            variant="secondary"
            disabled={busy || conflict !== undefined || draft === source.text}
            onClick={() => void (editorSave.current?.() ?? save())}
          >
            Save
          </OctantButton>
        )}
        {source === undefined ? null : (
          <OctantButton size="sm" variant="ghost" disabled={busy} onClick={() => void load()}>
            Reload file
          </OctantButton>
        )}
        {source !== undefined && draft !== source.text ? <span>Unsaved changes</span> : null}
      </div>
      {notice === undefined ? null : <p role="status">{notice}</p>}
      {busy ? <p role="status">Working…</p> : null}
      {conflict === undefined ? null : (
        <OctantAlert tone="warning">
          <p>The saved file differs from the draft's starting version.</p>
          <Suspense fallback={<p>Loading comparison…</p>}>
            <Diff
              ariaLabel="Disk and draft comparison"
              language={language}
              modelUriBase={`octant-code:/preview-conflict/${props.target.targetId}`}
              original={conflict.text}
              modified={draft}
              renderSideBySide={false}
            />
          </Suspense>
          <OctantButton
            size="sm"
            variant="secondary"
            onClick={() => {
              setSource(conflict);
              store.write(`${key}:base`, conflict.revision);
              setConflict(undefined);
              setNotice(
                store.error?.() ?? "Draft retained against the current version. Save when ready.",
              );
            }}
          >
            Keep draft against this version
          </OctantButton>
          <OctantButton
            size="sm"
            variant="ghost"
            onClick={() => {
              setSource(conflict);
              setDraft(conflict.text);
              store.clear(key);
              store.clear(`${key}:base`);
              setConflict(undefined);
              setNotice(store.error?.() ?? "Reloaded saved file.");
            }}
          >
            Discard draft and reload
          </OctantButton>
        </OctantAlert>
      )}
      {source === undefined ? (
        props.children
      ) : (
        <div className="text-editor-layout">
          <div hidden={view === "preview"} className="code-editor-pane">
            <Suspense fallback={<p>Loading editor…</p>}>
              <Editor
                ariaLabel={`Editor for ${props.target.displayName}`}
                language={language}
                modelUri={`octant-text:/${props.target.hostId}/${props.target.projectId}/${source.fileKey}`}
                value={draft}
                readOnly={busy}
                onChange={change}
                onSave={save}
                onReadySave={(save) => {
                  editorSave.current = save;
                }}
              />
            </Suspense>
          </div>
          {view === "source" ? null : markdown ? (
            <div className="preview-viewer">
              <Markdown body={draft} />
            </div>
          ) : (
            <pre className="preview-viewer">{draft}</pre>
          )}
        </div>
      )}
    </section>
  );
}

function languageForName(name: string): string {
  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  const languages: Readonly<Record<string, string>> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    py: "python",
    css: "css",
    html: "html",
    sh: "shell",
    xml: "xml",
    toml: "ini",
  };
  return languages[extension] ?? "plaintext";
}
