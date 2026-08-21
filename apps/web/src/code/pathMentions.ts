/**
 * `@file` mentions in the Code and Work composers.
 *
 * Completing a path writes it into the draft as `@path` text. The turn also
 * names the selected paths so the host can re-check the bound root and read
 * the file itself. The picker only offers what a confined listing already
 * returned; it grants nothing by naming a file.
 */

export interface PathMentionCandidate {
  readonly path: string;
  readonly kind: "file" | "directory";
}

export interface PathMentionQuery {
  /** Index of the `@` that opened this mention. */
  readonly start: number;
  /** Text typed after the `@`, used to filter candidates. */
  readonly query: string;
}

export const MAX_PATH_MENTION_CANDIDATES = 8;

/**
 * Finds the `@…` token the caret sits in, if any.
 *
 * A mention only opens at a word boundary so an email address or a decorator
 * mid-word does not turn into a picker, and it closes at whitespace so the
 * token stays one path.
 */
export function readPathMentionQuery(draft: string, caret: number): PathMentionQuery | undefined {
  if (caret < 0 || caret > draft.length) return undefined;
  const before = draft.slice(0, caret);
  const at = before.lastIndexOf("@");
  if (at === -1) return undefined;
  const preceding = at === 0 ? "" : before.charAt(at - 1);
  if (preceding !== "" && !/\s/.test(preceding)) return undefined;
  const query = before.slice(at + 1);
  if (/\s/.test(query)) return undefined;
  return { start: at, query };
}

function score(candidate: PathMentionCandidate, query: string): number {
  const path = candidate.path.toLocaleLowerCase();
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (query === "") return candidate.kind === "directory" ? 1 : 0;
  if (name.startsWith(query)) return 0;
  if (path.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (path.includes(query)) return 3;
  return Number.POSITIVE_INFINITY;
}

/**
 * Ranks candidates for a query: closest match first, then shortest path, so the
 * top suggestion is the one the user most likely meant.
 */
export function rankPathMentionCandidates(
  candidates: ReadonlyArray<PathMentionCandidate>,
  query: string,
  limit: number = MAX_PATH_MENTION_CANDIDATES,
): ReadonlyArray<PathMentionCandidate> {
  const needle = query.toLocaleLowerCase();
  return candidates
    .map((candidate) => ({ candidate, rank: score(candidate, needle) }))
    .filter((entry) => Number.isFinite(entry.rank))
    .sort(
      (left, right) =>
        left.rank - right.rank ||
        left.candidate.path.length - right.candidate.path.length ||
        left.candidate.path.localeCompare(right.candidate.path),
    )
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

export interface AppliedPathMention {
  readonly draft: string;
  readonly caret: number;
}

/**
 * Replaces the open `@…` token with the chosen path. A directory keeps its
 * trailing slash so the user can keep typing into it.
 */
export function applyPathMention(
  draft: string,
  mention: PathMentionQuery,
  candidate: PathMentionCandidate,
): AppliedPathMention {
  const after = draft.slice(mention.start + 1 + mention.query.length);
  const suffix =
    candidate.kind === "directory" ? "/" : after.length > 0 && /^\s/.test(after) ? "" : " ";
  const replacement = `@${candidate.path}${suffix}`;
  return {
    draft: `${draft.slice(0, mention.start)}${replacement}${after}`,
    caret: mention.start + replacement.length,
  };
}
