import type { FolderBrowseClient } from "@octant/client-runtime/folder-browse-client";
import type { ProjectSummary } from "@octant/contracts/projects";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { homeRelativePath } from "../lib/homeRelativePath";
import type { OctantHostBridge } from "../shell/hostBridge";
import { OctantButton } from "../ui/base/OctantButton";
import { FolderPicker } from "./FolderPicker";
import type { ProjectChange } from "./useProjectController";

type BoundProjectSummary = Extract<ProjectSummary, { readonly type: "work" | "code" }>;

export interface ProjectFoldersSectionProps {
  readonly project: BoundProjectSummary;
  /** The desktop shell's native picker; without it the host's folder browser is used. */
  readonly hostBridge?: Pick<OctantHostBridge, "selectProjectRoot">;
  readonly folderBrowseClient?: FolderBrowseClient;
  readonly hostId?: string;
  /** Absent when the host cannot accept the change; folders are then listed read-only. */
  readonly onAdd?: (receiptId: string) => Promise<ProjectChange>;
  readonly onRemove?: (canonicalRoot: string) => Promise<ProjectChange>;
  /** True for an archived Project or a stale snapshot: the folders are listed, never changed. */
  readonly disabled?: boolean;
}

type Notice =
  | { readonly kind: "none" }
  | { readonly kind: "done"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

const NO_NOTICE: Notice = { kind: "none" };
const SELECTION_UNAVAILABLE: Notice = {
  kind: "failed",
  message: "Folder selection is unavailable.",
};

/**
 * The folders a Work or Code Project reaches: its main folder, then the extra
 * folders the person added. Extra folders get the main folder's access at each
 * thread's level, so adding one is a grant and the page says so; the host
 * decides which folders it accepts and this section shows its reason when it
 * refuses one.
 */
export function ProjectFoldersSection(props: ProjectFoldersSectionProps) {
  const { onAdd, onRemove } = props;
  const alive = useRef(true);
  const [notice, setNotice] = useState<Notice>(NO_NOTICE);
  const [pending, setPending] = useState(false);
  const [picking, setPicking] = useState(false);
  const extras = props.project.extraFolders ?? [];
  const mode = props.project.type === "code" ? "code" : "work";
  const editable = props.disabled !== true;
  const canAdd = editable && onAdd !== undefined;
  const canRemove = editable && onRemove !== undefined;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  async function settle(change: Promise<ProjectChange>, done: string) {
    setPending(true);
    try {
      const outcome = await change;
      if (!alive.current) return;
      setNotice(
        outcome.status === "changed"
          ? { kind: "done", message: done }
          : { kind: "failed", message: outcome.message },
      );
    } catch {
      if (alive.current)
        setNotice({ kind: "failed", message: "The Project could not be changed." });
    } finally {
      // The host folder browser stays in its selecting state once it has
      // handed over a receipt, so it closes on every outcome; a refusal shows
      // here and the next Add folder… opens a fresh one.
      if (alive.current) {
        setPending(false);
        setPicking(false);
      }
    }
  }

  async function add(receiptId: string) {
    if (onAdd === undefined) return;
    await settle(onAdd(receiptId), "Folder added.");
  }

  async function choose() {
    setNotice(NO_NOTICE);
    if (props.hostBridge !== undefined) {
      try {
        const selection = await props.hostBridge.selectProjectRoot(mode);
        if (!alive.current || selection.kind === "cancelled") return;
        await add(selection.receiptId);
      } catch {
        if (alive.current) setNotice({ kind: "failed", message: "The folder could not be added." });
      }
      return;
    }
    if (props.folderBrowseClient !== undefined && props.hostId !== undefined) {
      setPicking(true);
      return;
    }
    setNotice(SELECTION_UNAVAILABLE);
  }

  const failed = notice.kind === "failed";
  return (
    <div className="project-folders">
      <ul aria-label="Project folders" className="project-folders__list">
        <FolderRow
          label={props.project.type === "code" ? "Main repository" : "Main directory"}
          path={props.project.binding.canonicalRoot}
        />
        {extras.map((folder) => (
          <FolderRow
            key={folder.canonicalRoot}
            label="Extra folder"
            path={folder.canonicalRoot}
            trailing={
              canRemove ? (
                <OctantButton
                  aria-label={`Remove ${folder.canonicalRoot}`}
                  disabled={pending}
                  onClick={() => {
                    setNotice(NO_NOTICE);
                    void settle(onRemove(folder.canonicalRoot), "Folder removed.");
                  }}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  Remove
                </OctantButton>
              ) : null
            }
          />
        ))}
      </ul>
      {canAdd || extras.length > 0 ? (
        <p className="project-folders__note">
          Extra folders get the same access as the main folder. Checkouts and Git stay in the main
          folder; a terminal or a saved action can start in any of them.
        </p>
      ) : null}
      {canAdd ? (
        <div className="project-folders__actions">
          <OctantButton
            disabled={pending}
            onClick={() => void choose()}
            size="sm"
            type="button"
            variant="secondary"
          >
            Add folder…
          </OctantButton>
        </div>
      ) : null}
      <p
        aria-live={failed ? "assertive" : "polite"}
        className="project-folders__status"
        {...(failed ? { role: "alert" } : {})}
      >
        {notice.kind === "none" ? "" : notice.message}
      </p>
      {picking && props.folderBrowseClient !== undefined && props.hostId !== undefined ? (
        <FolderPicker
          client={props.folderBrowseClient}
          hostId={props.hostId}
          mode={mode}
          onCancel={() => setPicking(false)}
          onSelect={(receiptId) => {
            void add(receiptId);
          }}
          showGitInit={false}
          title="Add a folder to this Project"
        />
      ) : null}
    </div>
  );
}

function FolderRow(props: {
  readonly label: string;
  readonly path: string;
  readonly trailing?: ReactNode;
}) {
  return (
    <li className="project-folders__row">
      <span className="project-folders__label">{props.label}</span>
      <strong className="project-folders__path" title={props.path}>
        <span aria-hidden="true">{homeRelativePath(props.path)}</span>
        <span className="sr-only">{props.path}</span>
      </strong>
      {props.trailing}
    </li>
  );
}
