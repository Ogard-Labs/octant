import type { ThreadExportClient } from "@octant/client-runtime/thread-export-client";
import type { ChatThreadView } from "@octant/contracts/chat";
import { Copy, Download, Ellipsis, FileDown, PanelsTopLeft } from "lucide-react";
import { useMemo, useState } from "react";
import { exportThreadBundle, resolveThreadExportClient } from "../thread/threadExport";
import { OctantMenu, type OctantMenuItem } from "../ui/base/OctantMenu";
import { buildChatMarkdownExport } from "./chatMarkdownExport";

export interface ChatThreadActionsMenuProps {
  readonly view: ChatThreadView;
  readonly connectionStatus?: "connected" | "disconnected";
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  readonly exportClient?: ThreadExportClient;
  /** Present only when this window has a canvas surface to disclose. */
  readonly canvas?: {
    readonly open: boolean;
    readonly onToggle: () => void;
  };
}

/**
 * The thread header's single overflow menu: copy or save the conversation,
 * export the host's portable cut, and toggle the canvas panel. One trigger
 * replaces a row of always-visible buttons; every action stays exactly what
 * its standalone control did.
 *
 * The Markdown export is built from the authoritative thread view this client
 * holds and always says what it could not include — a response still
 * arriving, unreadable content, attachments, superseded revisions, a
 * disconnected stream. When anything is missing the receipt says so too, so a
 * partial export is never handed over as if it were the whole conversation.
 */
export function ChatThreadActionsMenu(props: ChatThreadActionsMenuProps) {
  const [status, setStatus] = useState<string | undefined>(undefined);
  const [exporting, setExporting] = useState(false);
  const exportClient = useMemo(
    () =>
      resolveThreadExportClient({
        ...(props.exportClient === undefined ? {} : { client: props.exportClient }),
        ...(props.serverUrl === undefined ? {} : { serverUrl: props.serverUrl }),
        ...(props.windowCapability === undefined
          ? {}
          : { windowCapability: props.windowCapability }),
      }),
    [props.exportClient, props.serverUrl, props.windowCapability],
  );

  function build() {
    return buildChatMarkdownExport({
      view: props.view,
      ...(props.connectionStatus === undefined ? {} : { connectionStatus: props.connectionStatus }),
    });
  }

  function completenessSuffix(complete: boolean): string {
    return complete ? "" : " Some of the conversation could not be included; see the export notes.";
  }

  function copyConversation() {
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
  }

  function saveConversation() {
    const exported = build();
    const saved = saveMarkdown(exported.markdown, exported.fileName);
    setStatus(
      saved
        ? `Saved ${exported.fileName}.${completenessSuffix(exported.complete)}`
        : "The conversation could not be saved from this window.",
    );
  }

  function exportThread() {
    if (exportClient === undefined || exporting) return;
    setExporting(true);
    setStatus(undefined);
    void (async () => {
      try {
        setStatus(
          await exportThreadBundle(exportClient, {
            mode: "chat",
            threadId: String(props.view.thread.id),
            title: props.view.thread.title,
          }),
        );
      } finally {
        setExporting(false);
      }
    })();
  }

  const items: ReadonlyArray<OctantMenuItem> = [
    {
      icon: <Copy aria-hidden="true" size={14} strokeWidth={1.7} />,
      label: "Copy conversation",
      value: "copy-conversation",
    },
    {
      icon: <Download aria-hidden="true" size={14} strokeWidth={1.7} />,
      label: "Save as Markdown",
      value: "save-markdown",
    },
    ...(exportClient === undefined
      ? []
      : [
          {
            icon: <FileDown aria-hidden="true" size={14} strokeWidth={1.7} />,
            label: exporting ? "Exporting…" : "Export…",
            value: "export-thread",
          },
        ]),
    ...(props.canvas === undefined
      ? []
      : [
          {
            icon: <PanelsTopLeft aria-hidden="true" size={14} strokeWidth={1.7} />,
            // The label carries the panel's state because a menu item cannot
            // wear the disclosure's aria-expanded the standalone button had.
            label: props.canvas.open ? "Hide canvas" : "Show canvas",
            value: "canvas",
          },
        ]),
  ];

  return (
    <div className="chat-workspace__thread-actions">
      <OctantMenu
        items={items}
        onValueChange={(value) => {
          if (value === "copy-conversation") copyConversation();
          else if (value === "save-markdown") saveConversation();
          else if (value === "export-thread") exportThread();
          else if (value === "canvas") props.canvas?.onToggle();
        }}
        trigger={<Ellipsis aria-hidden="true" className="icon" size={16} strokeWidth={1.5} />}
        triggerClassName="shell-icon-button"
        triggerLabel="Thread actions"
        // No item is a persistent choice: an empty value keeps every click a
        // fresh action instead of a radio selection that would stop firing.
        value=""
      />
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
