import { useCallback, useEffect, useId, useState } from "react";
import {
  decodeFolderAttachmentId,
  type AttachFolderCommand,
  type CompatibleProjectEntry,
  type FolderAttachmentResult,
  type RootlessThreadSummary,
} from "@octant/contracts/rootless-thread";
import { LOCAL_HOST_ID } from "@octant/contracts/host";
import type { RootlessThreadClient } from "@octant/client-runtime/rootless-thread-client";
import type { FolderBrowseClient } from "@octant/client-runtime/folder-browse-client";
import type { OctantHostBridge } from "../shell/hostBridge";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantButton } from "../ui/base/OctantButton";
import { FolderPicker } from "../projects/FolderPicker";
import { FolderOpen, FolderPlus } from "lucide-react";

export interface RootlessAttachFolderDialogProps {
  readonly thread: RootlessThreadSummary;
  readonly client: Pick<RootlessThreadClient, "lookupCompatibleProjects" | "attachFolder">;
  readonly folderBrowseClient?: FolderBrowseClient;
  readonly hostBridge?: OctantHostBridge | undefined;
  readonly onAddFolder?: () => void;
  readonly onClose: () => void;
  readonly onAttached: () => void;
}

function isLocalHost(hostId: RootlessThreadSummary["hostId"]): boolean {
  return String(hostId) === String(LOCAL_HOST_ID);
}

type DialogStep =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "selecting-folder"; project: CompatibleProjectEntry }
  | { kind: "attaching"; project: CompatibleProjectEntry }
  | { kind: "error"; message: string };

export function RootlessAttachFolderDialog(props: RootlessAttachFolderDialogProps) {
  const [step, setStep] = useState<DialogStep>({ kind: "loading" });
  const [compatible, setCompatible] = useState<ReadonlyArray<CompatibleProjectEntry>>([]);
  const [errorMessage, setErrorMessage] = useState<string | undefined>(undefined);
  const pickerId = useId();

  const load = useCallback(async () => {
    setStep({ kind: "loading" });
    setErrorMessage(undefined);
    if (!isLocalHost(props.thread.hostId)) {
      const message =
        "This thread lives on a different host. Attach a folder from the host where this thread was created.";
      setStep({ kind: "error", message });
      setErrorMessage(message);
      return;
    }
    try {
      const entries = await props.client.lookupCompatibleProjects({
        threadId: props.thread.threadId,
        mode: props.thread.mode,
        hostId: props.thread.hostId,
      });
      setCompatible(entries);
      setStep({ kind: "ready" });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not load compatible Projects.";
      setStep({ kind: "error", message });
      setErrorMessage(message);
    }
  }, [props.client, props.thread]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleAttach = useCallback(
    async (project: CompatibleProjectEntry) => {
      setErrorMessage(undefined);

      if (!isLocalHost(props.thread.hostId)) {
        const message =
          "This thread lives on a different host. Attach a folder from the host where this thread was created.";
        setStep({ kind: "error", message });
        setErrorMessage(message);
        return;
      }

      if (props.hostBridge?.selectProjectRoot !== undefined && isLocalHost(props.thread.hostId)) {
        setStep({ kind: "attaching", project });
        let receipt: { receiptId: string } | undefined;
        try {
          const result = await props.hostBridge.selectProjectRoot(props.thread.mode);
          if (result.kind === "cancelled") {
            setStep({ kind: "ready" });
            return;
          }
          receipt = result;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "The native folder picker failed.";
          setStep({ kind: "error", message });
          setErrorMessage(message);
          return;
        }
        await submitAttach(project, receipt.receiptId);
        return;
      }

      if (props.folderBrowseClient !== undefined) {
        setStep({ kind: "selecting-folder", project });
        return;
      }

      const message =
        "This window has no folder picker. Attach a folder from the Octant desktop app or a browser with the host folder browser.";
      setStep({ kind: "error", message });
      setErrorMessage(message);
    },
    [props.hostBridge, props.folderBrowseClient, props.thread.hostId, props.thread.mode],
  );

  const submitAttach = useCallback(
    async (project: CompatibleProjectEntry, receiptId: string) => {
      setStep({ kind: "attaching", project });
      setErrorMessage(undefined);
      const command: AttachFolderCommand = {
        threadId: props.thread.threadId,
        projectId: project.projectId,
        receiptId,
        attachmentId: decodeFolderAttachmentId(globalThis.crypto.randomUUID()),
      };
      try {
        const result: FolderAttachmentResult = await props.client.attachFolder(command);
        if (result.kind === "attached") {
          props.onAttached();
        } else {
          setStep({ kind: "ready" });
          setErrorMessage(`The server refused the attachment: ${result.message ?? result.reason}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "Attachment request failed.";
        setStep({ kind: "ready" });
        setErrorMessage(message);
      }
    },
    [props.client, props.thread, props.onAttached],
  );

  function handleFolderSelected(receiptId: string) {
    if (step.kind !== "selecting-folder") return;
    void submitAttach(step.project, receiptId);
  }

  function handleFolderPickerCancel() {
    setStep({ kind: "ready" });
    setErrorMessage(undefined);
  }

  const modeLabel = props.thread.mode === "code" ? "Code" : "Work";

  return (
    <OctantDialog label="Attach folder" open onClose={props.onClose} popupId={pickerId}>
      <div className="rootless-attach-folder-dialog">
        <h2>Attach a {modeLabel} Project folder</h2>
        <p>Choose a saved {modeLabel} Project, then verify access by selecting the same folder.</p>

        {step.kind === "loading" || step.kind === "attaching" ? (
          <p role="status">
            {step.kind === "attaching"
              ? `Attaching ${step.project.displayName}…`
              : "Loading matching Projects…"}
          </p>
        ) : null}

        {step.kind === "selecting-folder" && props.folderBrowseClient !== undefined ? (
          <>
            <p role="status">
              Select the folder that matches <strong>{step.project.displayName}</strong>.
            </p>
            <FolderPicker
              client={props.folderBrowseClient}
              hostId={props.thread.hostId}
              mode={props.thread.mode}
              onCancel={handleFolderPickerCancel}
              onSelect={handleFolderSelected}
            />
          </>
        ) : null}

        {step.kind === "ready" ? (
          <>
            {compatible.length === 0 ? (
              <div className="rootless-attach-folder-dialog__empty" role="status">
                <p>No saved Projects match this thread.</p>
                {props.onAddFolder === undefined ? null : (
                  <OctantButton onClick={props.onAddFolder} type="button" variant="secondary">
                    <FolderPlus aria-hidden="true" size={14} strokeWidth={1.7} />
                    Add a local folder first
                  </OctantButton>
                )}
              </div>
            ) : (
              <ul
                aria-label="Compatible saved Projects"
                className="rootless-attach-folder-dialog__list"
              >
                {compatible.map((project) => (
                  <li key={String(project.projectId)}>
                    <OctantButton
                      onClick={() => handleAttach(project)}
                      type="button"
                      variant="ghost"
                    >
                      <FolderOpen aria-hidden="true" size={14} strokeWidth={1.7} />
                      Attach to {project.displayName}
                    </OctantButton>
                  </li>
                ))}
              </ul>
            )}
          </>
        ) : null}

        {errorMessage !== undefined ? (
          <p className="rootless-attach-folder-dialog__error" role="alert">
            {errorMessage}
          </p>
        ) : null}

        <div className="rootless-attach-folder-dialog__actions">
          <OctantButton onClick={props.onClose} type="button" variant="ghost">
            Cancel
          </OctantButton>
        </div>
      </div>
    </OctantDialog>
  );
}
