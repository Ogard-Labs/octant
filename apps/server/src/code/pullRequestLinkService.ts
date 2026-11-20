import { createHash } from "node:crypto";
import {
  CODE_PROJECT_PULL_REQUEST_AUTO_FIX_RECORDED,
  CODE_PROJECT_PULL_REQUEST_MERGE_WHEN_READY_RECORDED,
  CODE_PROJECT_PULL_REQUEST_SWITCHES_AGGREGATE,
  CODE_PROJECT_PULL_REQUEST_WATCH_RECORDED,
  CODE_PULL_REQUEST_LINK_AGGREGATE,
  CODE_PULL_REQUEST_LINK_CREATED,
  CODE_PULL_REQUEST_LINK_DISPLAY_UPDATED,
  CODE_PULL_REQUEST_LINK_FORGE_IDS_BACKFILLED,
  CODE_PULL_REQUEST_LINK_MERGED_INTO,
  CODE_PULL_REQUEST_LINK_THREAD_ATTACHED,
  MAX_CODE_PULL_REQUEST_LINK_THREADS,
  decodeCodeProjectPullRequestAutoFixRecorded,
  decodeCodeProjectPullRequestMergeWhenReadyRecorded,
  decodeCodeProjectPullRequestWatchRecorded,
  decodeCodePullRequestLinkCreated,
  decodeCodePullRequestLinkDisplayUpdated,
  decodeCodePullRequestLinkForgeIdsBackfilled,
  decodeCodePullRequestLinkMergedInto,
  decodeCodePullRequestLinkThreadAttached,
  decodeGithubPullRequestNodeId,
  decodePullRequestLinkId,
  GithubRepositoryNodeId,
  GithubRepositoryName,
  GithubRepositoryOwner,
  type CodeOperationEventFrame,
  type CodeProjectPullRequestSwitchTarget,
  type CodeThreadId,
  type EventActor,
  type GithubPullRequestNodeId,
  type ProjectId,
  type PullRequestLinkId,
  type PullRequestSwitchKind,
} from "@octant/contracts";
import {
  applyPullRequestLinkEvent,
  areSamePullRequestRepositoryInProject,
  canonicalPullRequestRepositoryInProject,
  emptyPullRequestLinkRegistryState,
  listPullRequestDisplayAliases,
  missingPullRequestForgeIds,
  pullRequestDisplayFieldsChanged,
  pullRequestDisplayLookupKey,
  resolveCanonicalPullRequestLink,
  resolvePullRequestLink,
  selectSurvivingPullRequestLink,
  type PullRequestDisplayCoordinate,
  type PullRequestLinkJournalEvent,
  type PullRequestLinkRecord,
  type PullRequestLinkRegistryState,
} from "@octant/domain/pull-request-identity-policy";
import { Schema } from "effect";
import type { Journal } from "../persistence/journal";
import { OCTANT_LOCAL_ACTOR_ID } from "../shellService";

const decodeRepositoryOwner = Schema.decodeUnknownSync(GithubRepositoryOwner);
const decodeRepositoryName = Schema.decodeUnknownSync(GithubRepositoryName);
const decodeRepositoryNodeId = Schema.decodeUnknownSync(GithubRepositoryNodeId);

export type PullRequestLinkSwitchReconciliationResult =
  | {
      readonly status: "reconciled";
      readonly disabledSwitches: ReadonlyArray<PullRequestSwitchKind>;
    }
  | {
      readonly status: "retry-required";
      readonly reason: "merge-when-ready-disable-failed";
    };

/**
 * Reconciles Merge when ready, Auto-fix, and pull-request watch when backfill
 * discovers that two existing links resolve to the same github.com pull request
 * node ID.
 */
export interface PullRequestLinkSwitchReconciler {
  reconcileDuplicateLinks(input: {
    readonly survivingTarget: CodeProjectPullRequestSwitchTarget;
    readonly mergedTarget: CodeProjectPullRequestSwitchTarget;
    readonly allLinkedThreadIds: ReadonlyArray<CodeThreadId>;
    /**
     * Commits the link-registry backfill and `merged-into` events once any
     * required forge auto-merge cancellation is confirmed and before retiring
     * local switch records, so an interruption before merge commit never leaves
     * a retained switch disabled on only one link.
     */
    readonly commitMerge?: (disabledSwitches: ReadonlyArray<PullRequestSwitchKind>) => void;
    readonly signal?: AbortSignal;
  }): Promise<PullRequestLinkSwitchReconciliationResult>;
}

/**
 * One pull-request link known only from pre-identity journal streams
 * (`code-operation` results or `code-project-pull-request-switches`). Read-only
 * until an observation materializes it into `code-pull-request-link`.
 */
export interface LegacyPullRequestLinkSeed {
  readonly projectId: ProjectId;
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  readonly number: number;
  readonly url?: string;
  readonly baseBranch?: string;
  readonly headOwner?: string;
  readonly headBranch?: string;
  readonly threadIds: ReadonlyArray<CodeThreadId>;
  readonly linkedAt: string;
}

export interface PullRequestLinkObservationInput {
  readonly projectId: ProjectId;
  /** Observed canonical repository owner on github.com. */
  readonly repositoryOwner: string;
  /** Observed canonical repository name on github.com. */
  readonly repositoryName: string;
  /**
   * Repository owner/name that was queried before GitHub followed a rename
   * redirect, when it differs from `repositoryOwner`/`repositoryName`.
   */
  readonly lookupRepositoryOwner?: string;
  readonly lookupRepositoryName?: string;
  readonly number: number;
  readonly url?: string;
  readonly baseBranch?: string;
  readonly headOwner?: string;
  readonly headBranch?: string;
  readonly pullRequestNodeId?: string;
  readonly baseRepositoryNodeId?: string;
  readonly threadIds?: ReadonlyArray<CodeThreadId>;
  /**
   * When true, updates/backfills/merges existing or legacy links only and does
   * not create a new link for an unrelated repository pull request.
   */
  readonly onlyIfKnown?: boolean;
  readonly actor?: EventActor;
}

export type PullRequestLinkObservationResult =
  | { readonly status: "created"; readonly link: PullRequestLinkRecord }
  | {
      readonly status: "updated";
      readonly link: PullRequestLinkRecord;
      readonly backfilled: boolean;
      readonly displayUpdated: boolean;
    }
  | {
      readonly status: "merged";
      readonly link: PullRequestLinkRecord;
      readonly mergedLinkIds: ReadonlyArray<PullRequestLinkId>;
      readonly disabledSwitches: ReadonlyArray<PullRequestSwitchKind>;
    }
  | {
      readonly status: "merge-deferred";
      readonly link: PullRequestLinkRecord;
      readonly reason: "merge-when-ready-disable-failed";
    }
  | { readonly status: "unchanged"; readonly link: PullRequestLinkRecord }
  | { readonly status: "ignored" };

export interface PullRequestLinkRecorder {
  recordObservation(
    input: PullRequestLinkObservationInput,
    signal?: AbortSignal,
  ): Promise<PullRequestLinkObservationResult>;
}

export interface PullRequestLinkLookupQuery {
  readonly projectId: ProjectId;
  readonly repositoryOwner?: string;
  readonly repositoryName?: string;
  readonly number?: number;
  readonly pullRequestNodeId?: string;
  readonly baseRepositoryNodeId?: string;
}

export interface PullRequestLinkReader {
  listActive(): ReadonlyArray<PullRequestLinkRecord>;
  listForProject(projectId: ProjectId): ReadonlyArray<PullRequestLinkRecord>;
  listForThread(threadId: CodeThreadId): ReadonlyArray<PullRequestLinkRecord>;
  findById(linkId: PullRequestLinkId): PullRequestLinkRecord | undefined;
  resolveCanonical(linkId: PullRequestLinkId): PullRequestLinkRecord | undefined;
  findByForgeId(projectId: ProjectId, pullRequestNodeId: string): PullRequestLinkRecord | undefined;
  findByDisplay(
    projectId: ProjectId,
    repositoryOwner: string,
    repositoryName: string,
    number: number,
  ): PullRequestLinkRecord | undefined;
  resolveLink(query: PullRequestLinkLookupQuery): PullRequestLinkRecord | undefined;
  displayAliasesForLink(linkId: PullRequestLinkId): ReadonlyArray<PullRequestDisplayCoordinate>;
  areSameRepository(
    projectId: ProjectId,
    left: { readonly owner: string; readonly name: string },
    right: { readonly owner: string; readonly name: string },
  ): boolean;
  canonicalRepository(
    projectId: ProjectId,
    candidate: { readonly owner: string; readonly name: string },
  ):
    | {
        readonly owner: string;
        readonly name: string;
        readonly baseRepositoryNodeId?: string;
      }
    | undefined;
  recordRepositoryAlias(input: {
    readonly projectId: ProjectId;
    readonly baseRepositoryNodeId: string;
    readonly canonicalOwner: string;
    readonly canonicalName: string;
    readonly aliasOwner: string;
    readonly aliasName: string;
  }): void;
}

export type PullRequestLinkOwner = PullRequestLinkRecorder & PullRequestLinkReader;

/**
 * Deterministic link ID for a pre-identity `(projectId, owner/name, number)`
 * entry so materializing it from a legacy journal stream is idempotent across
 * replays and never duplicates the link.
 */
export function deriveLegacyPullRequestLinkId(input: {
  readonly projectId: ProjectId | string;
  readonly repositoryOwner: string;
  readonly repositoryName: string;
  readonly number: number;
}): PullRequestLinkId {
  const digest = createHash("sha256")
    .update("octant.pull-request-link.legacy.v1\0")
    .update(String(input.projectId))
    .update("\0")
    .update(input.repositoryOwner.toLowerCase())
    .update("/")
    .update(input.repositoryName.toLowerCase())
    .update("\0")
    .update(String(input.number))
    .digest("hex")
    .slice(0, 32);
  return decodePullRequestLinkId(
    `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20)}`,
  );
}

/**
 * Authoritative journal-backed owner of linked github.com pull request identity.
 *
 * Records each PR's stable GitHub node ID and base repository node ID when
 * created or first observed, backfills missing forge IDs idempotently on later
 * observations, updates display fields on repository renames, and merges
 * duplicate links that resolve to the same PR node ID without deleting history.
 */
export class PullRequestLinkService implements PullRequestLinkOwner {
  readonly #journal: Pick<Journal, "append" | "replayAggregateType">;
  readonly #uuid: () => string;
  readonly #clock: () => string;
  readonly #switchReconciler: PullRequestLinkSwitchReconciler | undefined;
  readonly #legacyLinks:
    | ((projectId: ProjectId) => ReadonlyArray<LegacyPullRequestLinkSeed>)
    | undefined;
  readonly #versions = new Map<string, number>();
  /**
   * Every `(projectId, owner/name, number)` display key ever recorded in
   * `code-pull-request-link` (across created and display-updated events), so
   * legacy-history scanning never materializes a second link for an already
   * tracked pull request even after a rename.
   */
  readonly #knownDisplayKeys = new Set<string>();
  /**
   * Process-local repository aliases proved by GitHub's base repository node ID
   * (for example when a local checkout still carries a stale second remote
   * pointing at a renamed repository). Keyed by `${projectId}:${baseRepositoryNodeId}`.
   */
  readonly #repositoryAliases = new Map<
    string,
    {
      readonly projectId: ProjectId;
      readonly baseRepositoryNodeId: string;
      canonicalOwner: string;
      canonicalName: string;
      readonly names: Set<string>;
    }
  >();
  #state: PullRequestLinkRegistryState = emptyPullRequestLinkRegistryState();
  #sequence = 0;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: {
    readonly journal: Pick<Journal, "append" | "replayAggregateType">;
    readonly uuid: () => string;
    readonly clock?: () => string;
    readonly switchReconciler?: PullRequestLinkSwitchReconciler;
    readonly legacyLinks?: (projectId: ProjectId) => ReadonlyArray<LegacyPullRequestLinkSeed>;
  }) {
    this.#journal = options.journal;
    this.#uuid = options.uuid;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#switchReconciler = options.switchReconciler;
    this.#legacyLinks = options.legacyLinks;
    this.#replay();
  }

  listActive(): ReadonlyArray<PullRequestLinkRecord> {
    return [...this.#state.byId.values()].filter((link) => link.status === "active");
  }

  listForProject(projectId: ProjectId): ReadonlyArray<PullRequestLinkRecord> {
    return [...this.#state.byId.values()].filter(
      (link) => link.status === "active" && String(link.projectId) === String(projectId),
    );
  }

  findById(linkId: PullRequestLinkId): PullRequestLinkRecord | undefined {
    return this.#state.byId.get(String(linkId));
  }

  resolveCanonical(linkId: PullRequestLinkId): PullRequestLinkRecord | undefined {
    return resolveCanonicalPullRequestLink(this.#state, linkId);
  }

  findByForgeId(
    projectId: ProjectId,
    pullRequestNodeId: string,
  ): PullRequestLinkRecord | undefined {
    for (const link of this.#state.byId.values()) {
      if (
        link.status === "active" &&
        String(link.projectId) === String(projectId) &&
        link.pullRequestNodeId === pullRequestNodeId
      ) {
        return link;
      }
    }
    return undefined;
  }

  findByDisplay(
    projectId: ProjectId,
    repositoryOwner: string,
    repositoryName: string,
    number: number,
  ): PullRequestLinkRecord | undefined {
    const wanted = pullRequestDisplayLookupKey(projectId, repositoryOwner, repositoryName, number);
    for (const link of this.#state.byId.values()) {
      if (
        link.status === "active" &&
        pullRequestDisplayLookupKey(
          link.projectId,
          link.repositoryOwner,
          link.repositoryName,
          link.number,
        ) === wanted
      ) {
        return link;
      }
    }
    return undefined;
  }

  resolveLink(query: PullRequestLinkLookupQuery): PullRequestLinkRecord | undefined {
    const direct = resolvePullRequestLink(this.#state, query);
    if (direct !== undefined) return direct;
    if (
      query.repositoryOwner === undefined ||
      query.repositoryName === undefined ||
      query.number === undefined
    ) {
      return undefined;
    }
    const canonicalRepo = this.canonicalRepository(query.projectId, {
      owner: query.repositoryOwner,
      name: query.repositoryName,
    });
    if (canonicalRepo !== undefined) {
      const byCanonical = resolvePullRequestLink(this.#state, {
        projectId: query.projectId,
        repositoryOwner: canonicalRepo.owner,
        repositoryName: canonicalRepo.name,
        number: query.number,
        ...(query.pullRequestNodeId === undefined
          ? {}
          : { pullRequestNodeId: query.pullRequestNodeId }),
        ...(query.baseRepositoryNodeId === undefined
          ? {}
          : { baseRepositoryNodeId: query.baseRepositoryNodeId }),
      });
      if (byCanonical !== undefined) return byCanonical;
    }
    // Also check active links still displaying a pre-rename repository name
    // that has now been proven via baseRepositoryNodeId to be the same repo.
    for (const link of this.#state.byId.values()) {
      if (
        link.status !== "active" ||
        String(link.projectId) !== String(query.projectId) ||
        link.number !== query.number
      ) {
        continue;
      }
      if (
        query.pullRequestNodeId !== undefined &&
        link.pullRequestNodeId !== undefined &&
        link.pullRequestNodeId !== query.pullRequestNodeId
      ) {
        continue;
      }
      if (
        query.baseRepositoryNodeId !== undefined &&
        link.baseRepositoryNodeId !== undefined &&
        link.baseRepositoryNodeId !== query.baseRepositoryNodeId
      ) {
        continue;
      }
      if (
        this.areSameRepository(
          query.projectId,
          { owner: link.repositoryOwner, name: link.repositoryName },
          { owner: query.repositoryOwner, name: query.repositoryName },
        )
      ) {
        return link;
      }
    }
    return undefined;
  }

  displayAliasesForLink(linkId: PullRequestLinkId): ReadonlyArray<PullRequestDisplayCoordinate> {
    return listPullRequestDisplayAliases(this.#state, linkId);
  }

  areSameRepository(
    projectId: ProjectId,
    left: { readonly owner: string; readonly name: string },
    right: { readonly owner: string; readonly name: string },
  ): boolean {
    if (areSamePullRequestRepositoryInProject(this.#state, projectId, left, right)) return true;
    const leftKey = `${left.owner.toLowerCase()}/${left.name.toLowerCase()}`;
    const rightKey = `${right.owner.toLowerCase()}/${right.name.toLowerCase()}`;
    if (leftKey === rightKey) return true;
    for (const entry of this.#repositoryAliases.values()) {
      if (String(entry.projectId) !== String(projectId)) continue;
      if (!entry.names.has(leftKey) || !entry.names.has(rightKey)) continue;
      if (
        this.#repositoryNameOwnedByDifferentNode(projectId, leftKey, entry.baseRepositoryNodeId) ||
        this.#repositoryNameOwnedByDifferentNode(projectId, rightKey, entry.baseRepositoryNodeId)
      ) {
        continue;
      }
      return true;
    }
    return false;
  }

  canonicalRepository(
    projectId: ProjectId,
    candidate: { readonly owner: string; readonly name: string },
  ):
    | {
        readonly owner: string;
        readonly name: string;
        readonly baseRepositoryNodeId?: string;
      }
    | undefined {
    const key = `${candidate.owner.toLowerCase()}/${candidate.name.toLowerCase()}`;
    for (const entry of this.#repositoryAliases.values()) {
      if (String(entry.projectId) !== String(projectId)) continue;
      if (!entry.names.has(key)) continue;
      if (this.#repositoryNameOwnedByDifferentNode(projectId, key, entry.baseRepositoryNodeId)) {
        continue;
      }
      return {
        owner: entry.canonicalOwner,
        name: entry.canonicalName,
        baseRepositoryNodeId: entry.baseRepositoryNodeId,
      };
    }
    return canonicalPullRequestRepositoryInProject(this.#state, projectId, candidate);
  }

  recordRepositoryAlias(input: {
    readonly projectId: ProjectId;
    readonly baseRepositoryNodeId: string;
    readonly canonicalOwner: string;
    readonly canonicalName: string;
    readonly aliasOwner: string;
    readonly aliasName: string;
  }): void {
    const canonicalKey = `${input.canonicalOwner.toLowerCase()}/${input.canonicalName.toLowerCase()}`;
    const aliasKey = `${input.aliasOwner.toLowerCase()}/${input.aliasName.toLowerCase()}`;
    for (const existing of this.#repositoryAliases.values()) {
      if (
        String(existing.projectId) === String(input.projectId) &&
        existing.baseRepositoryNodeId !== input.baseRepositoryNodeId
      ) {
        existing.names.delete(canonicalKey);
        existing.names.delete(aliasKey);
      }
    }
    const key = `${String(input.projectId)}:${input.baseRepositoryNodeId}`;
    let entry = this.#repositoryAliases.get(key);
    if (entry === undefined) {
      entry = {
        projectId: input.projectId,
        baseRepositoryNodeId: input.baseRepositoryNodeId,
        canonicalOwner: input.canonicalOwner,
        canonicalName: input.canonicalName,
        names: new Set<string>(),
      };
      this.#repositoryAliases.set(key, entry);
    } else {
      entry.canonicalOwner = input.canonicalOwner;
      entry.canonicalName = input.canonicalName;
    }
    entry.names.add(canonicalKey);
    entry.names.add(aliasKey);
  }

  #repositoryNameOwnedByDifferentNode(
    projectId: ProjectId,
    nameKey: string,
    expectedNodeId: string,
  ): boolean {
    for (const link of this.#state.byId.values()) {
      if (
        link.status !== "active" ||
        String(link.projectId) !== String(projectId) ||
        link.baseRepositoryNodeId === undefined
      ) {
        continue;
      }
      const linkNameKey = `${link.repositoryOwner.toLowerCase()}/${link.repositoryName.toLowerCase()}`;
      if (linkNameKey === nameKey && String(link.baseRepositoryNodeId) !== expectedNodeId) {
        return true;
      }
    }
    return false;
  }

  listForThread(threadId: CodeThreadId): ReadonlyArray<PullRequestLinkRecord> {
    return [...this.#state.byId.values()].filter(
      (link) =>
        link.status === "active" &&
        link.threadIds.some((existing) => String(existing) === String(threadId)),
    );
  }

  recordObservation(
    input: PullRequestLinkObservationInput,
    signal?: AbortSignal,
  ): Promise<PullRequestLinkObservationResult> {
    const run = this.#queue.then(() => this.#recordObservationExclusive(input, signal));
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async #recordObservationExclusive(
    input: PullRequestLinkObservationInput,
    signal?: AbortSignal,
  ): Promise<PullRequestLinkObservationResult> {
    const normalized = normalizeObservation(input);
    if (normalized === undefined) return { status: "ignored" };
    const actor = input.actor ?? systemActor();

    this.#materializeMatchingLegacyLinks(normalized, actor);

    const matched = this.#findMatchingActiveLinks(normalized);
    if (matched.length === 0) {
      if (input.onlyIfKnown === true) return { status: "ignored" };
      const linkId = decodePullRequestLinkId(this.#uuid());
      const payload = decodeCodePullRequestLinkCreated({
        linkId,
        projectId: normalized.projectId,
        threadIds: uniqueThreads(normalized.threadIds),
        host: "github.com",
        repositoryOwner: normalized.repositoryOwner,
        repositoryName: normalized.repositoryName,
        number: normalized.number,
        ...(normalized.url === undefined ? {} : { url: normalized.url }),
        ...(normalized.baseBranch === undefined ? {} : { baseBranch: normalized.baseBranch }),
        ...(normalized.headOwner === undefined ? {} : { headOwner: normalized.headOwner }),
        ...(normalized.headBranch === undefined ? {} : { headBranch: normalized.headBranch }),
        ...(normalized.pullRequestNodeId === undefined
          ? {}
          : { pullRequestNodeId: normalized.pullRequestNodeId }),
        ...(normalized.baseRepositoryNodeId === undefined
          ? {}
          : { baseRepositoryNodeId: normalized.baseRepositoryNodeId }),
        linkedAt: this.#clock(),
      });
      this.#appendEvent(
        linkId,
        CODE_PULL_REQUEST_LINK_CREATED,
        { kind: "created", payload },
        actor,
      );
      const created = this.#state.byId.get(String(linkId));
      if (created === undefined) return { status: "ignored" };
      return { status: "created", link: created };
    }

    if (matched.length === 1) {
      const existing = matched[0];
      if (existing === undefined) return { status: "ignored" };
      const { backfilled, displayUpdated, threadsAttached } = this.#updateSingleLink(
        existing,
        normalized,
        actor,
      );
      const current = this.#state.byId.get(String(existing.linkId)) ?? existing;
      if (!backfilled && !displayUpdated && !threadsAttached) {
        return { status: "unchanged", link: current };
      }
      return { status: "updated", link: current, backfilled, displayUpdated };
    }

    // Multiple active links resolved to the same PR node ID: keep the one
    // linked first, reconcile switches, merge later link(s) into the survivor,
    // and update the survivor's display fields to the live observation.
    const { survivor, duplicates } = selectSurvivingPullRequestLink(matched);
    const pullRequestNodeId = normalized.pullRequestNodeId;
    if (pullRequestNodeId === undefined) {
      return { status: "unchanged", link: survivor };
    }

    const mergedLinkIds: PullRequestLinkId[] = [];
    const allDisabledSwitches: PullRequestSwitchKind[] = [];
    let deferredReason: "merge-when-ready-disable-failed" | undefined;

    for (const duplicate of duplicates) {
      const latestSurvivor = this.#state.byId.get(String(survivor.linkId)) ?? survivor;
      const allLinkedThreadIds = uniqueThreads([
        ...latestSurvivor.threadIds,
        ...duplicate.threadIds,
        ...normalized.threadIds,
      ]);
      const baseRepositoryNodeId =
        normalized.baseRepositoryNodeId ??
        latestSurvivor.baseRepositoryNodeId ??
        duplicate.baseRepositoryNodeId;
      let mergeCommitted = false;
      let mergeAttempted = false;
      const commitMerge = (disabledSwitches: ReadonlyArray<PullRequestSwitchKind>): void => {
        if (mergeCommitted) return;
        mergeAttempted = true;
        const currentSurvivor = this.#state.byId.get(String(survivor.linkId)) ?? latestSurvivor;
        const missingOnSurvivor = missingPullRequestForgeIds(currentSurvivor, {
          pullRequestNodeId,
          ...(baseRepositoryNodeId === undefined ? {} : { baseRepositoryNodeId }),
        });
        if (missingOnSurvivor !== undefined) {
          const payload = decodeCodePullRequestLinkForgeIdsBackfilled({
            linkId: survivor.linkId,
            ...missingOnSurvivor,
          });
          this.#appendEvent(
            survivor.linkId,
            CODE_PULL_REQUEST_LINK_FORGE_IDS_BACKFILLED,
            { kind: "forge-ids-backfilled", payload },
            actor,
          );
        }
        const survivorAfterBackfill =
          this.#state.byId.get(String(survivor.linkId)) ?? currentSurvivor;
        const existingThreadKeys = new Set(survivorAfterBackfill.threadIds.map((id) => String(id)));
        const movedThreadIds = uniqueThreads(
          duplicate.threadIds.filter((id) => !existingThreadKeys.has(String(id))),
        );
        const mergePayload = decodeCodePullRequestLinkMergedInto({
          linkId: duplicate.linkId,
          survivingLinkId: survivor.linkId,
          pullRequestNodeId,
          ...(baseRepositoryNodeId === undefined ? {} : { baseRepositoryNodeId }),
          movedThreadIds,
          disabledSwitches: [...disabledSwitches],
        });
        this.#appendEvent(
          duplicate.linkId,
          CODE_PULL_REQUEST_LINK_MERGED_INTO,
          { kind: "merged-into", payload: mergePayload },
          actor,
        );
        mergeCommitted = true;
      };
      let reconciliation: PullRequestLinkSwitchReconciliationResult;
      try {
        reconciliation =
          this.#switchReconciler === undefined
            ? { status: "reconciled", disabledSwitches: [] }
            : await this.#switchReconciler.reconcileDuplicateLinks({
                survivingTarget: switchTargetOf(latestSurvivor),
                mergedTarget: switchTargetOf(duplicate),
                allLinkedThreadIds,
                commitMerge,
                ...(signal === undefined ? {} : { signal }),
              });
      } catch (error) {
        if (mergeAttempted) {
          // The atomic journal transaction rolled back after `commitMerge`
          // appended link events; rebuild in-memory state from the journal so
          // both links remain active and the next observation retries cleanly.
          this.#resetAndReplay();
        }
        throw error;
      }
      if (reconciliation.status === "retry-required") {
        // Forge auto-merge could not be confirmed off; leave this duplicate
        // active and switches untouched so the next observation retries cleanly.
        deferredReason = reconciliation.reason;
        continue;
      }
      if (!mergeCommitted) {
        commitMerge(reconciliation.disabledSwitches);
      }
      mergedLinkIds.push(duplicate.linkId);
      for (const kind of reconciliation.disabledSwitches) {
        if (!allDisabledSwitches.includes(kind)) allDisabledSwitches.push(kind);
      }
    }

    if (mergedLinkIds.length === 0 && deferredReason !== undefined) {
      return {
        status: "merge-deferred",
        link: this.#state.byId.get(String(survivor.linkId)) ?? survivor,
        reason: deferredReason,
      };
    }

    const afterMerge = this.#state.byId.get(String(survivor.linkId)) ?? survivor;
    this.#updateSingleLink(afterMerge, normalized, actor);
    const finalSurvivor = this.#state.byId.get(String(survivor.linkId)) ?? afterMerge;
    return {
      status: "merged",
      link: finalSurvivor,
      mergedLinkIds,
      disabledSwitches: allDisabledSwitches,
    };
  }

  #updateSingleLink(
    link: PullRequestLinkRecord,
    normalized: NormalizedObservation,
    actor: EventActor,
  ): {
    readonly backfilled: boolean;
    readonly displayUpdated: boolean;
    readonly threadsAttached: boolean;
  } {
    let current = link;
    let backfilled = false;
    const missing = missingPullRequestForgeIds(current, {
      ...(normalized.pullRequestNodeId === undefined
        ? {}
        : { pullRequestNodeId: normalized.pullRequestNodeId }),
      ...(normalized.baseRepositoryNodeId === undefined
        ? {}
        : { baseRepositoryNodeId: normalized.baseRepositoryNodeId }),
    });
    if (missing !== undefined) {
      const payload = decodeCodePullRequestLinkForgeIdsBackfilled({
        linkId: current.linkId,
        ...missing,
      });
      this.#appendEvent(
        current.linkId,
        CODE_PULL_REQUEST_LINK_FORGE_IDS_BACKFILLED,
        { kind: "forge-ids-backfilled", payload },
        actor,
      );
      current = this.#state.byId.get(String(current.linkId)) ?? current;
      backfilled = true;
    }

    let displayUpdated = false;
    if (pullRequestDisplayFieldsChanged(current, normalized)) {
      const payload = decodeCodePullRequestLinkDisplayUpdated({
        linkId: current.linkId,
        repositoryOwner: normalized.repositoryOwner,
        repositoryName: normalized.repositoryName,
        number: normalized.number,
        ...(normalized.url === undefined ? {} : { url: normalized.url }),
        ...(normalized.baseBranch === undefined ? {} : { baseBranch: normalized.baseBranch }),
        ...(normalized.headOwner === undefined ? {} : { headOwner: normalized.headOwner }),
        ...(normalized.headBranch === undefined ? {} : { headBranch: normalized.headBranch }),
      });
      this.#appendEvent(
        current.linkId,
        CODE_PULL_REQUEST_LINK_DISPLAY_UPDATED,
        { kind: "display-updated", payload },
        actor,
      );
      current = this.#state.byId.get(String(current.linkId)) ?? current;
      displayUpdated = true;
    }

    let threadsAttached = false;
    const knownThreads = new Set(current.threadIds.map((id) => String(id)));
    for (const threadId of normalized.threadIds) {
      if (knownThreads.size >= MAX_CODE_PULL_REQUEST_LINK_THREADS) break;
      const key = String(threadId);
      if (knownThreads.has(key)) continue;
      knownThreads.add(key);
      const payload = decodeCodePullRequestLinkThreadAttached({
        linkId: current.linkId,
        threadId,
      });
      this.#appendEvent(
        current.linkId,
        CODE_PULL_REQUEST_LINK_THREAD_ATTACHED,
        { kind: "thread-attached", payload },
        actor,
      );
      threadsAttached = true;
    }

    return { backfilled, displayUpdated, threadsAttached };
  }

  #findMatchingActiveLinks(
    normalized: NormalizedObservation,
  ): ReadonlyArray<PullRequestLinkRecord> {
    const matched = new Map<string, PullRequestLinkRecord>();
    const conflictsWithObservation = (link: PullRequestLinkRecord): boolean =>
      (normalized.pullRequestNodeId !== undefined &&
        link.pullRequestNodeId !== undefined &&
        link.pullRequestNodeId !== normalized.pullRequestNodeId) ||
      (normalized.baseRepositoryNodeId !== undefined &&
        link.baseRepositoryNodeId !== undefined &&
        link.baseRepositoryNodeId !== normalized.baseRepositoryNodeId);
    const add = (link: PullRequestLinkRecord | undefined) => {
      if (link === undefined || link.status !== "active") return;
      // Never match or merge a link whose recorded pull-request or base-repository
      // node ID differs from the observed one (for example if an old repository
      // name was reused by a different repository with the same PR number).
      if (conflictsWithObservation(link)) {
        return;
      }
      matched.set(String(link.linkId), link);
    };
    const addByDisplay = (owner: string, name: string) => {
      const wanted = pullRequestDisplayLookupKey(
        normalized.projectId,
        owner,
        name,
        normalized.number,
      );
      for (const link of this.#state.byId.values()) {
        if (
          link.status === "active" &&
          !conflictsWithObservation(link) &&
          pullRequestDisplayLookupKey(
            link.projectId,
            link.repositoryOwner,
            link.repositoryName,
            link.number,
          ) === wanted
        ) {
          add(link);
        }
      }
      add(
        this.resolveLink({
          projectId: normalized.projectId,
          repositoryOwner: owner,
          repositoryName: name,
          number: normalized.number,
          ...(normalized.pullRequestNodeId === undefined
            ? {}
            : { pullRequestNodeId: normalized.pullRequestNodeId }),
          ...(normalized.baseRepositoryNodeId === undefined
            ? {}
            : { baseRepositoryNodeId: normalized.baseRepositoryNodeId }),
        }),
      );
    };
    if (normalized.pullRequestNodeId !== undefined) {
      for (const link of this.#state.byId.values()) {
        if (
          link.status === "active" &&
          String(link.projectId) === String(normalized.projectId) &&
          link.pullRequestNodeId === normalized.pullRequestNodeId
        ) {
          add(link);
        }
      }
    }
    addByDisplay(normalized.repositoryOwner, normalized.repositoryName);
    if (
      normalized.lookupRepositoryOwner !== undefined &&
      normalized.lookupRepositoryName !== undefined
    ) {
      addByDisplay(normalized.lookupRepositoryOwner, normalized.lookupRepositoryName);
    }
    return [...matched.values()];
  }

  #materializeMatchingLegacyLinks(normalized: NormalizedObservation, actor: EventActor): void {
    if (this.#legacyLinks === undefined) return;
    const wantedKeys = new Set<string>([
      pullRequestDisplayLookupKey(
        normalized.projectId,
        normalized.repositoryOwner,
        normalized.repositoryName,
        normalized.number,
      ),
    ]);
    if (
      normalized.lookupRepositoryOwner !== undefined &&
      normalized.lookupRepositoryName !== undefined
    ) {
      wantedKeys.add(
        pullRequestDisplayLookupKey(
          normalized.projectId,
          normalized.lookupRepositoryOwner,
          normalized.lookupRepositoryName,
          normalized.number,
        ),
      );
    }
    let needsLegacyScan = false;
    for (const key of wantedKeys) {
      if (!this.#knownDisplayKeys.has(key)) {
        needsLegacyScan = true;
        break;
      }
    }
    if (!needsLegacyScan) return;
    for (const seed of this.#legacyLinks(normalized.projectId)) {
      const key = pullRequestDisplayLookupKey(
        seed.projectId,
        seed.repositoryOwner,
        seed.repositoryName,
        seed.number,
      );
      if (!wantedKeys.has(key)) continue;
      const linkId = deriveLegacyPullRequestLinkId(seed);
      // Skip if this deterministic legacy link already exists OR if any link
      // in `code-pull-request-link` has already tracked this `(projectId,
      // owner/name, number)` display key (for example a post-change link with
      // a random UUID, even if its repository was later renamed).
      if (this.#state.byId.has(String(linkId)) || this.#knownDisplayKeys.has(key)) continue;
      let payload;
      try {
        payload = decodeCodePullRequestLinkCreated({
          linkId,
          projectId: seed.projectId,
          threadIds: uniqueThreads(seed.threadIds),
          host: "github.com",
          repositoryOwner: seed.repositoryOwner,
          repositoryName: seed.repositoryName,
          number: seed.number,
          ...(seed.url === undefined ? {} : { url: seed.url }),
          ...(seed.baseBranch === undefined ? {} : { baseBranch: seed.baseBranch }),
          ...(seed.headOwner === undefined ? {} : { headOwner: seed.headOwner }),
          ...(seed.headBranch === undefined ? {} : { headBranch: seed.headBranch }),
          linkedAt: seed.linkedAt,
        });
      } catch {
        continue;
      }
      this.#appendEvent(
        linkId,
        CODE_PULL_REQUEST_LINK_CREATED,
        { kind: "created", payload },
        actor,
      );
    }
  }

  #recordKnownDisplayKey(event: PullRequestLinkJournalEvent): void {
    if (event.kind === "created") {
      this.#knownDisplayKeys.add(
        pullRequestDisplayLookupKey(
          event.payload.projectId,
          event.payload.repositoryOwner,
          event.payload.repositoryName,
          event.payload.number,
        ),
      );
      return;
    }
    if (event.kind === "display-updated") {
      const existing = this.#state.byId.get(String(event.payload.linkId));
      if (existing !== undefined) {
        this.#knownDisplayKeys.add(
          pullRequestDisplayLookupKey(
            existing.projectId,
            event.payload.repositoryOwner,
            event.payload.repositoryName,
            event.payload.number,
          ),
        );
      }
    }
  }

  #appendEvent(
    linkId: PullRequestLinkId,
    eventName: string,
    event: PullRequestLinkJournalEvent,
    actor: EventActor,
  ): void {
    const key = String(linkId);
    const expectedVersion = this.#versions.get(key) ?? 0;
    const occurredAt = this.#clock();
    const committed = this.#journal.append({
      aggregate: {
        aggregateType: CODE_PULL_REQUEST_LINK_AGGREGATE,
        aggregateId: key,
      },
      expectedVersion,
      events: [
        {
          eventId: this.#uuid(),
          eventName,
          eventVersion: 1,
          correlationId: this.#uuid(),
          actor,
          occurredAt,
          payload: event.payload,
        },
      ],
    });
    const envelope = committed.events[0];
    this.#versions.set(key, envelope?.aggregateVersion ?? expectedVersion + 1);
    this.#sequence = envelope?.globalSequence ?? this.#sequence + 1;
    this.#recordKnownDisplayKey(event);
    this.#state = applyPullRequestLinkEvent(this.#state, event, this.#sequence);
  }

  #resetAndReplay(): void {
    this.#versions.clear();
    this.#knownDisplayKeys.clear();
    this.#state = emptyPullRequestLinkRegistryState();
    this.#sequence = 0;
    this.#replay();
  }

  #replay(): void {
    let afterSequence = 0;
    for (;;) {
      const page = this.#journal.replayAggregateType({
        aggregateType: CODE_PULL_REQUEST_LINK_AGGREGATE,
        afterSequence,
        limit: 1_000,
      });
      for (const envelope of page) {
        afterSequence = envelope.globalSequence;
        this.#sequence = envelope.globalSequence;
        this.#versions.set(envelope.aggregateId, envelope.aggregateVersion);
        const decoded = decodePullRequestLinkEnvelopeEvent(envelope.eventName, envelope.payload);
        if (decoded !== undefined) {
          this.#recordKnownDisplayKey(decoded);
          this.#state = applyPullRequestLinkEvent(this.#state, decoded, envelope.globalSequence);
        }
      }
      if (page.length < 1_000) return;
    }
  }
}

interface NormalizedObservation {
  readonly projectId: ProjectId;
  readonly repositoryOwner: GithubRepositoryOwner;
  readonly repositoryName: GithubRepositoryName;
  readonly lookupRepositoryOwner?: GithubRepositoryOwner;
  readonly lookupRepositoryName?: GithubRepositoryName;
  readonly number: number;
  readonly url?: string;
  readonly baseBranch?: string;
  readonly headOwner?: string;
  readonly headBranch?: string;
  readonly pullRequestNodeId?: GithubPullRequestNodeId;
  readonly baseRepositoryNodeId?: GithubRepositoryNodeId;
  readonly threadIds: ReadonlyArray<CodeThreadId>;
}

function normalizeObservation(
  input: PullRequestLinkObservationInput,
): NormalizedObservation | undefined {
  if (!Number.isSafeInteger(input.number) || input.number <= 0) return undefined;
  let repositoryOwner: GithubRepositoryOwner;
  let repositoryName: GithubRepositoryName;
  try {
    repositoryOwner = decodeRepositoryOwner(input.repositoryOwner);
    repositoryName = decodeRepositoryName(input.repositoryName);
  } catch {
    return undefined;
  }
  let lookupRepositoryOwner: GithubRepositoryOwner | undefined;
  let lookupRepositoryName: GithubRepositoryName | undefined;
  if (input.lookupRepositoryOwner !== undefined && input.lookupRepositoryName !== undefined) {
    try {
      lookupRepositoryOwner = decodeRepositoryOwner(input.lookupRepositoryOwner);
      lookupRepositoryName = decodeRepositoryName(input.lookupRepositoryName);
    } catch {
      lookupRepositoryOwner = undefined;
      lookupRepositoryName = undefined;
    }
  }
  const pullRequestNodeId = safeDecode(input.pullRequestNodeId, decodeGithubPullRequestNodeId);
  const baseRepositoryNodeId = safeDecode(input.baseRepositoryNodeId, decodeRepositoryNodeId);
  const url =
    input.url !== undefined && input.url.startsWith("https://") && input.url.length <= 2_048
      ? input.url
      : undefined;
  const baseBranch = safeBranch(input.baseBranch);
  const headBranch = safeBranch(input.headBranch);
  const headOwner =
    input.headOwner !== undefined && /^[A-Za-z0-9_.-]{1,128}$/.test(input.headOwner)
      ? input.headOwner
      : undefined;
  return {
    projectId: input.projectId,
    repositoryOwner,
    repositoryName,
    ...(lookupRepositoryOwner === undefined || lookupRepositoryName === undefined
      ? {}
      : { lookupRepositoryOwner, lookupRepositoryName }),
    number: input.number,
    ...(url === undefined ? {} : { url }),
    ...(baseBranch === undefined ? {} : { baseBranch }),
    ...(headOwner === undefined ? {} : { headOwner }),
    ...(headBranch === undefined ? {} : { headBranch }),
    ...(pullRequestNodeId === undefined ? {} : { pullRequestNodeId }),
    ...(baseRepositoryNodeId === undefined ? {} : { baseRepositoryNodeId }),
    threadIds: input.threadIds ?? [],
  };
}

function safeBranch(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > 255 || /\s/.test(trimmed) || trimmed.includes("..")) {
    return undefined;
  }
  return trimmed;
}

function safeDecode<T>(value: string | undefined, decode: (input: unknown) => T): T | undefined {
  if (value === undefined) return undefined;
  try {
    return decode(value);
  } catch {
    return undefined;
  }
}

export function decodePullRequestLinkEnvelopeEvent(
  eventName: string,
  payload: unknown,
): PullRequestLinkJournalEvent | undefined {
  try {
    switch (eventName) {
      case CODE_PULL_REQUEST_LINK_CREATED:
        return { kind: "created", payload: decodeCodePullRequestLinkCreated(payload) };
      case CODE_PULL_REQUEST_LINK_THREAD_ATTACHED:
        return {
          kind: "thread-attached",
          payload: decodeCodePullRequestLinkThreadAttached(payload),
        };
      case CODE_PULL_REQUEST_LINK_FORGE_IDS_BACKFILLED:
        return {
          kind: "forge-ids-backfilled",
          payload: decodeCodePullRequestLinkForgeIdsBackfilled(payload),
        };
      case CODE_PULL_REQUEST_LINK_DISPLAY_UPDATED:
        return {
          kind: "display-updated",
          payload: decodeCodePullRequestLinkDisplayUpdated(payload),
        };
      case CODE_PULL_REQUEST_LINK_MERGED_INTO:
        return {
          kind: "merged-into",
          payload: decodeCodePullRequestLinkMergedInto(payload),
        };
      default:
        return undefined;
    }
  } catch {
    return undefined;
  }
}

function uniqueThreads(threadIds: ReadonlyArray<CodeThreadId>): ReadonlyArray<CodeThreadId> {
  const result: CodeThreadId[] = [];
  const seen = new Set<string>();
  for (const id of threadIds) {
    if (result.length >= MAX_CODE_PULL_REQUEST_LINK_THREADS) break;
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(id);
  }
  return result;
}

function switchTargetOf(link: PullRequestLinkRecord): CodeProjectPullRequestSwitchTarget {
  return {
    projectId: link.projectId,
    repositoryOwner: decodeRepositoryOwner(link.repositoryOwner),
    repositoryName: decodeRepositoryName(link.repositoryName),
    number: link.number,
  };
}

function systemActor(): EventActor {
  return { kind: "system", actorId: OCTANT_LOCAL_ACTOR_ID };
}

/** Splits `owner/name` into its validated parts, or returns `undefined`. */
export function splitRepositoryName(
  repository: string,
): { readonly owner: string; readonly name: string } | undefined {
  const slash = repository.indexOf("/");
  if (slash <= 0 || repository.includes("/", slash + 1)) return undefined;
  const owner = repository.slice(0, slash);
  const name = repository.slice(slash + 1);
  return owner !== "" && name !== "" ? { owner, name } : undefined;
}

/**
 * Read-only scan of pre-identity journal streams (`code-project-pull-request-switches`
 * and thread operation summaries) so existing links recorded before
 * `code-pull-request-link` existed can be backfilled on their next observation.
 */
export function collectLegacyPullRequestLinks(input: {
  readonly journal: Pick<Journal, "replayAggregateType">;
  readonly threads: ReadonlyArray<{
    readonly threadId: CodeThreadId;
    readonly projectId: ProjectId;
    readonly frames: ReadonlyArray<CodeOperationEventFrame>;
  }>;
}): ReadonlyArray<LegacyPullRequestLinkSeed> {
  const byKey = new Map<
    string,
    {
      readonly projectId: ProjectId;
      readonly repositoryOwner: string;
      readonly repositoryName: string;
      readonly number: number;
      url?: string;
      baseBranch?: string;
      headOwner?: string;
      headBranch?: string;
      linkedAt: string;
      readonly threadIds: CodeThreadId[];
      readonly seenThreads: Set<string>;
    }
  >();

  const record = (entry: {
    readonly projectId: ProjectId;
    readonly repositoryOwner: string;
    readonly repositoryName: string;
    readonly number: number;
    readonly url?: string;
    readonly baseBranch?: string;
    readonly headOwner?: string;
    readonly headBranch?: string;
    readonly occurredAt: string;
    readonly threadId?: CodeThreadId;
  }) => {
    const key = pullRequestDisplayLookupKey(
      entry.projectId,
      entry.repositoryOwner,
      entry.repositoryName,
      entry.number,
    );
    let existing = byKey.get(key);
    if (existing === undefined) {
      existing = {
        projectId: entry.projectId,
        repositoryOwner: entry.repositoryOwner,
        repositoryName: entry.repositoryName,
        number: entry.number,
        linkedAt: entry.occurredAt,
        threadIds: [],
        seenThreads: new Set(),
      };
      byKey.set(key, existing);
    } else if (entry.occurredAt < existing.linkedAt) {
      existing.linkedAt = entry.occurredAt;
    }
    if (entry.url !== undefined && existing.url === undefined) existing.url = entry.url;
    if (entry.baseBranch !== undefined && existing.baseBranch === undefined) {
      existing.baseBranch = entry.baseBranch;
    }
    if (entry.headOwner !== undefined && existing.headOwner === undefined) {
      existing.headOwner = entry.headOwner;
    }
    if (entry.headBranch !== undefined && existing.headBranch === undefined) {
      existing.headBranch = entry.headBranch;
    }
    if (
      entry.threadId !== undefined &&
      existing.threadIds.length < MAX_CODE_PULL_REQUEST_LINK_THREADS &&
      !existing.seenThreads.has(String(entry.threadId))
    ) {
      existing.seenThreads.add(String(entry.threadId));
      existing.threadIds.push(entry.threadId);
    }
  };

  let afterSequence = 0;
  for (;;) {
    const page = input.journal.replayAggregateType({
      aggregateType: CODE_PROJECT_PULL_REQUEST_SWITCHES_AGGREGATE,
      afterSequence,
      limit: 1_000,
    });
    for (const envelope of page) {
      afterSequence = envelope.globalSequence;
      try {
        if (envelope.eventName === CODE_PROJECT_PULL_REQUEST_MERGE_WHEN_READY_RECORDED) {
          const decoded = decodeCodeProjectPullRequestMergeWhenReadyRecorded(envelope.payload);
          record({
            projectId: decoded.target.projectId,
            repositoryOwner: decoded.target.repositoryOwner,
            repositoryName: decoded.target.repositoryName,
            number: decoded.target.number,
            occurredAt: envelope.occurredAt,
          });
        } else if (envelope.eventName === CODE_PROJECT_PULL_REQUEST_AUTO_FIX_RECORDED) {
          const decoded = decodeCodeProjectPullRequestAutoFixRecorded(envelope.payload);
          record({
            projectId: decoded.target.projectId,
            repositoryOwner: decoded.target.repositoryOwner,
            repositoryName: decoded.target.repositoryName,
            number: decoded.target.number,
            occurredAt: envelope.occurredAt,
            threadId: decoded.threadId,
          });
        } else if (envelope.eventName === CODE_PROJECT_PULL_REQUEST_WATCH_RECORDED) {
          const decoded = decodeCodeProjectPullRequestWatchRecorded(envelope.payload);
          record({
            projectId: decoded.target.projectId,
            repositoryOwner: decoded.target.repositoryOwner,
            repositoryName: decoded.target.repositoryName,
            number: decoded.target.number,
            occurredAt: envelope.occurredAt,
            threadId: decoded.threadId,
          });
        }
      } catch {
        // Ignore malformed switch records during legacy seed scan.
      }
    }
    if (page.length < 1_000) break;
  }

  for (const thread of input.threads) {
    for (const frame of thread.frames) {
      if (frame.event.kind !== "operation-result") continue;
      const result = frame.event.result;
      if (
        result.kind === "pull-request-state" &&
        (result.state === "created" || result.state === "existing" || result.state === "merged")
      ) {
        // Frames carrying forge node IDs were written after link identity
        // tracking existed, not from a pre-identity journal.
        if (result.pullRequestNodeId !== undefined) continue;
        const repo = splitRepositoryName(result.baseRepository);
        if (repo === undefined) continue;
        record({
          projectId: thread.projectId,
          repositoryOwner: repo.owner,
          repositoryName: repo.name,
          number: result.number,
          url: result.url,
          baseBranch: result.baseBranch,
          headOwner: result.headRepository,
          headBranch: result.headBranch,
          occurredAt: frame.occurredAt,
          threadId: thread.threadId,
        });
      } else if (result.kind === "pull-request-review" && result.state === "observed") {
        if (result.pullRequestNodeId !== undefined) continue;
        const repo = splitRepositoryName(result.baseRepository);
        if (repo === undefined) continue;
        record({
          projectId: thread.projectId,
          repositoryOwner: repo.owner,
          repositoryName: repo.name,
          number: result.number,
          url: result.url,
          baseBranch: result.baseBranch,
          ...(result.headRepository === "" ? {} : { headOwner: result.headRepository }),
          headBranch: result.headBranch,
          occurredAt: frame.occurredAt,
          threadId: thread.threadId,
        });
      }
    }
  }

  return [...byKey.values()].map((entry) => ({
    projectId: entry.projectId,
    repositoryOwner: entry.repositoryOwner,
    repositoryName: entry.repositoryName,
    number: entry.number,
    ...(entry.url === undefined ? {} : { url: entry.url }),
    ...(entry.baseBranch === undefined ? {} : { baseBranch: entry.baseBranch }),
    ...(entry.headOwner === undefined ? {} : { headOwner: entry.headOwner }),
    ...(entry.headBranch === undefined ? {} : { headBranch: entry.headBranch }),
    threadIds: entry.threadIds,
    linkedAt: entry.linkedAt,
  }));
}
