import {
  lookupClosedToolCatalogEntry,
  MAX_NAMED_INGESTED_SOURCES,
  nativeHarnessToolCapabilityId,
  NATIVE_HARNESS_TOOL_NAMES,
  type ContentOrigin,
  type ContentProvenance,
  type ThreadExternalContentTaint,
  type ToolCapabilityId,
} from "@octant/contracts";

/**
 * Untrusted-content policy helpers for Security S2.
 * Consumed by the tool-call policy engine step 7 (S1) and approval paths.
 * Canonical: docs/security/security-architecture-threat-model.md § Untrusted-Content Policy
 * Approved Decision #3: taint scope is thread lifetime (does not clear on session/turn).
 */

/** Design §8.4 approval categories. */
export type ToolApprovalClass =
  | "project-file-writes"
  | "shell-commands"
  | "network-access"
  | "external-application-observation-or-control"
  | "destructive-or-irreversible"
  | "credential-or-secret-access"
  | "access-outside-selected-project"
  | "privilege-expansion-or-sandbox-change";

const IRREVERSIBLE_OR_AUTHORITY_BEARING = new Set<ToolApprovalClass>([
  "destructive-or-irreversible",
  "credential-or-secret-access",
  "access-outside-selected-project",
  "privilege-expansion-or-sandbox-change",
]);

export type StandingApprovalGrant = "none" | "session" | "remembered-full-access";

export type ThreadContentTaintEvent =
  | {
      readonly kind: "content-ingested";
      readonly provenance: ContentProvenance;
    }
  | { readonly kind: "session-boundary" }
  | { readonly kind: "turn-boundary" };

export type TaintedApprovalDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "allow-standing-grant" }
  | {
      readonly kind: "prompt";
      readonly reason: "tainted-thread-requires-fresh-confirmation";
      readonly prompt: string;
      readonly ignoredStandingGrant: StandingApprovalGrant;
    };

export type ExternalContentIngestionDecision =
  | { readonly kind: "record" }
  | { readonly kind: "already-recorded" }
  | { readonly kind: "ignore"; readonly reason: "not-tainting" }
  | { readonly kind: "refuse"; readonly reason: "unauthorized" };

export function emptyThreadContentTaint(): ThreadExternalContentTaint {
  return { externalContentIngested: false, ingestedSources: [] };
}

/** Origins that mark the thread as having ingested external content. */
export function originTaintsThread(origin: ContentOrigin): boolean {
  return origin === "tool-result" || origin === "external-content";
}

/**
 * Fold provenance events into the thread-lifetime taint projection.
 * Session and turn boundaries never clear `externalContentIngested`.
 */
export function projectThreadContentTaint(
  state: ThreadExternalContentTaint,
  event: ThreadContentTaintEvent,
): ThreadExternalContentTaint {
  if (event.kind === "session-boundary" || event.kind === "turn-boundary") {
    return state;
  }
  if (!originTaintsThread(event.provenance.origin)) {
    return state;
  }
  const sourceLabel = event.provenance.sourceLabel;
  if (state.ingestedSources.includes(sourceLabel)) {
    return { externalContentIngested: true, ingestedSources: state.ingestedSources };
  }
  if (state.ingestedSources.length >= MAX_NAMED_INGESTED_SOURCES) {
    return { externalContentIngested: true, ingestedSources: state.ingestedSources };
  }
  return {
    externalContentIngested: true,
    ingestedSources: [...state.ingestedSources, sourceLabel],
  };
}

/**
 * Whether a tainting ingestion should append a journal event.
 * Unauthorized callers are refused before origin is considered, so a denied
 * caller cannot distinguish a tainting payload from a clean one.
 */
export function decideExternalContentIngestion(input: {
  readonly authorized: boolean;
  readonly origin: ContentOrigin;
  readonly alreadyRecorded: boolean;
}): ExternalContentIngestionDecision {
  if (!input.authorized) {
    return { kind: "refuse", reason: "unauthorized" };
  }
  if (!originTaintsThread(input.origin)) {
    return { kind: "ignore", reason: "not-tainting" };
  }
  if (input.alreadyRecorded) {
    return { kind: "already-recorded" };
  }
  return { kind: "record" };
}

/**
 * Whether a successful native harness tool result taints its thread. Only a
 * tool the catalog marks as bringing in outside content does. A delegate call
 * is outside content only when `collect` hands back a finished child's reply:
 * starting, listing, or waiting on children, and a `collect` that finds the
 * child still running, return the host's own records. A name the catalog does
 * not know taints, so a new tool cannot slip outside content in unmarked.
 */
export function nativeHarnessResultTaintsThread(input: {
  readonly toolName: string;
  readonly arguments: unknown;
  readonly result: unknown;
}): boolean {
  const name = NATIVE_HARNESS_TOOL_NAMES.find((candidate) => candidate === input.toolName);
  if (name === undefined) return true;
  const entry = lookupClosedToolCatalogEntry({
    id: nativeHarnessToolCapabilityId(name) as ToolCapabilityId,
    version: 1,
  });
  if (entry === undefined) return true;
  if (name === "delegate") {
    return (
      fieldOf(input.arguments, "operation") === "collect" &&
      fieldOf(input.result, "status") === "completed"
    );
  }
  return entry.resultTaintsThread;
}

function fieldOf(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? (value as Readonly<Record<string, unknown>>)[key]
    : undefined;
}

/** A search query longer than this is refused on a tainted thread. */
export const MAX_SEARCH_QUERY_LENGTH_UNDER_TAINT = 200;

/** Why a search query on a tainted thread looks like it carries data. */
export type SearchQueryRefusalDetail =
  | "contains a URL"
  | "contains an email address"
  | "contains a hex run"
  | "contains a percent-encoded run"
  | "contains a base64 run"
  | "contains a long high-entropy token"
  | "is longer than 200 characters";

export type SearchQueryRefusal = {
  readonly reason: "search-query-refused-under-taint";
  readonly detail: SearchQueryRefusalDetail;
};

// A scheme, a `www.` host, a dotted name followed by a path, query, fragment,
// or a port and one of those, or an IPv4 address followed by a port or path.
// A bare version such as `19.2` or `v1.2.3/dist` is not a URL: the last label
// of a name must be letters, a punycode `xn--` label, and may carry a root
// dot (`host.example./path`). A port alone after a name is not enough, because
// `Component.test.tsx:42` is a file and line.
const URL_PATTERN =
  /[a-z][a-z0-9+.-]*:\/\/|\bwww\.|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:[a-z]{2,}|xn--[a-z0-9-]+)\.?(?::\d{1,5})?[/?#]|\b\d{1,3}(?:\.\d{1,3}){3}[:/]/i;
const EMAIL_PATTERN = /[^\s@]+@[^\s@]+\.[^\s@]+/;
// Sixteen hex digits is a 64-bit value: longer than a short commit SHA, and
// as long as a card number or the start of a key.
const HEX_RUN_PATTERN = /[0-9a-f]{16,}/i;
// Three escaped bytes in a row: `%68%75%6E` or `\x68\x75\x6e` is text spelled
// to slip past the hex and base64 checks, never part of a question.
const ESCAPED_BYTE_RUN_PATTERN = /(?:(?:%|\\x)[0-9a-f]{2}){3,}/i;
const BASE64_RUN_PATTERN = /[A-Za-z0-9+/]{24,}={0,2}|[A-Za-z0-9+/]{16,}={1,2}/g;
const MIN_HIGH_ENTROPY_TOKEN_LENGTH = 20;
const MIN_HIGH_ENTROPY_BITS_PER_CHARACTER = 3.5;

/**
 * Why a `web-search` query from a tainted thread must not leave, or
 * `undefined` when it reads like an ordinary question. Outside content the
 * thread took in can tell the model to smuggle what it has read into a query,
 * and the endpoint sees every query; refusing what looks like data — a URL,
 * an address, a key, an encoded run, a long blob — keeps the search useful
 * without asking a person on every call. A short query can still carry a few
 * words, but only to the search endpoint the person configured.
 */
export function searchQueryRefusalUnderTaint(query: string): SearchQueryRefusal | undefined {
  const detail = searchQueryDataSign(query);
  return detail === undefined ? undefined : { reason: "search-query-refused-under-taint", detail };
}

function searchQueryDataSign(query: string): SearchQueryRefusalDetail | undefined {
  if (query.length > MAX_SEARCH_QUERY_LENGTH_UNDER_TAINT) return "is longer than 200 characters";
  if (URL_PATTERN.test(query)) return "contains a URL";
  if (EMAIL_PATTERN.test(query)) return "contains an email address";
  if (HEX_RUN_PATTERN.test(query)) return "contains a hex run";
  if (ESCAPED_BYTE_RUN_PATTERN.test(query)) return "contains a percent-encoded run";
  for (const run of query.match(BASE64_RUN_PATTERN) ?? []) {
    // Real base64 mixes cases and digits; a long identifier or word does not.
    if (run.endsWith("=") || (/[a-z]/.test(run) && /[A-Z]/.test(run) && /\d/.test(run))) {
      return "contains a base64 run";
    }
  }
  // Path, file, and sentence punctuation separate words; `-` and `_` sit
  // inside keys, so they stay part of the token.
  for (const token of query.split(/[\s.,:;/\\()[\]{}"'`<>|!?]+/)) {
    if (
      token.length >= MIN_HIGH_ENTROPY_TOKEN_LENGTH &&
      /[a-z]/i.test(token) &&
      /\d/.test(token) &&
      shannonBitsPerCharacter(token) >= MIN_HIGH_ENTROPY_BITS_PER_CHARACTER
    ) {
      return "contains a long high-entropy token";
    }
  }
  return undefined;
}

function shannonBitsPerCharacter(text: string): number {
  const counts = new Map<string, number>();
  for (const character of text) counts.set(character, (counts.get(character) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const share = count / text.length;
    bits -= share * Math.log2(share);
  }
  return bits;
}

export function isIrreversibleOrAuthorityBearingApprovalClass(
  approvalClass: ToolApprovalClass,
): boolean {
  return IRREVERSIBLE_OR_AUTHORITY_BEARING.has(approvalClass);
}

export function formatTaintedApprovalPrompt(ingestedSources: ReadonlyArray<string>): string {
  const named =
    ingestedSources.length === 0 ? "unknown external sources" : ingestedSources.join(", ");
  return `This thread ingested external content (${named}). Confirm this irreversible or authority-bearing action explicitly; standing Full access and session grants do not apply.`;
}

/**
 * Policy step-7 helper: on a tainted thread, irreversible/authority-bearing
 * approval classes require fresh per-action confirmation. Standing session
 * grants and remembered Full access do not silently satisfy them.
 */
export function resolveTaintedApproval(input: {
  readonly taint: ThreadExternalContentTaint;
  readonly approvalClass: ToolApprovalClass;
  readonly standingGrant: StandingApprovalGrant;
  readonly freshPerActionConfirmation: boolean;
}): TaintedApprovalDecision {
  if (
    !input.taint.externalContentIngested ||
    !isIrreversibleOrAuthorityBearingApprovalClass(input.approvalClass)
  ) {
    // Taint rule does not constrain this decision; standing grants may apply.
    return { kind: "allow-standing-grant" };
  }

  if (input.freshPerActionConfirmation) {
    return { kind: "allow" };
  }

  // Standing session grants and remembered Full access never silently satisfy
  // irreversible/authority-bearing classes on a tainted thread.
  return {
    kind: "prompt",
    reason: "tainted-thread-requires-fresh-confirmation",
    prompt: formatTaintedApprovalPrompt(input.taint.ingestedSources),
    ignoredStandingGrant: input.standingGrant,
  };
}
