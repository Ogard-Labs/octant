import type { ChatThreadView } from "@octant/contracts/chat";
import { Copy, Download } from "lucide-react";
import { useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";
import { buildChatMarkdownExport } from "./chatMarkdownExport";

export interface ChatExportControlProps {
  readonly view: ChatThreadView;
  readonly connectionStatus?: "connected" | "disconnected";
}

/**
 * Copies or saves the conversation as Markdown.
 *
 * The export is built from the authoritative thread view this client holds and
 * always says what it could not include — a response still arriving, unreadable
 * content, attachments, superseded revisions, a disconnected stream. When
 * anything is missing the control says so here too, so a partial export is
 * never handed over as if it were the whole conversation.
 */
export function ChatExportControl(props: ChatExportControlProps) {
  const [status, setStatus] = useState<string | undefined>(undefined);

  function build() {
    return buildChatMarkdownExport({
      view: props.view,
      ...(props.connectionStatus === undefined ? {} : { connectionStatus: props.connectionStatus }),
    });
  }

  function completenessSuffix(complete: boolean): string {
    return complete ? "" : " Some of the conversation could not be included; see the export notes.";
  }

  return (
    <div aria-label="Export conversation" className="chat-workspace__export" role="group">
      <OctantButton
        onClick={() => {
          const exported = build();
          void (async () => {
            try {
              // A window without the Clipboard API must not be told the copy
              // succeeded: optional chaining would resolve to `undefined` and
              // report success while nothing was written.
              const writeText = globalThis.navigator?.clipboard?.writeText;
              if (typeof writeText !== "function") {
                setStatus("The conversation could not be copied to the clipboard.");
                return;
              }
              await writeText.call(navigator.clipboard, exported.markdown);
              setStatus(`Conversation copied as Markdown.${completenessSuffix(exported.complete)}`);
            } catch {
              setStatus("The conversation could not be copied to the clipboard.");
            }
          })();
        }}
        size="sm"
        type="button"
        variant="ghost"
      >
        <Copy aria-hidden="true" size={14} strokeWidth={1.7} />
        Copy Markdown
      </OctantButton>
      <OctantButton
        onClick={() => {
          const exported = build();
          const saved = saveMarkdown(exported.markdown, exported.fileName);
          setStatus(
            saved
              ? `Saved ${exported.fileName}.${completenessSuffix(exported.complete)}`
              : "The conversation could not be saved from this window.",
          );
        }}
        size="sm"
        type="button"
        variant="ghost"
      >
        <Download aria-hidden="true" size={14} strokeWidth={1.7} />
        Save Markdown
      </OctantButton>
      {status === undefined ? null : (
        <p aria-live="polite" className="chat-workspace__export-status" role="status">
          {status}
        </p>
      )}
    </div>
  );
}

/** Hands the Markdown to the host as a local download; no network is involved. */
function saveMarkdown(markdown: string, fileName: string): boolean {
  if (typeof URL.createObjectURL !== "function") return false;
  const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
  try {
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = "noreferrer";
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    return true;
  } finally {
    URL.revokeObjectURL(url);
  }
}
