import type { CodeClient } from "@octant/client-runtime/code-client";
import type { CodeCheckoutId, CodeThreadId } from "@octant/contracts/code";
import { decodeCodeRelativePath } from "@octant/contracts/code";
import { useEffect, useState } from "react";
import { useCodeFileChangeWatch, noticeTouches } from "../code/useCodeFileChangeWatch";
import { MarkdownLite } from "../preview/previewViewers";
import { ShellState } from "./ShellState";

export interface DockDocumentToolProps {
  readonly client: Pick<CodeClient, "openFile" | "content">;
  readonly threadId: CodeThreadId;
  readonly checkoutId?: CodeCheckoutId;
  /** Checkout-relative path of the document the thread wrote. */
  readonly path: string;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
}

type DocumentLoad =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly text: string }
  | { readonly kind: "unavailable"; readonly message: string };

const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(["md", "markdown", "mdx"]);

function isMarkdownPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot !== -1 && MARKDOWN_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

/**
 * Reads the document a turn wrote, beside the transcript.
 *
 * The file is opened through the same host-authorized path the editor uses,
 * so the dock never receives a root path and a Plan-mode or unreadable file
 * is refused the same way. A rewrite reaches the tool through the checkout
 * watch; the person keeps reading the document as it grows.
 */
export function DockDocumentTool(props: DockDocumentToolProps) {
  const [load, setLoad] = useState<DocumentLoad>({ kind: "loading" });
  const [revision, setRevision] = useState(0);
  const { client, threadId, checkoutId, path } = props;

  useCodeFileChangeWatch({
    enabled: checkoutId !== undefined,
    threadId,
    checkoutId,
    serverUrl: props.serverUrl,
    windowCapability: props.windowCapability,
    onChanged: (notice) => {
      if (noticeTouches(notice, path)) setRevision((current) => current + 1);
    },
  });

  useEffect(() => {
    let alive = true;
    if (checkoutId === undefined) {
      setLoad({ kind: "unavailable", message: "This thread has no checkout to read from." });
      return;
    }
    let relativePath;
    try {
      relativePath = decodeCodeRelativePath(path);
    } catch {
      setLoad({ kind: "unavailable", message: "The document path could not be read." });
      return;
    }
    // A rewrite keeps the last text on screen until the new one arrives, so
    // the document does not flash to a spinner every time the agent saves.
    setLoad((current) => (current.kind === "ready" ? current : { kind: "loading" }));
    void client
      .openFile(threadId, checkoutId, relativePath)
      .then(async (result) => {
        if (result.status !== "editable") {
          return {
            kind: "unavailable" as const,
            message:
              result.status === "read-only"
                ? result.reason === "binary"
                  ? "This file is binary and cannot be shown as a document."
                  : "This file is too large to show here."
                : "The document is not available right now.",
          };
        }
        const bytes = await client.content(result.content.contentId);
        try {
          return {
            kind: "ready" as const,
            text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          };
        } catch {
          return {
            kind: "unavailable" as const,
            message: "This file is not UTF-8 text and cannot be shown as a document.",
          };
        }
      })
      .catch(() => ({
        kind: "unavailable" as const,
        message: "The document could not be read.",
      }))
      .then((next) => {
        if (alive) setLoad(next);
      });
    return () => {
      alive = false;
    };
  }, [client, threadId, checkoutId, path, revision]);

  if (load.kind === "loading") {
    return <ShellState message="Reading the document." state="loading" title="Loading Document" />;
  }
  if (load.kind === "unavailable") {
    return <ShellState message={load.message} state="neutral" title="Document is unavailable" />;
  }
  return (
    <article aria-label={path} className="dock-document-tool">
      <p className="dock-document-tool__path oct-meta oct-meta--mono">{path}</p>
      {isMarkdownPath(path) ? (
        <div className="preview-viewer preview-viewer--markdown dock-document-tool__body">
          {load.text === "" ? (
            <p role="status">The document is empty.</p>
          ) : (
            <MarkdownLite text={load.text} />
          )}
        </div>
      ) : (
        <pre className="preview-viewer preview-viewer--text dock-document-tool__body">
          {load.text === "" ? "The document is empty." : load.text}
        </pre>
      )}
    </article>
  );
}
