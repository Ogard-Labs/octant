import type { FolderBrowseClient } from "@octant/client-runtime/folder-browse-client";
import type { ProjectClient } from "@octant/client-runtime/project-client";
import type { ProjectAvailability, ProjectId, ProjectSummary } from "@octant/contracts/projects";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { OctantHostBridge } from "../shell/hostBridge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { FolderPicker } from "./FolderPicker";
import { ProjectMemorySection } from "./ProjectMemorySection";
import { ProjectThreadsSection } from "./ProjectThreadsSection";

export interface ProjectOverviewProps {
  readonly allowRootRelink?: boolean;
  readonly availability?: ProjectAvailability;
  readonly chatOverview?: ReactNode;
  readonly connectionStale?: boolean;
  readonly codeOverview?: ReactNode;
  readonly canvasInventory?: ReactNode;
  readonly workOverview?: ReactNode;
  readonly workPromotion?: ReactNode;
  readonly folderBrowseClient?: FolderBrowseClient;
  readonly hostBridge?: OctantHostBridge;
  readonly hostId?: string;
  readonly memoryProjects?: ReadonlyArray<ProjectSummary>;
  readonly onArchive: (projectId: ProjectId) => void;
  readonly onMemoryChanged?: () => void;
  readonly onRelink: (projectId: ProjectId, receiptId: string) => Promise<boolean>;
  readonly onRename: (projectId: ProjectId, name: string) => Promise<boolean>;
  readonly project: ProjectSummary;
  readonly projectClient?: ProjectClient;
}

export function ProjectOverview(props: ProjectOverviewProps) {
  const alive = useRef(true);
  const nameInput = useRef<HTMLInputElement>(null);
  const relinkGeneration = useRef(0);
  const [relinkStatus, setRelinkStatus] = useState("");
  const [relinkFailed, setRelinkFailed] = useState(false);
  const [picking, setPicking] = useState(false);
  const archived = props.project.lifecycle === "archived";
  const connectionStale = props.connectionStale === true;
  const allowRootRelink = props.allowRootRelink !== false;
  const unavailable = props.project.type !== "chat" && props.availability?.status === "unavailable";
  const boundMode = props.project.type === "code" ? "code" : "work";

  useEffect(() => {
    alive.current = true;
    relinkGeneration.current += 1;
    setPicking(false);
    setRelinkFailed(false);
    return () => {
      alive.current = false;
      relinkGeneration.current += 1;
    };
  }, [props.project.id]);

  async function commitName() {
    const normalized = nameInput.current?.value.trim() ?? "";
    if (!archived && normalized !== "" && normalized !== props.project.name) {
      await props.onRename(props.project.id, normalized);
    }
  }

  async function applyReceipt(receiptId: string) {
    const operation = ++relinkGeneration.current;
    try {
      const relinked = await props.onRelink(props.project.id, receiptId);
      if (!alive.current || operation !== relinkGeneration.current) return;
      if (relinked) {
        setRelinkFailed(false);
        setRelinkStatus("Project root relinked.");
        setPicking(false);
      } else {
        setRelinkFailed(true);
        setRelinkStatus("Project root could not be relinked. Review the Project status and retry.");
      }
    } catch {
      if (!alive.current || operation !== relinkGeneration.current) return;
      setRelinkFailed(true);
      setRelinkStatus("Project root could not be relinked.");
    }
  }

  async function relink() {
    const operation = ++relinkGeneration.current;
    if (props.project.type === "chat") {
      setRelinkFailed(true);
      setRelinkStatus("Folder selection is unavailable.");
      return;
    }
    if (props.hostBridge !== undefined) {
      try {
        const selection = await props.hostBridge.selectProjectRoot(boundMode);
        if (!alive.current || operation !== relinkGeneration.current) return;
        if (selection.kind === "cancelled") {
          setRelinkFailed(false);
          setRelinkStatus("Relink cancelled.");
          return;
        }
        await applyReceipt(selection.receiptId);
      } catch {
        if (!alive.current || operation !== relinkGeneration.current) return;
        setRelinkFailed(true);
        setRelinkStatus("Project root could not be relinked.");
      }
      return;
    }
    if (props.folderBrowseClient !== undefined && props.hostId !== undefined) {
      setPicking(true);
      setRelinkFailed(false);
      setRelinkStatus("");
      return;
    }
    setRelinkFailed(true);
    setRelinkStatus("Folder selection is unavailable.");
  }

  return (
    <section className="project-overview">
      {connectionStale ? (
        <div className="project-overview__warning" role="status">
          <div className="project-overview__warning-copy">
            <strong>Stale Project snapshot</strong>
            <p>Mutations are disabled until the remote session reconnects.</p>
          </div>
        </div>
      ) : null}
      <header className="project-overview__toolbar">
        <div className="project-overview__identity">
          <form
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void commitName();
            }}
          >
            <label className="sr-only" htmlFor={`project-name-${props.project.id}`}>
              Project name
            </label>
            {/* The name is the page title, edited in place: the heading carries
                the title role and the field inherits its type. */}
            <h1 className="oct-title project-overview__title">
              <OctantInput
                className="project-overview__name"
                defaultValue={props.project.name}
                id={`project-name-${props.project.id}`}
                onBlur={() => void commitName()}
                readOnly={archived || connectionStale}
                ref={nameInput}
              />
            </h1>
          </form>
          {props.project.type === "chat" ? null : (
            <span className="project-overview__type">{label(props.project.type)} Project</span>
          )}
        </div>
        <div className="project-overview__actions" aria-label="Project actions">
          <p
            aria-live={relinkFailed ? "assertive" : "polite"}
            className="project-overview__status"
            {...(relinkFailed ? { role: "alert" } : {})}
          >
            {relinkStatus}
          </p>
          {props.project.type !== "chat" && !archived && allowRootRelink ? (
            <OctantButton onClick={() => void relink()} size="sm" type="button" variant="ghost">
              {unavailable ? "Choose new root" : "Relink folder"}
            </OctantButton>
          ) : null}
          {archived || connectionStale ? (
            <span className="project-overview__archived">
              {archived ? "Archived Project · read-only" : "Stale snapshot · read-only"}
            </span>
          ) : (
            <OctantButton
              className="project-overview__archive"
              onClick={() => props.onArchive(props.project.id)}
              size="sm"
              type="button"
              variant="ghost"
            >
              {props.project.type === "chat" ? "Archive" : "Archive Project"}
            </OctantButton>
          )}
        </div>
      </header>
      {props.project.type !== "chat" ? (
        <section className="project-overview__context" aria-label="Project binding">
          <div className="project-overview__root">
            <span>{props.project.type === "code" ? "Repository" : "Directory"}</span>
            <strong>{props.project.binding.canonicalRoot}</strong>
          </div>
          {unavailable ? (
            <div className="project-overview__warning" role="alert">
              <div className="project-overview__warning-copy">
                <strong>{archived ? "Unavailable while archived" : "Relink required"}</strong>
                <p>{props.availability?.reason}</p>
              </div>
            </div>
          ) : (
            <span className="project-overview__availability">
              {archived
                ? "Archived · read-only"
                : props.availability?.status === "unverified"
                  ? "Availability unverified"
                  : "Available"}
            </span>
          )}
        </section>
      ) : null}
      {props.project.type === "chat" ? null : (
        <p className="project-overview__description">{authorityCopy(props.project.type)}</p>
      )}
      {props.projectClient === undefined ? null : (
        <ProjectMemorySection
          client={props.projectClient}
          key={String(props.project.id)}
          {...(props.onMemoryChanged === undefined ? {} : { onChanged: props.onMemoryChanged })}
          project={props.project}
          projects={props.memoryProjects ?? []}
          {...(connectionStale ? { readOnly: true } : {})}
        />
      )}
      {picking &&
      props.folderBrowseClient !== undefined &&
      props.hostId !== undefined &&
      props.project.type !== "chat" ? (
        <FolderPicker
          client={props.folderBrowseClient}
          hostId={props.hostId}
          mode={boundMode}
          onCancel={() => setPicking(false)}
          onSelect={(receiptId) => {
            void applyReceipt(receiptId);
          }}
        />
      ) : null}
      {/*
        Chat and Code Projects already get a threads list from their own
        overview: Chat's can also create a thread and expand the full list in
        the sidebar; Code's sessions list carries the host-reported board facts
        plus open, rename, and pin. Rendering the shared section too showed the
        same threads twice from two different fetches, so the mode's richer
        list owns the page and the generic section stands down.
      */}
      {(props.project.type === "chat" && props.chatOverview !== undefined) ||
      (props.project.type === "code" && props.codeOverview !== undefined) ? null : (
        <ProjectThreadsSection project={props.project} />
      )}
      {props.canvasInventory !== undefined ? props.canvasInventory : null}
      {props.project.type === "chat" && props.chatOverview !== undefined ? (
        props.chatOverview
      ) : props.project.type === "code" && props.codeOverview !== undefined ? (
        props.codeOverview
      ) : props.project.type === "work" && props.workOverview !== undefined ? (
        <>
          {props.workOverview}
          {props.workPromotion}
        </>
      ) : props.project.type === "work" && props.workPromotion !== undefined ? (
        props.workPromotion
      ) : (
        <section className="project-overview__prompt">
          <span aria-hidden="true" className="project-overview__prompt-mark">
            ○
          </span>
          <h2>Project workspace</h2>
          <p>Project controls and approved context are ready.</p>
        </section>
      )}
    </section>
  );
}

function label(type: ProjectSummary["type"]): string {
  return type === "chat" ? "Chat" : type === "work" ? "Work" : "Code";
}

function authorityCopy(type: ProjectSummary["type"]): string {
  if (type === "chat")
    return "Virtual organization with approved memory and no implicit host access.";
  if (type === "work")
    return "Bound to one confined directory. Knowledge-work stays inside the Project root.";
  return "Bound to one Git repository. New Code work starts approval-gated.";
}
