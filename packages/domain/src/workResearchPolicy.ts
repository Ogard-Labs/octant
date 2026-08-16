import type {
  WorkResearchBrief,
  WorkResearchBriefStatus,
  WorkSourceAvailability,
  WorkSourceKind,
} from "@octant/contracts/work-research";
import type { PreviewSourceVersion } from "@octant/contracts/previews";
import { classifySourceAvailability } from "./previewPolicy";

/**
 * Re-exported source-availability classifier so the Work research provenance
 * policy has one discoverable entry point. A research source re-runs this
 * against its known source version before backing a new claim; a stale or
 * unavailable source never silently supports a conclusion.
 */
export type ResearchSourceFreshness = "fresh" | "stale" | "unavailable";

/**
 * Classify a research source's freshness from its known `PreviewSourceVersion`
 * and a current observation. `fresh` means the current observation matches the
 * known version; `stale` means the source changed since capture; `unavailable`
 * means the source could not be re-observed. Revoked authority is handled
 * separately by `classifyResearchAuthority` because revocation is a host
 * decision, not a version observation.
 */
export function classifySourceFreshness(input: {
  readonly known: PreviewSourceVersion | undefined;
  readonly current: PreviewSourceVersion | undefined;
}): ResearchSourceFreshness {
  const availability = classifySourceAvailability(input.current, input.known);
  if (availability === "available") return "fresh";
  if (availability === "stale") return "stale";
  return "unavailable";
}

/**
 * Normalize a source identity for duplicate detection. Two sources with the
 * same kind and normalized opaque id are duplicates. The opaque id is
 * case-normalized and trimmed so cosmetic differences do not bypass the check.
 */
export function normalizeSourceIdentity(kind: WorkSourceKind, sourceRef: string): string {
  return `${kind}:${sourceRef.trim().normalize("NFC").toLowerCase()}`;
}

/**
 * Detect a duplicate source within a brief's recorded source set. Returns the
 * existing source id that conflicts, or `undefined` when the source is new.
 * The host supplies the already-recorded sources as kind+ref pairs so this
 * pure check never needs the full source records.
 */
export function detectDuplicateSource(
  existing: ReadonlyArray<{ readonly kind: WorkSourceKind; readonly sourceRef: string }>,
  candidate: { readonly kind: WorkSourceKind; readonly sourceRef: string },
): boolean {
  const candidateIdentity = normalizeSourceIdentity(candidate.kind, candidate.sourceRef);
  return existing.some(
    (entry) => normalizeSourceIdentity(entry.kind, entry.sourceRef) === candidateIdentity,
  );
}

/**
 * Citation integrity validation result. `valid` means every claim anchor
 * resolves to recorded evidence; `unsupported` means one or more anchors
 * dangle. Unsupported claims are flagged honestly, not silently dropped.
 */
export type CitationIntegrityResult =
  | { readonly kind: "valid" }
  | { readonly kind: "unsupported"; readonly danglingAnchors: ReadonlyArray<string> };

/**
 * Validate citation integrity for a set of claims against recorded evidence.
 * Every claim's citation anchors must resolve to an evidence entry's citation
 * anchor for a source that is currently `fresh`. Anchors that resolve only to
 * stale, unavailable, or revoked sources, or to no evidence at all, are
 * dangling and the claim is unsupported. Returns the dangling anchors so the
 * server can flag the claim's `unsupported` field honestly.
 */
export function validateCitationIntegrity(input: {
  readonly evidence: ReadonlyArray<{
    readonly citationAnchor: string;
    readonly sourceId: string;
  }>;
  readonly sources: ReadonlyArray<{
    readonly sourceId: string;
    readonly availability: WorkSourceAvailability;
  }>;
  readonly claims: ReadonlyArray<{
    readonly citationAnchors: ReadonlyArray<string>;
  }>;
}): CitationIntegrityResult {
  const freshSourceIds = new Set(
    input.sources
      .filter((source) => source.availability === "fresh")
      .map((source) => source.sourceId),
  );
  const supportedAnchors = new Set(
    input.evidence
      .filter((entry) => freshSourceIds.has(entry.sourceId))
      .map((entry) => entry.citationAnchor),
  );
  const dangling = new Set<string>();
  for (const claim of input.claims) {
    for (const anchor of claim.citationAnchors) {
      if (!supportedAnchors.has(anchor)) {
        dangling.add(anchor);
      }
    }
  }
  if (dangling.size === 0) return { kind: "valid" };
  return { kind: "unsupported", danglingAnchors: [...dangling] };
}

/**
 * Determine whether a claim is unsupported given the recorded evidence and
 * source availability. Convenience wrapper around `validateCitationIntegrity`
 * for a single claim. A claim with no anchors is unsupported.
 */
export function isClaimUnsupported(input: {
  readonly evidence: ReadonlyArray<{ readonly citationAnchor: string; readonly sourceId: string }>;
  readonly sources: ReadonlyArray<{
    readonly sourceId: string;
    readonly availability: WorkSourceAvailability;
  }>;
  readonly claim: { readonly citationAnchors: ReadonlyArray<string> };
}): boolean {
  if (input.claim.citationAnchors.length === 0) return true;
  const result = validateCitationIntegrity({
    evidence: input.evidence,
    sources: input.sources,
    claims: [input.claim],
  });
  return result.kind === "unsupported";
}

/**
 * Research authority decision. Research is read-only, so authority is binary:
 * `allowed` or `denied`. There is no `needs-approval` posture because no
 * mutation of an external system ever occurs. `denied` carries a bounded
 * reason so the server can return a typed `unauthorized` result without
 * leaking host paths, credentials, or metadata beyond opaque ids.
 */
export type ResearchAuthorityDecision =
  | { readonly kind: "allowed" }
  | {
      readonly kind: "denied";
      readonly reason:
        | "source-revoked"
        | "source-stale"
        | "source-unavailable"
        | "source-kind-not-allowed"
        | "source-outside-brief"
        | "source-budget-exceeded"
        | "brief-not-found"
        | "brief-finalized"
        | "brief-cancelled";
    };

/**
 * Fail-closed research authority check. The host supplies the brief, the
 * recorded sources, the candidate source kind, and the source's current
 * availability. The check denies when:
 * - the brief is missing, finalized, or cancelled (no further transitions);
 * - the source kind is not in the brief's allowed policy;
 * - the source set already meets the brief's `maxSources` budget;
 * - the source is revoked, stale, or unavailable (cannot back new evidence).
 * Revoked sources deny with `source-revoked` so the server returns
 * `unauthorized` with only opaque ids — never content-derived metadata.
 */
export function classifyResearchAuthority(input: {
  readonly brief: WorkResearchBrief | undefined;
  readonly recordedSourceCount: number;
  readonly candidateSourceKind: WorkSourceKind;
  readonly candidateAvailability: WorkSourceAvailability;
  readonly isExistingSource: boolean;
}): ResearchAuthorityDecision {
  const brief = input.brief;
  if (brief === undefined) return { kind: "denied", reason: "brief-not-found" };
  if (brief.status === "finalized") return { kind: "denied", reason: "brief-finalized" };
  if (brief.status === "cancelled") return { kind: "denied", reason: "brief-cancelled" };

  if (input.candidateAvailability === "revoked") {
    return { kind: "denied", reason: "source-revoked" };
  }
  if (input.candidateAvailability === "stale") {
    return { kind: "denied", reason: "source-stale" };
  }
  if (input.candidateAvailability === "unavailable") {
    return { kind: "denied", reason: "source-unavailable" };
  }

  if (!input.isExistingSource) {
    if (!brief.sourcePolicy.allowedKinds.includes(input.candidateSourceKind)) {
      return { kind: "denied", reason: "source-kind-not-allowed" };
    }
    if (input.recordedSourceCount >= brief.sourcePolicy.maxSources) {
      return { kind: "denied", reason: "source-budget-exceeded" };
    }
  }
  return { kind: "allowed" };
}

/**
 * Evidence leakage classification. Rejects host paths, credentials, and
 * authority tokens in bounded excerpts. The excerpt is already
 * path-separator- and scheme-free by contract; this pure check is the runtime
 * defense against a host path or credential reaching the journal through a
 * server bug. A leaked excerpt fails closed and is never recorded.
 */
export type EvidenceLeakageResult = "clean" | "leaked";

const LEAKAGE_PATTERNS = [
  /\/Users\//i,
  /\/home\//i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsk-[A-Za-z0-9]{20,}\b/,
  /\bBearer\s+[A-Za-z0-9._-]+/i,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i,
];

export function classifyEvidenceLeakage(excerpt: string): EvidenceLeakageResult {
  for (const pattern of LEAKAGE_PATTERNS) {
    if (pattern.test(excerpt)) return "leaked";
  }
  return "clean";
}

/**
 * Excerpt support classification. `present` means the excerpt's exact text
 * occurs in the source; `absent` means it does not and therefore cannot be
 * recorded as source-backed evidence.
 */
export type ExcerptSupportResult = "present" | "absent";

/**
 * Collapse every run of whitespace to one space and trim. Applied identically
 * to the source text and the excerpt, this is the only difference the match
 * tolerates: line wrapping, indentation, and CRLF carry no meaning a reader
 * could cite, and a bounded excerpt cannot reproduce them anyway. NFC
 * normalization makes composed and decomposed spellings of the same characters
 * compare equal. Nothing else is folded — case, punctuation, and word order are
 * compared exactly.
 */
function normalizeForExcerptMatch(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

/**
 * Decide whether an excerpt is genuinely supported by the source it claims.
 * The excerpt is supported only when its normalized text occurs as a
 * contiguous substring of the normalized source text, so the cited words must
 * appear in the source in that exact order and spelling. Text the source never
 * states — including a paraphrase, a reordering, or a differently cased
 * variant — is `absent` and must not be journaled as evidence. An excerpt that
 * normalizes to nothing supports no claim and is `absent` too.
 */
export function classifyExcerptSupport(input: {
  readonly sourceText: string;
  readonly excerpt: string;
}): ExcerptSupportResult {
  const excerpt = normalizeForExcerptMatch(input.excerpt);
  if (excerpt.length === 0) return "absent";
  return normalizeForExcerptMatch(input.sourceText).includes(excerpt) ? "present" : "absent";
}

/**
 * Next brief status for a successful transition. Adding a source or recording
 * evidence moves `draft` to `gathering`. Recording a claim moves `draft` or
 * `gathering` to `analyzing`. Finalizing a report moves to `finalized`.
 * Cancelling retrieval keeps the current status.
 */
export function nextBriefStatus(
  current: WorkResearchBriefStatus,
  transition: WorkResearchSuccessTransitionKind,
): WorkResearchBriefStatus {
  if (transition === "report-finalized") return "finalized";
  if (transition === "source-added" && current === "draft") return "gathering";
  if (transition === "evidence-recorded" && current === "draft") return "gathering";
  if (transition === "claim-recorded" && current === "draft") return "analyzing";
  if (transition === "claim-recorded" && current === "gathering") return "analyzing";
  return current;
}

type WorkResearchSuccessTransitionKind =
  | "brief-created"
  | "source-added"
  | "source-revoked"
  | "evidence-recorded"
  | "claim-recorded"
  | "report-finalized"
  | "retrieval-cancelled";
