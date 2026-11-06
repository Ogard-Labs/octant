import { createFileMentionClient } from "@octant/client-runtime";
import { decodeFileMentionRequestId, type FolderMentionScope } from "@octant/contracts";
import { useEffect, useRef, useState, type DragEvent } from "react";
import { getInjectedHostBridge, type OctantHostBridge } from "../shell/hostBridge";
import { OctantAlert } from "../ui/base/OctantAlert";

export function insertFolderReferences(draft: string, caret: number, paths: ReadonlyArray<string>) {
  const references = [...new Set(paths)]
    .map((path) => `@${path.replace(/\/$/u, "")}/`)
    .filter((reference) => {
      let index = draft.indexOf(reference);
      while (index >= 0) {
        const after = draft.charAt(index + reference.length);
        if (
          (index === 0 || /\s/u.test(draft.charAt(index - 1))) &&
          (after === "" || /\s/u.test(after))
        )
          return false;
        index = draft.indexOf(reference, index + reference.length);
      }
      return true;
    });
  if (references.length === 0) return { draft, caret };
  const before = draft.slice(0, caret);
  const after = draft.slice(caret);
  const inserted = `${before !== "" && !/\s$/u.test(before) ? " " : ""}${references.join(" ")} `;
  return { draft: `${before}${inserted}${after}`, caret: before.length + inserted.length };
}

/** Native paths are resolved only by the local desktop bridge, never File.name or renderer File.path. */
export function droppedFolders(
  transfer: DataTransfer,
  bridge: Pick<OctantHostBridge, "getDroppedFilePath"> | undefined,
) {
  const paths: string[] = [];
  const ordinaryFiles: File[] = [];
  let recognized = false;
  const fileItems = Array.from(transfer.items).filter((item) => item.kind === "file");
  for (const item of fileItems) {
    const file = item.getAsFile();
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory === true || (entry == null && file?.type === "" && file.size === 0)) {
      recognized = true;
      if (file !== null) {
        const path = bridge?.getDroppedFilePath?.(file);
        if (path !== undefined) paths.push(path);
      }
    } else if (file !== null) ordinaryFiles.push(file);
  }
  const uriList = transfer.getData("text/uri-list");
  if (uriList !== "" && fileItems.length === 0) {
    for (const line of uriList.split(/\r?\n/u)) {
      if (line === "" || line.startsWith("#")) continue;
      try {
        const url = new URL(line);
        if (url.protocol !== "file:") continue;
        recognized = true;
        if (
          bridge?.getDroppedFilePath === undefined ||
          (url.hostname !== "" && url.hostname !== "localhost") ||
          url.search !== "" ||
          url.hash !== ""
        )
          continue;
        paths.push(decodeURIComponent(url.pathname));
      } catch {
        /* A malformed URI never becomes a host path. */
      }
    }
  }
  return { recognized, paths: [...new Set(paths)], ordinaryFiles };
}

export function useDroppedFolderMentions(options: {
  readonly scope: FolderMentionScope | undefined;
  readonly draft: string;
  readonly onDraftChange: (text: string, caret: number) => void;
  readonly textarea: () => HTMLTextAreaElement | null;
  readonly serverUrl?: string | undefined;
  readonly windowCapability?: string | undefined;
  readonly hostId?: string | undefined;
  readonly refused?: boolean | undefined;
  readonly hostBridge?: Pick<OctantHostBridge, "getDroppedFilePath"> | undefined;
  readonly onFiles: (files: ReadonlyArray<File>) => void;
}) {
  const [notice, setNotice] = useState<string>();
  const latest = useRef(options);
  latest.current = options;
  const pending = useRef<AbortController | undefined>(undefined);
  const scopeKey = JSON.stringify(options.scope);
  useEffect(() => {
    setNotice(undefined);
    return () => pending.current?.abort();
  }, [scopeKey, options.hostId, options.refused]);

  function onDrop(event: DragEvent<HTMLTextAreaElement>) {
    let bridge = options.hostBridge;
    try {
      bridge ??= getInjectedHostBridge();
    } catch {
      bridge = undefined;
    }
    const dropped = droppedFolders(event.dataTransfer, bridge);
    if (!dropped.recognized) return false;
    event.preventDefault();
    if (dropped.ordinaryFiles.length > 0) options.onFiles(dropped.ordinaryFiles);
    if (
      bridge?.getDroppedFilePath === undefined ||
      options.refused === true ||
      (options.hostId !== undefined && options.hostId !== "local") ||
      options.scope === undefined ||
      options.serverUrl === undefined ||
      options.windowCapability === undefined
    ) {
      setNotice(
        "Folder drops require this computer’s desktop window and an existing local Project folder. For a future managed checkout, open the thread first. Remote client paths are unavailable.",
      );
      return true;
    }
    if (dropped.paths.length === 0 || dropped.paths.length > 8) {
      setNotice(
        "Could not identify the local folders. Drop up to eight folders from Finder or a local file tree.",
      );
      return true;
    }
    const { serverUrl, windowCapability, scope } = options;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const timeout = setTimeout(() => {
      if (controller.signal.aborted) return;
      controller.abort();
      setNotice("Folder check timed out. Try the drop again.");
    }, 10_000);
    setNotice("Checking folder references on this computer…");
    void (async () => {
      try {
        const result = await createFileMentionClient({
          baseUrl: serverUrl,
          windowCapability,
          fetch: globalThis.fetch,
        }).execute(
          {
            kind: "inspect-folder-mentions",
            requestId: decodeFileMentionRequestId(crypto.randomUUID()),
            scope,
            paths: dropped.paths,
          },
          controller.signal,
        );
        if (
          controller.signal.aborted ||
          JSON.stringify(latest.current.scope) !== scopeKey ||
          latest.current.hostId !== options.hostId ||
          latest.current.refused === true
        )
          return;
        if (result.kind !== "folder-mentions-inspected") {
          setNotice(
            "Folder references are unavailable for this Project. Check its folder binding and try again.",
          );
          return;
        }
        const current = latest.current;
        const inserted = insertFolderReferences(
          current.draft,
          current.textarea()?.selectionStart ?? current.draft.length,
          result.folders.map((folder) => folder.path),
        );
        current.onDraftChange(inserted.draft, inserted.caret);
        requestAnimationFrame(() => {
          if (controller.signal.aborted) return;
          const textarea = latest.current.textarea();
          if (textarea?.value !== inserted.draft) return;
          textarea.focus();
          textarea.setSelectionRange(inserted.caret, inserted.caret);
        });
        setNotice(
          [
            ...result.folders.map(
              (folder) =>
                `This computer: ${folder.path} — editable folder reference; contents were not read.`,
            ),
            ...result.unavailable.map(
              (folder) =>
                `${folder.path}: folder unavailable or outside this Project’s permitted folders. Use an existing in-scope folder or change the Project’s folder settings explicitly.`,
            ),
          ].join(" "),
        );
      } catch {
        if (!controller.signal.aborted)
          setNotice(
            "Could not check folder references. Draft text and attachments are preserved; check the Project’s folder binding and try again.",
          );
      } finally {
        clearTimeout(timeout);
      }
    })();
    return true;
  }
  return { onDrop, notice: notice === undefined ? null : <OctantAlert>{notice}</OctantAlert> };
}
