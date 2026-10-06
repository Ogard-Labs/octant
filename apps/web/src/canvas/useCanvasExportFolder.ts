import type { CanvasClient } from "@octant/client-runtime/canvas-client";
import type { CanvasId } from "@octant/contracts";
import type { CanvasExportFolderView } from "@octant/contracts/canvas-export-folder";
import type { FolderBrowseResult, FolderCandidateId } from "@octant/contracts/folder-browse";
import { useCallback, useEffect, useState } from "react";

export interface CanvasExportFolderState {
  /** Where this Canvas exports to, as the host resolved it. */
  readonly view: CanvasExportFolderView | undefined;
  readonly busy: boolean;
  readonly message: string | undefined;
  /**
   * The host's folder browser for this Canvas. Absent on a host with no folder
   * surface at all, which is also why no chooser is shown.
   */
  readonly browse:
    | ((input: {
        readonly parentCandidateId?: FolderCandidateId;
        readonly search?: string;
      }) => Promise<FolderBrowseResult>)
    | undefined;
  /** Record a picked candidate. Answers whether the host took it. */
  readonly choose: (candidateId: FolderCandidateId) => Promise<boolean>;
}

/**
 * The folder a Canvas exports to.
 *
 * The host owns the folder, its version, and the host identity the browser
 * works against; this reads them and sends back only a candidate the host
 * itself listed. A refusal is shown in the host's words rather than re-derived.
 */
export function useCanvasExportFolder(options: {
  readonly client: CanvasClient | undefined;
  /** Absent before a Canvas is chosen, e.g. before an export dialog opens. */
  readonly canvasId: CanvasId | undefined;
}): CanvasExportFolderState {
  const { client, canvasId } = options;
  const [view, setView] = useState<CanvasExportFolderView | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | undefined>(undefined);

  const load = useCallback(async () => {
    const read = client?.exportFolder;
    if (read === undefined || canvasId === undefined) return;
    try {
      setView(await read(canvasId));
    } catch {
      setView(undefined);
    }
  }, [client, canvasId]);

  useEffect(() => {
    void load();
  }, [load]);

  const browse =
    view === undefined || client?.browseFolders === undefined
      ? undefined
      : (input: { readonly parentCandidateId?: FolderCandidateId; readonly search?: string }) =>
          client.browseFolders?.({
            hostId: view.hostId,
            mode: view.mode,
            ...input,
          }) ?? Promise.reject(new Error("Folder browsing is unavailable."));

  const choose = useCallback(
    async (candidateId: FolderCandidateId): Promise<boolean> => {
      const send = client?.chooseExportFolder;
      if (send === undefined || view === undefined || canvasId === undefined) return false;
      setBusy(true);
      setMessage(undefined);
      try {
        const result = await send({
          schemaVersion: 1,
          kind: "choose-canvas-export-folder",
          canvasId,
          mode: view.mode,
          candidateId,
          scope: view.scope,
          expectedVersion: view.settings.version,
        });
        if (result.kind === "canvas-export-folder-refused") {
          setMessage(result.message);
          return false;
        }
        await load();
        return true;
      } catch {
        setMessage("The export folder could not be saved.");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [client, canvasId, load, view],
  );

  return { view, busy, message, browse, choose };
}
