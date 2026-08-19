import type { OctantMode } from "@octant/contracts/modes";

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
  | "automations"
  | "artifact-library"
  | "plugins"
  | "thread-board"
  | "pull-requests"
  | "projects";

export interface SidebarNavigationDescriptor {
  readonly id: SidebarNavigationDescriptorId;
  readonly label: string;
}

export interface SidebarNavigationInput {
  readonly activeMode: OctantMode;
  readonly createThread: NavigationAvailability;
  readonly projects: NavigationAvailability;
  readonly threadBoard: NavigationAvailability;
  readonly pullRequests: NavigationAvailability;
  readonly plugins: NavigationAvailability;
  readonly automationsEnabled: boolean;
  readonly artifactLibrary: NavigationAvailability;
}

export interface ChatThreadNavigationSource {
  readonly followUpOpen?: boolean;
  readonly lastSequence?: number;
  readonly projectId?: string;
  readonly readSequence: number;
  readonly threadId: string;
  readonly title: string;
  readonly updatedAt?: string;
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
 * `working` is only claimed for a thread whose turn this window is actually
 * running: a dot that pulses on a thread nothing is doing would be a lie, and
 * the host reports no per-thread run state to the sidebar yet.
 */
export type ThreadRowActivity = "working" | "attention" | "unread" | "idle";

export interface ChatThreadNavigationItem {
  /** Absent leaves the row's dot idle rather than inventing a state. */
  readonly activity?: ThreadRowActivity;
  readonly followUp?: boolean;
  readonly meta?: string;
  readonly provider?: ThreadProviderIdentity;
  /** The provider instance the thread runs on, before it is resolved to a mark. */
  readonly providerInstanceId?: string;
  readonly navigationId?: string;
  readonly projectId?: string;
  readonly threadId: string;
  readonly title: string;
  readonly unread?: boolean;
  /** Whether the user pinned this thread to the top of the sidebar. */
  readonly pinned?: boolean;
  readonly updatedAt?: string;
}

export function buildChatThreadNavigation(
  threads: ReadonlyArray<ChatThreadNavigationSource>,
): ReadonlyArray<ChatThreadNavigationItem> {
  return threads.map((thread) => ({
    ...(thread.followUpOpen === undefined ? {} : { followUp: thread.followUpOpen }),
    ...(thread.projectId === undefined ? {} : { projectId: thread.projectId }),
    threadId: thread.threadId,
    title: thread.title,
    ...(thread.lastSequence === undefined
      ? {}
      : { unread: thread.lastSequence > thread.readSequence }),
    ...(thread.updatedAt === undefined ? {} : { updatedAt: thread.updatedAt }),
  }));
}

const descriptors = {
  "new-chat": { id: "new-chat", label: "New chat" },
  "new-work-thread": { id: "new-work-thread", label: "New thread" },
  "new-code-thread": { id: "new-code-thread", label: "New thread" },
  automations: { id: "automations", label: "Automations" },
  "artifact-library": { id: "artifact-library", label: "Artifacts" },
  plugins: { id: "plugins", label: "Plugins" },
  "thread-board": { id: "thread-board", label: "Thread board" },
  "pull-requests": { id: "pull-requests", label: "Pull requests" },
  projects: { id: "projects", label: "Projects" },
} as const satisfies Record<SidebarNavigationDescriptorId, SidebarNavigationDescriptor>;

export function buildSidebarNavigation(
  input: SidebarNavigationInput,
): ReadonlyArray<SidebarNavigationDescriptor> {
  const automations = input.automationsEnabled ? [descriptors.automations] : [];
  // Skills and plugins are installed once and apply wherever the active mode
  // allows them, so the destination belongs in every mode rather than only the
  // two work modes.
  const plugins = input.plugins === "available" ? [descriptors.plugins] : [];
  // Artifacts are made in every mode and the library gathers all of them, so
  // the destination belongs in every mode rather than only where Canvas is
  // most used. A mode-scoped library would be the per-Project inventory again.
  const artifacts = input.artifactLibrary === "available" ? [descriptors["artifact-library"]] : [];

  switch (input.activeMode) {
    case "chat":
      return [
        ...(input.createThread === "available" ? [descriptors["new-chat"]] : []),
        ...artifacts,
        ...plugins,
        ...(input.projects === "available" ? [descriptors.projects] : []),
      ];
    case "work":
      return [
        ...(input.createThread === "available" ? [descriptors["new-work-thread"]] : []),
        ...automations,
        ...artifacts,
        ...plugins,
        ...(input.threadBoard === "available" ? [descriptors["thread-board"]] : []),
        ...(input.projects === "available" ? [descriptors.projects] : []),
      ];
    case "code":
      return [
        ...(input.createThread === "available" ? [descriptors["new-code-thread"]] : []),
        ...automations,
        ...artifacts,
        ...plugins,
        ...(input.threadBoard === "available" ? [descriptors["thread-board"]] : []),
        ...(input.pullRequests === "available" ? [descriptors["pull-requests"]] : []),
        ...(input.projects === "available" ? [descriptors.projects] : []),
      ];
  }
}
