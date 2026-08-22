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
} from "@octant/contracts/projects";
import type { AggregateVersion } from "@octant/contracts/events";
import { LOCAL_HOST_ID, type HostId } from "@octant/contracts/host";
import { createProjectClient, type ProjectClient } from "@octant/client-runtime/project-client";
import type { OctantMode } from "@octant/contracts/modes";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";

export type ProjectControllerStatus = "loading" | "ready" | "disconnected" | "conflict-reload";
export type ProjectSearchStatus = "idle" | "searching" | "success" | "error";
export type ProjectMemoryStatus = "idle" | "loading" | "ready" | "error" | "conflict-reload";

export interface ProjectControllerOptions {
  readonly activeMode: OctantMode;
  readonly activeProjectId?: ProjectId;
  readonly client?: ProjectClient;
  readonly serverUrl?: string;
  readonly windowCapability?: string;
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
    async (reason: "bootstrap" | "retry" | "refresh" | "conflict" = "retry") => {
      const request = ++generation.current;
      setStatus(reason === "conflict" ? "conflict-reload" : "loading");
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
        setStatus("disconnected");
        setErrorMessage(failureMessage(error));
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
        setMemoryErrorMessage(failureMessage(error));
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

  const allProjects = [...state.active, ...state.archived];
  const projectById = new Map(allProjects.map((project) => [project.id, project]));

  async function execute(
    command: Parameters<ProjectClient["executeProject"]>[0],
    successMessage: string,
  ): Promise<boolean> {
    setErrorMessage(undefined);
    try {
      await fallbackClient.executeProject(command);
      await load("retry");
      if (!mounted.current) return false;
      announce(successMessage);
      return true;
    } catch (error) {
      if (!mounted.current) return false;
      if (failureCategory(error) === "conflict") {
        await load("conflict");
        return false;
      }
      const message = failureMessage(error);
      setErrorMessage(message);
      announce(message);
      return false;
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

  async function create(
    type: ProjectType,
    name: string,
    receiptId?: string,
    hostId: HostId = LOCAL_HOST_ID,
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
      };
    }
    return (await execute(command, `${modeLabel(type)} Project created.`)) ? projectId : undefined;
  }

  async function rename(projectId: ProjectId, name: string): Promise<boolean> {
    const project = projectById.get(projectId);
    if (project === undefined) return false;
    return execute(
      { kind: "rename-project", projectId, expectedVersion: project.version, name },
      "Project renamed.",
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
      const message = failureMessage(error);
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
        const message = failureMessage(error);
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

  const projects = state.active.filter((project) => project.type === options.activeMode);
  const archivedProjects = state.archived.filter((project) => project.type === options.activeMode);
  const activeProject =
    options.activeProjectId === undefined ? undefined : projectById.get(options.activeProjectId);
  const availabilityByProject = new Map(
    state.availability.map((availability) => [availability.projectId, availability]),
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
    rename,
    retry: () => load("retry"),
    retryMemory: loadMemory,
    touchMemoryRevision: advanceMemoryRevision,
    search,
    searchErrorMessage,
    searchResults,
    searchStatus,
    setCodeAccessPersistence,
    setCodeNewThreadWorkspace,
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

function failureMessage(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
    ? error.message
    : "Octant Project service is unavailable.";
}

function modeLabel(type: ProjectType): string {
  return type === "chat" ? "Chat" : type === "work" ? "Work" : "Code";
}
