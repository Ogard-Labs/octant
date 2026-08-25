import type { FolderBrowseClient } from "@octant/client-runtime/folder-browse-client";
import type { OctantMode } from "@octant/contracts/modes";
import type { ProjectId } from "@octant/contracts/projects";
import { FolderOpen } from "lucide-react";
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
      <form noValidate onSubmit={submit}>
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
          <OctantButton disabled={submitting} onClick={requestClose} type="button" variant="ghost">
            Cancel
          </OctantButton>
          <OctantButton disabled={submitting || name.trim() === ""} type="submit">
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

/**
 * Naming and binding a Work or Code Project in one dialog.
 *
 * The native picker used to open the moment this dialog mounted, and what sat
 * behind it was a single sentence and a Retry button: a person who had not
 * decided anything yet was already standing in a file chooser, and the Project
 * took the folder's name with no say in it. The dialog now states both facts it
 * is about — the name and the folder — and opens the picker only when asked.
 *
 * One folder, not a list: a bound Project has exactly one canonical root, so a
 * second folder is a second Project rather than another row here.
 */
function BoundProjectAddFolderDialog(props: ProjectCreateDialogProps) {
  const mode = props.mode === "code" ? "code" : "work";
  const alive = useRef(true);
  const operationGeneration = useRef(0);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [name, setName] = useState("");
  /**
   * The chosen folder as the receipt the host minted for it, plus the label to
   * show. The renderer never learns the path: the receipt is the authority the
   * server binds against, and a path echoed here would be a second answer to
   * where this Project lives.
   */
  const [folder, setFolder] = useState<{
    readonly receiptId: string;
    readonly displayName: string;
  }>();

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  function requestClose() {
    operationGeneration.current += 1;
    props.onClose();
  }

  async function createProject(receiptId: string, projectName: string) {
    const operation = ++operationGeneration.current;
    setSubmitting(true);
    setStatus("");
    try {
      const projectId = await props.onCreate(mode, projectName, receiptId);
      if (!alive.current || operation !== operationGeneration.current) return;
      if (projectId !== undefined) {
        props.onCreated(projectId, mode, projectName);
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

  async function chooseFolder() {
    const bridge = props.hostBridge;
    if (bridge === undefined || choosing || submitting) return;
    const operation = ++operationGeneration.current;
    setChoosing(true);
    setStatus("");
    try {
      const selection = await bridge.selectProjectRoot(mode);
      // `alive` alone answers whether this dialog is still on screen. The
      // generation moves only when a newer operation starts or the dialog is
      // dismissed; bumping it on unmount too stranded the pick that a
      // development-mode remount interrupted, leaving a dialog that reported
      // nothing and offered only Retry.
      if (!alive.current || operation !== operationGeneration.current) return;
      setChoosing(false);
      if (selection.kind === "cancelled") return;
      const displayName =
        "displayName" in selection && typeof selection.displayName === "string"
          ? selection.displayName
          : "Folder";
      setFolder({ receiptId: selection.receiptId, displayName });
      // The folder names the Project until the user says otherwise. A name they
      // already typed is theirs, and a later pick does not overwrite it.
      setName((current) => (current.trim() === "" ? displayName : current));
    } catch (error) {
      if (!alive.current || operation !== operationGeneration.current) return;
      setChoosing(false);
      setStatus(safeNativePickerMessage(error));
    }
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const normalized = name.trim();
    const chosen = folder;
    if (chosen === undefined || normalized === "" || submitting) return;
    void createProject(chosen.receiptId, normalized);
  }

  if (props.hostBridge !== undefined) {
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
            onClick={requestClose}
            size="icon"
            type="button"
            variant="ghost"
          >
            ×
          </OctantButton>
        </div>
        <p>
          {mode === "code"
            ? "One folder, opened as a Git repository. Octant records the binding."
            : "One folder, bound as this Project's root. Octant records the binding."}
        </p>
        <form noValidate onSubmit={submit}>
          <label htmlFor="project-name">Project name</label>
          <OctantInput
            id="project-name"
            onChange={(event) => setName(event.target.value)}
            placeholder="Untitled Project"
            ref={nameInputRef}
            required
            value={name}
          />
          <p className="project-dialog__field-label" id="project-folder-label">
            Folder
          </p>
          <OctantButton
            aria-describedby="project-folder-label"
            className="project-dialog__folder"
            data-chosen={folder === undefined ? "false" : "true"}
            disabled={choosing || submitting}
            onClick={() => void chooseFolder()}
            type="button"
            variant="ghost"
          >
            <FolderOpen aria-hidden="true" size={16} strokeWidth={1.6} />
            <span className="project-dialog__folder-name">
              {folder?.displayName ??
                (choosing ? "Waiting for the folder chooser…" : "Choose a folder")}
            </span>
            {folder === undefined ? null : (
              <span className="project-dialog__folder-change">Change</span>
            )}
          </OctantButton>
          <div className="project-dialog__actions">
            <OctantButton onClick={requestClose} type="button" variant="ghost">
              Cancel
            </OctantButton>
            <OctantButton
              disabled={submitting || choosing || folder === undefined || name.trim() === ""}
              type="submit"
            >
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

  if (props.folderBrowseClient !== undefined && props.hostId !== undefined) {
    return (
      <FolderPicker
        client={props.folderBrowseClient}
        hostId={props.hostId}
        mode={mode}
        onCancel={props.onClose}
        onSelect={(receiptId, displayName) => {
          void createProject(receiptId, displayName);
        }}
      />
    );
  }

  return (
    <OctantDialog
      className="project-dialog"
      label="Create Project"
      onClose={props.onClose}
      open
      popupId="create-project-dialog"
    >
      <div className="project-dialog__header">
        <div>
          <h1 id="create-project-title">Create Project</h1>
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
        <OctantButton onClick={props.onClose} type="button">
          Close
        </OctantButton>
      </div>
    </OctantDialog>
  );
}

function safeNativePickerMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Project creation could not be completed.";
  if (error.message === "Choose an accessible directory.") {
    return error.message;
  }
  return "Project creation could not be completed.";
}
