import type { FolderBrowseClient } from "@octant/client-runtime/folder-browse-client";
import type { OctantMode } from "@octant/contracts/modes";
import type { ProjectId } from "@octant/contracts/projects";
import { useEffect, useRef, useState } from "react";
import type { OctantHostBridge } from "../shell/hostBridge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialog } from "../ui/base/OctantDialog";
import { OctantInput } from "../ui/base/OctantInput";
import { FolderPicker } from "./FolderPicker";

export interface ProjectCreateDialogProps {
  readonly folderBrowseClient?: FolderBrowseClient;
  readonly hostBridge?: OctantHostBridge;
  readonly hostId?: string;
  readonly mode: OctantMode;
  readonly onClose: () => void;
  readonly onCreate: (
    mode: OctantMode,
    name: string,
    receiptId?: string,
  ) => Promise<ProjectId | undefined>;
  readonly onCreated: (projectId: ProjectId, mode: OctantMode, name: string) => void;
}

export function ProjectCreateDialog(props: ProjectCreateDialogProps) {
  if (props.mode === "chat") {
    return <ChatProjectCreateDialog {...props} />;
  }
  return <BoundProjectAddFolderDialog {...props} />;
}

function ChatProjectCreateDialog(props: ProjectCreateDialogProps) {
  const nameInputRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const operationGeneration = useRef(0);
  const [name, setName] = useState("");
  const [status, setStatus] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      operationGeneration.current += 1;
    };
  }, []);

  function requestClose() {
    if (submitting) return;
    operationGeneration.current += 1;
    props.onClose();
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const normalized = name.trim();
    if (normalized === "" || submitting) return;
    const operation = ++operationGeneration.current;
    setSubmitting(true);
    setStatus("");
    try {
      const projectId = await props.onCreate("chat", normalized, undefined);
      if (!alive.current || operation !== operationGeneration.current) return;
      if (projectId !== undefined) {
        props.onCreated(projectId, "chat", normalized);
        props.onClose();
      } else {
        setStatus("Project could not be created. Review the Project status and retry.");
      }
    } catch {
      if (!alive.current || operation !== operationGeneration.current) return;
      setStatus("Project creation could not be completed.");
    } finally {
      if (alive.current && operation === operationGeneration.current) {
        setSubmitting(false);
      }
    }
  }

  return (
    <OctantDialog
      className="project-dialog"
      initialFocus={nameInputRef}
      label="Create Project"
      onClose={requestClose}
      open
      popupId="create-project-dialog"
    >
      <div className="project-dialog__header">
        <div>
          <h1 id="create-project-title">Create Project</h1>
        </div>
        <OctantButton
          aria-label="Close new Project"
          disabled={submitting}
          onClick={requestClose}
          size="icon"
          type="button"
          variant="ghost"
        >
          ×
        </OctantButton>
      </div>
      <p>A virtual space for approved memory. No filesystem or shell access.</p>
      <form onSubmit={submit}>
        <label htmlFor="project-name">Project name</label>
        <OctantInput
          autoFocus
          id="project-name"
          onChange={(event) => setName(event.target.value)}
          placeholder="Untitled Project"
          ref={nameInputRef}
          required
          value={name}
        />
        <div className="project-dialog__actions">
          <OctantButton
            disabled={submitting}
            onClick={requestClose}
            type="button"
            variant="outline"
          >
            Cancel
          </OctantButton>
          <OctantButton disabled={submitting || name.trim() === ""} type="submit" variant="default">
            Create Project
          </OctantButton>
        </div>
      </form>
      <p aria-live="polite" className="project-dialog__status">
        {status}
      </p>
    </OctantDialog>
  );
}

function BoundProjectAddFolderDialog(props: ProjectCreateDialogProps) {
  const mode = props.mode === "code" ? "code" : "work";
  const alive = useRef(true);
  const operationGeneration = useRef(0);
  const [status, setStatus] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const nativeStarted = useRef(false);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      operationGeneration.current += 1;
    };
  }, []);

  useEffect(() => {
    if (props.hostBridge === undefined || nativeStarted.current || submitting) return;
    nativeStarted.current = true;
    void beginNativeSelection();
  }, [props.hostBridge]);

  async function commitSelection(receiptId: string, displayName: string) {
    const operation = ++operationGeneration.current;
    setSubmitting(true);
    setStatus("");
    try {
      const projectId = await props.onCreate(mode, displayName, receiptId);
      if (!alive.current || operation !== operationGeneration.current) return;
      if (projectId !== undefined) {
        props.onCreated(projectId, mode, displayName);
        props.onClose();
      } else {
        setStatus("Project could not be created. Review the Project status and retry.");
      }
    } catch {
      if (!alive.current || operation !== operationGeneration.current) return;
      setStatus("Project creation could not be completed.");
    } finally {
      if (alive.current && operation === operationGeneration.current) {
        setSubmitting(false);
      }
    }
  }

  async function beginNativeSelection() {
    if (props.hostBridge === undefined) return;
    const operation = ++operationGeneration.current;
    setSubmitting(true);
    setStatus("");
    try {
      const selection = await props.hostBridge.selectProjectRoot(mode);
      if (!alive.current || operation !== operationGeneration.current) return;
      if (selection.kind === "cancelled") {
        setStatus("Project creation cancelled.");
        setSubmitting(false);
        return;
      }
      const displayName =
        "displayName" in selection && typeof selection.displayName === "string"
          ? selection.displayName
          : "Folder";
      await commitSelection(selection.receiptId, displayName);
    } catch (error) {
      if (!alive.current || operation !== operationGeneration.current) return;
      setStatus(safeNativePickerMessage(error));
      setSubmitting(false);
    }
  }

  if (props.hostBridge !== undefined) {
    return (
      <OctantDialog
        className="project-dialog"
        label="Add folder"
        onClose={props.onClose}
        open
        popupId="create-project-dialog"
      >
        <div className="project-dialog__header">
          <div>
            <h1 id="create-project-title">Add folder</h1>
          </div>
          <OctantButton
            aria-label="Close new Project"
            onClick={props.onClose}
            size="icon"
            type="button"
            variant="ghost"
          >
            ×
          </OctantButton>
        </div>
        <p>Choose one directory. Octant records the binding.</p>
        <div className="project-dialog__actions">
          <OctantButton onClick={props.onClose} type="button" variant="outline">
            Cancel
          </OctantButton>
          <OctantButton onClick={() => void beginNativeSelection()} type="button" variant="default">
            {submitting ? "Retry" : "Choose folder"}
          </OctantButton>
        </div>
        <p aria-live="polite" className="project-dialog__status">
          {status}
        </p>
      </OctantDialog>
    );
  }

  if (props.folderBrowseClient !== undefined && props.hostId !== undefined) {
    return (
      <FolderPicker
        client={props.folderBrowseClient}
        hostId={props.hostId}
        mode={mode}
        onCancel={props.onClose}
        onSelect={(receiptId, displayName) => {
          void commitSelection(receiptId, displayName);
        }}
      />
    );
  }

  return (
    <OctantDialog
      className="project-dialog"
      label="Add folder"
      onClose={props.onClose}
      open
      popupId="create-project-dialog"
    >
      <div className="project-dialog__header">
        <div>
          <h1 id="create-project-title">Add folder</h1>
        </div>
        <OctantButton
          aria-label="Close new Project"
          onClick={props.onClose}
          size="icon"
          type="button"
          variant="ghost"
        >
          ×
        </OctantButton>
      </div>
      <p role="alert">
        Folder selection is unavailable. Authenticated web needs the host folder browser; Electron
        needs the native picker bridge.
      </p>
      <div className="project-dialog__actions">
        <OctantButton onClick={props.onClose} type="button" variant="default">
          Close
        </OctantButton>
      </div>
    </OctantDialog>
  );
}

function safeNativePickerMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Project creation could not be completed.";
  if (
    error.message === "Choose the top-level Git repository or linked-worktree folder." ||
    error.message === "Choose an accessible directory."
  ) {
    return error.message;
  }
  return "Project creation could not be completed.";
}
