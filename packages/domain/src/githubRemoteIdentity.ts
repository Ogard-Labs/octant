export interface GithubRemoteIdentity {
  readonly owner: string;
  readonly name: string;
}

export type GithubRemoteParseResult =
  | { readonly status: "resolved"; readonly identity: GithubRemoteIdentity }
  | { readonly status: "unconnected" };

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const NAME_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;
const SCP_REMOTE = /^git@github\.com:([^/:]+\/[^/]+?)(?:\.git)?$/;

/**
 * Resolve a git remote to a github.com owner/name, or fail closed.
 * HTTPS, SCP-style, and ssh:// remotes are accepted. Userinfo, credentials,
 * GitHub Enterprise, and any host other than github.com stay unconnected.
 */
export function parseGithubRemote(remote: string): GithubRemoteParseResult {
  const trimmed = remote.trim();
  if (trimmed.length === 0 || trimmed.includes("\0")) return { status: "unconnected" };

  const scp = SCP_REMOTE.exec(trimmed);
  if (scp?.[1] !== undefined) return identityFromPath(scp[1]);

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "ssh:") return { status: "unconnected" };
    if (url.hostname.toLowerCase() !== "github.com") return { status: "unconnected" };
    if (url.password !== "") return { status: "unconnected" };
    if (url.search !== "" || url.hash !== "") return { status: "unconnected" };
    // HTTPS userinfo is always credential material. ssh:// may carry the
    // conventional `git` login; any other username is treated as userinfo.
    if (url.protocol === "https:" && url.username !== "") return { status: "unconnected" };
    if (url.protocol === "ssh:" && url.username !== "" && url.username !== "git") {
      return { status: "unconnected" };
    }
    const path = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
    return identityFromPath(path);
  } catch {
    return { status: "unconnected" };
  }
}

function identityFromPath(path: string): GithubRemoteParseResult {
  const segments = path.split("/");
  if (segments.length !== 2) return { status: "unconnected" };
  const [owner, name] = segments;
  if (owner === undefined || name === undefined) return { status: "unconnected" };
  if (!OWNER_PATTERN.test(owner) || !NAME_PATTERN.test(name)) return { status: "unconnected" };
  if (owner.includes("..") || name.includes("..")) return { status: "unconnected" };
  return { status: "resolved", identity: { owner, name } };
}
