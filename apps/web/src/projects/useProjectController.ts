import type { KeyProviderDriverKinds, PermissionMode } from "@octant/contracts/providers";
import type { AutoReviewer } from "@octant/contracts/shield";
import {
  decodeBindingReceiptId,
  decodeMemoryEntryId,
  decodeProjectId,
  type MemoryCommand,
  type MemoryEntryId,
  type MemoryKind,
  type ProjectBootstrap,
  type ProjectId,
  type ProjectMemoryView,
  type ProjectSummary,
  type ProjectType,
  type CodeAccessPersistence,
  type CodeNewThreadWorkspace,
  type CodeProjectAgentMerge,
  type CodeProjectPullRequestBackgroundRefresh,
  type ProjectAction,
  type ProjectColor,
  type ProjectProviderPolicy,
  type WorkProjectStatusFile,
} from "@octant/contracts/projects";
import type { CanvasDesignBrand } from "@octant/contracts/canvas";
import type { DesktopRecipe, DesktopRecipeKeyChange } from "@octant/contracts/desktop-lease";
import type { AggregateVersion } from "@octant/contracts/events";
import { LOCAL_HOST_ID, type HostId } from "@octant/contracts/host";
import { createProjectClient, type ProjectClient } from "@octant/client-runtime/project-client";
import type { OctantMode } from "@octant/contracts/modes";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { failureMessage } from "../lib/failureMessage";

const PROJECT_UNAVAILABLE = "Octant Project service is unavailable.";
const PROJECT_CHANGED_ELSEWHERE = "The Project changed in another window. Review it and try again.";

/** Whether a command changed the Project, or why the host refused it. */
export type ProjectChange =
  | { readonly status: "changed" }
  | { readonly status: "refused"; readonly message: string };

export type ProjectControllerStatus = "loading" | "ready" | "disconnected" | "conflict-reload";
export type ProjectSearchStatus = "idle" | "searching" | "success" | "error";
export type ProjectMemoryStatus = "idle" | "loading" | "ready" | "error" | "conflict-reload";

export interface ProjectControllerOptions {
  readonly activeMode: OctantMode;
  readonly activeProjectId?: ProjectId;
  readonly client?: ProjectClient;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
  readonly changeRevision?: number;
}

interface Announcement {
  readonly message: string;
  readonly sequence: number;
}

const emptyBootstrap: ProjectBootstrap = {
  active: [],
  archived: [],
  availability: [],
  memory: [],
};

export function useProjectController(options: ProjectControllerOptions) {
  const fallbackClient = useMemo(
    () =>
      options.client ??
      createProjectClient({
        baseUrl: required(options.serverUrl),
        fetch: globalThis.fetch,
        windowCapability: required(options.windowCapability),
      }),
    [options.client, options.serverUrl, options.windowCapability],
  );
  const [status, setStatus] = useState<ProjectControllerStatus>("loading");
  const [state, setState] = useState<ProjectBootstrap>(emptyBootstrap);
  const [errorMessage, setErrorMessage] = useState<string>();
  const [searchErrorMessage, setSearchErrorMessage] = useState<string>();
  const [searchResults, setSearchResults] = useState<ReadonlyArray<ProjectSummary>>([]);
  const [searchStatus, setSearchStatus] = useState<ProjectSearchStatus>("idle");
  const [memory, setMemory] = useState<ProjectMemoryView>();
  const [memoryStatus, setMemoryStatus] = useState<ProjectMemoryStatus>("idle");
  const [memoryErrorMessage, setMemoryErrorMessage] = useState<string>();
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [memoryRevision, advanceMemoryRevision] = useReducer((revision: number) => revision + 1, 0);
  const [announcement, announce] = useReducer(
    (previous: Announcement, message: string): Announcement => ({
      message,
      sequence: previous.sequence + 1,
    }),
    { message: "", sequence: 0 },
  );
  const mounted = useRef(true);
  const generation = useRef(0);
  const searchGeneration = useRef(0);
  const memoryRequestGeneration = useRef(0);
  const memoryDisclosureGeneration = useRef(0);
  const memoryOperation = useRef(false);
  const memoryOwnerProjectId = useRef<ProjectId | undefined>(undefined);

  const load = useCallback(
    async (reason: "bootstrap" | "retry" | "refresh" | "conflict" | "revision" = "retry") => {
      const request = ++generation.current;
      if (reason !== "revision") {
        setStatus(reason === "conflict" ? "conflict-reload" : "loading");
      }
      setErrorMessage(undefined);
      try {
        const bootstrap = await fallbackClient.bootstrap();
        if (!mounted.current || request !== generation.current) return;
        setState(bootstrap);
        setStatus("ready");
        if (reason === "conflict") {
          announce("Project changed concurrently. Reloaded authoritative state.");
        } else if (reason === "refresh") {
          announce("Project availability refreshed.");
        }
      } catch (error) {
        if (!mounted.current || request !== generation.current) return;
        if (reason === "revision") {
          setErrorMessage(failureMessage(error, PROJECT_UNAVAILABLE));
          return;
        }
        setStatus("disconnected");
        setErrorMessage(failureMessage(error, PROJECT_UNAVAILABLE));
      }
    },
    [fallbackClient],
  );

  useEffect(() => {
    mounted.current = true;
    void load("bootstrap");
    return () => {
      mounted.current = false;
      generation.current += 1;
      memoryRequestGeneration.current += 1;
      memoryDisclosureGeneration.current += 1;
    };
  }, [load]);

  useEffect(() => {
    if (options.changeRevision === undefined || options.changeRevision <= 0) return;
    void load("revision");
  }, [load, options.changeRevision]);

  const loadMemory = useCallback(
    async (projectId: ProjectId, reason: "open" | "retry" | "refresh" | "conflict" = "open") => {
      const request = ++memoryRequestGeneration.current;
      setMemoryStatus(reason === "conflict" ? "conflict-reload" : "loading");
      setMemoryErrorMessage(undefined);
      try {
        const view = await fallbackClient.memory(projectId);
        if (!mounted.current || request !== memoryRequestGeneration.current) return;
        setMemory(view);
        memoryOwnerProjectId.current = view.projectId;
        setMemoryStatus("ready");
        advanceMemoryRevision();
        if (reason === "conflict") {
          announce("Project memory changed concurrently. Reloaded authoritative memory.");
        }
      } catch (error) {
        if (!mounted.current || request !== memoryRequestGeneration.current) return;
        setMemory(undefined);
        setMemoryStatus("error");
        setMemoryErrorMessage(failureMessage(error, PROJECT_UNAVAILABLE));
      }
    },
    [fallbackClient],
  );

  const clearMemory = useCallback((): void => {
    memoryRequestGeneration.current += 1;
    memoryDisclosureGeneration.current += 1;
    memoryOwnerProjectId.current = undefined;
    setMemory(undefined);
    setMemoryErrorMessage(undefined);
    setMemoryStatus("idle");
  }, []);

  // Memoized on the lists they are read from: the shell's surfaces compare these by
  // identity, and a fresh array on every render re-rendered all of them.
  const allProjects = useMemo(
    () => [...state.active, ...state.archived],
    [state.active, state.archived],
  );
  const projectById = useMemo(
    () => new Map(allProjects.map((project) => [project.id, project])),
    [allProjects],
  );

  async function execute(
    command: Parameters<ProjectClient["executeProject"]>[0],
    successMessage: string,
  ): Promise<boolean> {
    return (await executeReporting(command, successMessage)).status === "changed";
  }

  /**
   * Like {@link execute}, but answers why a command did not change the Project,
   * for a view that shows the reason next to the control the person used.
   */
  async function executeReporting(
    command: Parameters<ProjectClient["executeProject"]>[0],
    successMessage: string,
  ): Promise<ProjectChange> {
    setErrorMessage(undefined);
    try {
      await fallbackClient.executeProject(command);
      await load("retry");
      if (!mounted.current) return { status: "refused", message: PROJECT_UNAVAILABLE };
      announce(successMessage);
      return { status: "changed" };
    } catch (error) {
      if (!mounted.current) return { status: "refused", message: PROJECT_UNAVAILABLE };
      if (failureCategory(error) === "conflict") {
        await load("conflict");
        return { status: "refused", message: PROJECT_CHANGED_ELSEWHERE };
      }
      const message = failureMessage(error, PROJECT_UNAVAILABLE);
      setErrorMessage(message);
      announce(message);
      return { status: "refused", message };
    }
  }

  async function setCodeAccessPersistence(
    projectId: ProjectId,
    codeAccessPersistence: CodeAccessPersistence,
  ): Promise<boolean> {
    const project = projectById.get(projectId);
    if (project?.type !== "code") return false;
    if (project.codeAccessPersistence === codeAccessPersistence) return true;
    return execute(
      {
        kind: "change-code-project-access",
        projectId,
        expectedVersion: project.version,
        codeAccessPersistence,
      },
      "Code Project access persistence updated.",
    );
  }

  /**
   * Record how new Code threads in this Project should start.
   *
   * The habit lives on the Project record so every window sees the same
   * default; the create dialog still overrides it for one thread without
   * coming through here.
   */
  /** Record the mode a Code Project's new threads start in; absent follows Settings. */
  async function setCodePermissionMode(
    projectId: ProjectId,
    permissionMode: PermissionMode | undefined,
  ): Promise<boolean> {
    const project = projectById.get(projectId);
    if (project?.type !== "code") return false;
    if (project.defaultPermissionMode === permissionMode) return true;
    return execute(
      {
        kind: "change-code-project-permission-mode",
        projectId,
        expectedVersion: project.version,
        ...(permissionMode === undefined ? {} : { permissionMode }),
      },
      "Code Project default mode updated.",
    );
  }

  /** Record who answers a Code Project's prompts at Auto; absent follows Settings. */
  async function setCodeAutoReviewer(
    projectId: ProjectId,
    autoReviewer: AutoReviewer | undefined,
  ): Promise<boolean> {
    const project = projectById.get(projectId);
    if (project?.type !== "code") return false;
    if (project.autoReviewer === autoReviewer) return true;
    return execute(
      {
        kind: "change-code-project-auto-reviewer",
        projectId,
        expectedVersion: project.version,
        ...(autoReviewer === undefined ? {} : { autoReviewer }),
      },
      "Code Project Auto reviewer updated.",
    );
  }

  async function setCodeNewThreadWorkspace(
    projectId: ProjectId,
    newThreadWorkspace: CodeNewThreadWorkspace,
  ): Promise<boolean> {
    const project = projectById.get(projectId);
    if (project?.type !== "code") return false;
    if ((project.newThreadWorkspace ?? "current-checkout") === newThreadWorkspace) return true;
    return execute(
      {
        kind: "change-code-project-new-thread-workspace",
        projectId,
        expectedVersion: project.version,
        newThreadWorkspace,
      },
      "Code Project new-thread workspace updated.",
    );
  }

  /**
   * Opt a Code Project into (or out of) background refresh of its pull-request
   * snapshot. The server is the authority: this only issues the command.
   */
  async function setCodePullRequestBackgroundRefresh(
    projectId: ProjectId,
    pullRequestBackgroundRefresh: CodeProjectPullRequestBackgroundRefresh,
  ): Promise<boolean> {
    const project = projectById.get(projectId);
    if (project?.type !== "code") return false;
    if ((project.pullRequestBackgroundRefresh ?? "disabled") === pullRequestBackgroundRefresh) {
      return true;
    }
    return execute(
      {
        kind: "change-code-project-pull-request-background-refresh",
        projectId,
        expectedVersion: project.version,
        pullRequestBackgroundRefresh,
      },
      pullRequestBackgroundRefresh === "enabled"
        ? "Background pull-request refresh enabled."
        : "Background pull-request refresh disabled.",
    );
  }

  /**
   * Let a Code Project's agents merge the pull requests their threads own
   * without asking each time, or stop that. The server is the authority and
   * accepts it only from a window on the host.
   */
  async function setCodeAgentMerge(
    projectId: ProjectId,
    agentMerge: CodeProjectAgentMerge,
  ): Promise<boolean> {
    const project = projectById.get(projectId);
    if (project?.type !== "code") return false;
    if ((project.agentMerge ?? "disabled") === agentMerge) return true;
    return execute(
      {
        kind: "change-code-project-agent-merge",
        projectId,
        expectedVersion: project.version,
        agentMerge,
      },
      agentMerge === "enabled"
        ? "Agents may now merge this Project's pull requests."
        : "Agents no longer merge this Project's pull requests without asking.",
    );
  }

  /**
   * Opt a Work Project into (or out of) the STATUS.md Octant keeps in its
   * folder. The server refuses it for the default-folder Project.
   */
  async function setWorkStatusFile(
    projectId: ProjectId,
    statusFile: WorkProjectStatusFile,
  ): Promise<boolean> {
    const project = projectById.get(projectId);
    if (project?.type !== "work") return false;
    if ((project.statusFile ?? "disabled") === statusFile) return true;
    return execute(
      {
        kind: "change-work-project-status-file",
        projectId,
        expectedVersion: project.version,
        statusFile,
      },
      statusFile === "enabled" ? "Status file turned on." : "Status file turned off.",
    );
  }

  /** Set, replace, or (with an empty kit) clear the Project's brand kit. */
  async function setBrandKit(projectId: ProjectId, brandKit: CanvasDesignBrand): Promise<boolean> {
    const project = projectById.get(projectId);
    if (project === undefined) return false;
    return execute(
      {
        kind: "change-project-brand-kit",
        projectId,
        expectedVersion: project.version,
        brandKit,
      },
      Object.keys(brandKit).length === 0 ? "Brand kit cleared." : "Brand kit saved.",
    );
  }

  /**
   * Set, replace, or (with `null`) remove a Code Project's disposable desktop
   * recipe, entering or removing its cloud provider's key with it. The key
   * goes to the host in this one request and is kept nowhere here.
   */
  async function setDesktopRecipe(
    projectId: ProjectId,
    recipe: DesktopRecipe | null,
    key?: DesktopRecipeKeyChange,
  ): Promise<boolean> {
    const project = projectById.get(projectId);
    if (project?.type !== "code") return false;
    return execute(
      {
        kind: "change-code-project-desktop-recipe",
        projectId,
        expectedVersion: project.version,
        recipe,
        ...(key === undefined ? {} : { key }),
      },
      recipe === null
        ? "Desktop recipe removed."
        : key?.action === "remove"
          ? "Desktop key removed."
          : key?.action === "enter"
            ? "Desktop recipe and key saved."
            : "Desktop recipe saved.",
    );
  }

  /**
   * Save the whole list of a Work or Code Project's terminal actions. The
   * host refuses an archived Project and a list that changes nothing.
   */
  async function setActions(
    projectId: ProjectId,
    actions: ReadonlyArray<ProjectAction>,
  ): Promise<boolean> {
    const project = projectById.get(projectId);
    if (project?.type !== "code" && project?.type !== "work") return false;
    return execute(
      {
        kind:
          project.type === "code" ? "change-code-project-actions" : "change-work-project-actions",
        projectId,
        expectedVersion: project.version,
        actions,
      },
      "Project actions saved.",
    );
  }

  /**
   * Turn a Work Project's developer surfaces (its terminal and actions) on or
   * off. The host journals who and when; it changes what the Project shows,
   * not what its threads may do.
   */
  async function setWorkDeveloperTools(projectId: ProjectId, enabled: boolean): Promise<boolean> {
    const project = projectById.get(projectId);
    if (project?.type !== "work") return false;
    if ((project.developerTools?.enabled ?? false) === enabled) return true;
    return execute(
      {
        kind: "change-work-project-developer-tools",
        projectId,
        expectedVersion: project.version,
        enabled,
      },
      enabled ? "Developer tools turned on." : "Developer tools turned off.",
    );
  }

  /** Restrict provider/model choices for Work and Code turns in this Project. */
  async function setProviderPolicy(
    projectId: ProjectId,
    providerPolicy: ProjectProviderPolicy,
  ): Promise<boolean> {
    const project = projectById.get(projectId);
    if (project === undefined || project.type === "chat") return false;
    const current = project.providerPolicy ?? { mode: "all" as const, providerInstanceIds: [] };
    if (
      current.mode === providerPolicy.mode &&
      current.providerInstanceIds.length === providerPolicy.providerInstanceIds.length &&
      current.providerInstanceIds.every((id) =>
        providerPolicy.providerInstanceIds.some((candidate) => String(candidate) === String(id)),
      )
    ) {
      return true;
    }
    return execute(
      {
        kind: "change-project-provider-policy",
        projectId,
        expectedVersion: project.version,
        policy: providerPolicy,
      },
      "Project provider policy updated.",
    );
  }

  /** Sets which key providers run as themselves in this Work or Code Project. */
  async function setNativeProviders(
    projectId: ProjectId,
    providers: KeyProviderDriverKinds,
  ): Promise<boolean> {
    const project = projectById.get(projectId);
    if (project === undefined || project.type === "chat") return false;
    const current = project.nativeProviders ?? [];
    if (current.length === providers.length && current.every((kind) => providers.includes(kind))) {
      return true;
    }
    return execute(
      {
        kind: "change-project-native-providers",
        projectId,
        expectedVersion: project.version,
        providers,
      },
      "Project trust updated.",
    );
  }

  async function create(
    type: ProjectType,
    name: string,
    receiptId?: string,
    hostId: HostId = LOCAL_HOST_ID,
    initializeGit?: boolean,
  ): Promise<ProjectId | undefined> {
    const projectId = decodeProjectId(crypto.randomUUID());
    const base = { projectId, expectedVersion: 0 as AggregateVersion, name, hostId };
    let command: Parameters<ProjectClient["executeProject"]>[0];
    if (type === "chat") {
      command = { kind: "create-chat-project", ...base };
    } else if (type === "work") {
      if (receiptId === undefined) throw new Error("A native root selection is required.");
      command = {
        kind: "create-work-project",
        ...base,
        receiptId: decodeBindingReceiptId(receiptId),
      };
    } else {
      if (receiptId === undefined) throw new Error("A native root selection is required.");
      command = {
        kind: "create-code-project",
        ...base,
        receiptId: decodeBindingReceiptId(receiptId),
        ...(initializeGit === true ? { initializeGit: true } : {}),
      };
    }
    return (await execute(command, `${modeLabel(type)} Project created.`)) ? projectId : undefined;
  }

  /**
   * The Project a thread starts in when nobody chose one. The host provisions
   * it under the default folder on first use and hands back the same one after,
   * so the result is the Project to select, created or not.
   */
  async function ensureDefault(
    type: "work" | "code",
    hostId: HostId = LOCAL_HOST_ID,
  ): Promise<{ readonly projectId: ProjectId; readonly name: string } | undefined> {
    setErrorMessage(undefined);
    try {
      const result = await fallbackClient.executeProject({
        kind: "ensure-default-project",
        projectId: decodeProjectId(crypto.randomUUID()),
        expectedVersion: 0 as AggregateVersion,
        projectType: type,
        hostId,
      });
      if (result.kind !== "default-project-ensured") return undefined;
      if (result.created) {
        await load("retry");
        if (!mounted.current) return undefined;
        announce(`${modeLabel(type)} Project created in the default folder.`);
      }
      return { projectId: result.project.id, name: result.project.name };
    } catch (error) {
      if (!mounted.current) return undefined;
      const message = failureMessage(error, PROJECT_UNAVAILABLE);
      setErrorMessage(message);
      announce(message);
      return undefined;
    }
  }

  async function rename(projectId: ProjectId, name: string): Promise<boolean> {
    const project = projectById.get(projectId);
    if (project === undefined) return false;
    return execute(
      { kind: "rename-project", projectId, expectedVersion: project.version, name },
      "Project renamed.",
    );
  }

  /** Set or clear (`null`) the Project's identity colour. */
  async function setColor(projectId: ProjectId, color: ProjectColor | null): Promise<boolean> {
    const project = projectById.get(projectId);
    if (project === undefined) return false;
    if ((project.color ?? null) === color) return true;
    return execute(
      { kind: "change-project-color", projectId, expectedVersion: project.version, color },
      color === null ? "Project colour cleared." : "Project colour updated.",
    );
  }

  async function move(
    projectId: ProjectId,
    pinned: boolean,
    beforeProjectId?: ProjectId,
    afterProjectId?: ProjectId,
  ): Promise<boolean> {
    const project = projectById.get(projectId);
    if (project === undefined) return false;
    return execute(
      {
        kind: "move-project",
        projectId,
        expectedVersion: project.version,
        pinned,
        ...(beforeProjectId === undefined ? {} : { beforeProjectId }),
        ...(afterProjectId === undefined ? {} : { afterProjectId }),
      },
      pinned ? "Project pinned." : "Project unpinned.",
    );
  }

  async function setArchived(projectId: ProjectId, archived: boolean): Promise<boolean> {
    const project = projectById.get(projectId);
    if (project === undefined) return false;
    return execute(
      {
        kind: "change-project-lifecycle",
        projectId,
        expectedVersion: project.version,
        lifecycle: archived ? "archived" : "active",
      },
      archived ? "Project archived." : "Project restored.",
    );
  }

  async function relink(projectId: ProjectId, receiptId: string): Promise<boolean> {
    const project = projectById.get(projectId);
    if (project === undefined || project.type === "chat") return false;
    return execute(
      {
        kind: "relink-project",
        projectId,
        expectedVersion: project.version,
        receiptId: decodeBindingReceiptId(receiptId),
      },
      "Project root relinked.",
    );
  }

  /**
   * Add the folder a picker receipt names to a Work or Code Project beside its
   * main folder. The host refuses the home folder, system and credential
   * folders, and any folder that overlaps one the Project already has.
   */
  async function addExtraFolder(projectId: ProjectId, receiptId: string): Promise<ProjectChange> {
    const project = projectById.get(projectId);
    if (project === undefined || project.type === "chat") {
      return { status: "refused", message: "Only a Work or Code Project can have extra folders." };
    }
    return executeReporting(
      {
        kind: "add-project-extra-folder",
        projectId,
        expectedVersion: project.version,
        receiptId: decodeBindingReceiptId(receiptId),
      },
      "Folder added to the Project.",
    );
  }

  async function removeExtraFolder(
    projectId: ProjectId,
    canonicalRoot: string,
  ): Promise<ProjectChange> {
    const project = projectById.get(projectId);
    if (project === undefined || project.type === "chat") {
      return { status: "refused", message: "Only a Work or Code Project can have extra folders." };
    }
    return executeReporting(
      {
        kind: "remove-project-extra-folder",
        projectId,
        expectedVersion: project.version,
        canonicalRoot,
      },
      "Folder removed from the Project.",
    );
  }

  async function search(query: string): Promise<void> {
    const request = ++searchGeneration.current;
    const normalized = query.trim();
    setSearchResults([]);
    setSearchErrorMessage(undefined);
    if (normalized === "") {
      setSearchStatus("idle");
      announce("");
      return;
    }
    setSearchStatus("searching");
    try {
      const results = await fallbackClient.search(normalized);
      if (!mounted.current || request !== searchGeneration.current) return;
      setSearchResults(results);
      setSearchStatus("success");
    } catch {
      if (!mounted.current || request !== searchGeneration.current) return;
      setSearchStatus("error");
      setSearchErrorMessage("Project search is unavailable. Try again or enter a new query.");
    }
  }

  async function executeMemory(
    command: MemoryCommand,
    successMessage: string,
    visibleProjectId: ProjectId,
    lockAlreadyHeld = false,
    disclosureGeneration = memoryDisclosureGeneration.current,
  ): Promise<boolean> {
    if (!lockAlreadyHeld) {
      if (memoryOperation.current) return false;
      memoryOperation.current = true;
      setMemoryBusy(true);
    }
    setMemoryErrorMessage(undefined);
    try {
      await fallbackClient.executeMemory(command);
      if (disclosureGeneration !== memoryDisclosureGeneration.current) return true;
      await loadMemory(visibleProjectId, "refresh");
      if (!mounted.current || disclosureGeneration !== memoryDisclosureGeneration.current)
        return true;
      announce(successMessage);
      return true;
    } catch (error) {
      if (!mounted.current || disclosureGeneration !== memoryDisclosureGeneration.current)
        return false;
      if (failureCategory(error) === "conflict") {
        await loadMemory(visibleProjectId, "conflict");
        return false;
      }
      const message = failureMessage(error, PROJECT_UNAVAILABLE);
      setMemoryErrorMessage(message);
      announce(message);
      return false;
    } finally {
      memoryOperation.current = false;
      if (mounted.current) setMemoryBusy(false);
    }
  }

  async function createMemory(kind: MemoryKind, content: string): Promise<boolean> {
    if (memory === undefined) return false;
    return executeMemory(
      {
        kind: "create-memory-entry",
        projectId: memory.projectId,
        entryId: decodeMemoryEntryId(crypto.randomUUID()),
        memoryKind: kind,
        content,
        expectedVersion: memoryVersion(memory),
      },
      "Project memory added.",
      memory.projectId,
    );
  }

  async function supersedeMemory(entryId: MemoryEntryId, content: string): Promise<boolean> {
    if (memory === undefined) return false;
    return executeMemory(
      {
        kind: "supersede-memory-entry",
        projectId: memory.projectId,
        entryId,
        successorEntryId: decodeMemoryEntryId(crypto.randomUUID()),
        content,
        expectedVersion: memoryVersion(memory),
      },
      "Project memory replaced with an audited successor.",
      memory.projectId,
    );
  }

  async function retractMemory(entryId: MemoryEntryId, reason: string): Promise<boolean> {
    if (memory === undefined) return false;
    return executeMemory(
      {
        kind: "retract-memory-entry",
        projectId: memory.projectId,
        entryId,
        reason,
        expectedVersion: memoryVersion(memory),
      },
      "Project memory retracted.",
      memory.projectId,
    );
  }

  async function transferMemory(
    sourceEntryId: MemoryEntryId,
    destinationProjectId: ProjectId,
  ): Promise<boolean> {
    if (memory === undefined) return false;
    if (memoryOperation.current) return false;
    const sourceProjectId = memory.projectId;
    const disclosureGeneration = memoryDisclosureGeneration.current;
    memoryOperation.current = true;
    setMemoryBusy(true);
    let destinationMemory: ProjectMemoryView;
    try {
      destinationMemory = await fallbackClient.memory(destinationProjectId);
    } catch (error) {
      if (mounted.current && disclosureGeneration === memoryDisclosureGeneration.current) {
        const message = failureMessage(error, PROJECT_UNAVAILABLE);
        setMemoryErrorMessage(message);
        announce(message);
      }
      memoryOperation.current = false;
      if (mounted.current) setMemoryBusy(false);
      return false;
    }
    if (
      !mounted.current ||
      disclosureGeneration !== memoryDisclosureGeneration.current ||
      memoryOwnerProjectId.current !== sourceProjectId
    ) {
      memoryOperation.current = false;
      if (mounted.current) setMemoryBusy(false);
      return false;
    }
    return executeMemory(
      {
        kind: "transfer-memory-entry",
        sourceProjectId,
        sourceEntryId,
        destinationProjectId,
        destinationEntryId: decodeMemoryEntryId(crypto.randomUUID()),
        expectedVersion: memoryVersion(destinationMemory),
      },
      "Project memory transferred with provenance.",
      sourceProjectId,
      true,
      disclosureGeneration,
    );
  }

  const projects = useMemo(
    () => state.active.filter((project) => project.type === options.activeMode),
    [options.activeMode, state.active],
  );
  const archivedProjects = useMemo(
    () => state.archived.filter((project) => project.type === options.activeMode),
    [options.activeMode, state.archived],
  );
  const activeProject =
    options.activeProjectId === undefined ? undefined : projectById.get(options.activeProjectId);
  const availabilityByProject = useMemo(
    () => new Map(state.availability.map((availability) => [availability.projectId, availability])),
    [state.availability],
  );

  return {
    activeProject,
    allProjects,
    announcement: announcement.message,
    announcementSequence: announcement.sequence,
    archivedProjects,
    availabilityByProject,
    client: fallbackClient,
    create,
    ensureDefault,
    createMemory,
    clearMemory,
    errorMessage,
    move,
    memory,
    memoryBusy,
    memoryErrorMessage,
    memoryRevision,
    memoryStatus,
    projects,
    refreshAvailability: () => load("refresh"),
    relink,
    addExtraFolder,
    removeExtraFolder,
    rename,
    retry: () => load("retry"),
    retryMemory: loadMemory,
    touchMemoryRevision: advanceMemoryRevision,
    search,
    searchErrorMessage,
    searchResults,
    searchStatus,
    setCodeAccessPersistence,
    setColor,
    setCodeNewThreadWorkspace,
    setCodePermissionMode,
    setCodeAutoReviewer,
    setCodePullRequestBackgroundRefresh,
    setCodeAgentMerge,
    setProviderPolicy,
    setNativeProviders,
    setBrandKit,
    setDesktopRecipe,
    setActions,
    setWorkStatusFile,
    setWorkDeveloperTools,
    setArchived,
    status,
    supersedeMemory,
    retractMemory,
    transferMemory,
    loadMemory,
  };
}

function memoryVersion(view: ProjectMemoryView): AggregateVersion {
  return Math.max(
    0,
    ...view.active.map((entry) => entry.version),
    ...view.history.map((entry) => entry.version),
  ) as AggregateVersion;
}

function required(value: string | undefined): string {
  if (value === undefined || value.trim() === "") {
    throw new Error("Octant Project authority is unavailable.");
  }
  return value;
}

function failureCategory(error: unknown): string {
  return typeof error === "object" && error !== null && "category" in error
    ? String(error.category)
    : "unavailable";
}

function modeLabel(type: ProjectType): string {
  return type === "chat" ? "Chat" : type === "work" ? "Work" : "Code";
}
