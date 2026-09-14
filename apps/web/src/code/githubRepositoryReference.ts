/**
 * The owner/repository pairs a person may type or paste into the GitHub
 * repository flow. A pasted github.com URL is reduced to its owner and name
 * here; no URL ever reaches the server, which observes the live repository
 * itself before anything is cloned.
 */

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const NAME_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;

export interface GithubRepositoryReference {
  readonly owner: string;
  readonly name: string;
}

export function parseGithubRepositoryReference(
  input: string,
): GithubRepositoryReference | undefined {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (trimmed === "") return undefined;

  const match = /^(?:https:\/\/)?(?:www\.)?github\.com\/([^/?#\s]+)\/([^/?#\s]+)$/.exec(trimmed);
  if (match !== null) {
    return referenceFromParts(match[1] ?? "", match[2] ?? "");
  }

  // A bare `owner/name` is the same reference without the URL dressing.
  const parts = trimmed.split("/");
  if (parts.length === 2) {
    return referenceFromParts(parts[0] ?? "", parts[1] ?? "");
  }
  return undefined;
}

function referenceFromParts(owner: string, rawName: string): GithubRepositoryReference | undefined {
  const name = rawName.replace(/\.git$/i, "");
  if (!OWNER_PATTERN.test(owner) || !NAME_PATTERN.test(name)) return undefined;
  return { owner, name };
}
