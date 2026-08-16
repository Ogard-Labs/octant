/**
 * Pure policy for the composer-first "Start from origin" managed-worktree source
 * choice. The authoritative fetch, exact-ref resolution, worktree creation, and
 * receipt provenance live on the server; this module only models the selection
 * default, remote preference, typed refresh/result states, and the exact
 * disclosure copy the renderer presents. It never mutates a checkout or ref.
 */

import type { CodeWorktreeSourcePreview } from "@octant/contracts/code";

export interface WorktreeRemoteFacts {
  readonly remotes: ReadonlyArray<string>;
  readonly upstreamRemote?: string;
  readonly defaultRemote?: string;
}

export type WorktreeRemoteSelection =
  | Readonly<{ status: "selected"; remoteName: string; source: "upstream" | "default" }>
  | Readonly<{ status: "unavailable"; reason: "no-remote" | "ambiguous" }>;

export function selectWorktreeRemote(facts: WorktreeRemoteFacts): WorktreeRemoteSelection {
  const remotes = facts.remotes;
  if (facts.upstreamRemote !== undefined && remotes.includes(facts.upstreamRemote)) {
    return { status: "selected", remoteName: facts.upstreamRemote, source: "upstream" };
  }
  if (facts.defaultRemote !== undefined && remotes.includes(facts.defaultRemote)) {
    return { status: "selected", remoteName: facts.defaultRemote, source: "default" };
  }
  if (remotes.length === 1) {
    return { status: "selected", remoteName: remotes[0]!, source: "default" };
  }
  return remotes.length === 0
    ? { status: "unavailable", reason: "no-remote" }
    : { status: "unavailable", reason: "ambiguous" };
}

/** New managed worktrees default to the fresh remote source when a usable remote exists. */
export function defaultStartFromOrigin(facts: WorktreeRemoteFacts): boolean {
  return selectWorktreeRemote(facts).status === "selected";
}

/**
 * The default delivery branch intent for a new managed Code thread. It must
 * never collide with the base branch (e.g. `development`), which normally
 * exists. The default is a unique `octant/<short-id>` branch that the user
 * can override explicitly before submit.
 */
export function defaultDeliveryBranchIntent(baseBranch: string, shortId: string): string {
  const trimmed = baseBranch.trim();
  const safeId = shortId
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "")
    .slice(0, 12);
  const id = safeId.length > 0 ? safeId : "new";
  const candidate = `octant/${id}`;
  // Guard against the pathological case where the base branch itself is the
  // default pattern; append a suffix to avoid collision.
  return candidate === trimmed ? `${candidate}-work` : candidate;
}

/**
 * Failure reasons are limited to what the credential-safe server boundary can
 * honestly report. The managed-worktree Git port never echoes raw Git stderr,
 * so offline and authentication failures are not distinguished here; both
 * surface as an actionable `fetch-rejected`.
 */
export type WorktreeSourceFailureReason =
  | "remote-unavailable"
  | "fetch-rejected"
  | "cancelled"
  | "ambiguous-ref"
  | "ref-unavailable"
  | "unavailable";

export type WorktreeSourceResolution =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "fetching"; remoteName: string; branch: string }>
  | Readonly<{
      kind: "origin";
      remoteName: string;
      branch: string;
      resolvedHead: string;
      fetchedAt: string;
    }>
  | Readonly<{ kind: "local"; branch: string; resolvedHead: string; remoteName?: string }>
  | Readonly<{
      kind: "cached-snapshot";
      remoteName: string;
      branch: string;
      resolvedHead: string;
      fetchedAt: string;
    }>
  | Readonly<{ kind: "failed"; reason: WorktreeSourceFailureReason }>;

export interface WorktreeSourceDisclosure {
  readonly label: string;
  readonly detail?: string;
  readonly ageMs?: number;
}

export function shortSha(resolvedHead: string): string {
  return resolvedHead.slice(0, 7);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

export function formatFetchAge(ageMs: number): string {
  if (ageMs < MINUTE_MS) return "just now";
  if (ageMs < HOUR_MS) return `${Math.max(1, Math.round(ageMs / MINUTE_MS))}m`;
  if (ageMs < DAY_MS) return `${Math.max(1, Math.round(ageMs / HOUR_MS))}h`;
  return `${Math.max(1, Math.round(ageMs / DAY_MS))}d`;
}

function ageDetail(fetchedAt: string, now: () => Date): { detail: string; ageMs: number } {
  const ageMs = Math.max(0, now().getTime() - new Date(fetchedAt).getTime());
  const age = formatFetchAge(ageMs);
  return { detail: age === "just now" ? "fetched just now" : `fetched ${age} ago`, ageMs };
}

const FAILURE_COPY: Record<WorktreeSourceFailureReason, { label: string; detail: string }> = {
  "remote-unavailable": {
    label: "Remote unavailable",
    detail:
      "No usable remote is configured for this branch. Choose a local source or add a remote.",
  },
  "fetch-rejected": {
    label: "Fetch failed",
    detail:
      "The remote fetch failed. Check connectivity, credentials, and the remote, then retry or cancel.",
  },
  cancelled: {
    label: "Fetch cancelled",
    detail: "The fetch was cancelled before a source could be resolved. Retry when ready.",
  },
  "ambiguous-ref": {
    label: "Ambiguous ref",
    detail: "The remote-tracking ref is ambiguous. Choose an exact branch and retry.",
  },
  "ref-unavailable": {
    label: "Ref unavailable",
    detail: "The remote-tracking ref does not exist. Choose another branch and retry.",
  },
  unavailable: {
    label: "Source unavailable",
    detail: "The repository source could not be observed. Retry, or choose a local source.",
  },
};

export function describeWorktreeSource(
  resolution: WorktreeSourceResolution,
  now: () => Date,
): WorktreeSourceDisclosure | undefined {
  switch (resolution.kind) {
    case "idle":
      return undefined;
    case "fetching":
      return { label: `Fetching ${resolution.remoteName}/${resolution.branch}…` };
    case "origin":
      return {
        label: `${resolution.remoteName}/${resolution.branch} · ${shortSha(resolution.resolvedHead)}`,
      };
    case "local":
      return {
        label: `Local ${resolution.branch} · ${shortSha(resolution.resolvedHead)}`,
        detail: `may differ from ${resolution.remoteName ?? "remote"}`,
      };
    case "cached-snapshot": {
      const aged = ageDetail(resolution.fetchedAt, now);
      return {
        label: `${resolution.remoteName}/${resolution.branch} · ${shortSha(resolution.resolvedHead)}`,
        detail: aged.detail,
        ageMs: aged.ageMs,
      };
    }
    case "failed":
      return FAILURE_COPY[resolution.reason];
  }
}

export interface CachedSnapshotFacts {
  readonly remoteName?: string;
  readonly branch?: string;
  readonly resolvedHead?: string;
  readonly fetchedAt?: string;
}

export type CachedSnapshotEligibility =
  | Readonly<{ eligible: true; disclosure: WorktreeSourceDisclosure }>
  | Readonly<{ eligible: false }>;

/**
 * A last-fetched snapshot may be offered only as an explicit user action that
 * first displays its age, remote, branch, and exact object ID. It is eligible
 * only when every one of those facts is present.
 */
export function canUseCachedSnapshot(
  facts: CachedSnapshotFacts,
  now: () => Date,
): CachedSnapshotEligibility {
  if (
    facts.remoteName === undefined ||
    facts.branch === undefined ||
    facts.resolvedHead === undefined ||
    facts.fetchedAt === undefined
  ) {
    return { eligible: false };
  }
  const disclosure = describeWorktreeSource(
    {
      kind: "cached-snapshot",
      remoteName: facts.remoteName,
      branch: facts.branch,
      resolvedHead: facts.resolvedHead,
      fetchedAt: facts.fetchedAt,
    },
    now,
  );
  if (disclosure === undefined) return { eligible: false };
  return { eligible: true, disclosure };
}

/**
 * Maps the server-authoritative preview (exact object ID resolved by the
 * managed-worktree Git port) into the renderer's presentation resolution. The
 * renderer never infers or fabricates a SHA; it displays exactly what the
 * server resolved.
 */
export function worktreePreviewToResolution(
  preview: CodeWorktreeSourcePreview,
): WorktreeSourceResolution {
  switch (preview.kind) {
    case "origin":
      return {
        kind: "origin",
        remoteName: preview.remoteName,
        branch: preview.branch,
        resolvedHead: preview.resolvedHead,
        fetchedAt: preview.fetchedAt,
      };
    case "local":
      return preview.remoteName === undefined
        ? { kind: "local", branch: preview.branch, resolvedHead: preview.resolvedHead }
        : {
            kind: "local",
            branch: preview.branch,
            resolvedHead: preview.resolvedHead,
            remoteName: preview.remoteName,
          };
    case "failed":
      return { kind: "failed", reason: preview.reason };
  }
}
