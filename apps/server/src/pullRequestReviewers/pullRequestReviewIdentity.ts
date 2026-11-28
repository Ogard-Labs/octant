import {
  GithubPullRequestNodeId,
  GithubRepositoryName,
  GithubRepositoryOwner,
  type PullRequestReviewTarget,
} from "@octant/contracts";
import {
  pullRequestReviewLegacyTargetKey,
  pullRequestReviewNodeTargetKey,
  pullRequestReviewTargetKey,
} from "@octant/domain";
import {
  applyPullRequestLinkEvent,
  pullRequestDisplayLookupKey,
  resolveCanonicalPullRequestLink,
  type PullRequestLinkJournalEvent,
  type PullRequestLinkRecord,
  type PullRequestLinkRegistryState,
} from "@octant/domain/pull-request-identity-policy";
import { Option, Schema } from "effect";
import type { PullRequestLinkReader } from "../code/pullRequestLinkService";

const decodeRepositoryOwner = Schema.decodeUnknownSync(GithubRepositoryOwner);
const decodeRepositoryName = Schema.decodeUnknownSync(GithubRepositoryName);
const decodeNodeIdOption = Schema.decodeUnknownOption(GithubPullRequestNodeId);

export function parsePullRequestNodeId(
  value: string | undefined,
): GithubPullRequestNodeId | undefined {
  if (value === undefined) return undefined;
  return Option.getOrUndefined(decodeNodeIdOption(value));
}

/**
 * In-memory bucket key for a linked pull request: node-ID key when GitHub's
 * node ID is known, otherwise a link-ID key while awaiting forge backfill.
 */
export function pullRequestLinkBucketKey(link: PullRequestLinkRecord): string {
  if (link.pullRequestNodeId !== undefined) {
    return pullRequestReviewNodeTargetKey(link.projectId, link.pullRequestNodeId);
  }
  return `${String(link.projectId)}:link:${String(link.linkId)}`;
}

export interface PullRequestReviewIdentityMigration {
  readonly fromKey: string;
  readonly toKey: string;
}

/**
 * Advances `linkState` by one journaled `code-pull-request-link` event and
 * returns the bucket migrations needed so reviews and guides follow repository
 * renames, node-ID backfills, and duplicate link merges without ever allowing
 * a reused repository name to inherit an earlier pull request's history.
 */
export function stepPullRequestLinkReplay(
  state: PullRequestLinkRegistryState,
  event: PullRequestLinkJournalEvent,
  sequence: number,
): {
  readonly nextState: PullRequestLinkRegistryState;
  readonly migrations: ReadonlyArray<PullRequestReviewIdentityMigration>;
} {
  const migrations: PullRequestReviewIdentityMigration[] = [];
  const addMigration = (fromKey: string, toKey: string) => {
    if (fromKey !== toKey) {
      migrations.push({ fromKey, toKey });
    }
  };

  if (event.kind === "created") {
    const legacyKey = pullRequestDisplayLookupKey(
      event.payload.projectId,
      event.payload.repositoryOwner,
      event.payload.repositoryName,
      event.payload.number,
    );
    const hadPriorOwner = state.historicalDisplayByKey.has(legacyKey);
    const nextState = applyPullRequestLinkEvent(state, event, sequence);
    const created = nextState.byId.get(String(event.payload.linkId));
    if (created !== undefined && !hadPriorOwner) {
      addMigration(legacyKey, pullRequestLinkBucketKey(created));
    }
    return { nextState, migrations };
  }

  if (event.kind === "forge-ids-backfilled") {
    const before = state.byId.get(String(event.payload.linkId));
    const nextState = applyPullRequestLinkEvent(state, event, sequence);
    const after = nextState.byId.get(String(event.payload.linkId));
    if (before !== undefined && after !== undefined) {
      addMigration(pullRequestLinkBucketKey(before), pullRequestLinkBucketKey(after));
    }
    return { nextState, migrations };
  }

  if (event.kind === "display-updated") {
    const before = state.byId.get(String(event.payload.linkId));
    const nextLegacyKey =
      before === undefined
        ? undefined
        : pullRequestDisplayLookupKey(
            before.projectId,
            event.payload.repositoryOwner,
            event.payload.repositoryName,
            event.payload.number,
          );
    const hadPriorOwner =
      nextLegacyKey === undefined ? true : state.historicalDisplayByKey.has(nextLegacyKey);
    const nextState = applyPullRequestLinkEvent(state, event, sequence);
    const after = nextState.byId.get(String(event.payload.linkId));
    if (before !== undefined && after !== undefined) {
      const destKey = pullRequestLinkBucketKey(after);
      addMigration(pullRequestLinkBucketKey(before), destKey);
      if (nextLegacyKey !== undefined && !hadPriorOwner) {
        addMigration(nextLegacyKey, destKey);
      }
    }
    return { nextState, migrations };
  }

  if (event.kind === "merged-into") {
    const survivingBefore = resolveCanonicalPullRequestLink(state, event.payload.survivingLinkId);
    const mergedBefore = state.byId.get(String(event.payload.linkId));
    const nextState = applyPullRequestLinkEvent(state, event, sequence);
    const survivingAfter = resolveCanonicalPullRequestLink(
      nextState,
      event.payload.survivingLinkId,
    );
    if (survivingAfter !== undefined) {
      const destKey = pullRequestLinkBucketKey(survivingAfter);
      if (survivingBefore !== undefined) {
        addMigration(pullRequestLinkBucketKey(survivingBefore), destKey);
      }
      if (mergedBefore !== undefined) {
        addMigration(pullRequestLinkBucketKey(mergedBefore), destKey);
      }
    }
    return { nextState, migrations };
  }

  return {
    nextState: applyPullRequestLinkEvent(state, event, sequence),
    migrations,
  };
}

export interface ResolvedPullRequestReviewIdentity {
  /** In-memory bucket key (`projectId:node:…`, `projectId:link:…`, or legacy `projectId:owner/name#n`). */
  readonly bucketKey: string;
  /** Journal key (`projectId:node:…` when node ID is known, else legacy `projectId:owner/name#n`). */
  readonly writeKey: string;
  /** Canonical display target with `pullRequestNodeId` populated when known. */
  readonly target: PullRequestReviewTarget;
  /** Earlier bucket keys that may be adopted into `bucketKey` without crossing pull requests. */
  readonly adoptKeys: ReadonlyArray<string>;
}

function aliasClaimedByEarlierLink(
  links: PullRequestLinkReader,
  link: PullRequestLinkRecord,
  legacyKey: string,
): boolean {
  for (const other of links.listForProject(link.projectId)) {
    if (String(other.linkId) === String(link.linkId)) continue;
    if (other.createdOrder >= link.createdOrder) continue;
    for (const alias of links.displayAliasesForLink(other.linkId)) {
      if (
        pullRequestDisplayLookupKey(
          other.projectId,
          alias.repositoryOwner,
          alias.repositoryName,
          alias.number,
        ) === legacyKey
      ) {
        return true;
      }
    }
  }
  return false;
}

function legacyKeyClaimedByAnyLink(
  links: PullRequestLinkReader,
  projectId: PullRequestReviewTarget["projectId"],
  legacyKey: string,
): boolean {
  for (const other of links.listForProject(projectId)) {
    for (const alias of links.displayAliasesForLink(other.linkId)) {
      if (
        pullRequestDisplayLookupKey(
          other.projectId,
          alias.repositoryOwner,
          alias.repositoryName,
          alias.number,
        ) === legacyKey
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Resolves a pull request target to its canonical display fields, stable node
 * ID key, and safe legacy read-fallback keys for reviews and guides.
 */
export function resolvePullRequestReviewIdentity(input: {
  readonly target: PullRequestReviewTarget;
  readonly pullRequestLinks?: PullRequestLinkReader | undefined;
  readonly canonicalTarget?: PullRequestReviewTarget | undefined;
  readonly pullRequestNodeId?: string | undefined;
}): ResolvedPullRequestReviewIdentity {
  const suppliedNodeId = parsePullRequestNodeId(
    input.pullRequestNodeId ??
      input.canonicalTarget?.pullRequestNodeId ??
      input.target.pullRequestNodeId,
  );
  const lookupTarget = input.canonicalTarget ?? input.target;
  const link = input.pullRequestLinks?.resolveLink({
    projectId: lookupTarget.projectId,
    repositoryOwner: lookupTarget.repositoryOwner,
    repositoryName: lookupTarget.repositoryName,
    number: lookupTarget.number,
    ...(suppliedNodeId === undefined ? {} : { pullRequestNodeId: suppliedNodeId }),
  });

  if (link !== undefined) {
    const nodeId = link.pullRequestNodeId ?? suppliedNodeId;
    const canonicalTarget: PullRequestReviewTarget = {
      projectId: link.projectId,
      repositoryOwner: decodeRepositoryOwner(link.repositoryOwner),
      repositoryName: decodeRepositoryName(link.repositoryName),
      number: link.number,
      ...(nodeId === undefined ? {} : { pullRequestNodeId: nodeId }),
    };
    const linkKey = `${String(link.projectId)}:link:${String(link.linkId)}`;
    const bucketKey =
      nodeId !== undefined ? pullRequestReviewNodeTargetKey(link.projectId, nodeId) : linkKey;
    const writeKey =
      nodeId !== undefined
        ? pullRequestReviewNodeTargetKey(link.projectId, nodeId)
        : pullRequestReviewLegacyTargetKey(canonicalTarget);
    const adoptKeys: string[] = [];
    const seen = new Set<string>([bucketKey]);
    if (!seen.has(linkKey)) {
      seen.add(linkKey);
      adoptKeys.push(linkKey);
    }
    if (input.pullRequestLinks !== undefined) {
      for (const alias of input.pullRequestLinks.displayAliasesForLink(link.linkId)) {
        const legacyKey = pullRequestDisplayLookupKey(
          link.projectId,
          alias.repositoryOwner,
          alias.repositoryName,
          alias.number,
        );
        if (seen.has(legacyKey)) continue;
        if (aliasClaimedByEarlierLink(input.pullRequestLinks, link, legacyKey)) continue;
        seen.add(legacyKey);
        adoptKeys.push(legacyKey);
      }
    }
    return { bucketKey, writeKey, target: canonicalTarget, adoptKeys };
  }

  const canonicalTarget: PullRequestReviewTarget =
    suppliedNodeId === undefined
      ? lookupTarget
      : { ...lookupTarget, pullRequestNodeId: suppliedNodeId };
  const bucketKey = pullRequestReviewTargetKey(canonicalTarget);
  const adoptKeys: string[] = [];
  if (suppliedNodeId !== undefined) {
    const seen = new Set<string>([bucketKey]);
    for (const candidate of [
      pullRequestReviewLegacyTargetKey(input.target),
      pullRequestReviewLegacyTargetKey(lookupTarget),
    ]) {
      if (seen.has(candidate)) continue;
      if (
        input.pullRequestLinks !== undefined &&
        legacyKeyClaimedByAnyLink(input.pullRequestLinks, canonicalTarget.projectId, candidate)
      ) {
        continue;
      }
      seen.add(candidate);
      adoptKeys.push(candidate);
    }
  }
  return {
    bucketKey,
    writeKey: bucketKey,
    target: canonicalTarget,
    adoptKeys,
  };
}
