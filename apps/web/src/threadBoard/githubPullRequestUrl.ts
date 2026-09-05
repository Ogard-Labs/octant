import {
  decodeThreadBoardPullRequestIdentity,
  type ThreadBoardPullRequestIdentity,
} from "@octant/contracts";

/**
 * The github.com address of an exact pull-request identity, or nothing.
 *
 * The address is built from the identity rather than carried as a string, so
 * there is no URL for a stale snapshot or a hostile title to smuggle in. It is
 * refused when the identity itself does not decode (an owner or repository the
 * contract would never accept) or when the built address does not round-trip
 * to exactly `github.com/<owner>/<name>/pull/<number>` — which is what rules
 * out credentials, a different host, or a query the owner name tried to carry.
 */
export function githubPullRequestUrl(identity: ThreadBoardPullRequestIdentity): string | undefined {
  try {
    decodeThreadBoardPullRequestIdentity(identity);
  } catch {
    return undefined;
  }
  const path = `/${identity.repositoryOwner}/${identity.repositoryName}/pull/${String(identity.number)}`;
  let url: URL;
  try {
    url = new URL(`https://github.com${path}`);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.pathname !== path
  ) {
    return undefined;
  }
  return url.toString();
}
