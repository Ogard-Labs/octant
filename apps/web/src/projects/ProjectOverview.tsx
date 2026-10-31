import type { KeyProviderDriverKinds, PermissionMode } from "@octant/contracts/providers";
import { createDesktopPaneClient } from "@octant/client-runtime/desktop-pane-client";
import { createProjectTerminalClient } from "@octant/client-runtime/project-terminal-client";
import type { FolderBrowseClient } from "@octant/client-runtime/folder-browse-client";
import type { ProjectClient } from "@octant/client-runtime/project-client";
import type {
  ProjectAction,
  ProjectAvailability,
  ProjectId,
  ProjectSummary,
} from "@octant/contracts/projects";
import type { CanvasDesignBrand } from "@octant/contracts/canvas";
import type { DesktopRecipe, DesktopRecipeKeyChange } from "@octant/contracts/desktop-lease";
import type { ProjectColor, ProjectProviderPolicy } from "@octant/contracts/projects";
import type { ProviderInstance } from "@octant/contracts/providers";
import { ChevronDown, SquarePen } from "lucide-react";
import { Children, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { OctantHostBridge } from "../shell/hostBridge";
import { OctantButton } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantMenu } from "../ui/base/OctantMenu";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { FolderPicker } from "./FolderPicker";
import { ProjectMemorySection } from "./ProjectMemorySection";
import { ProjectThreadsSection } from "./ProjectThreadsSection";
import { ProjectBrandKitSection } from "./ProjectBrandKitSection";
import { ProjectActionsSection } from "./ProjectActionsSection";
import { ProjectFoldersSection } from "./ProjectFoldersSection";
import type { ProjectChange } from "./useProjectController";
import { ProjectDesktopRecipeSection } from "./ProjectDesktopRecipeSection";
import { ProjectPermissionModeSection } from "./ProjectPermissionModeSection";
import { ProjectProviderPolicySection } from "./ProjectProviderPolicySection";
import { ProjectNativeProvidersSection } from "./ProjectNativeProvidersSection";
import {
  PROJECT_COLOR_MENU_ITEMS,
  ProjectTile,
  projectColorFromMenuValue,
  projectColorMenuValue,
} from "./ProjectTile";
import { ProjectSpendCeilingSection } from "../usage/ProjectSpendCeilingSection";
import { OctantAlert } from "../ui/base/OctantAlert";

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
  readonly onNewThread?: () => void;
  readonly onRelink: (projectId: ProjectId, receiptId: string) => Promise<boolean>;
  /** Absent when the host cannot accept the change; the Project's folders are then read-only. */
  readonly onAddExtraFolder?: (projectId: ProjectId, receiptId: string) => Promise<ProjectChange>;
  readonly onRemoveExtraFolder?: (
    projectId: ProjectId,
    canonicalRoot: string,
  ) => Promise<ProjectChange>;
  readonly onRename: (projectId: ProjectId, name: string) => Promise<boolean>;
  /** Absent when the host cannot accept a colour change; the tile is then only a mark. */
  readonly onColorChange?: (projectId: ProjectId, color: ProjectColor | null) => Promise<boolean>;
  readonly onProviderPolicyChange?: (
    projectId: ProjectId,
    policy: ProjectProviderPolicy,
  ) => Promise<boolean>;
  /** Sets which key providers run as themselves in this Work or Code Project. */
  readonly onNativeProvidersChange?: (
    projectId: ProjectId,
    providers: KeyProviderDriverKinds,
  ) => Promise<boolean>;
  /** Sets the mode this Code Project's new threads start in; absent follows Settings. */
  readonly onPermissionModeChange?: (
    projectId: ProjectId,
    permissionMode: PermissionMode | undefined,
  ) => Promise<boolean>;
  /** Absent when the host cannot accept the change; the brand kit is then not shown. */
  readonly onBrandKitChange?: (
    projectId: ProjectId,
    brandKit: CanvasDesignBrand,
  ) => Promise<boolean>;
  /** Absent when the host cannot accept the change; a Code Project's recipe is then not shown. */
  readonly onDesktopRecipeChange?: (
    projectId: ProjectId,
    recipe: DesktopRecipe | null,
    key?: DesktopRecipeKeyChange,
  ) => Promise<boolean>;
  /** Absent when the host cannot accept the change; a Code Project's actions are then not shown. */
  readonly onActionsChange?: (
    projectId: ProjectId,
    actions: ReadonlyArray<ProjectAction>,
  ) => Promise<boolean>;
  /** The host this window reaches, so the recipe editor can ask which desktop providers it offers. */
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  /** Absent when the host cannot accept the change; the setting is then not shown. */
  readonly onWorkStatusFileChange?: (projectId: ProjectId, enabled: boolean) => Promise<boolean>;
  readonly providerInstances?: ReadonlyArray<ProviderInstance>;
  readonly project: ProjectSummary;
  readonly projectClient?: ProjectClient;
  readonly spendCeilingClient?: import("@octant/client-runtime").SpendCeilingClient;
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
  const { onAddExtraFolder, onRemoveExtraFolder } = props;
  const unavailable = props.project.type !== "chat" && props.availability?.status === "unavailable";
  const boundMode = props.project.type === "code" ? "code" : "work";
  // A base URL the client refuses (a remote host over plain HTTP) leaves the
  // recipe editor unable to ask, which it says, rather than broken.
  const { serverUrl, windowCapability } = props;
  const desktopPaneClient = useMemo(() => {
    if (serverUrl === undefined || windowCapability === undefined) return undefined;
    try {
      return createDesktopPaneClient({
        baseUrl: serverUrl,
        fetch: globalThis.fetch,
        windowCapability,
      });
    } catch {
      return undefined;
    }
  }, [serverUrl, windowCapability]);

  const projectTerminalClient = useMemo(() => {
    if (serverUrl === undefined || windowCapability === undefined) return undefined;
    try {
      return createProjectTerminalClient({
        baseUrl: serverUrl,
        fetch: globalThis.fetch,
        windowCapability,
      });
    } catch {
      return undefined;
    }
  }, [serverUrl, windowCapability]);

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
    <section className="projects-workspace--detail-only">
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
            {props.onColorChange === undefined || archived || connectionStale ? (
              <ProjectTile project={props.project} />
            ) : (
              <OctantMenu
                items={PROJECT_COLOR_MENU_ITEMS}
                onValueChange={(value) => {
                  const color = projectColorFromMenuValue(value);
                  if (color !== undefined) void props.onColorChange?.(props.project.id, color);
                }}
                trigger={<ProjectTile project={props.project} />}
                triggerClassName="project-overview__color"
                triggerLabel={`Project colour for ${props.project.name}`}
                value={projectColorMenuValue(props.project.color)}
              />
            )}
            <div className="project-overview__heading">
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
                    unstyled
                  />
                </h1>
              </form>
              {props.project.type === "chat" ? null : (
                <span className="project-overview__type">{label(props.project.type)} Project</span>
              )}
            </div>
          </div>
          <div className="project-overview__actions" aria-label="Project actions">
            <p
              aria-live={relinkFailed ? "assertive" : "polite"}
              className="project-overview__status"
              {...(relinkFailed ? { role: "alert" } : {})}
            >
              {relinkStatus}
            </p>
            {props.onNewThread === undefined || archived || connectionStale ? null : (
              <OctantButton onClick={props.onNewThread} size="sm" type="button" variant="secondary">
                <SquarePen aria-hidden="true" size={14} strokeWidth={1.7} />
                {props.project.type === "chat" ? "New chat" : "New thread"}
              </OctantButton>
            )}
            {props.project.type !== "chat" && !archived && !connectionStale && allowRootRelink ? (
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
            <ProjectFoldersSection
              key={String(props.project.id)}
              disabled={archived || connectionStale}
              {...(props.folderBrowseClient === undefined
                ? {}
                : { folderBrowseClient: props.folderBrowseClient })}
              {...(props.hostBridge === undefined ? {} : { hostBridge: props.hostBridge })}
              {...(props.hostId === undefined ? {} : { hostId: props.hostId })}
              {...(onAddExtraFolder === undefined
                ? {}
                : {
                    onAdd: (receiptId: string) => onAddExtraFolder(props.project.id, receiptId),
                  })}
              {...(onRemoveExtraFolder === undefined
                ? {}
                : {
                    onRemove: (canonicalRoot: string) =>
                      onRemoveExtraFolder(props.project.id, canonicalRoot),
                  })}
              project={props.project}
            />
            {unavailable ? (
              <OctantAlert className="project-overview__warning" tone="warning">
                <div className="project-overview__warning-copy">
                  <strong>{archived ? "Unavailable while archived" : "Relink required"}</strong>
                  <p>{props.availability?.reason}</p>
                </div>
              </OctantAlert>
            ) : (
              <span className="project-overview__availability">
                {archived
                  ? "Archived · read-only"
                  : props.availability?.status === "unverified"
                    ? "Availability unverified"
                    : "Available"}
              </span>
            )}
            <p className="project-overview__description">{authorityCopy(props.project.type)}</p>
          </section>
        ) : null}
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
        <div className="project-overview__primary">
          {(props.project.type === "chat" && props.chatOverview !== undefined) ||
          (props.project.type === "code" && props.codeOverview !== undefined) ? null : (
            <ProjectThreadsSection project={props.project} />
          )}
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
        </div>
        {/*
          Two groups rather than one run of identical rows: what the Project's
          threads know (memory, brand, canvases) and what they may reach or
          spend. Six alike rows in one list gave a reader nothing to scan by.
        */}
        <div aria-label="Project settings" className="project-overview__inspectors">
          <ProjectOverviewGroup label="Context">
            {props.projectClient === undefined ? null : (
              <ProjectOverviewInspector
                key={`${String(props.project.id)}-memory`}
                label="Memory"
                summary="Approved context and audit history"
              >
                <ProjectMemorySection
                  client={props.projectClient}
                  {...(props.onMemoryChanged === undefined
                    ? {}
                    : { onChanged: props.onMemoryChanged })}
                  project={props.project}
                  projects={props.memoryProjects ?? []}
                  {...(connectionStale ? { readOnly: true } : {})}
                />
              </ProjectOverviewInspector>
            )}
            {props.onBrandKitChange === undefined ? null : (
              <ProjectOverviewInspector
                key={`${String(props.project.id)}-brand-kit`}
                label="Brand kit"
                summary="Colours and fonts your designs can use"
              >
                <ProjectBrandKitSection
                  disabled={archived || connectionStale}
                  onChange={async (brandKit) =>
                    (await props.onBrandKitChange?.(props.project.id, brandKit)) ?? false
                  }
                  project={props.project}
                />
              </ProjectOverviewInspector>
            )}
            {props.canvasInventory === undefined ? null : (
              <ProjectOverviewInspector
                key={`${String(props.project.id)}-canvases`}
                label="Canvases"
                summary="Boards and visual artifacts saved with this Project"
              >
                {props.canvasInventory}
              </ProjectOverviewInspector>
            )}
          </ProjectOverviewGroup>
          <ProjectOverviewGroup label="Access and limits">
            {props.project.type !== "chat" && props.onProviderPolicyChange !== undefined ? (
              <ProjectOverviewInspector
                key={`${String(props.project.id)}-providers`}
                label="Provider access"
                summary="Choose which providers and models this Project may use"
              >
                <ProjectProviderPolicySection
                  disabled={archived || connectionStale}
                  onChange={async (policy) =>
                    (await props.onProviderPolicyChange?.(props.project.id, policy)) ?? false
                  }
                  project={props.project}
                  providerInstances={props.providerInstances ?? []}
                />
              </ProjectOverviewInspector>
            ) : null}
            {props.project.type !== "chat" && props.onNativeProvidersChange !== undefined ? (
              <ProjectOverviewInspector
                key={`${String(props.project.id)}-native-providers`}
                label="Trusted providers"
                summary="Let a provider load this Project's own hooks, MCP servers, and plugins"
              >
                <ProjectNativeProvidersSection
                  disabled={archived || connectionStale}
                  onChange={async (providers) =>
                    (await props.onNativeProvidersChange?.(props.project.id, providers)) ?? false
                  }
                  project={props.project}
                />
              </ProjectOverviewInspector>
            ) : null}
            {props.project.type === "code" && props.onActionsChange !== undefined ? (
              <ProjectOverviewInspector
                key={`${String(props.project.id)}-actions`}
                label="Actions"
                summary="Run, Test, Dev and other commands for this Project's terminal"
              >
                <ProjectActionsSection
                  {...(projectTerminalClient === undefined
                    ? {}
                    : { client: projectTerminalClient })}
                  disabled={archived || connectionStale}
                  onChange={async (actions) =>
                    (await props.onActionsChange?.(props.project.id, actions)) ?? false
                  }
                  project={props.project}
                />
              </ProjectOverviewInspector>
            ) : null}
            {props.project.type === "code" && props.onPermissionModeChange !== undefined ? (
              <ProjectOverviewInspector
                key={`${String(props.project.id)}-mode`}
                label="Default mode"
                summary="The mode this Project's new threads start in"
              >
                <ProjectPermissionModeSection
                  disabled={archived || connectionStale}
                  onChange={async (mode) =>
                    (await props.onPermissionModeChange?.(props.project.id, mode)) ?? false
                  }
                  project={props.project}
                />
              </ProjectOverviewInspector>
            ) : null}
            {props.project.type === "code" && props.onDesktopRecipeChange !== undefined ? (
              <ProjectOverviewInspector
                key={`${String(props.project.id)}-desktop-recipe`}
                label="Disposable desktop"
                summary="The Linux desktop this Project's threads can start"
              >
                <ProjectDesktopRecipeSection
                  {...(desktopPaneClient === undefined ? {} : { client: desktopPaneClient })}
                  disabled={archived || connectionStale}
                  onChange={async (recipe, key) =>
                    (await props.onDesktopRecipeChange?.(props.project.id, recipe, key)) ?? false
                  }
                  project={props.project}
                />
              </ProjectOverviewInspector>
            ) : null}
            {props.project.type === "work" &&
            props.project.origin !== "default-folder" &&
            props.onWorkStatusFileChange !== undefined ? (
              <WorkStatusFileSetting
                disabled={archived || connectionStale}
                enabled={props.project.statusFile === "enabled"}
                onChange={(enabled) => props.onWorkStatusFileChange?.(props.project.id, enabled)}
              />
            ) : null}
            {props.spendCeilingClient === undefined ? null : (
              <ProjectOverviewInspector
                key={`${String(props.project.id)}-ceiling`}
                label="Spend ceiling"
                summary="Optional Project limits on tokens, turns, agent run time, and money"
              >
                <ProjectSpendCeilingSection
                  client={props.spendCeilingClient}
                  projectId={String(props.project.id)}
                />
              </ProjectOverviewInspector>
            )}
          </ProjectOverviewGroup>
        </div>
      </section>
    </section>
  );
}

/**
 * The opt-in for the STATUS.md Octant keeps in a Work folder. Not offered for
 * the default folder, which the host refuses: it holds what nobody gave a
 * Project, so there is no single piece of work for a status to describe.
 */
function WorkStatusFileSetting(props: {
  readonly disabled: boolean;
  readonly enabled: boolean;
  readonly onChange: (enabled: boolean) => Promise<boolean> | undefined;
}) {
  // Each command asserts the Project version it read; a second flip before
  // the first returns would be refused as a conflict, so the switch waits.
  const [pending, setPending] = useState(false);
  const descriptionId = useId();
  return (
    <section className="project-overview-inspector">
      <div className="project-overview-inspector__row">
        <div>
          <h3>Status file</h3>
          <p id={descriptionId}>
            Keep a STATUS.md in this folder. Every task reads it and updates where the work stands,
            and its dated follow-ups and deadlines become reminders. When off, Octant writes nothing
            into the folder.
          </p>
        </div>
        <OctantSwitch
          checked={props.enabled}
          describedBy={descriptionId}
          disabled={props.disabled || pending}
          label="Keep a status file"
          onCheckedChange={(enabled) => {
            setPending(true);
            void Promise.resolve(props.onChange(enabled)).finally(() => setPending(false));
          }}
        />
      </div>
    </section>
  );
}

/** A titled card of setting rows; drawn only when one of its rows is. */
function ProjectOverviewGroup(props: { readonly children: ReactNode; readonly label: string }) {
  const headingId = useId();
  if (Children.toArray(props.children).length === 0) return null;
  return (
    <section aria-labelledby={headingId} className="project-overview__group">
      <h2 className="project-overview__section-label" id={headingId}>
        {props.label}
      </h2>
      <div className="project-overview__card">{props.children}</div>
    </section>
  );
}

function ProjectOverviewInspector(props: {
  readonly children: ReactNode;
  readonly label: string;
  readonly summary: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="project-overview-inspector">
      <div className="project-overview-inspector__row">
        <div>
          <h3>{props.label}</h3>
          <p>{props.summary}</p>
        </div>
        <OctantButton
          aria-expanded={open}
          aria-label={`Manage ${props.label}`}
          onClick={() => setOpen((current) => !current)}
          size="sm"
          type="button"
          variant="ghost"
        >
          Manage
          <ChevronDown
            aria-hidden="true"
            className="project-overview-inspector__chevron"
            size={14}
          />
        </OctantButton>
      </div>
      {open ? <div className="project-overview-inspector__content">{props.children}</div> : null}
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
    return "Confined to the Project's folders. Knowledge-work stays inside them.";
  return "Checkouts and Git stay in the main repository. New Code work starts approval-gated.";
}
