import { useEffect, useRef, useState } from "react";
import type { CodeClient } from "@octant/client-runtime/code-client";
import type {
  CodeCheckoutId,
  CodeFileMetadata,
  CodeRelativePath,
  CodeSearchMatch,
  CodeThreadId,
} from "@octant/contracts";
import { decodeCodeProjectFilePath } from "@octant/contracts";
import type { EditorDraftStore } from "../editor/editorDraftStore";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";

interface Replacement {
  readonly path: CodeRelativePath;
  readonly before: string;
  readonly after: string;
  readonly metadata: CodeFileMetadata;
  readonly draftKey: string;
  readonly count: number;
}

/** A bounded review followed by ordinary revision-checked saves; never blind replace-all. */
export function CodeWorkspaceReplace(props: {
  readonly client: Pick<CodeClient, "openFile" | "content" | "save">;
  readonly drafts: EditorDraftStore;
  readonly threadId: CodeThreadId;
  readonly checkoutId: CodeCheckoutId;
  readonly query: string;
  readonly matches: ReadonlyArray<CodeSearchMatch>;
  readonly truncated: boolean;
  readonly readOnly: boolean;
}) {
  const [replacement, setReplacement] = useState("");
  const [preview, setPreview] = useState<ReadonlyArray<Replacement>>();
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [notice, setNotice] = useState<string>();
  const identity = JSON.stringify([
    props.threadId,
    props.checkoutId,
    props.query,
    replacement,
    props.matches,
  ]);
  const current = useRef(identity);
  current.current = identity;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    setPreview(undefined);
  }, [identity]);
  const prepare = async () => {
    if (lock.current || props.query === "") return;
    const original = identity;
    lock.current = true;
    setBusy(true);
    setNotice(undefined);
    setPreview(undefined);
    try {
      const paths = [
        ...new Set(
          props.matches.map((match) =>
            decodeCodeProjectFilePath(
              match.folder === undefined ? match.path : `${match.folder}/${match.path}`,
            ),
          ),
        ),
      ];
      if (paths.length > 16)
        throw new Error("Narrow the search to at most 16 files before preparing replacements.");
      const edits: Replacement[] = [];
      let total = 0;
      for (const path of paths) {
        if (!mounted.current || current.current !== original) return;
        const opened = await props.client.openFile(props.threadId, props.checkoutId, path);
        if (opened.status !== "editable")
          throw new Error(`Cannot edit ${path}. Nothing was saved.`);
        if (opened.metadata.byteLength > 256 * 1024)
          throw new Error(
            "A matching file exceeds the replacement preview limit. Narrow the search.",
          );
        const draftKey = `octant-code://${props.checkoutId}/${opened.fileId}`;
        if (props.drafts.read(draftKey) !== undefined)
          throw new Error(`Save or discard the open draft for ${path} first.`);
        const before = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          await props.client.content(opened.content.contentId),
        );
        let count = 0;
        const pattern = new RegExp(props.query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
        const after = before.replace(pattern, () => {
          count += 1;
          return replacement;
        });
        total += before.length + after.length;
        if (total > 1024 * 1024 || new TextEncoder().encode(after).length > 256 * 1024)
          throw new Error("This preview is too large. Narrow the search.");
        if (count > 0 && before !== after)
          edits.push({ path, before, after, metadata: opened.metadata, draftKey, count });
      }
      if (mounted.current && current.current === original) setPreview(edits);
    } catch (error) {
      if (mounted.current)
        setNotice(error instanceof Error ? error.message : "Replacements could not be prepared.");
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const apply = async () => {
    if (lock.current || props.readOnly || preview === undefined) return;
    const original = identity;
    lock.current = true;
    setBusy(true);
    setPreview(undefined);
    let completed = 0;
    try {
      if (preview.some((file) => props.drafts.read(file.draftKey) !== undefined))
        throw new Error("An affected file has an unsaved draft.");
      for (const file of preview) {
        if (!mounted.current || current.current !== original)
          throw new Error("The search changed.");
        if (props.drafts.read(file.draftKey) !== undefined)
          throw new Error(`An unsaved draft opened for ${file.path}.`);
        const result = await props.client.save({
          threadId: props.threadId,
          checkoutId: props.checkoutId,
          path: file.path,
          expectedIdentity: file.metadata.identity,
          expectedDigest: file.metadata.digest,
          text: file.after,
        });
        if (result.status !== "completed")
          throw new Error(`Stopped at ${file.path}: ${result.status}.`);
        completed += 1;
      }
      if (mounted.current) setNotice(`Saved replacements in ${completed} files.`);
    } catch (error) {
      if (mounted.current)
        setNotice(
          `${completed} files saved. ${error instanceof Error ? error.message : "The save outcome is unknown."} Check the files before preparing again; nothing is retried automatically.`,
        );
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <details className="code-editor-pane__references">
      <summary>Replace in matching files</summary>
      <p>Case-insensitive literal replacements. Review every affected file before saving.</p>
      {props.truncated ? (
        <p role="status">
          Search results are incomplete. Replacements cover only the matching files listed here.
        </p>
      ) : null}
      <div className="editor-tools">
        <OctantInput
          aria-label="Replacement text"
          value={replacement}
          disabled={busy}
          onChange={(event) => setReplacement(event.target.value)}
        />
        <OctantButton
          size="sm"
          variant="secondary"
          disabled={busy || props.query === "" || props.matches.length === 0}
          onClick={() => void prepare()}
        >
          Preview replacements
        </OctantButton>
      </div>
      {busy ? <p role="status">Working…</p> : null}
      {notice === undefined ? null : <p role="status">{notice}</p>}
      {preview === undefined ? null : (
        <>
          <p>
            {preview.length} files will change. Saves stop at the first conflict; earlier successful
            saves remain.
          </p>
          {preview.map((file) => (
            <details key={file.path}>
              <summary>
                {file.path} · {file.count} replacements
              </summary>
              <p>Before</p>
              <pre>{file.before}</pre>
              <p>After</p>
              <pre>{file.after}</pre>
            </details>
          ))}
          <OctantButton
            size="sm"
            variant="secondary"
            disabled={busy || props.readOnly || preview.length === 0}
            onClick={() => void apply()}
          >
            Save reviewed replacements
          </OctantButton>
          {props.readOnly ? <p>Plan · read-only</p> : null}
        </>
      )}
    </details>
  );
}
