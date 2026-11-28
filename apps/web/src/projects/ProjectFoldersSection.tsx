import type { FolderBrowseClient } from "@octant/client-runtime/folder-browse-client";
import type { ProjectSummary } from "@octant/contracts/projects";
import type {
  DiscoveredProjectRepository,
  DiscoveredWorkspaceFolder,
  ProjectRepositoriesList,
} from "@octant/contracts/project-repositories";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { homeRelativePath } from "../lib/homeRelativePath";
import type { OctantHostBridge } from "../shell/hostBridge";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantBadge } from "../ui/base/OctantBadge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantDialogPresence } from "../ui/base/OctantDialogPresence";
import { FolderPicker } from "./FolderPicker";
import type { ExtraFolderChange, ProjectChange } from "./useProjectController";

type BoundProjectSummary = Extract<ProjectSummary, { readonly type: "work" | "code" }>;

export interface ProjectFoldersSectionProps {
  readonly project: BoundProjectSummary;
  /** The desktop shell's native picker; without it the host's folder browser is used. */
  readonly hostBridge?: Pick<OctantHostBridge, "selectProjectRoot">;
  readonly folderBrowseClient?: FolderBrowseClient;
  readonly hostId?: string;
  /** Absent when the host cannot accept the change; folders are then listed read-only. */
  /** `confirmHomeFolder` resends a home folder the person confirmed after its warning. */
  readonly onAdd?: (receiptId: string, confirmHomeFolder?: boolean) => Promise<ExtraFolderChange>;
  readonly onRemove?: (canonicalRoot: string) => Promise<ProjectChange>;
  /** Discovered Git repositories and `.code-workspace` entries for a Code Project. */
  readonly listRepositories?: (signal?: AbortSignal) => Promise<ProjectRepositoriesList>;
  /** True for an archived Project or a stale snapshot: the folders are listed, never changed. */
  readonly disabled?: boolean;
}

type Notice =
  | { readonly kind: "none" }
  | { readonly kind: "done"; readonly message: string }
  | { readonly kind: "failed"; readonly message: string };

const WORK_EXTRA_FOLDERS_RULE =
  "Extra folders get the same access as the main folder. Checkouts and Git stay in the main folder. A terminal or action can start in any of them.";

const CODE_EXTRA_FOLDERS_RULE =
  "Extra folders share the main folder's access. Git repositories inside granted folders are reachable per repository in Diff and Git. A terminal or action can start in any of them.";

const NO_NOTICE: Notice = { kind: "none" };
const SELECTION_UNAVAILABLE: Notice = {
  kind: "failed",
  message: "Folder selection is unavailable.",
};

/**
 * The folders a Work or Code Project reaches: its main folder, then the extra
 * folders the person added. For Code Projects, also lists repositories
 * discovered inside those granted folders and any outside folders named by a
 * `.code-workspace` file (offered through the existing extra-folder picker).
 */
export function ProjectFoldersSection(props: ProjectFoldersSectionProps) {
  const { onAdd, onRemove, listRepositories } = props;
  const alive = useRef(true);
  const [notice, setNotice] = useState<Notice>(NO_NOTICE);
  const [pending, setPending] = useState(false);
  const [picking, setPicking] = useState(false);
  const [discovered, setDiscovered] = useState<ProjectRepositoriesList>();
  // The host stopped at the home folder warning; Confirm spends its fresh receipt.
  const [homeWarning, setHomeWarning] = useState<
    | { readonly canonicalRoot: string; readonly receiptId: string; readonly warning: string }
    | undefined
  >();
  const extras = props.project.extraFolders ?? [];
  const extraRootsKey = extras.map((folder) => folder.canonicalRoot).join("\0");
  const mode = props.project.type === "code" ? "code" : "work";
  const editable = props.disabled !== true;
  const canAdd = editable && onAdd !== undefined;
  const canRemove = editable && onRemove !== undefined;
  const extraFoldersRule =
    props.project.type === "code" ? CODE_EXTRA_FOLDERS_RULE : WORK_EXTRA_FOLDERS_RULE;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (props.project.type !== "code" || listRepositories === undefined) {
      setDiscovered(undefined);
      return;
    }
    const controller = new AbortController();
    let active = true;
    void listRepositories(controller.signal)
      .then((result) => {
        if (active && alive.current && !controller.signal.aborted) {
          setDiscovered(result);
        }
      })
      .catch(() => {
        if (active && alive.current && !controller.signal.aborted) {
          setDiscovered(undefined);
        }
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [
    listRepositories,
    props.project.id,
    props.project.type,
    props.project.binding.canonicalRoot,
    extraRootsKey,
  ]);

  async function settle(change: Promise<ExtraFolderChange>, done: string) {
    setPending(true);
    try {
      const outcome = await change;
      if (!alive.current) return;
      if (outcome.status === "needs-confirmation") {
        setHomeWarning({
          canonicalRoot: outcome.canonicalRoot,
          receiptId: outcome.receiptId,
          warning: outcome.warning,
        });
        setNotice(NO_NOTICE);
        return;
      }
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

  async function add(receiptId: string, confirmHomeFolder = false) {
    if (onAdd === undefined) return;
    setHomeWarning(undefined);
    await settle(confirmHomeFolder ? onAdd(receiptId, true) : onAdd(receiptId), "Folder added.");
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
  const discoveredRepos = discovered?.repositories ?? [];
  const workspaceFolders = discovered?.workspaceFolders ?? [];
  const mainIsPlainMultiRepo =
    props.project.type === "code" &&
    discoveredRepos.length > 0 &&
    !discoveredRepos.some((repo) => repo.source === "main-folder");

  return (
    <div className="project-folders">
      <ul aria-label="Project folders" className="project-folders__list">
        <FolderRow
          label={
            props.project.type === "code"
              ? mainIsPlainMultiRepo
                ? "Main folder"
                : "Main repository"
              : "Main directory"
          }
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
      {discoveredRepos.length > 0 ? (
        <div className="project-folders__repositories">
          <p className="project-folders__subheading">
            Repositories ({discoveredRepos.length}
            {discovered?.truncated === true ? "+" : ""})
          </p>
          <ul aria-label="Discovered repositories" className="project-folders__list">
            {discoveredRepos.map((repo) => (
              <RepositoryRow key={repo.canonicalRoot} repository={repo} />
            ))}
          </ul>
          {discovered?.truncated === true ? (
            <p className="project-folders__note">
              Showing the first {discoveredRepos.length} repositories in this Project&apos;s
              folders.
            </p>
          ) : null}
        </div>
      ) : null}
      {workspaceFolders.length > 0 ? (
        <div className="project-folders__workspace-folders">
          <p className="project-folders__subheading">Workspace file folders</p>
          <ul aria-label="Workspace file folders" className="project-folders__list">
            {workspaceFolders.map((entry) => (
              <WorkspaceFolderRow
                key={`${entry.workspaceFile}:${entry.path}`}
                entry={entry}
                canAdd={canAdd}
                pending={pending}
                onChoose={() => void choose()}
              />
            ))}
          </ul>
        </div>
      ) : null}
      {canAdd || extras.length > 0 ? (
        <p className="project-folders__note" title={extraFoldersRule}>
          Extra folders share the main folder&apos;s access.
          <span className="sr-only"> {extraFoldersRule}</span>
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
      {homeWarning === undefined ? null : (
        <OctantAlert
          action={
            <div className="project-folders__actions">
              <OctantButton
                disabled={pending}
                onClick={() => void add(homeWarning.receiptId, true)}
                size="sm"
                type="button"
                variant="secondary"
              >
                Confirm
              </OctantButton>
              <OctantButton
                disabled={pending}
                onClick={() => setHomeWarning(undefined)}
                size="sm"
                type="button"
                variant="ghost"
              >
                Cancel
              </OctantButton>
            </div>
          }
          title="Add your home folder?"
          tone="warning"
        >
          {homeWarning.warning}
        </OctantAlert>
      )}
      <p
        aria-live={failed ? "assertive" : "polite"}
        className="project-folders__status"
        {...(failed ? { role: "alert" } : {})}
      >
        {notice.kind === "none" ? "" : notice.message}
      </p>
      <OctantDialogPresence>
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
      </OctantDialogPresence>
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

function RepositoryRow(props: { readonly repository: DiscoveredProjectRepository }) {
  const { repository } = props;
  const headLabel =
    repository.head.kind === "branch"
      ? String(repository.head.name)
      : repository.head.kind === "detached"
        ? "Detached HEAD"
        : undefined;
  return (
    <li className="project-folders__row project-folders__row--repo">
      <span className="project-folders__label">{repository.name}</span>
      <strong className="project-folders__path" title={repository.canonicalRoot}>
        <span aria-hidden="true">{homeRelativePath(repository.canonicalRoot)}</span>
        <span className="sr-only">{repository.canonicalRoot}</span>
      </strong>
      {headLabel === undefined ? null : <OctantBadge variant="secondary">{headLabel}</OctantBadge>}
      {repository.submodules !== undefined && repository.submodules.length > 0 ? (
        <ul aria-label={`Submodules in ${repository.name}`} className="project-folders__submodules">
          {repository.submodules.map((sub) => (
            <li key={sub.path} className="project-folders__submodule">
              <span>{sub.path}</span>
              <OctantBadge variant="secondary">
                {sub.initialized ? "Submodule" : "Submodule · uninitialized"}
              </OctantBadge>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function WorkspaceFolderRow(props: {
  readonly entry: DiscoveredWorkspaceFolder;
  readonly canAdd: boolean;
  readonly pending: boolean;
  readonly onChoose: () => void;
}) {
  const { entry } = props;
  return (
    <li className="project-folders__row">
      <span className="project-folders__label" title={entry.workspaceFile}>
        {entry.name}
      </span>
      <strong className="project-folders__path" title={entry.path}>
        <span aria-hidden="true">{homeRelativePath(entry.path)}</span>
        <span className="sr-only">{entry.path}</span>
      </strong>
      {entry.status === "available" && props.canAdd ? (
        <OctantButton
          aria-label={`Add ${entry.name} from ${entry.workspaceFile}`}
          disabled={props.pending}
          onClick={props.onChoose}
          size="sm"
          type="button"
          variant="ghost"
        >
          Add folder…
        </OctantButton>
      ) : entry.status === "already-included" ? (
        <OctantBadge variant="secondary">Included</OctantBadge>
      ) : entry.status === "refused" ? (
        <span className="project-folders__note">{entry.reason ?? "Unavailable."}</span>
      ) : null}
    </li>
  );
}
