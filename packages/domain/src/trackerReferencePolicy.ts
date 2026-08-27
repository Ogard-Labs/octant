import { MAX_TRACKER_REFERENCES_PER_RESOLUTION, type TrackerReference } from "@octant/contracts";

/**
 * One recognized span inside a text run. `start`/`end` are string offsets so a
 * renderer can replace exactly the typed token without re-scanning.
 */
export interface TrackerReferenceSpan {
  readonly start: number;
  readonly end: number;
  readonly reference: TrackerReference;
}

// Keep these aligned with `GithubRepositoryOwner` / `GithubRepositoryName`.
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const NAME_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;
const TRACKER_KEY_IDENTITY = /^[A-Z][A-Z0-9]{1,9}-[0-9]{1,10}$/;

// GitHub form requires owner/name#number. A leading path separator is refused
// so a github.com URL fragment is not mistaken for a shorthand.
const GITHUB_CANDIDATE =
  /(?<![A-Za-z0-9_.\-/])([A-Za-z0-9-]{1,39})\/([A-Za-z0-9_.-]{1,100})#([1-9][0-9]{0,8})(?![A-Za-z0-9])/g;

// Tracker-key form is `#?[A-Z][A-Z0-9]{1,9}-[0-9]{1,10}`. Bare `#123` is excluded
// because it is already the `#thread` mention token: unmatched `#text` stays
// ordinary text, and stealing `#123` would reopen or suppress that typeahead.
const TRACKER_KEY_CANDIDATE =
  /(?<![A-Za-z0-9._#/[\]-])(#?[A-Z][A-Z0-9]{1,9}-[0-9]{1,10})(?![A-Za-z0-9])/g;

/**
 * Scan a text run for tracker-reference spans. The grammar is conservative on
 * purpose: `#thread` mentions already own unmatched `#text`, so this recognizer
 * never claims a bare `#123` or a `#word` without a team-prefix form.
 */
export function recognizeTrackerReferences(text: string): ReadonlyArray<TrackerReferenceSpan> {
  if (text.length === 0) return [];
  const spans: TrackerReferenceSpan[] = [];
  collectGithubSpans(text, spans);
  collectTrackerKeySpans(text, spans);
  spans.sort((left, right) => left.start - right.start);
  return spans.slice(0, MAX_TRACKER_REFERENCES_PER_RESOLUTION);
}

function collectGithubSpans(text: string, spans: TrackerReferenceSpan[]): void {
  for (const match of text.matchAll(GITHUB_CANDIDATE)) {
    const raw = match[0];
    const owner = match[1];
    const name = match[2];
    const numberText = match[3];
    const start = match.index;
    if (
      owner === undefined ||
      name === undefined ||
      numberText === undefined ||
      start === undefined
    ) {
      continue;
    }
    if (!OWNER_PATTERN.test(owner) || !NAME_PATTERN.test(name)) continue;
    const number = Number.parseInt(numberText, 10);
    if (!Number.isSafeInteger(number) || number < 1) continue;
    const reference: TrackerReference = {
      patternKind: "github-issue-or-pull",
      raw,
      owner,
      name,
      number,
    };
    spans.push({ start, end: start + raw.length, reference });
  }
}

function collectTrackerKeySpans(text: string, spans: TrackerReferenceSpan[]): void {
  for (const match of text.matchAll(TRACKER_KEY_CANDIDATE)) {
    const raw = match[0];
    const start = match.index;
    if (start === undefined) continue;
    const end = start + raw.length;
    if (overlaps(spans, start, end)) continue;
    const key = raw.startsWith("#") ? raw.slice(1) : raw;
    if (!TRACKER_KEY_IDENTITY.test(key)) continue;
    const reference: TrackerReference = {
      patternKind: "tracker-key",
      raw,
      key,
    };
    spans.push({ start, end, reference });
  }
}

function overlaps(spans: ReadonlyArray<TrackerReferenceSpan>, start: number, end: number): boolean {
  return spans.some((span) => start < span.end && end > span.start);
}
