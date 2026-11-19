import "../styles/project-overview.css";
import type { KeyProviderDriverKinds, PermissionMode } from "@octant/contracts/providers";
import type { DesignSystemChoice } from "@octant/contracts/design-systems";
import type { AutoReviewer } from "@octant/contracts/shield";
import { createDesktopPaneClient } from "@octant/client-runtime/desktop-pane-client";
import { createProjectTerminalClient } from "@octant/client-runtime/project-terminal-client";
import type { FolderBrowseClient } from "@octant/client-runtime/folder-browse-client";
import type { ProjectClient } from "@octant/client-runtime/project-client";
import type { OctantInstructionsClient } from "@octant/client-runtime/octant-instructions-client";
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
import { ChevronDown, Ellipsis, SquarePen } from "../ui/icons";
import { Children, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import type { OctantHostBridge } from "../shell/hostBridge";
import { homeRelativePath } from "../lib/homeRelativePath";
import { OctantButton, octantButtonClassName } from "../ui/base/OctantButton";
import { OctantInput } from "../ui/base/OctantInput";
import { OctantMenu, type OctantMenuItem } from "../ui/base/OctantMenu";
import { OctantSwitch } from "../ui/base/OctantSwitch";
import { ProjectIcon, useProjectIconDetails, useProjectIconSource } from "./ProjectIcon";
import { FolderPicker } from "./FolderPicker";
import { ProjectMemorySection } from "./ProjectMemorySection";
import { ProjectThreadsSection } from "./ProjectThreadsSection";
import { ProjectBrandKitSection } from "./ProjectBrandKitSection";
import { ProjectDesignSystemSection } from "./ProjectDesignSystemSection";
import { ProjectActionsSection } from "./ProjectActionsSection";
import { ProjectFoldersSection } from "./ProjectFoldersSection";
import type { ExtraFolderChange, ProjectChange } from "./useProjectController";
import { ProjectDesktopRecipeSection } from "./ProjectDesktopRecipeSection";
import { ProjectAutoReviewerSection } from "./ProjectAutoReviewerSection";
import {
  ProjectModelRolesSection,
  type ProjectModelRolesSectionProps,
} from "./ProjectModelRolesSection";
import { ProjectPermissionModeSection } from "./ProjectPermissionModeSection";
import { ProjectProviderPolicySection } from "./ProjectProviderPolicySection";
import { ProjectNativeProvidersSection } from "./ProjectNativeProvidersSection";
import {
  PROJECT_COLOR_MENU_ITEMS,
  ProjectTile,
  projectColorFromMenuValue,
  projectColorMenuValue,
} from "./ProjectTile";
import {
  ProjectSpendCeilingSection,
  useProjectSpendCeilingSet,
} from "../usage/ProjectSpendCeilingSection";
import { ProjectInstructionsSettings } from "../settings/OctantInstructionsSettings";
import { OctantAlert } from "../ui/base/OctantAlert";
import { OctantDialogPresence } from "../ui/base/OctantDialogPresence";

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
  readonly onAddExtraFolder?: (
    projectId: ProjectId,
    receiptId: string,
    confirmHomeFolder?: boolean,
  ) => Promise<ExtraFolderChange>;
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
  readonly onOpenSandboxRestrictions?: () => void;
  /** Sets the mode this Code Project's new threads start in; absent follows Settings. */
  readonly onPermissionModeChange?: (
    projectId: ProjectId,
    permissionMode: PermissionMode | undefined,
    /** "keep" (the default) leaves the Project's sandbox choice as it is. */
    strict?: boolean | "inherit" | "keep",
  ) => Promise<boolean>;
  /** Sets who answers this Code Project's prompts at Auto; absent follows Settings. */
  readonly onAutoReviewerChange?: (
    projectId: ProjectId,
    autoReviewer: AutoReviewer | undefined,
  ) => Promise<boolean>;
  /** Absent when the host cannot accept the change; the switch is then not shown. */
  readonly onAgentMemoryWritesChange?: (projectId: ProjectId, enabled: boolean) => Promise<boolean>;
  /** Drops the image model the Project's agents use without asking; absent hides the row. */
  readonly onImageGenerationAskAgain?: (projectId: ProjectId) => Promise<boolean>;
  /** Absent when the host cannot accept the change; the brand kit is then not shown. */
  readonly onBrandKitChange?: (
    projectId: ProjectId,
    brandKit: CanvasDesignBrand,
  ) => Promise<boolean>;
  /** Absent when the host cannot accept the change; the panel then offers no choice. */
  readonly onDesignSystemChange?: (
    projectId: ProjectId,
    designSystem: DesignSystemChoice | null,
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
  /**
   * Runs this Code Project's language services from its own toolchain. The
   * host accepts it only from a window on its own machine.
   */
  readonly onOwnToolchainChange?: (projectId: ProjectId, enabled: boolean) => Promise<boolean>;
  /** Absent when the host cannot accept the change; the switch is then not shown. */
  readonly onWorkDeveloperToolsChange?: (
    projectId: ProjectId,
    enabled: boolean,
  ) => Promise<boolean>;
  readonly providerInstances?: ReadonlyArray<ProviderInstance>;
  readonly project: ProjectSummary;
  readonly projectClient?: ProjectClient;
  /** The person's instructions for this Project, beside its memory. */
  readonly octantInstructionsClient?: OctantInstructionsClient;
  readonly spendCeilingClient?: import("@octant/client-runtime").SpendCeilingClient;
  /** Off hides the Project's spend ceiling row, unless a ceiling is set. */
  readonly spendCeilingShown?: boolean;
  /** Absent when the window cannot reach the host's model roles; the Models section is then not shown. */
  readonly modelRoles?: Omit<ProjectModelRolesSectionProps, "projectId" | "disabled">;
}

const MAX_ICON_BYTES = 262_144;

/** The Project's own icon when its folder has one, else the coloured tile; the colour menu opens from either. */
function ProjectPageMark(props: { readonly project: ProjectOverviewProps["project"] }) {
  return (
    <ProjectIcon
      fallback={<ProjectTile project={props.project} />}
      projectId={String(props.project.id)}
      size={24}
    />
  );
}

export function ProjectOverview(props: ProjectOverviewProps) {
  const projectCeilingSet = useProjectSpendCeilingSet(
    props.spendCeilingClient,
    String(props.project.id),
    props.spendCeilingShown === true,
  );
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
  const canRelink =
    props.project.type !== "chat" && !archived && !connectionStale && allowRootRelink;
  // Relink and Archive are occasional; New thread is the page's one action.
  // An unavailable root is the exception: choosing a new one is then the
  // remedy, so it stays beside New thread instead of waiting in the menu.
  const iconSource = useProjectIconSource();
  const iconDetails = useProjectIconDetails(String(props.project.id));
  const iconFile = useRef<HTMLInputElement>(null);
  // The picture is chosen with the desktop's own file picker; a browser tab
  // has no such picker, so the item says why it is off.
  const canChooseIcon = props.hostBridge !== undefined && iconSource?.choose !== undefined;
  const iconItems: ReadonlyArray<OctantMenuItem> =
    archived || connectionStale || iconSource?.choose === undefined
      ? []
      : [
          {
            label: "Change icon…",
            value: "icon-change",
            disabled: !canChooseIcon,
            ...(canChooseIcon ? {} : { description: "Choose an icon in the desktop app." }),
          },
          ...(iconDetails?.custom === true
            ? [
                iconDetails.foundAvailable
                  ? { label: "Use found icon", value: "icon-reset" }
                  : { label: "Remove custom icon", value: "icon-reset" },
              ]
            : []),
        ];
  const overflowItems: ReadonlyArray<OctantMenuItem> = [
    ...iconItems,
    ...(canRelink && !unavailable ? [{ label: "Relink folder", value: "relink" }] : []),
    {
      destructive: true,
      label: props.project.type === "chat" ? "Archive" : "Archive Project",
      value: "archive",
    },
  ];
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

  async function chooseIcon(file: File | undefined) {
    if (file === undefined || iconSource?.choose === undefined) return;
    const operation = ++relinkGeneration.current;
    setRelinkFailed(false);
    setRelinkStatus("");
    // The host checks again; this only spares a round trip for a plain mistake.
    if (file.size > MAX_ICON_BYTES) {
      setRelinkFailed(true);
      setRelinkStatus("That image is larger than 256 KB. Choose a smaller icon.");
      return;
    }
    const outcome = await iconSource.choose(String(props.project.id), file);
    if (!alive.current || operation !== relinkGeneration.current) return;
    setRelinkFailed(outcome.status === "refused");
    setRelinkStatus(outcome.status === "changed" ? "Icon changed." : outcome.message);
  }

  async function resetIcon() {
    if (iconSource?.reset === undefined) return;
    const operation = ++relinkGeneration.current;
    const outcome = await iconSource.reset(String(props.project.id));
    if (!alive.current || operation !== relinkGeneration.current) return;
    setRelinkFailed(outcome.status === "refused");
    setRelinkStatus(outcome.status === "changed" ? "Icon changed." : outcome.message);
  }

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
        setRelinkStatus(
          "Could not relink the Project folder. Check the Project status and try again.",
        );
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
      <section className="project-overview" data-project-type={props.project.type}>
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
              <ProjectPageMark project={props.project} />
            ) : (
              <OctantMenu
                items={PROJECT_COLOR_MENU_ITEMS}
                onValueChange={(value) => {
                  const color = projectColorFromMenuValue(value);
                  if (color !== undefined) void props.onColorChange?.(props.project.id, color);
                }}
                trigger={<ProjectPageMark project={props.project} />}
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
                <p className="project-overview__type">
                  <span>{label(props.project.type)} Project</span>
                  <span aria-hidden="true">·</span>
                  <span className="project-overview__root">
                    {homeRelativePath(props.project.binding.canonicalRoot)}
                  </span>
                </p>
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
              <OctantButton onClick={props.onNewThread} size="sm" type="button" variant="solid">
                <SquarePen aria-hidden="true" size={14} />
                {props.project.type === "chat" ? "New chat" : "New thread"}
              </OctantButton>
            )}
            {canRelink && unavailable ? (
              <OctantButton
                onClick={() => void relink()}
                size="sm"
                type="button"
                variant="secondary"
              >
                Choose new root
              </OctantButton>
            ) : null}
            <input
              accept="image/png,image/svg+xml,image/x-icon,.png,.svg,.ico"
              aria-label="Choose an icon image"
              className="sr-only"
              onChange={(event) => {
                const file = event.currentTarget.files?.item(0) ?? undefined;
                event.currentTarget.value = "";
                void chooseIcon(file);
              }}
              ref={iconFile}
              tabIndex={-1}
              type="file"
            />
            {archived || connectionStale ? (
              <span className="project-overview__archived">
                {archived ? "Archived Project · read-only" : "Stale snapshot · read-only"}
              </span>
            ) : (
              <OctantMenu
                items={overflowItems}
                onValueChange={(value) => {
                  if (value === "relink") void relink();
                  else if (value === "archive") props.onArchive(props.project.id);
                  else if (value === "icon-change") iconFile.current?.click();
                  else if (value === "icon-reset") void resetIcon();
                }}
                selectionMode="action"
                trigger={<Ellipsis aria-hidden="true" size={16} />}
                triggerClassName={`${octantButtonClassName({ size: "icon-sm", variant: "ghost" })} project-overview__more`}
                triggerLabel="More Project actions"
                value=""
              />
            )}
          </div>
        </header>
        {props.project.type !== "chat" ? (
          <section
            className="project-overview__context project-overview__repo"
            aria-label="Project binding"
          >
            <header className="project-overview__card-header">
              <h2 className="project-overview__card-title">
                {props.project.type === "code" ? "Repository" : "Folders"}
              </h2>
              {unavailable ? null : (
                <span
                  className="project-overview__availability"
                  data-state={
                    archived
                      ? "quiet"
                      : props.availability?.status === "unverified"
                        ? "quiet"
                        : "ok"
                  }
                >
                  <span aria-hidden="true" className="project-overview__availability-dot" />
                  {archived
                    ? "Archived · read-only"
                    : props.availability?.status === "unverified"
                      ? "Availability unverified"
                      : "Available"}
                </span>
              )}
            </header>
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
                    onAdd: (receiptId: string, confirmHomeFolder?: boolean) =>
                      onAddExtraFolder(props.project.id, receiptId, confirmHomeFolder),
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
            ) : null}
            <p className="project-overview__description">{authorityCopy(props.project.type)}</p>
          </section>
        ) : null}
        <OctantDialogPresence>
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
        </OctantDialogPresence>
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
            <div className="project-overview__stack">
              {props.workOverview}
              {props.workPromotion}
            </div>
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
          threads know (memory, design system, brand, canvases) and what they may reach or
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
            {props.octantInstructionsClient === undefined ? null : (
              <ProjectOverviewInspector
                key={`${String(props.project.id)}-instructions`}
                label="Instructions"
                summary="Your rules for work in this Project"
              >
                <ProjectInstructionsSettings
                  client={props.octantInstructionsClient}
                  projectId={String(props.project.id)}
                  readOnly={archived || connectionStale}
                />
              </ProjectOverviewInspector>
            )}
            {props.projectClient === undefined || props.project.type === "chat" ? null : (
              <ProjectOverviewInspector
                key={`${String(props.project.id)}-design-system`}
                label="Design system"
                summary="DESIGN.md: the look code, documents, and decks follow"
              >
                <ProjectDesignSystemSection
                  client={props.projectClient}
                  {...(props.onDesignSystemChange === undefined
                    ? {}
                    : {
                        onChoose: async (choice: DesignSystemChoice | null) =>
                          (await props.onDesignSystemChange?.(props.project.id, choice)) ?? false,
                      })}
                  disabled={archived || connectionStale}
                  project={props.project}
                />
              </ProjectOverviewInspector>
            )}
            {props.onBrandKitChange === undefined ? null : (
              <ProjectOverviewInspector
                key={`${String(props.project.id)}-brand-kit`}
                label="Brand kit"
                summary={
                  props.project.type === "chat"
                    ? "Colours and fonts your designs can use"
                    : "Colours and fonts for designs without a DESIGN.md"
                }
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
                summary="Hooks, MCP servers, and plugins a provider may load"
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
            {props.onAgentMemoryWritesChange === undefined ? null : (
              <AgentMemoryWritesSetting
                disabled={archived || connectionStale}
                enabled={props.project.agentMemoryWrites === "enabled"}
                onChange={(enabled) => props.onAgentMemoryWritesChange?.(props.project.id, enabled)}
              />
            )}
            {props.onImageGenerationAskAgain === undefined ||
            props.project.imageGenerationChoice === undefined ? null : (
              <KeptImageGenerationChoice
                disabled={archived || connectionStale}
                modelId={String(props.project.imageGenerationChoice.modelId)}
                onAskAgain={() => props.onImageGenerationAskAgain?.(props.project.id)}
              />
            )}
            {props.project.type === "work" && props.onWorkDeveloperToolsChange !== undefined ? (
              <WorkDeveloperToolsSetting
                disabled={archived || connectionStale}
                enabled={props.project.developerTools?.enabled === true}
                onChange={(enabled) =>
                  props.onWorkDeveloperToolsChange?.(props.project.id, enabled)
                }
              />
            ) : null}
            {(props.project.type === "code" ||
              (props.project.type === "work" && props.project.developerTools?.enabled === true)) &&
            props.onActionsChange !== undefined ? (
              <ProjectOverviewInspector
                key={`${String(props.project.id)}-actions`}
                label="Actions"
                summary="Run, Test, Dev and other named commands"
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
            {props.project.type !== "chat" && props.onPermissionModeChange !== undefined ? (
              <ProjectOverviewInspector
                key={`${String(props.project.id)}-mode`}
                label="Default mode"
                summary="The mode this Project's new threads start in"
              >
                <ProjectPermissionModeSection
                  {...(props.onOpenSandboxRestrictions === undefined
                    ? {}
                    : { onOpenSandboxRestrictions: props.onOpenSandboxRestrictions })}
                  disabled={archived || connectionStale}
                  onChange={async (mode, strict) =>
                    (await props.onPermissionModeChange?.(
                      props.project.id,
                      mode,
                      strict ?? "keep",
                    )) ?? false
                  }
                  project={props.project}
                />
              </ProjectOverviewInspector>
            ) : null}
            {props.project.type === "code" && props.onAutoReviewerChange !== undefined ? (
              <ProjectOverviewInspector
                key={`${String(props.project.id)}-auto-reviewer`}
                label="Auto reviewer"
                summary="Who approves this Project's actions at Auto"
              >
                <ProjectAutoReviewerSection
                  disabled={archived || connectionStale}
                  onChange={async (reviewer) =>
                    (await props.onAutoReviewerChange?.(props.project.id, reviewer)) ?? false
                  }
                  project={props.project}
                />
              </ProjectOverviewInspector>
            ) : null}
            {props.project.type === "code" && props.onOwnToolchainChange !== undefined ? (
              <OwnToolchainSetting
                disabled={archived || connectionStale}
                enabled={props.project.ownToolchain === "enabled"}
                onChange={(enabled) => props.onOwnToolchainChange?.(props.project.id, enabled)}
              />
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
            {props.project.type !== "chat" && props.modelRoles !== undefined ? (
              <ProjectOverviewInspector
                key={`${String(props.project.id)}-models`}
                label="Models"
                summary="Models this Project's coordinators and helpers use"
              >
                <ProjectModelRolesSection
                  {...props.modelRoles}
                  disabled={archived || connectionStale}
                  projectId={String(props.project.id)}
                />
              </ProjectOverviewInspector>
            ) : null}
            {props.spendCeilingClient === undefined ||
            (props.spendCeilingShown !== true && !projectCeilingSet) ? null : (
              <ProjectOverviewInspector
                key={`${String(props.project.id)}-ceiling`}
                label="Spend ceiling"
                summary="Optional limits on tokens, turns, run time, and money"
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

const STATUS_FILE_RULE =
  "Keep a STATUS.md in this folder. Tasks read it and update it, and dated follow-ups become reminders. Off: Octant writes nothing to the folder.";

const DEVELOPER_TOOLS_RULE =
  "Show this Project's terminal and its Run, Test and Dev actions. Tasks can still run commands and Git either way; this only changes what you see.";

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
          <p title={STATUS_FILE_RULE}>Keep a STATUS.md in this folder.</p>
          <span className="sr-only" id={descriptionId}>
            {STATUS_FILE_RULE}
          </span>
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

/**
 * Whether this Project's agents write its memory without the person confirming
 * each change. Full access never asks and Plan never writes, so the text says
 * the switch covers the levels between.
 */
function AgentMemoryWritesSetting(props: {
  readonly disabled: boolean;
  readonly enabled: boolean;
  readonly onChange: (enabled: boolean) => Promise<boolean> | undefined;
}) {
  // As for the other switches: a second flip before the first returns would
  // be refused as a version conflict, so the switch waits.
  const [pending, setPending] = useState(false);
  const descriptionId = useId();
  return (
    <section className="project-overview-inspector">
      <div className="project-overview-inspector__row">
        <div>
          <h3>Agent memory writes</h3>
          {/* The limits stay on screen: they are what make the switch safe. */}
          <p id={descriptionId}>
            Below Full access, agents write memory without asking. Each entry is marked as written
            by an agent. Full access never asks. Plan never writes.
          </p>
        </div>
        <OctantSwitch
          checked={props.enabled}
          describedBy={descriptionId}
          disabled={props.disabled || pending}
          label="Agents may write Project memory without asking"
          onCheckedChange={(enabled) => {
            setPending(true);
            void Promise.resolve(props.onChange(enabled)).finally(() => setPending(false));
          }}
        />
      </div>
    </section>
  );
}

/**
 * The image model a person told a thread of this Project to keep using
 * ("Don't ask again" on the image card). It is shown only while one is kept,
 * because the card is where a model is chosen; here the person takes the
 * standing permission back.
 */
function KeptImageGenerationChoice(props: {
  readonly disabled: boolean;
  readonly modelId: string;
  readonly onAskAgain: () => Promise<boolean> | undefined;
}) {
  const [pending, setPending] = useState(false);
  return (
    <section className="project-overview-inspector">
      <div className="project-overview-inspector__row">
        <div>
          <h3>Image generation</h3>
          <p>
            Agents in this Project generate images with {props.modelId} without asking, in routines
            too. Each image is billed to your image provider. Plan never generates.
          </p>
        </div>
        <OctantButton
          disabled={props.disabled || pending}
          onClick={() => {
            setPending(true);
            void Promise.resolve(props.onAskAgain()).finally(() => setPending(false));
          }}
          size="sm"
          type="button"
          variant="secondary"
        >
          Ask again
        </OctantButton>
      </div>
    </section>
  );
}

/**
 * A Code Project's choice to run language services from its own copy of a
 * toolchain. The description says what that costs, because the Project's copy
 * is a program the repository supplies and each checkout then asks before it
 * runs.
 */
function OwnToolchainSetting(props: {
  readonly disabled: boolean;
  readonly enabled: boolean;
  readonly onChange: (enabled: boolean) => Promise<boolean> | undefined;
}) {
  // Each command asserts the Project version it read, so the switch waits
  // for one change before it takes the next.
  const [pending, setPending] = useState(false);
  const descriptionId = useId();
  return (
    <section className="project-overview-inspector">
      <div className="project-overview-inspector__row">
        <div>
          <h3>Language services toolchain</h3>
          <p id={descriptionId}>
            Type errors and go to definition use the TypeScript this Project installs instead of the
            one bundled with Octant. That runs code from the repository, so each checkout asks you
            to allow it first, it never runs in Plan, and it can write the checkout and reach the
            hosts this Project's network rules allow. Only this computer can change this.
          </p>
        </div>
        <OctantSwitch
          checked={props.enabled}
          describedBy={descriptionId}
          disabled={props.disabled || pending}
          label="Use the Project's own toolchain"
          onCheckedChange={(enabled) => {
            setPending(true);
            void Promise.resolve(props.onChange(enabled)).finally(() => setPending(false));
          }}
        />
      </div>
    </section>
  );
}

/**
 * A Work Project's Developer tools switch: its Project terminal and actions
 * appear when on. Work threads keep the shell and Git at their level either
 * way, so the switch says that it only changes what the Project shows.
 */
function WorkDeveloperToolsSetting(props: {
  readonly disabled: boolean;
  readonly enabled: boolean;
  readonly onChange: (enabled: boolean) => Promise<boolean> | undefined;
}) {
  const [pending, setPending] = useState(false);
  const descriptionId = useId();
  return (
    <section className="project-overview-inspector">
      <div className="project-overview-inspector__row">
        <div>
          <h3>Developer tools</h3>
          <p title={DEVELOPER_TOOLS_RULE}>Show this Project&apos;s terminal and actions.</p>
          <span className="sr-only" id={descriptionId}>
            {DEVELOPER_TOOLS_RULE}
          </span>
        </div>
        <OctantSwitch
          checked={props.enabled}
          describedBy={descriptionId}
          disabled={props.disabled || pending}
          label="Show developer tools"
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
    return "A virtual organization with approved memory. No automatic host access.";
  if (type === "work") return "Stays inside the Project's folders.";
  return "New Code work starts approval-gated.";
}
