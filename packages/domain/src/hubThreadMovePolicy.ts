// Pure rules for moving a thread between hub members: whether a thread can
// move to a destination, whether a destination accepts a move, where Prepare
// to shut down starts each thread, and what a source does when it learns the
// destination's state after a lost answer or a restart. The server applies
// these; nothing here touches a network, a disk, or a journal.

import type {
  HostOwnerEntry,
  HubGrant,
  HubMemberId,
  HubRoster,
  OctantMode,
  PeerGrant,
  ProjectId,
  ShutdownChoice,
  ThreadMoveDestinationState,
  ThreadMoveFailureReason,
} from "@octant/contracts";
import { authorizeOwnerRequest } from "./hubAndSpokesPolicy";

const sameId = (left: { toString(): string }, right: { toString(): string }) =>
  String(left) === String(right);

/** What keeps a thread busy; any of these refuses a move unless the person picks Stop and move. */
export type ThreadActivity = "idle" | "running" | "waiting-on-person" | "child-running";

export type MovableThread = {
  readonly mode: OctantMode;
  readonly activity: ThreadActivity;
  /** A thread a peer delegated to this host belongs to that delegation and never moves. */
  readonly delegated: boolean;
  /** For Code: the remote URLs the thread's checkout has. */
  readonly repositoryRemotes: ReadonlyArray<string>;
};

/** A Project on the destination as the source reads it for the move sheet. */
export type DestinationProject = {
  readonly projectId: ProjectId;
  readonly mode: OctantMode;
  /** For Code: the remote URLs of the clone the Project is bound to. */
  readonly repositoryRemotes: ReadonlyArray<string>;
};

/** What the source knows about a destination before it asks for an unlock. */
export type DestinationReading = {
  readonly reachable: boolean;
  /** False when the destination's answer was the same-words refusal. */
  readonly acceptsMoves: boolean;
  /** Whether this device is on the destination's owner list. */
  readonly ownerThere: boolean;
  readonly projects: ReadonlyArray<DestinationProject>;
};

export type MoveEligibility =
  | {
      readonly status: "eligible";
      /** Empty for a Chat thread, which may move into no Project. */
      readonly projects: ReadonlyArray<DestinationProject>;
      /** True when the thread is busy and the move must wait for its turn or stop it. */
      readonly waitsForTurn: boolean;
    }
  | { readonly status: "cannot-move"; readonly reason: ThreadMoveFailureReason };

/**
 * Hosts whose repository paths are case-insensitive, so `Team/Repo` and
 * `team/repo` name one repository there. Every other host keeps the path's
 * case, because a self-hosted server may serve both as different repositories.
 */
const CASE_INSENSITIVE_HOSTS: ReadonlySet<string> = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
]);

/** A transport's own port, which a URL may spell out without naming another service. */
const DEFAULT_PORTS: Readonly<Record<string, string>> = {
  "ssh:": "22",
  "git:": "9418",
  "https:": "443",
  "http:": "80",
};

/**
 * Remote URLs name the same repository when they agree after the transport,
 * credentials, and the `.git` suffix are set aside, so an SSH clone and an
 * HTTPS clone of one repository match. A non-default port stays part of the
 * identity, since one host may serve different repositories on different
 * ports, and the path keeps its case except on hosts known to ignore it.
 */
export function normalizeRepositoryRemote(remote: string): string | undefined {
  const trimmed = remote.trim();
  if (trimmed.length === 0) return undefined;
  // A clone of a repository on the same disk names it by its path; the path
  // is the identity there, case and all.
  if (trimmed.startsWith("/") || trimmed.startsWith("file://")) {
    const path = trimCharacter(trimmed.replace(/^file:\/\//, ""), "/").replace(/\.git$/i, "");
    return path.length === 0 ? undefined : `file:/${path}`;
  }
  const scp = /^[^@/\s]+@([^:/\s]+):(.+)$/.exec(trimmed);
  let host: string;
  let port = "";
  let path: string;
  if (scp !== null && !trimmed.includes("://")) {
    host = scp[1] ?? "";
    path = scp[2] ?? "";
  } else {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return undefined;
    }
    host = url.hostname;
    port = url.port === DEFAULT_PORTS[url.protocol] ? "" : url.port;
    path = url.pathname;
  }
  const lowerHost = host.toLowerCase();
  const cleanPath = trimCharacter(path, "/").replace(/\.git$/i, "");
  if (lowerHost.length === 0 || cleanPath.length === 0) return undefined;
  const comparedPath = CASE_INSENSITIVE_HOSTS.has(lowerHost) ? cleanPath.toLowerCase() : cleanPath;
  return `${lowerHost}${port.length > 0 ? `:${port}` : ""}/${comparedPath}`;
}

function sharesRepository(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  const known = new Set(left.map(normalizeRepositoryRemote).filter((value) => value !== undefined));
  return right.some((remote) => {
    const normalized = normalizeRepositoryRemote(remote);
    return normalized !== undefined && known.has(normalized);
  });
}

/**
 * Whether one thread can move to one destination, and into which Projects.
 * Checked in the order the person can act on: a delegated thread never moves;
 * an unreachable or refusing destination is named before its Projects; a
 * busy thread is eligible but waits for its turn.
 */
export function decideMoveEligibility(input: {
  readonly thread: MovableThread;
  readonly destination: DestinationReading;
}): MoveEligibility {
  const { thread, destination } = input;
  if (thread.delegated) return { status: "cannot-move", reason: "delegated" };
  if (!destination.reachable) return { status: "cannot-move", reason: "destination-unreachable" };
  if (!destination.acceptsMoves) return { status: "cannot-move", reason: "refused" };
  if (!destination.ownerThere) return { status: "cannot-move", reason: "unlock-required" };
  const sameMode = destination.projects.filter((project) => project.mode === thread.mode);
  const projects =
    thread.mode === "code"
      ? sameMode.filter((project) =>
          sharesRepository(thread.repositoryRemotes, project.repositoryRemotes),
        )
      : sameMode;
  if (thread.mode !== "chat" && projects.length === 0) {
    return { status: "cannot-move", reason: "no-eligible-project" };
  }
  return { status: "eligible", projects, waitsForTurn: thread.activity !== "idle" };
}

export type MoveInAuthorization =
  | { readonly status: "allowed"; readonly owner: HostOwnerEntry }
  | { readonly status: "refused"; readonly reason: "refused" | "unlock-required" };

/**
 * Whether a destination accepts a move. The sending member needs the Move in
 * item on the peer grant this host gave it, and the request needs an owner
 * device on this host's own owner list with an own-class fresh unlock (an
 * administration session never covers a move). A missing grant item, Owners
 * unticked, a sender no longer in the roster, and a sender that is not an
 * owner all answer `refused` in the same words; only a missing or stale
 * unlock from a real owner answers `unlock-required`, so the owner can retry.
 */
export function authorizeMoveIn(input: {
  readonly host: "hub" | "spoke";
  readonly hubGrant: HubGrant | undefined;
  readonly roster: HubRoster;
  readonly grants: ReadonlyArray<PeerGrant>;
  readonly owners: ReadonlyArray<HostOwnerEntry>;
  readonly senderMemberId: HubMemberId;
  readonly ownerMemberId: HubMemberId;
  readonly ownerIdentityKeyFingerprint: string;
  readonly unlock: "fresh" | "session" | "absent";
}): MoveInAuthorization {
  const sender = input.roster.members.find((member) =>
    sameId(member.memberId, input.senderMemberId),
  );
  const grant = input.grants.find((entry) => sameId(entry.memberId, input.senderMemberId));
  if (sender === undefined || grant?.moveIn !== true) {
    return { status: "refused", reason: "refused" };
  }
  const owner = authorizeOwnerRequest({
    host: input.host,
    grant: input.hubGrant,
    owners: input.owners,
    roster: input.roster,
    memberId: input.ownerMemberId,
    identityKeyFingerprint: input.ownerIdentityKeyFingerprint,
    unlock: input.unlock,
    unlockClass: "own",
  });
  if (owner.status === "allowed") return { status: "allowed", owner: owner.entry };
  if (owner.kind === "unlock-required" || owner.kind === "own-unlock-required") {
    return { status: "refused", reason: "unlock-required" };
  }
  return { status: "refused", reason: "refused" };
}

/** A member as Prepare to shut down reads it when choosing the destination. */
export type ShutdownMember = {
  readonly memberId: HubMemberId;
  readonly role: "hub" | "standby-hub" | "spoke";
  readonly online: boolean;
  /** Whether it can take at least one listed thread. */
  readonly takesThreads: boolean;
};

/**
 * The destination Prepare to shut down starts on: the member the person last
 * moved a thread to, otherwise the hub when it can take threads, otherwise the
 * first eligible member that is online. Each must be able to take a thread.
 */
export function defaultShutdownDestination(input: {
  readonly lastMovedTo: HubMemberId | undefined;
  readonly members: ReadonlyArray<ShutdownMember>;
}): HubMemberId | undefined {
  const usable = input.members.filter((member) => member.takesThreads);
  const last = input.lastMovedTo;
  if (last !== undefined) {
    const remembered = usable.find((member) => sameId(member.memberId, last));
    if (remembered !== undefined) return remembered.memberId;
  }
  const hub = usable.find((member) => member.role === "hub");
  if (hub !== undefined) return hub.memberId;
  return usable.find((member) => member.online)?.memberId;
}

export type ShutdownRowStart = {
  readonly choice: ShutdownChoice;
  /** The choices the row's menu offers. */
  readonly offers: ReadonlyArray<ShutdownChoice>;
  /** The reason shown when the row cannot move. */
  readonly reason?: ThreadMoveFailureReason;
};

/**
 * The choice each row starts on. A thread that can move starts on Move, or on
 * Move after this turn when busy; one that cannot starts on Leave here with
 * its reason. A handover writes a commit and may push, and Stop and move ends
 * work, so neither is ever preselected.
 */
export function startingShutdownChoice(input: {
  readonly mode: OctantMode;
  readonly eligibility: MoveEligibility;
}): ShutdownRowStart {
  const handover: ReadonlyArray<ShutdownChoice> = input.mode === "code" ? ["hand-over"] : [];
  if (input.eligibility.status === "cannot-move") {
    return {
      choice: "leave-here",
      offers: [...handover, "leave-here"],
      reason: input.eligibility.reason,
    };
  }
  if (input.eligibility.waitsForTurn) {
    return {
      choice: "move-after-turn",
      offers: ["move-after-turn", "stop-and-move", ...handover, "leave-here"],
    };
  }
  return { choice: "move", offers: ["move", ...handover, "leave-here"] };
}

/** A thread as Prepare to shut down reads it when building its list. */
export type ShutdownCandidate = {
  readonly activity: ThreadActivity;
  readonly open: boolean;
  readonly lastTurnAt: number | undefined;
};

/** How long an open thread's last turn may be ago and still be listed by itself. */
export const SHUTDOWN_RECENT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Where a thread appears in Prepare to shut down: listed when it runs, waits
 * on the person, or is open with a turn in the last 14 days; folded under
 * Older threads when it is open but quieter; absent when it is completed or
 * archived.
 */
export function shutdownListing(input: {
  readonly thread: ShutdownCandidate;
  readonly now: number;
}): "listed" | "older" | "absent" {
  const { thread } = input;
  if (thread.activity !== "idle") return "listed";
  if (!thread.open) return "absent";
  if (
    thread.lastTurnAt !== undefined &&
    input.now - thread.lastTurnAt <= SHUTDOWN_RECENT_WINDOW_MS
  ) {
    return "listed";
  }
  return "older";
}

/** What a frozen source does after reading the destination's state for its move. */
export type SourceRecovery =
  | { readonly action: "erase" }
  | { readonly action: "commit" }
  | { readonly action: "resume-transfer" }
  | { readonly action: "unfreeze" };

/**
 * The source's next step for a move in progress, from what the destination
 * holds. Only `committed` leads to the erase, so the source never removes a
 * thread the destination cannot run.
 */
export function recoverSourceMove(state: ThreadMoveDestinationState): SourceRecovery {
  switch (state.state) {
    case "committed":
      return { action: "erase" };
    case "arrived":
      return { action: "commit" };
    case "receiving":
      return { action: "resume-transfer" };
    case "discarded":
    case "unknown":
      return { action: "unfreeze" };
  }
}

/** How long the source must be silent before the destination offers Activate anyway. */
export const ACTIVATE_ANYWAY_AFTER_MS = 5 * 60 * 1000;

/**
 * Whether the destination may offer Activate anyway on an arriving thread. The
 * source froze before it sent anything, so after five minutes of silence it
 * cannot have continued the thread.
 */
export function mayActivateAnyway(input: {
  readonly state: "arriving" | "active";
  readonly lastHeardFromSourceAt: number;
  readonly now: number;
}): boolean {
  return (
    input.state === "arriving" &&
    input.now - input.lastHeardFromSourceAt >= ACTIVATE_ANYWAY_AFTER_MS
  );
}

/** Whether the source may remove the thread's managed worktree after the erase. */
export function mayRemoveMovedWorktree(input: {
  readonly refusedFiles: number;
  readonly ignoredFiles: number;
}): boolean {
  return input.refusedFiles === 0 && input.ignoredFiles === 0;
}

const HANDOVER_SLUG_LIMIT = 48;

/**
 * The branch a handover commits to: the thread's own branch, or a new
 * `octant/handover/<slug>` branch when the thread works on the default branch
 * or a detached head, so a handover never commits to or pushes the default
 * branch.
 */
export function handoverBranch(input: {
  readonly currentBranch: string | undefined;
  readonly defaultBranch: string;
  readonly threadTitle: string;
  readonly threadId: string;
}): string {
  const current = input.currentBranch;
  if (current !== undefined && current.length > 0 && current !== input.defaultBranch) {
    return current;
  }
  const dashed = input.threadTitle
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-");
  const slug = trimCharacter(trimCharacter(dashed, "-").slice(0, HANDOVER_SLUG_LIMIT), "-");
  const suffix = input.threadId.replace(/-/g, "").slice(0, 8);
  return `octant/handover/${slug.length > 0 ? `${slug}-` : ""}${suffix}`;
}

/**
 * Drops a character from both ends of a text. A loop, not an anchored regular
 * expression, because a run of the character in untrusted input would make
 * `/x+$/` take polynomial time.
 */
function trimCharacter(text: string, character: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && text[start] === character) start += 1;
  while (end > start && text[end - 1] === character) end -= 1;
  return text.slice(start, end);
}
