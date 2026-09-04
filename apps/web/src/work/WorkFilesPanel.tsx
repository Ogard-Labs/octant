import type {
  PreviewHostId,
  PreviewOpaqueRef,
  PreviewTargetId,
  ProjectId,
  WorkArtifactFormat,
  WorkFileListingEntry,
  WorkThreadId,
} from "@octant/contracts";
import type { WorkFileListingClient } from "@octant/client-runtime";
import { createWorkFileListingClient } from "@octant/client-runtime/work-file-listing-client";
import { FolderOpen, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { OctantButton } from "../ui/base/OctantButton";

type FileEntry = Extract<WorkFileListingEntry, { readonly kind: "file" }>;

/** Everything the shell needs to open one listed file, all of it host-minted. */
export interface WorkFileOpenRequest {
  readonly targetId: PreviewTargetId;
  readonly opaqueRef: PreviewOpaqueRef;
  readonly hostId: PreviewHostId;
  readonly projectId: ProjectId;
  readonly displayName: string;
}

type PanelStatus = "loading" | "ready" | "error";

export interface WorkFilesPanelProps {
  readonly threadId: WorkThreadId;
  readonly projectId?: ProjectId | undefined;
  /** Injected in tests; otherwise built from the server URL and capability. */
  readonly client?: WorkFileListingClient;
  readonly serverUrl?: string | undefined;
  readonly windowCapability?: string | undefined;
  /** Absent on a surface that cannot open a preview; rows then stay read-only. */
  readonly onOpenFile?: (request: WorkFileOpenRequest) => void;
}

/**
 * The files in the folder this Work thread's Project is bound to.
 *
 * The panel answers "what did this work produce" before "what else is here",
 * so the host's own attribution decides the grouping: files Work wrote are
 * named with their format and version, and the rest of the folder follows.
 * Nothing is inferred from an extension — a file the folder already held is
 * shown as a name and a size, which is all the host actually knows about it.
 */
export function WorkFilesPanel(props: WorkFilesPanelProps) {
  const [status, setStatus] = useState<PanelStatus>("loading");
  const [entries, setEntries] = useState<ReadonlyArray<WorkFileListingEntry>>([]);
  const [truncated, setTruncated] = useState(false);
  const [previewHostId, setPreviewHostId] = useState<PreviewHostId | undefined>(undefined);
  const [message, setMessage] = useState<string | undefined>(undefined);
  const [reloadKey, setReloadKey] = useState(0);

  const projectId = props.projectId;
  const injected = props.client;
  const serverUrl = props.serverUrl;
  const windowCapability = props.windowCapability;

  const client = useMemo((): WorkFileListingClient | undefined => {
    if (injected !== undefined) return injected;
    if (serverUrl === undefined || windowCapability === undefined) return undefined;
    try {
      return createWorkFileListingClient({
        baseUrl: serverUrl,
        fetch: globalThis.fetch,
        windowCapability,
      });
    } catch {
      return undefined;
    }
  }, [injected, serverUrl, windowCapability]);

  useEffect(() => {
    if (client === undefined || projectId === undefined) {
      setStatus("error");
      setMessage("Work files are unavailable in this window.");
      return;
    }
    const controller = new AbortController();
    let cancelled = false;
    setStatus("loading");
    setMessage(undefined);
    void client
      .list({ threadId: props.threadId, projectId }, controller.signal)
      .then((result) => {
        if (cancelled) return;
        if (result.status === "failed") {
          setStatus("error");
          setMessage(result.failure.message);
          return;
        }
        setEntries(result.listing.entries);
        setPreviewHostId(result.listing.previewHostId);
        setTruncated(result.listing.truncated);
        setStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setStatus("error");
        setMessage("Work files could not be read.");
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [client, projectId, props.threadId, reloadKey]);

  const refresh = useCallback(() => setReloadKey((current) => current + 1), []);

  const onOpenFile = props.onOpenFile;
  // Opening needs the host's own target and the host it belongs to. A listing
  // that carries neither leaves the rows readable and inert rather than letting
  // the renderer assemble a target of its own.
  const open = useMemo(() => {
    if (onOpenFile === undefined || previewHostId === undefined || projectId === undefined) {
      return undefined;
    }
    return (entry: FileEntry) => {
      if (entry.preview === undefined) return;
      onOpenFile({
        targetId: entry.preview.targetId,
        opaqueRef: entry.preview.opaqueRef,
        hostId: previewHostId,
        projectId,
        displayName: entry.path,
      });
    };
  }, [onOpenFile, previewHostId, projectId]);

  const authored = entries.filter(
    (entry): entry is FileEntry => entry.kind === "file" && entry.origin === "authored",
  );
  const rest = entries.filter((entry) => entry.kind !== "file" || entry.origin !== "authored");

  return (
    <div className="work-files-panel">
      <div className="work-files-panel__toolbar">
        <OctantButton
          aria-label="Refresh files"
          disabled={status === "loading"}
          onClick={refresh}
          size="icon"
          title="Refresh files"
          type="button"
          variant="ghost"
        >
          <RefreshCw aria-hidden="true" size={14} strokeWidth={1.8} />
        </OctantButton>
      </div>

      {status === "loading" ? (
        <p className="work-files-panel__status" role="status">
          Reading this Project&rsquo;s folder…
        </p>
      ) : null}

      {status === "error" ? (
        <p className="work-files-panel__error" role="alert">
          {message ?? "Work files are unavailable."}
        </p>
      ) : null}

      {truncated ? (
        <p className="work-files-panel__status" role="status">
          Octant listed part of this folder. The list is incomplete.
        </p>
      ) : null}

      {status === "ready" && entries.length === 0 ? (
        <p className="work-files-panel__status" role="status">
          <FolderOpen aria-hidden="true" size={16} strokeWidth={1.8} />
          This folder is empty.
        </p>
      ) : null}

      {authored.length > 0 ? (
        <section aria-label="Made here" className="work-files-panel__group">
          <h3 className="oct-section-label">Made here</h3>
          <ul className="work-files-panel__list">
            {authored.map((entry) => (
              <FileRow
                detail={
                  entry.artifact === undefined
                    ? formatBytes(entry.byteLength)
                    : `${formatLabel(entry.artifact.format)} · v${entry.artifact.sequence} · ${formatBytes(entry.byteLength)}`
                }
                entry={entry}
                key={entry.path}
                {...(open === undefined ? {} : { onOpen: open })}
              />
            ))}
          </ul>
        </section>
      ) : null}

      {rest.length > 0 ? (
        <section aria-label="In this folder" className="work-files-panel__group">
          <h3 className="oct-section-label">In this folder</h3>
          <ul className="work-files-panel__list">
            {rest.map((entry) =>
              entry.kind === "directory" ? (
                <li className="work-files-panel__row" key={entry.path}>
                  <span className="oct-row-label">{entry.path}</span>
                  <span className="oct-row-detail">Folder</span>
                </li>
              ) : (
                <FileRow
                  detail={formatBytes(entry.byteLength)}
                  entry={entry}
                  key={entry.path}
                  {...(open === undefined ? {} : { onOpen: open })}
                />
              ),
            )}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

/** The format names a person uses for these files, not the host's literals. */
function formatLabel(format: WorkArtifactFormat): string {
  switch (format) {
    case "markdown":
      return "Markdown";
    case "markdown-deck":
      return "Deck";
    case "docx":
      return "Word";
    case "pptx":
      return "Slides";
    case "xlsx":
      return "Spreadsheet";
    case "csv":
      return "CSV";
    case "pdf":
      return "PDF";
    case "image":
      return "Image";
  }
}

function formatBytes(byteLength: number): string {
  if (byteLength < 1_024) return `${byteLength} B`;
  if (byteLength < 1_024 * 1_024) return `${Math.round(byteLength / 1_024)} KB`;
  return `${(byteLength / (1_024 * 1_024)).toFixed(1)} MB`;
}

/**
 * One listed file. It is a button only when the host gave it a target to open;
 * otherwise it stays a row, because a control that looks interactive and does
 * nothing is worse than one that never claimed to be.
 */
function FileRow(props: {
  readonly entry: FileEntry;
  readonly detail: string;
  readonly onOpen?: (entry: FileEntry) => void;
}) {
  const openable = props.onOpen !== undefined && props.entry.preview !== undefined;
  if (!openable) {
    return (
      <li className="work-files-panel__row">
        <span className="oct-row-label">{props.entry.path}</span>
        <span className="oct-row-detail">{props.detail}</span>
      </li>
    );
  }
  return (
    <li>
      <OctantButton
        className="work-files-panel__row work-files-panel__row--openable"
        onClick={() => props.onOpen?.(props.entry)}
        title={`Open ${props.entry.path}`}
        type="button"
        variant="ghost"
      >
        <span className="oct-row-label">{props.entry.path}</span>
        <span className="oct-row-detail">{props.detail}</span>
      </OctantButton>
    </li>
  );
}
