import {
  MAX_CODE_PULL_REQUEST_LINK_THREADS,
  type CodePullRequestLinkCreated,
  type CodePullRequestLinkDisplayUpdated,
  type CodePullRequestLinkForgeIdsBackfilled,
  type CodePullRequestLinkMergedInto,
  type CodePullRequestLinkThreadAttached,
  type CodeThreadId,
  type GithubPullRequestNodeId,
  type GithubRepositoryNodeId,
  type ProjectId,
  type PullRequestLinkId,
  type PullRequestSwitchKind,
} from "@octant/contracts";

export interface PullRequestLinkRecord {
  readonly linkId: PullRequestLinkId;
  readonly projectId: ProjectId;
  readonly status: "active" | "merged-into";
  readonly mergedIntoLinkId?: PullRequestLinkId;
  readonly host: "github.com";
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  readonly number: number;
  readonly url?: string;
  readonly baseBranch?: string;
  readonly headOwner?: string;
  readonly headBranch?: string;
  readonly pullRequestNodeId?: GithubPullRequestNodeId;
  readonly baseRepositoryNodeId?: GithubRepositoryNodeId;
  readonly threadIds: ReadonlyArray<CodeThreadId>;
  readonly linkedAt: string;
  /** Monotonic creation order from replay sequence, used to break equal-timestamp ties. */
  readonly createdOrder: number;
}

export type PullRequestLinkJournalEvent =
  | { readonly kind: "created"; readonly payload: CodePullRequestLinkCreated }
  | { readonly kind: "thread-attached"; readonly payload: CodePullRequestLinkThreadAttached }
  | {
      readonly kind: "forge-ids-backfilled";
      readonly payload: CodePullRequestLinkForgeIdsBackfilled;
    }
  | { readonly kind: "display-updated"; readonly payload: CodePullRequestLinkDisplayUpdated }
  | { readonly kind: "merged-into"; readonly payload: CodePullRequestLinkMergedInto };

export interface PullRequestLinkRegistryState {
  readonly byId: ReadonlyMap<string, PullRequestLinkRecord>;
}

export function emptyPullRequestLinkRegistryState(): PullRequestLinkRegistryState {
  return { byId: new Map() };
}

/** Case-insensitive owner/name lookup key used while a link has no forge node ID yet. */
export function pullRequestDisplayLookupKey(
  projectId: ProjectId | string,
  repositoryOwner: string,
  repositoryName: string,
  number: number,
): string {
  return `${String(projectId)}:${repositoryOwner.toLowerCase()}/${repositoryName.toLowerCase()}#${number}`;
}

export function pullRequestForgeLookupKey(
  projectId: ProjectId | string,
  pullRequestNodeId: string,
): string {
  return `${String(projectId)}:${pullRequestNodeId}`;
}

/**
 * Pure event fold for the pull-request link identity aggregate. Replaying all
 * journaled link events in order reconstructs the exact active links and
 * merged-into redirect history without deleting anything from history.
 */
export function applyPullRequestLinkEvent(
  state: PullRequestLinkRegistryState,
  event: PullRequestLinkJournalEvent,
  sequence: number,
): PullRequestLinkRegistryState {
  const byId = new Map(state.byId);
  switch (event.kind) {
    case "created": {
      const p = event.payload;
      byId.set(String(p.linkId), {
        linkId: p.linkId,
        projectId: p.projectId,
        status: "active",
        host: p.host,
        repositoryOwner: p.repositoryOwner,
        repositoryName: p.repositoryName,
        number: p.number,
        ...(p.url === undefined ? {} : { url: p.url }),
        ...(p.baseBranch === undefined ? {} : { baseBranch: p.baseBranch }),
        ...(p.headOwner === undefined ? {} : { headOwner: p.headOwner }),
        ...(p.headBranch === undefined ? {} : { headBranch: p.headBranch }),
        ...(p.pullRequestNodeId === undefined ? {} : { pullRequestNodeId: p.pullRequestNodeId }),
        ...(p.baseRepositoryNodeId === undefined
          ? {}
          : { baseRepositoryNodeId: p.baseRepositoryNodeId }),
        threadIds: [...p.threadIds],
        linkedAt: p.linkedAt,
        createdOrder: sequence,
      });
      return { byId };
    }
    case "thread-attached": {
      const existing = byId.get(String(event.payload.linkId));
      if (existing === undefined) return state;
      if (existing.threadIds.some((id) => String(id) === String(event.payload.threadId))) {
        return state;
      }
      if (existing.threadIds.length >= MAX_CODE_PULL_REQUEST_LINK_THREADS) return state;
      byId.set(String(existing.linkId), {
        ...existing,
        threadIds: [...existing.threadIds, event.payload.threadId],
      });
      return { byId };
    }
    case "forge-ids-backfilled": {
      const existing = byId.get(String(event.payload.linkId));
      if (existing === undefined) return state;
      const pullRequestNodeId = event.payload.pullRequestNodeId ?? existing.pullRequestNodeId;
      const baseRepositoryNodeId =
        event.payload.baseRepositoryNodeId ?? existing.baseRepositoryNodeId;
      byId.set(String(existing.linkId), {
        ...existing,
        ...(pullRequestNodeId === undefined ? {} : { pullRequestNodeId }),
        ...(baseRepositoryNodeId === undefined ? {} : { baseRepositoryNodeId }),
      });
      return { byId };
    }
    case "display-updated": {
      const existing = byId.get(String(event.payload.linkId));
      if (existing === undefined) return state;
      const p = event.payload;
      const url = p.url ?? existing.url;
      const baseBranch = p.baseBranch ?? existing.baseBranch;
      const headOwner = p.headOwner ?? existing.headOwner;
      const headBranch = p.headBranch ?? existing.headBranch;
      byId.set(String(existing.linkId), {
        ...existing,
        repositoryOwner: p.repositoryOwner,
        repositoryName: p.repositoryName,
        number: p.number,
        ...(url === undefined ? {} : { url }),
        ...(baseBranch === undefined ? {} : { baseBranch }),
        ...(headOwner === undefined ? {} : { headOwner }),
        ...(headBranch === undefined ? {} : { headBranch }),
      });
      return { byId };
    }
    case "merged-into": {
      const p = event.payload;
      const merged = byId.get(String(p.linkId));
      if (merged !== undefined) {
        const pullRequestNodeId = merged.pullRequestNodeId ?? p.pullRequestNodeId;
        const baseRepositoryNodeId = merged.baseRepositoryNodeId ?? p.baseRepositoryNodeId;
        byId.set(String(merged.linkId), {
          ...merged,
          status: "merged-into",
          mergedIntoLinkId: p.survivingLinkId,
          pullRequestNodeId,
          ...(baseRepositoryNodeId === undefined ? {} : { baseRepositoryNodeId }),
        });
      }
      const survivor = byId.get(String(p.survivingLinkId));
      if (survivor !== undefined) {
        const mergedThreads = appendUniqueThreads(survivor.threadIds, p.movedThreadIds);
        const pullRequestNodeId = survivor.pullRequestNodeId ?? p.pullRequestNodeId;
        const baseRepositoryNodeId = survivor.baseRepositoryNodeId ?? p.baseRepositoryNodeId;
        byId.set(String(survivor.linkId), {
          ...survivor,
          threadIds: mergedThreads,
          pullRequestNodeId,
          ...(baseRepositoryNodeId === undefined ? {} : { baseRepositoryNodeId }),
        });
      }
      return { byId };
    }
  }
}

/** Follows `merged-into` pointers to the active surviving link. */
export function resolveCanonicalPullRequestLink(
  state: PullRequestLinkRegistryState,
  linkId: PullRequestLinkId,
): PullRequestLinkRecord | undefined {
  let current = state.byId.get(String(linkId));
  const visited = new Set<string>();
  while (current !== undefined && current.status === "merged-into") {
    const key = String(current.linkId);
    if (visited.has(key) || current.mergedIntoLinkId === undefined) return current;
    visited.add(key);
    current = state.byId.get(String(current.mergedIntoLinkId));
  }
  return current;
}

/**
 * Picks the surviving link when backfill discovers two or more active links
 * resolving to the same pull request node ID: the one linked first stays.
 */
export function selectSurvivingPullRequestLink(links: ReadonlyArray<PullRequestLinkRecord>): {
  readonly survivor: PullRequestLinkRecord;
  readonly duplicates: ReadonlyArray<PullRequestLinkRecord>;
} {
  const sorted = [...links].sort(compareLinkEarliestFirst);
  const [survivor, ...duplicates] = sorted;
  if (survivor === undefined) {
    throw new Error("Expected at least one pull request link to select a survivor.");
  }
  return { survivor, duplicates };
}

function compareLinkEarliestFirst(
  left: PullRequestLinkRecord,
  right: PullRequestLinkRecord,
): number {
  const leftMs = Date.parse(left.linkedAt);
  const rightMs = Date.parse(right.linkedAt);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs) && leftMs !== rightMs) {
    return leftMs - rightMs;
  }
  const timestampOrder = left.linkedAt.localeCompare(right.linkedAt);
  if (timestampOrder !== 0) return timestampOrder;
  if (left.createdOrder !== right.createdOrder) return left.createdOrder - right.createdOrder;
  return String(left.linkId).localeCompare(String(right.linkId));
}

/**
 * Returns only the forge IDs present in `observed` that `link` does not yet
 * have recorded, or `undefined` when nothing new needs to be backfilled.
 */
export function missingPullRequestForgeIds(
  link: PullRequestLinkRecord,
  observed: {
    readonly pullRequestNodeId?: GithubPullRequestNodeId;
    readonly baseRepositoryNodeId?: GithubRepositoryNodeId;
  },
):
  | {
      readonly pullRequestNodeId?: GithubPullRequestNodeId;
      readonly baseRepositoryNodeId?: GithubRepositoryNodeId;
    }
  | undefined {
  const pullRequestNodeId =
    link.pullRequestNodeId === undefined ? observed.pullRequestNodeId : undefined;
  const baseRepositoryNodeId =
    link.baseRepositoryNodeId === undefined ? observed.baseRepositoryNodeId : undefined;
  if (pullRequestNodeId === undefined && baseRepositoryNodeId === undefined) return undefined;
  return {
    ...(pullRequestNodeId === undefined ? {} : { pullRequestNodeId }),
    ...(baseRepositoryNodeId === undefined ? {} : { baseRepositoryNodeId }),
  };
}

/**
 * Whether an observation carries updated display/lookup fields for `link`.
 * Optional fields omitted by the observation never clear previously recorded values.
 */
export function pullRequestDisplayFieldsChanged(
  link: PullRequestLinkRecord,
  observed: {
    readonly repositoryOwner: string;
    readonly repositoryName: string;
    readonly number: number;
    readonly url?: string;
    readonly baseBranch?: string;
    readonly headOwner?: string;
    readonly headBranch?: string;
  },
): boolean {
  if (
    link.repositoryOwner !== observed.repositoryOwner ||
    link.repositoryName !== observed.repositoryName ||
    link.number !== observed.number
  ) {
    return true;
  }
  if (observed.url !== undefined && link.url !== observed.url) return true;
  if (observed.baseBranch !== undefined && link.baseBranch !== observed.baseBranch) return true;
  if (observed.headOwner !== undefined && link.headOwner !== observed.headOwner) return true;
  if (observed.headBranch !== undefined && link.headBranch !== observed.headBranch) return true;
  return false;
}

export interface PullRequestLinkSwitchSnapshot {
  readonly mergeWhenReadyOn: boolean;
  readonly autoFix: { readonly on: boolean; readonly threadId?: string };
  readonly watch: { readonly on: boolean; readonly threadId?: string };
}

export type PullRequestSwitchMergeAction = "keep-on" | "turn-off" | "already-off";

export interface PullRequestSwitchMergeDecision {
  readonly mergeWhenReady: PullRequestSwitchMergeAction;
  readonly autoFix: PullRequestSwitchMergeAction;
  readonly watch: PullRequestSwitchMergeAction;
  /** Every switch that was on in only one of the two duplicate links and must be turned off. */
  readonly disabledSwitches: ReadonlyArray<PullRequestSwitchKind>;
}

/**
 * Reconciles Merge when ready, Auto-fix, and pull-request watch when two
 * duplicate links resolve to the same pull request node ID: each switch stays
 * ON only if it was ON in both links; otherwise it is turned OFF.
 */
export function reconcileMergedPullRequestSwitches(
  surviving: PullRequestLinkSwitchSnapshot,
  merged: PullRequestLinkSwitchSnapshot,
): PullRequestSwitchMergeDecision {
  const decide = (leftOn: boolean, rightOn: boolean): PullRequestSwitchMergeAction => {
    if (leftOn && rightOn) return "keep-on";
    if (leftOn || rightOn) return "turn-off";
    return "already-off";
  };
  const mergeWhenReady = decide(surviving.mergeWhenReadyOn, merged.mergeWhenReadyOn);
  const autoFix = decide(surviving.autoFix.on, merged.autoFix.on);
  const watch = decide(surviving.watch.on, merged.watch.on);
  const disabledSwitches: PullRequestSwitchKind[] = [];
  if (mergeWhenReady === "turn-off") disabledSwitches.push("merge-when-ready");
  if (autoFix === "turn-off") disabledSwitches.push("auto-fix");
  if (watch === "turn-off") disabledSwitches.push("watch");
  return { mergeWhenReady, autoFix, watch, disabledSwitches };
}

export interface DuplicatePullRequestSwitchNotice {
  readonly threadId: string;
  readonly switches: ReadonlyArray<PullRequestSwitchKind>;
  readonly notice: string;
}

const SWITCH_LABELS: Readonly<Record<PullRequestSwitchKind, string>> = {
  "merge-when-ready": "Merge when ready",
  "auto-fix": "Auto-fix",
  watch: "Pull request watch",
};

/**
 * Builds one concise notice per affected thread naming every switch turned off
 * during a duplicate link merge and explaining why, so the person can turn it
 * back on.
 */
export function buildDuplicatePullRequestSwitchNotices(input: {
  readonly pullRequestNumber: number;
  readonly decision: PullRequestSwitchMergeDecision;
  readonly surviving: PullRequestLinkSwitchSnapshot;
  readonly merged: PullRequestLinkSwitchSnapshot;
  readonly allLinkedThreadIds: ReadonlyArray<string>;
}): ReadonlyArray<DuplicatePullRequestSwitchNotice> {
  if (input.decision.disabledSwitches.length === 0) return [];
  const switchesByThread = new Map<string, Set<PullRequestSwitchKind>>();
  const add = (threadId: string | undefined, kind: PullRequestSwitchKind) => {
    if (threadId === undefined || threadId === "") return;
    let set = switchesByThread.get(threadId);
    if (set === undefined) {
      set = new Set();
      switchesByThread.set(threadId, set);
    }
    set.add(kind);
  };

  if (input.decision.mergeWhenReady === "turn-off") {
    for (const threadId of input.allLinkedThreadIds) add(threadId, "merge-when-ready");
  }
  if (input.decision.autoFix === "turn-off") {
    const autoFixThread = input.surviving.autoFix.on
      ? input.surviving.autoFix.threadId
      : input.merged.autoFix.threadId;
    if (autoFixThread !== undefined) add(autoFixThread, "auto-fix");
    else for (const threadId of input.allLinkedThreadIds) add(threadId, "auto-fix");
  }
  if (input.decision.watch === "turn-off") {
    const watchThread = input.surviving.watch.on
      ? input.surviving.watch.threadId
      : input.merged.watch.threadId;
    if (watchThread !== undefined) add(watchThread, "watch");
    else for (const threadId of input.allLinkedThreadIds) add(threadId, "watch");
  }

  const orderedKinds: ReadonlyArray<PullRequestSwitchKind> = [
    "merge-when-ready",
    "auto-fix",
    "watch",
  ];
  const notices: DuplicatePullRequestSwitchNotice[] = [];
  for (const [threadId, set] of switchesByThread) {
    const switches = orderedKinds.filter((kind) => set.has(kind));
    if (switches.length === 0) continue;
    const labels = switches.map((kind) => SWITCH_LABELS[kind]);
    const list = formatList(labels);
    const notice =
      switches.length === 1
        ? `${list} was turned off on pull request #${input.pullRequestNumber} because two duplicate links for the same pull request were merged and it was only on in one of them. You can turn it back on.`
        : `${list} were turned off on pull request #${input.pullRequestNumber} because two duplicate links for the same pull request were merged and they were only on in one of them. You can turn them back on.`;
    notices.push({ threadId, switches, notice });
  }
  return notices;
}

function formatList(items: ReadonlyArray<string>): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

function appendUniqueThreads(
  existing: ReadonlyArray<CodeThreadId>,
  incoming: ReadonlyArray<CodeThreadId>,
): ReadonlyArray<CodeThreadId> {
  const result = [...existing];
  const seen = new Set(existing.map((id) => String(id)));
  for (const threadId of incoming) {
    if (result.length >= MAX_CODE_PULL_REQUEST_LINK_THREADS) break;
    const key = String(threadId);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(threadId);
  }
  return result;
}
