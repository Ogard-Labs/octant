import type { ConnectedGitHubRepository } from "@octant/contracts/projects";
import { parseGithubRemote } from "@octant/domain/github-remote-identity";

/**
 * Resolve one safe GitHub identity from a checkout's observed remotes.
 *
 * The caller supplies only Git's already-observed fetch/push URLs. This
 * function never returns either URL, and it refuses anything credentialed,
 * non-GitHub, malformed, or ambiguous. Exactly one unambiguous GitHub identity
 * may be projected.
 */
export function resolveConnectedGitHubRepository(
  remotes: ReadonlyArray<{
    readonly name: string;
    readonly fetchUrl: string;
    readonly pushUrl: string;
    readonly credentialed?: boolean;
  }>,
): ConnectedGitHubRepository | undefined {
  const candidates: ConnectedGitHubRepository[] = [];
  for (const remote of remotes) {
    const fetch = parseGitHubRemote(remote.fetchUrl);
    const push = parseGitHubRemote(remote.pushUrl);
    if (
      remote.credentialed === true ||
      fetch === undefined ||
      push === undefined ||
      !sameIdentity(fetch, push)
    ) {
      return undefined;
    }
    candidates.push(fetch);
  }
  const identities = uniqueIdentities(candidates);
  return identities.length === 1 ? identities[0] : undefined;
}

type ParsedIdentity = ConnectedGitHubRepository;

function parseGitHubRemote(value: string): ConnectedGitHubRepository | undefined {
  const parsed = parseGithubRemote(value);
  return parsed.status === "resolved"
    ? { host: "github.com", owner: parsed.identity.owner, repository: parsed.identity.name }
    : undefined;
}

function sameIdentity(left: ConnectedGitHubRepository, right: ConnectedGitHubRepository) {
  return (
    left.host === right.host &&
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.repository.toLowerCase() === right.repository.toLowerCase()
  );
}

function uniqueIdentities(candidates: ReadonlyArray<ParsedIdentity>) {
  const identities: ParsedIdentity[] = [];
  for (const candidate of candidates) {
    if (!identities.some((identity) => sameIdentity(identity, candidate))) {
      identities.push({
        host: candidate.host,
        owner: candidate.owner,
        repository: candidate.repository,
      });
    }
  }
  return identities;
}
