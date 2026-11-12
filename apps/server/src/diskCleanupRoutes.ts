import {
  decodeRemoveHostWorktreeRequest,
  decodeRemoveXcodeBuildDataRequest,
  type HostWorktreeRefusalReason,
  type HostWorktreeScan,
  type RemoveHostWorktreeResult,
  type XcodeBuildDataList,
} from "@octant/contracts/disk-cleanup";
import { UtcTimestamp } from "@octant/contracts";
import { Schema } from "effect";
import type { XcodeDerivedData } from "./apple/xcodeDerivedData";
import type { HostWorktreeScan as Scanned } from "./code/hostWorktreeDiscovery";
import type { HostWorktreeRemoval, HostWorktreeRemovalRequest } from "./code/hostWorktreeRemoval";
import { authenticateRoutePrincipal } from "./principalRouteContext";
import { isLoopbackHostname } from "./shellRoutes";
import { WindowAuthorityError, type WindowAuthorityStore } from "./windowAuthorityStore";

const METHODS = "GET, POST, OPTIONS";
const timestamp = (ms: number) =>
  Schema.decodeUnknownSync(UtcTimestamp)(new Date(ms).toISOString());
const HEADERS = "content-type, x-octant-window-capability";
const BODY_LIMIT = 256 * 1024;
export const HOST_WORKTREES_PATH = "/api/code/host-worktrees";
export const HOST_WORKTREES_SCAN_PATH = "/api/code/host-worktrees/scan";
export const HOST_WORKTREE_REMOVE_PATH = "/api/code/host-worktrees/remove";
export const XCODE_BUILD_DATA_PATH = "/api/apple/xcode-build-data";
export const XCODE_BUILD_DATA_REMOVE_PATH = "/api/apple/xcode-build-data/remove";
const PATHS = new Set([
  HOST_WORKTREES_PATH,
  HOST_WORKTREES_SCAN_PATH,
  HOST_WORKTREE_REMOVE_PATH,
  XCODE_BUILD_DATA_PATH,
  XCODE_BUILD_DATA_REMOVE_PATH,
]);

const REFUSALS: Record<HostWorktreeRefusalReason, string> = {
  malformed: "That worktree request is not valid.",
  unauthorized: "Only a window on this computer can see or remove its worktrees and build data.",
  "not-found": "That worktree is already gone.",
  "main-worktree": "That is the repository's own checkout, not a worktree.",
  bare: "That is a bare repository, not a worktree.",
  locked:
    "Git has this worktree locked; something asked for it to be kept. Unlock it with git worktree unlock first.",
  "owned-by-octant":
    "Octant made this worktree. Archive its thread, or remove it from the list above.",
  "linked-elsewhere": "This folder now belongs to another repository, so it was left alone.",
  "broken-link":
    "Git's record of this worktree no longer leads to its folder. Run git worktree repair in the repository first.",
  "runs-filters":
    "This repository's own config sets filters that run commands, so Octant did not read it.",
  unreadable: "Git could not read this worktree, so it was left alone.",
  dirty: "The worktree has uncommitted or untracked changes. Commit or discard them first.",
  "detached-commits":
    "This worktree has commits on a detached HEAD that no branch keeps. Put them on a branch first.",
  "git-refused": "Git refused to remove the worktree.",
};

function corsHeaders(origin: string | null): Record<string, string> {
  return {
    "access-control-allow-origin": origin ?? "",
    "access-control-allow-methods": METHODS,
    "access-control-allow-headers": HEADERS,
  };
}

function json(body: unknown, status: number, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders(origin) },
  });
}

function refusedWorktree(
  reason: HostWorktreeRefusalReason,
  detail?: string,
): RemoveHostWorktreeResult {
  const message = detail === undefined ? REFUSALS[reason] : `${REFUSALS[reason]} (${detail})`;
  return { kind: "host-worktree-refused", reason, message: message.slice(0, 600) };
}

export interface DiskCleanupRouteDependencies {
  readonly scan: (signal: AbortSignal) => Promise<Scanned>;
  readonly remove: (
    request: HostWorktreeRemovalRequest,
    signal: AbortSignal,
  ) => Promise<HostWorktreeRemoval>;
  readonly derivedData: XcodeDerivedData;
  readonly windowAuthorityStore: WindowAuthorityStore;
  readonly now?: () => number;
}

/**
 * Settings › Code › Worktrees on this computer and Xcode build data. Every
 * request is a window on this host's: the lists name folders on this computer
 * and removal deletes from its disk, so a paired device gets neither. The
 * last scan is kept in memory only, never journaled, and one scan runs at a
 * time.
 */
export function createDiskCleanupRouteHandler(dependencies: DiskCleanupRouteDependencies) {
  const now = dependencies.now ?? Date.now;
  let last: HostWorktreeScan = {
    kind: "host-worktrees",
    complete: true,
    repositories: [],
    problems: [],
  };
  let running: Promise<HostWorktreeScan> | undefined;

  const scan = (): Promise<HostWorktreeScan> => {
    running ??= dependencies
      .scan(AbortSignal.timeout(120_000))
      .then((found) => {
        last = toWire(found, timestamp(now()));
        return last;
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  };

  const forget = (repositoryPath: string, worktreePath: string) => {
    last = {
      ...last,
      repositories: last.repositories
        .map((repo) =>
          repo.path === repositoryPath
            ? { ...repo, worktrees: repo.worktrees.filter((wt) => wt.path !== worktreePath) }
            : repo,
        )
        .filter((repo) => repo.worktrees.length > 0),
    };
  };

  return async (request: Request): Promise<Response | undefined> => {
    const url = new URL(request.url);
    if (!PATHS.has(url.pathname)) return undefined;
    const origin = request.headers.get("origin");
    if (!isLoopbackHostname(url.hostname)) {
      return json({ error: "Disk cleanup requests must use loopback." }, 400, null);
    }
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }
    let principal;
    try {
      principal = authenticateRoutePrincipal({
        request,
        store: dependencies.windowAuthorityStore,
        now: now(),
      }).principal;
    } catch (error) {
      if (error instanceof WindowAuthorityError) {
        return json({ error: error.message }, error.category === "invalid" ? 400 : 401, origin);
      }
      throw error;
    }
    if (principal.kind !== "local-window") {
      return json(refusedWorktree("unauthorized"), 403, origin);
    }

    if (url.pathname === HOST_WORKTREES_PATH && request.method === "GET") {
      return json(last, 200, origin);
    }
    if (url.pathname === HOST_WORKTREES_SCAN_PATH && request.method === "POST") {
      return json(await scan(), 200, origin);
    }
    if (url.pathname === HOST_WORKTREE_REMOVE_PATH && request.method === "POST") {
      let parsed;
      try {
        const text = await request.text();
        if (text.length > BODY_LIMIT) return json({ error: "Request is too large." }, 413, origin);
        parsed = decodeRemoveHostWorktreeRequest(JSON.parse(text) as unknown);
      } catch {
        return json(refusedWorktree("malformed"), 400, origin);
      }
      const removal = await dependencies.remove(
        {
          repositoryPath: parsed.repositoryPath,
          worktreePath: parsed.worktreePath,
          ...(parsed.confirmedCommits === undefined
            ? {}
            : { confirmedCommits: parsed.confirmedCommits }),
          ...(parsed.confirmedRecentActivity === undefined
            ? {}
            : { confirmedRecentActivity: parsed.confirmedRecentActivity }),
        },
        AbortSignal.timeout(90_000),
      );
      const result = toRemovalResult(removal);
      if (result.kind === "host-worktree-removed" || result.kind === "host-worktree-forgotten") {
        forget(parsed.repositoryPath, parsed.worktreePath);
      }
      return json(result, result.kind === "host-worktree-refused" ? 409 : 200, origin);
    }
    if (url.pathname === XCODE_BUILD_DATA_PATH && request.method === "GET") {
      const list: XcodeBuildDataList = {
        kind: "xcode-build-data",
        available: dependencies.derivedData.available,
        entries: (await dependencies.derivedData.list()).map((entry) => ({
          name: entry.name,
          ...(entry.workspacePath === undefined ? {} : { workspacePath: entry.workspacePath }),
          ...(entry.lastAccessedMs === undefined
            ? {}
            : { lastAccessedAt: timestamp(entry.lastAccessedMs) }),
          state: entry.state === "orphaned" ? "orphaned" : "unused",
          ...(entry.size === undefined
            ? {}
            : { sizeBytes: Math.round(entry.size.bytes), sizeComplete: entry.size.complete }),
        })),
      };
      return json(list, 200, origin);
    }
    if (url.pathname === XCODE_BUILD_DATA_REMOVE_PATH && request.method === "POST") {
      let names;
      try {
        const text = await request.text();
        if (text.length > BODY_LIMIT) return json({ error: "Request is too large." }, 413, origin);
        names = decodeRemoveXcodeBuildDataRequest(JSON.parse(text) as unknown).names;
      } catch {
        return json({ error: "That request is not valid." }, 400, origin);
      }
      const removed: string[] = [];
      const kept: string[] = [];
      for (const name of new Set(names)) {
        const result = await dependencies.derivedData.remove(name);
        (result.status === "removed" ? removed : kept).push(name);
      }
      return json({ kind: "xcode-build-data-removed", removed, kept }, 200, origin);
    }
    return json({ error: "Disk cleanup route is not found." }, 404, origin);
  };
}

function toRemovalResult(removal: HostWorktreeRemoval): RemoveHostWorktreeResult {
  if (removal.status === "removed") return { kind: "host-worktree-removed" };
  if (removal.status === "forgotten") return { kind: "host-worktree-forgotten" };
  if (removal.status === "needs-confirmation") {
    return {
      kind: "host-worktree-needs-confirmation",
      reason: removal.reason,
      ...(removal.commits === undefined ? {} : { commits: removal.commits }),
      ...(removal.commitCount === undefined ? {} : { commitCount: removal.commitCount }),
    };
  }
  return refusedWorktree(removal.reason, removal.detail);
}

function toWire(found: Scanned, scannedAt: UtcTimestamp): HostWorktreeScan {
  return {
    kind: "host-worktrees",
    scannedAt,
    complete: found.complete,
    problems: found.problems.slice(0, 200).map((problem) => problem.slice(0, 600)),
    repositories: found.repositories
      .map((repo) => ({
        path: repo.path,
        worktrees: repo.worktrees
          .filter((wt) => !wt.ownedByOctant)
          .map((wt) => ({
            path: wt.path,
            ...(wt.branch === undefined ? {} : { branch: wt.branch.slice(0, 255) }),
            detached: wt.detached,
            locked: wt.locked,
            missing: wt.missing,
            ...(wt.delivered === undefined ? {} : { delivered: wt.delivered }),
            ...(wt.lastActivityMs === undefined
              ? {}
              : { lastActivityAt: timestamp(wt.lastActivityMs) }),
            ...(wt.size === undefined
              ? {}
              : { sizeBytes: Math.round(wt.size.bytes), sizeComplete: wt.size.complete }),
          })),
      }))
      .filter((repo) => repo.worktrees.length > 0),
  };
}
