import type { ThreadBoardPullRequestSummaries } from "@octant/contracts";
import type { OctantMode } from "@octant/contracts/modes";
import type {
  SidebarDestinationCustomization,
  SidebarDestinationId,
} from "@octant/contracts/shell";

export type NavigationAvailability = "available" | "disabled" | "unavailable" | "unauthorized";

/**
 * Destinations the sidebar can offer.
 *
 * Every id here renders somewhere. Three earlier ones did not: `search` is an
 * icon in the mode switcher rather than a list row, and `threads` and
 * `recent-chats` both described flat thread lists that `ProjectSidebarSection`
 * already renders nested under Projects — emitting either would have shown the
 * same threads twice. A model that describes rows the shell refuses to build
 * reads as a missing feature to whoever finds it next.
 */
export type SidebarNavigationDescriptorId =
  | "new-chat"
  | "new-work-thread"
  | "new-code-thread"
  | "agents"
  | "automations"
  | "artifact-library"
  | "image-library"
  | "plugins"
  | "inbox"
  | "thread-board"
  | "pull-requests"
  | "github-issues"
  | "linear-issues"
  | "projects";

export type SidebarAppMenuDescriptorId =
  | "agents"
  | "automations"
  | "artifact-library"
  | "image-library"
  | "plugins";

export interface SidebarNavigationDescriptor {
  readonly id: SidebarNavigationDescriptorId;
  readonly label: string;
}

export interface SidebarNavigationInput {
  readonly activeMode: OctantMode;
  readonly createThread: NavigationAvailability;
  /**
   * The Inbox converges what already waits on the user — blocked and finished
   * threads, plus assigned GitHub and Linear work where those reads are
   * connected. It renders in every mode because an agent blocked in one mode
   * still needs the user who is working in another.
   */
  readonly inbox: NavigationAvailability;
  readonly projects: NavigationAvailability;
  readonly threadBoard: NavigationAvailability;
  readonly pullRequests: NavigationAvailability;
  readonly githubIssues: NavigationAvailability;
  readonly linearIssues: NavigationAvailability;
  readonly plugins: NavigationAvailability;
  readonly automationsEnabled: boolean;
  readonly agentsCenterEnabled: boolean;
  readonly artifactLibrary: NavigationAvailability;
  /** Absent on hosts that serve no image generation. */
  readonly imageLibrary?: NavigationAvailability;
}

export interface ChatThreadNavigationSource {
  readonly executing?: boolean;
  readonly followUpOpen?: boolean;
  readonly lastSequence?: number;
  /**
   * The visible thread this one was forked or branched from. Absent when the
   * thread started on its own. The id is the host's thread id, not a pane or
   * navigation identity.
   */
  readonly lineageParentThreadId?: string;
  readonly projectId?: string;
  /** Provider identity carried from the host navigation projection. */
  readonly providerInstanceId?: string;
  readonly readSequence: number;
  readonly threadId: string;
  readonly title: string;
  readonly updatedAt?: string;
  /** Completed and snoozed rest carried from the host's thread record. */
  readonly completedAt?: string | undefined;
  readonly snooze?: ChatThreadNavigationItem["snooze"] | undefined;
}

/**
 * Which provider answers for a thread, resolved from its provider instance.
 *
 * The row shows the mark rather than the model name: the model changes inside a
 * thread and reads as noise on every row, while the provider is what a reader
 * scanning the list is actually distinguishing between.
 */
export interface ThreadProviderIdentity {
  readonly displayName: string;
  readonly driverKind: string;
}

/**
 * What a thread row's status dot says, in the vocabulary the thread board
 * already uses.
 *
 * `working` is claimed only while the host projects the thread as executing —
 * the same run-state signal board reasons derive from. When that settles, the
 * row falls back to follow-up, unread, or idle.
 */
export type ThreadRowActivity = "working" | "attention" | "unread" | "idle";

/**
 * Compact checkout identity for a Code row bound to its own worktree. Absent
 * for the Project's default checkout so those rows stay quiet.
 */
export interface ThreadCheckoutChip {
  readonly checkoutKind: "managed-worktree";
  readonly label: string;
}

export interface ChatThreadNavigationItem {
  /** Absent leaves the row's dot idle rather than inventing a state. */
  readonly activity?: ThreadRowActivity;
  /** Present when the host projected a non-default Code checkout for this row. */
  readonly checkoutChip?: ThreadCheckoutChip;
  readonly followUp?: boolean;
  /**
   * The visible thread this one was forked or branched from. Absent when the
   * thread started on its own. Work threads never carry this: they have no
   * fork provenance.
   */
  readonly lineageParentThreadId?: string;
  readonly meta?: string;
  readonly provider?: ThreadProviderIdentity;
  /** The provider instance the thread runs on, before it is resolved to a mark. */
  readonly providerInstanceId?: string;
  readonly navigationId?: string;
  readonly projectId?: string;
  /**
   * The exact linked pull requests the host joined for a Code row, from its
   * cached snapshot. Absent when there are none, when GitHub authority is
   * gone, or on Chat and Work rows: a Work thread has no authoritative link to
   * the Code thread that carries its pull request, so it shows none rather
   * than a guess — the same closed door the Work board keeps.
   */
  readonly pullRequests?: ThreadBoardPullRequestSummaries;
  readonly threadId: string;
  readonly title: string;
  readonly unread?: boolean;
  /** Whether the user pinned this thread to the top of the sidebar. */
  readonly pinned?: boolean;
  readonly updatedAt?: string;
  /** When the person completed the thread. Absent while it is in play. */
  readonly completedAt?: string;
  /** The thread's snooze as the host recorded it. Absent while it is awake. */
  readonly snooze?: {
    readonly until: string;
    readonly at: string;
    readonly duringTurn?: boolean | undefined;
  };
  /** Where the sidebar files the row now. Absent means the active list. */
  readonly shelf?: "snoozed" | "completed";
  /**
   * The snooze ended — its time passed, or the thread needed the person —
   * but the record still carries it. The row says so until the thread is
   * opened, because it reappears where it was rather than at the top.
   */
  readonly woke?: boolean;
  /** Compact time until a snoozed row wakes, such as "2h" or "3d". */
  readonly wakeLabel?: string;
}

/** The same activity precedence applies in the Project tree and Activity view. */
export function threadRowActivity(thread: ChatThreadNavigationItem): ThreadRowActivity {
  if (thread.activity !== undefined) return thread.activity;
  if (thread.followUp === true) return "attention";
  if (thread.unread === true) return "unread";
  return "idle";
}

export function buildChatThreadNavigation(
  threads: ReadonlyArray<ChatThreadNavigationSource>,
): ReadonlyArray<ChatThreadNavigationItem> {
  return threads.map((thread) => ({
    ...(thread.executing === true ? { activity: "working" as const } : {}),
    ...(thread.followUpOpen === undefined ? {} : { followUp: thread.followUpOpen }),
    ...(thread.lineageParentThreadId === undefined
      ? {}
      : { lineageParentThreadId: thread.lineageParentThreadId }),
    ...(thread.projectId === undefined ? {} : { projectId: thread.projectId }),
    ...(thread.providerInstanceId === undefined
      ? {}
      : { providerInstanceId: thread.providerInstanceId }),
    threadId: thread.threadId,
    title: thread.title,
    ...(thread.lastSequence === undefined
      ? {}
      : { unread: thread.lastSequence > thread.readSequence }),
    ...(thread.updatedAt === undefined ? {} : { updatedAt: thread.updatedAt }),
    ...(thread.completedAt === undefined ? {} : { completedAt: thread.completedAt }),
    ...(thread.snooze === undefined ? {} : { snooze: thread.snooze }),
  }));
}

const descriptors = {
  "new-chat": { id: "new-chat", label: "New chat" },
  "new-work-thread": { id: "new-work-thread", label: "New task" },
  "new-code-thread": { id: "new-code-thread", label: "New task" },
  inbox: { id: "inbox", label: "Inbox" },
  automations: { id: "automations", label: "Automations" },
  agents: { id: "agents", label: "Agents" },
  "artifact-library": { id: "artifact-library", label: "Artifacts" },
  "image-library": { id: "image-library", label: "Image generator" },
  plugins: { id: "plugins", label: "Plugins" },
  "thread-board": { id: "thread-board", label: "Board" },
  "pull-requests": { id: "pull-requests", label: "Pull requests" },
  "github-issues": { id: "github-issues", label: "Issues" },
  "linear-issues": { id: "linear-issues", label: "Linear" },
  projects: { id: "projects", label: "Projects" },
} as const satisfies Record<SidebarNavigationDescriptorId, SidebarNavigationDescriptor>;

export function buildSidebarNavigation(
  input: SidebarNavigationInput,
): ReadonlyArray<SidebarNavigationDescriptor> {
  switch (input.activeMode) {
    case "chat":
      return [
        ...(input.createThread === "available" ? [descriptors["new-chat"]] : []),
        ...(input.inbox === "available" ? [descriptors.inbox] : []),
        ...(input.projects === "available" ? [descriptors.projects] : []),
      ];
    case "work":
      return [
        ...(input.createThread === "available" ? [descriptors["new-work-thread"]] : []),
        ...(input.inbox === "available" ? [descriptors.inbox] : []),
        ...(input.threadBoard === "available" ? [descriptors["thread-board"]] : []),
        ...(input.projects === "available" ? [descriptors.projects] : []),
      ];
    case "code":
      return [
        ...(input.createThread === "available" ? [descriptors["new-code-thread"]] : []),
        ...(input.inbox === "available" ? [descriptors.inbox] : []),
        ...(input.threadBoard === "available" ? [descriptors["thread-board"]] : []),
        ...(input.githubIssues === "available" ? [descriptors["github-issues"]] : []),
        ...(input.pullRequests === "available" ? [descriptors["pull-requests"]] : []),
        ...(input.linearIssues === "available" ? [descriptors["linear-issues"]] : []),
        ...(input.projects === "available" ? [descriptors.projects] : []),
      ];
  }
}

/**
 * Low-frequency destinations stay available without competing with the active
 * thread and Project tree. The profile menu is host-wide, while availability
 * remains mode-aware and fail-closed through the same input as primary nav.
 */
export function buildSidebarAppMenu(
  input: SidebarNavigationInput,
): ReadonlyArray<SidebarNavigationDescriptor & { readonly id: SidebarAppMenuDescriptorId }> {
  return [
    ...(input.agentsCenterEnabled ? [descriptors.agents] : []),
    ...(input.activeMode !== "chat" && input.automationsEnabled ? [descriptors.automations] : []),
    ...(input.artifactLibrary === "available" ? [descriptors["artifact-library"]] : []),
    ...(input.imageLibrary === "available" ? [descriptors["image-library"]] : []),
    ...(input.plugins === "available" ? [descriptors.plugins] : []),
  ];
}

export function sidebarNavigationDescriptor(
  id: SidebarNavigationDescriptorId,
): SidebarNavigationDescriptor {
  return descriptors[id];
}

/**
 * Where a destination lives when the shell is untouched. Primary destinations
 * render as rows until the person hides them; workspace destinations stay in
 * the account menu until the person promotes them.
 */
export type SidebarDestinationPlacement = "primary" | "menu";

export interface SidebarDestination {
  readonly id: SidebarDestinationId;
  readonly label: string;
  readonly placement: SidebarDestinationPlacement;
}

/**
 * Every destination a person can arrange, in the shell's canonical order.
 * Named for what the person wants ("New thread") rather than the per-mode row
 * that renders it, so one customization covers Chat, Work, and Code.
 */
export const SIDEBAR_DESTINATIONS: ReadonlyArray<SidebarDestination> = [
  { id: "new-thread", label: "New thread", placement: "primary" },
  { id: "inbox", label: "Inbox", placement: "primary" },
  { id: "board", label: "Board", placement: "primary" },
  { id: "github-issues", label: "Issues", placement: "primary" },
  { id: "pull-requests", label: "Pull requests", placement: "primary" },
  { id: "linear-issues", label: "Linear", placement: "primary" },
  { id: "projects", label: "Projects", placement: "primary" },
  { id: "agents", label: "Agents", placement: "menu" },
  { id: "automations", label: "Automations", placement: "menu" },
  { id: "artifact-library", label: "Artifacts", placement: "menu" },
  { id: "image-library", label: "Image generator", placement: "menu" },
  { id: "plugins", label: "Plugins", placement: "menu" },
];

/**
 * Effective placement a reader of the sidebar sees. "Menu" is the untouched
 * home of a workspace destination; it is never persisted, because a primary
 * destination has no menu to return to.
 */
export type SidebarDestinationPlacementVisibility = "shown" | "hidden" | "menu";

const destinationsById = new Map(
  SIDEBAR_DESTINATIONS.map((destination) => [destination.id, destination]),
);

function defaultPlacement(id: SidebarDestinationId): SidebarDestinationPlacement {
  return destinationsById.get(id)?.placement ?? "primary";
}

/** Destinations in the requested order, followed by unlisted ones canonically. */
export function sidebarDestinationOrder(
  customization: SidebarDestinationCustomization,
): ReadonlyArray<SidebarDestination> {
  const listed = customization.order
    .map((id) => destinationsById.get(id))
    .filter((destination): destination is SidebarDestination => destination !== undefined);
  const listedIds = new Set(customization.order);
  return [
    ...listed,
    ...SIDEBAR_DESTINATIONS.filter((destination) => !listedIds.has(destination.id)),
  ];
}

export function sidebarDestinationVisibility(
  customization: SidebarDestinationCustomization,
  id: SidebarDestinationId,
): SidebarDestinationPlacementVisibility {
  const entry = customization.visibility.find((candidate) => candidate.id === id);
  if (entry !== undefined) return entry.visibility;
  return defaultPlacement(id) === "menu" ? "menu" : "shown";
}

/**
 * Records only deviations from the untouched shell: a primary destination is
 * shown until hidden, and a workspace destination is in the menu until
 * promoted. Returning to the default removes the stored entry entirely.
 */
export function setSidebarDestinationVisibility(
  customization: SidebarDestinationCustomization,
  id: SidebarDestinationId,
  visibility: SidebarDestinationPlacementVisibility,
): SidebarDestinationCustomization {
  const rest = customization.visibility.filter((entry) => entry.id !== id);
  const defaultVisibility = defaultPlacement(id) === "menu" ? "menu" : "shown";
  if (visibility === defaultVisibility || visibility === "menu") {
    return { ...customization, visibility: rest };
  }
  return { ...customization, visibility: [...rest, { id, visibility }] };
}

/**
 * Swaps a destination past its neighbour in the effective order and persists
 * the whole order, so the move stays put even as destinations gain defaults.
 */
export function moveSidebarDestination(
  customization: SidebarDestinationCustomization,
  id: SidebarDestinationId,
  direction: "up" | "down",
): SidebarDestinationCustomization {
  const order = sidebarDestinationOrder(customization).map((destination) => destination.id);
  const index = order.indexOf(id);
  const target = direction === "up" ? index - 1 : index + 1;
  if (index === -1 || target < 0 || target >= order.length) return customization;
  const current = order[index];
  const neighbour = order[target];
  if (current === undefined || neighbour === undefined) return customization;
  const swapped = [...order];
  swapped[index] = neighbour;
  swapped[target] = current;
  return { ...customization, order: trimCanonicalSuffix(swapped) };
}

/**
 * A trailing stretch already in canonical order says nothing the shell does
 * not know, so it is left unstored: the record keeps only the prefix that
 * actually carries the person's arrangement.
 */
function trimCanonicalSuffix(order: ReadonlyArray<SidebarDestinationId>): SidebarDestinationId[] {
  const trimmed = [...order];
  while (
    trimmed.length > 0 &&
    trimmed[trimmed.length - 1] === SIDEBAR_DESTINATIONS[trimmed.length - 1]?.id
  ) {
    trimmed.pop();
  }
  return trimmed;
}

export interface SidebarDestinationLayout {
  readonly rows: ReadonlyArray<SidebarNavigationDescriptorId>;
  readonly menu: ReadonlyArray<
    SidebarNavigationDescriptor & { readonly id: SidebarAppMenuDescriptorId }
  >;
}

function destinationRowId(
  id: SidebarDestinationId,
  activeMode: OctantMode,
): SidebarNavigationDescriptorId {
  switch (id) {
    case "new-thread":
      return activeMode === "chat"
        ? "new-chat"
        : activeMode === "work"
          ? "new-work-thread"
          : "new-code-thread";
    case "inbox":
      return "inbox";
    case "board":
      return "thread-board";
    case "pull-requests":
      return "pull-requests";
    case "github-issues":
      return "github-issues";
    case "linear-issues":
      return "linear-issues";
    case "projects":
      return "projects";
    case "agents":
      return "agents";
    case "automations":
      return "automations";
    case "artifact-library":
      return "artifact-library";
    case "image-library":
      return "image-library";
    case "plugins":
      return "plugins";
  }
}

function menuDestinationRowId(id: SidebarDestinationId): SidebarAppMenuDescriptorId | undefined {
  switch (id) {
    case "agents":
      return "agents";
    case "automations":
      return "automations";
    case "artifact-library":
      return "artifact-library";
    case "image-library":
      return "image-library";
    case "plugins":
      return "plugins";
    default:
      return undefined;
  }
}

/**
 * Resolves the person's customization against what this host can offer right
 * now: a hidden destination is gone from rows and menu alike, a promoted one
 * renders as a row only where the host serves it, and an unavailable
 * destination stays absent no matter what was requested.
 */
export function layoutSidebarDestinations({
  activeMode,
  input,
  customization,
}: {
  readonly activeMode: OctantMode;
  readonly input: SidebarNavigationInput;
  readonly customization: SidebarDestinationCustomization;
}): SidebarDestinationLayout {
  const availableRows = new Set(buildSidebarNavigation(input).map((row) => row.id));
  const availableMenu = new Map(
    buildSidebarAppMenu(input).map((descriptor) => [descriptor.id, descriptor] as const),
  );
  const rows: SidebarNavigationDescriptorId[] = [];
  const menu: Array<SidebarNavigationDescriptor & { readonly id: SidebarAppMenuDescriptorId }> = [];
  for (const destination of sidebarDestinationOrder(customization)) {
    const visibility = sidebarDestinationVisibility(customization, destination.id);
    if (visibility === "hidden") continue;
    const menuId = menuDestinationRowId(destination.id);
    if (menuId !== undefined) {
      const descriptor = availableMenu.get(menuId);
      if (descriptor !== undefined) {
        if (visibility === "menu") menu.push(descriptor);
        else rows.push(descriptor.id);
      }
      continue;
    }
    const rowId = destinationRowId(destination.id, activeMode);
    if (availableRows.has(rowId)) rows.push(rowId);
  }
  return { rows, menu };
}
