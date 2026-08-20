import type { CodeClient, CodeFileSaveResult } from "@octant/client-runtime/code-client";
import type {
  CodeCheckoutId,
  CodeFileId,
  CodeFileMetadata,
  CodeRelativePath,
  CodeThread,
  CodeThreadId,
} from "@octant/contracts/code";
import type { CodeEvidenceReference } from "@octant/contracts/code-operations";
import { useCallback, useEffect, useRef, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { MonacoEditorAdapter, type MonacoAdapterRuntime } from "./MonacoEditorAdapter";

interface CodeEditorFileFields {
  readonly checkoutId: CodeCheckoutId;
  readonly executionPolicy: CodeThread["executionPolicy"];
  readonly fileId: CodeFileId;
  readonly language: string;
  readonly path: CodeRelativePath;
  readonly threadId: CodeThreadId;
}

export type CodeEditorFileProjection = CodeEditorFileFields &
  (
    | {
        readonly state: "available";
        readonly content: CodeEvidenceReference;
        readonly metadata: CodeFileMetadata;
      }
    | {
        readonly state: "read-only";
        readonly metadata: CodeFileMetadata;
        readonly reason: "binary" | "oversized";
      }
    | { readonly state: "unavailable"; readonly reason: string }
  );

export interface MonacoEditorPaneProps {
  readonly client: Pick<CodeClient, "content" | "save">;
  readonly draftStore?: CodeEditorDraftStore;
  readonly file: CodeEditorFileProjection;
  readonly loadRuntime?: () => Promise<MonacoAdapterRuntime>;
  readonly onRequestRefresh?: () => void;
  readonly onOpenExternalEditor?: () => Promise<void>;
}

export interface CodeEditorDraftStore {
  readonly clear: (key: string) => void;
  readonly read: (key: string) => string | undefined;
  readonly write: (key: string, value: string) => void;
}

type LoadState =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly text: string }
  | { readonly kind: "unavailable"; readonly message: string };

export function MonacoEditorPane(props: MonacoEditorPaneProps) {
  if (props.file.state === "read-only") return <ReadOnlyFile file={props.file} />;
  if (props.file.state === "unavailable") return <UnavailableFile file={props.file} />;
  return <AvailableEditor {...props} file={props.file} />;
}

function AvailableEditor(
  props: MonacoEditorPaneProps & {
    readonly file: Extract<CodeEditorFileProjection, { readonly state: "available" }>;
  },
) {
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string>();
  const [conflict, setConflict] = useState<"external" | "save">();
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const dirtyRef = useRef(false);
  const draftRef = useRef("");
  const metadataRef = useRef(props.file.metadata);
  const requestGeneration = useRef(0);
  const mounted = useRef(true);
  // Manual edits are the user's own action; only Plan mode is read-only.
  const writable = props.file.executionPolicy !== "plan";
  const draftKey = modelUri(props.file.checkoutId, props.file.fileId);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestGeneration.current += 1;
    };
  }, []);

  useEffect(() => {
    // A watched change re-opens the file underneath a pane that stays mounted.
    // While the user holds unsaved work, the pane keeps both the draft and the
    // identity and digest that draft was based on: adopting the external
    // revision here would let Save carry the new digest and overwrite the
    // external edit without the host ever seeing a conflict.
    if (dirtyRef.current && !sameRevision(metadataRef.current, props.file.metadata)) {
      setConflict("external");
      setMessage(undefined);
      return;
    }
    metadataRef.current = props.file.metadata;
    const request = ++requestGeneration.current;
    setLoadState({ kind: "loading" });
    setConflict(undefined);
    setMessage(undefined);
    void props.client
      .content(props.file.content.contentId)
      .then((bytes) => {
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw new Error("The file is not valid UTF-8 and cannot be edited.");
        }
        if (!mounted.current || request !== requestGeneration.current) return;
        const restoredDraft = props.draftStore?.read(draftKey);
        const nextDraft = restoredDraft ?? text;
        const nextDirty = nextDraft !== text;
        setLoadState({ kind: "ready", text });
        setDraft(nextDraft);
        draftRef.current = nextDraft;
        setDirty(nextDirty);
        dirtyRef.current = nextDirty;
      })
      .catch((error: unknown) => {
        if (!mounted.current || request !== requestGeneration.current) return;
        setLoadState({
          kind: "unavailable",
          message: safeMessage(error, "Code file content is unavailable."),
        });
      });
  }, [
    props.client,
    props.draftStore,
    props.file.content.contentId,
    props.file.metadata,
    reloadGeneration,
    draftKey,
  ]);

  const save = useCallback(async () => {
    if (!writable || !dirty || saving || loadState.kind !== "ready") return;
    const savedDraft = draftRef.current;
    setSaving(true);
    setConflict(undefined);
    setMessage(undefined);
    try {
      const result = await props.client.save({
        threadId: props.file.threadId,
        checkoutId: props.file.checkoutId,
        path: props.file.path,
        expectedIdentity: metadataRef.current.identity,
        expectedDigest: metadataRef.current.digest,
        text: savedDraft,
      });
      if (!mounted.current) return;
      applySaveResult(result);
    } catch (error) {
      if (mounted.current) setMessage(saveFailureMessage(error));
    } finally {
      setSaving(false);
    }

    function applySaveResult(result: CodeFileSaveResult) {
      switch (result.status) {
        case "completed":
          metadataRef.current = result.metadata;
          setLoadState({ kind: "ready", text: savedDraft });
          const nextDirty = draftRef.current !== savedDraft;
          setDirty(nextDirty);
          dirtyRef.current = nextDirty;
          if (nextDirty) props.draftStore?.write(draftKey, draftRef.current);
          else props.draftStore?.clear(draftKey);
          setMessage(nextDirty ? "Saved earlier changes. New edits remain unsaved." : "Saved");
          return;
        case "conflict":
          setConflict("save");
          return;
        case "interrupted":
          setMessage("Save was interrupted. Rescan the file before retrying.");
          return;
        case "failed":
          setMessage("Code file save failed. The draft remains in this editor.");
      }
    }
  }, [
    dirty,
    draftKey,
    loadState.kind,
    props.client,
    props.draftStore,
    props.file,
    saving,
    writable,
  ]);

  const discardDraftAndReload = useCallback(() => {
    dirtyRef.current = false;
    setDirty(false);
    setConflict(undefined);
    setMessage(undefined);
    props.draftStore?.clear(draftKey);
    setReloadGeneration((value) => value + 1);
    props.onRequestRefresh?.();
  }, [draftKey, props.draftStore, props.onRequestRefresh]);

  return (
    <section aria-label={`Code editor for ${props.file.path}`} className="code-editor-pane">
      <header className="code-editor-pane__toolbar">
        <div>
          <span>Code file</span>
          <h1>{props.file.path}</h1>
        </div>
        {!writable ? <p>Plan · read-only</p> : null}
        {props.onOpenExternalEditor === undefined ? null : (
          <OctantButton
            aria-label={`Open ${props.file.path} externally`}
            onClick={() =>
              void props
                .onOpenExternalEditor?.()
                .then(() => setMessage("Opened in the configured external editor."))
                .catch(() => setMessage("Octant could not open the configured external editor."))
            }
            size="sm"
            type="button"
            variant="secondary"
          >
            Open externally
          </OctantButton>
        )}
        {writable ? (
          <OctantButton
            aria-label={`Save ${props.file.path}`}
            disabled={!dirty || saving || loadState.kind !== "ready"}
            onClick={() => void save()}
            size="sm"
            type="button"
            variant="secondary"
          >
            {saving ? "Saving…" : "Save"}
          </OctantButton>
        ) : null}
      </header>

      {conflict !== undefined ? (
        <div className="code-editor-pane__warning" role="alert">
          <strong>
            {conflict === "save"
              ? "This file changed outside this editor."
              : "A new external revision is available."}
          </strong>
          <p>Your draft is preserved. Reload only after deciding how to reconcile it.</p>
          <OctantButton onClick={discardDraftAndReload} size="sm" type="button" variant="secondary">
            Discard draft and reload
          </OctantButton>
        </div>
      ) : null}

      {message !== undefined ? (
        <p role={message === "Saved" ? "status" : "alert"}>{message}</p>
      ) : dirty && conflict === undefined ? (
        <p role="status">Unsaved changes</p>
      ) : null}

      {loadState.kind === "loading" ? <p role="status">Loading file…</p> : null}
      {loadState.kind === "unavailable" ? <p role="alert">{loadState.message}</p> : null}
      {loadState.kind === "ready" ? (
        <MonacoEditorAdapter
          ariaLabel={`Editor for ${props.file.path}`}
          language={props.file.language}
          {...(props.loadRuntime === undefined ? {} : { loadRuntime: props.loadRuntime })}
          modelUri={modelUri(props.file.checkoutId, props.file.fileId)}
          onChange={(value) => {
            setDraft(value);
            draftRef.current = value;
            const nextDirty = value !== loadState.text;
            setDirty(nextDirty);
            dirtyRef.current = nextDirty;
            if (nextDirty) props.draftStore?.write(draftKey, value);
            else props.draftStore?.clear(draftKey);
            setMessage(undefined);
          }}
          {...(writable ? { onSave: () => void save() } : {})}
          readOnly={!writable}
          value={draft}
        />
      ) : null}
    </section>
  );
}

function ReadOnlyFile(props: {
  readonly file: Extract<CodeEditorFileProjection, { readonly state: "read-only" }>;
}) {
  return (
    <section aria-label={`Read-only file ${props.file.path}`} className="code-editor-pane">
      <h1>{props.file.path}</h1>
      <p>
        {props.file.reason === "binary"
          ? "Binary files are read-only."
          : "Files larger than 5 MiB are read-only."}
      </p>
      <p>{props.file.metadata.byteLength.toLocaleString()} bytes</p>
    </section>
  );
}

function UnavailableFile(props: {
  readonly file: Extract<CodeEditorFileProjection, { readonly state: "unavailable" }>;
}) {
  return (
    <section aria-label={`Unavailable file ${props.file.path}`} className="code-editor-pane">
      <h1>{props.file.path}</h1>
      <p role="alert">{props.file.reason}</p>
    </section>
  );
}

/**
 * Whether two open answers describe the same bytes of the same file. A reopen
 * restages the content under a fresh reference, so only the file's identity and
 * digest say whether what is on disk still matches what a draft was based on.
 */
function sameRevision(observed: CodeFileMetadata, opened: CodeFileMetadata): boolean {
  return (
    observed.digest === opened.digest &&
    observed.identity.device === opened.identity.device &&
    observed.identity.inode === opened.identity.inode
  );
}

function modelUri(checkoutId: CodeCheckoutId, fileId: CodeFileId): string {
  return `octant-code://${checkoutId}/${fileId}`;
}

function safeMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

function saveFailureMessage(error: unknown): string {
  const category =
    typeof error === "object" && error !== null && "category" in error
      ? (error as { readonly category?: unknown }).category
      : undefined;
  if (category === "disconnected") {
    return "Octant is disconnected. Your draft remains in this editor; reconnect and retry save.";
  }
  if (category === "unavailable") {
    return "Code save is unavailable. Your draft remains in this editor; restore Code authority and retry save.";
  }
  return safeMessage(error, "Code file save failed.");
}
