import type { OctantMode } from "@octant/contracts/modes";
import type { ProjectThreadsAccess } from "../projects/ProjectThreadsSection";
import type { ChatThreadNavigationItem, ThreadRowActivity } from "./navigationModel";
import type { ThreadSearchListingStatus } from "./ThreadSearchOverlay";

/**
 * What a Code thread's status dot says.
 *
 * A host-projected executing turn lights `working` first: that is the live
 * claim the board reasons from. An open follow-up or waiting/interrupted
 * lifecycle outranks unread when the turn has settled. Idle is the rest.
 */
export function codeThreadActivity(thread: {
  readonly executing?: boolean;
  readonly followUp?: boolean;
  readonly lifecycle: "active" | "waiting" | "interrupted" | "archived";
  readonly unread?: boolean;
}): ThreadRowActivity {
  if (thread.executing === true) return "working";
  if (thread.followUp === true) return "attention";
  if (thread.lifecycle === "waiting" || thread.lifecycle === "interrupted") return "attention";
  if (thread.unread === true) return "unread";
  return "idle";
}

export function threadSearchListingForStatus(
  status: "ready" | "loading" | string,
): ThreadSearchListingStatus {
  return status === "ready" ? "ready" : status === "loading" ? "loading" : "unavailable";
}

export function threadSearchArchivedListingForStatus(
  status: "loading" | "unavailable" | string,
): ThreadSearchListingStatus {
  return status === "loading" ? "loading" : status === "unavailable" ? "unavailable" : "ready";
}

/** Message-body search status; `idle` means nothing was asked yet. */
export function threadSearchContentListingForStatus(
  status: "idle" | "loading" | "ready" | "unavailable" | string,
): ThreadSearchListingStatus {
  return status === "loading"
    ? "loading"
    : status === "unavailable"
      ? "unavailable"
      : "ready";
}

export function projectThreadsAccessForMode(input: {
  readonly activeMode: OctantMode;
  readonly chat: {
    readonly status: string;
    readonly errorMessage?: string;
    readonly onRetry: () => void;
    readonly onSelectThread: (threadId: string) => void;
    readonly threads: ReadonlyArray<ChatThreadNavigationItem>;
  };
  readonly code: {
    readonly status: string;
    readonly errorMessage?: string;
    readonly onRetry: () => void;
    readonly onSelectThread: (navigationId: string) => void;
    readonly threads: ReadonlyArray<ChatThreadNavigationItem>;
  };
  readonly work: {
    readonly status: string;
    readonly errorMessage?: string;
    readonly onRetry: () => void;
    readonly onSelectThread: (navigationId: string) => void;
    readonly threads: ReadonlyArray<ChatThreadNavigationItem>;
  };
}): ProjectThreadsAccess {
  if (input.activeMode === "chat") {
    return {
      ...(input.chat.status === "disconnected" && input.chat.errorMessage !== undefined
        ? { errorMessage: input.chat.errorMessage }
        : {}),
      onRetry: input.chat.onRetry,
      onSelectThread: input.chat.onSelectThread,
      status:
        input.chat.status === "ready"
          ? "ready"
          : input.chat.status === "disconnected"
            ? "unavailable"
            : "loading",
      threads: input.chat.threads,
    };
  }
  if (input.activeMode === "code") {
    return {
      ...(input.code.status === "disconnected" && input.code.errorMessage !== undefined
        ? { errorMessage: input.code.errorMessage }
        : {}),
      onRetry: input.code.onRetry,
      onSelectThread: input.code.onSelectThread,
      status:
        input.code.status === "disconnected"
          ? "unavailable"
          : input.code.status === "ready"
            ? "ready"
            : "loading",
      threads: input.code.threads,
    };
  }
  return {
    ...(input.work.status === "unavailable" && input.work.errorMessage !== undefined
      ? { errorMessage: input.work.errorMessage }
      : {}),
    onRetry: input.work.onRetry,
    onSelectThread: input.work.onSelectThread,
    status:
      input.work.status === "unavailable"
        ? "unavailable"
        : input.work.status === "ready"
          ? "ready"
          : "loading",
    threads: input.work.threads,
  };
}

export function sidebarThreadGroupsForMode(input: {
  readonly activeMode: OctantMode;
  readonly codeThreads: ReadonlyArray<ChatThreadNavigationItem>;
  readonly workThreads: ReadonlyArray<ChatThreadNavigationItem>;
}):
  | {
      readonly recents: ReadonlyArray<ChatThreadNavigationItem>;
      readonly all: ReadonlyArray<ChatThreadNavigationItem>;
      readonly unfiled: ReadonlyArray<ChatThreadNavigationItem>;
    }
  | undefined {
  if (input.activeMode === "code") {
    return { recents: input.codeThreads, all: input.codeThreads, unfiled: [] };
  }
  if (input.activeMode === "work") {
    return { recents: input.workThreads, all: input.workThreads, unfiled: [] };
  }
  return undefined;
}
