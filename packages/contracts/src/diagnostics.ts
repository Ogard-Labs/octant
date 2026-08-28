import { Schema } from "effect";
import { CorrelationId, UtcTimestamp } from "./events";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));

/**
 * Wire version for the redacted diagnostics evidence packet. A second reviewer
 * reproduces a failure from a packet only when its structural version matches;
 * the number bumps whenever the packet shape changes in a breaking way.
 */
export const DIAGNOSTICS_PACKET_VERSION = 1 as const;

/** Upper bounds keep a packet reviewable and deny unbounded store dumps. */
export const MAX_DIAGNOSTIC_VERSIONS = 32;
export const MAX_DIAGNOSTIC_RECOVERY_FACTS = 16;
export const MAX_DIAGNOSTIC_REDACTIONS = 32;
export const MAX_DIAGNOSTIC_CORRELATIONS = 16;

export const DiagnosticPacketId = brandedUuid("DiagnosticPacketId");
export type DiagnosticPacketId = typeof DiagnosticPacketId.Type;

/**
 * Supported failure domains the diagnostics export makes reproducible. The set
 * is closed so a packet cannot smuggle an unmodeled surface past redaction.
 */
export const DiagnosticFailureDomain = Schema.Literal(
  "provider",
  "storage",
  "network",
  "remote-auth",
  "migration",
  "confinement",
  "process-cleanup",
);
export type DiagnosticFailureDomain = typeof DiagnosticFailureDomain.Type;

/**
 * Bounded, provider-neutral failure code. Free-text exception messages never
 * cross the wire through the code; a redacted summary carries any safe hint.
 */
export const DiagnosticFailureCode = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(64),
  Schema.pattern(/^[a-z][a-z0-9-]*$/),
  Schema.brand("DiagnosticFailureCode"),
);
export type DiagnosticFailureCode = typeof DiagnosticFailureCode.Type;

/**
 * Categories of sensitive material a packet declares it removed. Presence in a
 * packet records that redaction ran for that class; the raw value is never
 * representable in the schema.
 */
export const DiagnosticRedactionTag = Schema.Literal(
  "credential",
  "private-key",
  "pairing-material",
  "session-material",
  "sensitive-root",
  "private-content",
  "raw-store",
);
export type DiagnosticRedactionTag = typeof DiagnosticRedactionTag.Type;

const RAW_SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
  // Provider keys are multipart (`sk-proj-...`, `sk-ant-...`), so hyphens and
  // underscores are part of the token and must not terminate the match before
  // the 16-character body is counted.
  /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{14,}[A-Za-z0-9]\b/,
  // Bearerless opaque credentials are common in copied provider diagnostics.
  // These formats do not need a preceding "token" label to be sensitive.
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/i,
  /\blin_api_[A-Za-z0-9][A-Za-z0-9_-]{8,}[A-Za-z0-9]\b/,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/,
  // Google/Gemini API keys are accepted by the provider adapter and can appear
  // unlabeled in provider diagnostics, so deny their fixed opaque shape too.
  /\bAIza[A-Za-z0-9_-]{35}\b/,
  /\b(?:bearer|api[_-]?key|password|secret|token|pairing[ _-]?(?:code|token|ticket|secret))\b[\s:=]+\S+/i,
  /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /(?:^|[\s"'([{])(?:\/Users\/|\/home\/|\/root\/|[A-Za-z]:\\Users\\)/,
];

const isSecretFree = (value: string): boolean =>
  !RAW_SECRET_PATTERNS.some((pattern) => pattern.test(value));

/**
 * Positive allowlist for reviewer-facing free text. Diagnostic summaries and
 * recovery actions are single-line phrases assembled from redacted, sanitized
 * facts, so only letters, digits, spaces, and a small punctuation set (plus the
 * `[redacted-*]` placeholder brackets) are representable. Denying everything else
 * keeps arbitrary private thread/file content — multi-line dumps, JSON/log
 * structure, markup, shell/code fragments, and non-ASCII prose — out of a packet
 * even when it matches none of the specific secret patterns below.
 */
const SAFE_TEXT_ALLOWLIST = /^[A-Za-z0-9 .,:;'"()[\]/@%+=?!_-]+$/;

/**
 * Renderer- and reviewer-facing free text that has already been redacted. It
 * must fit the single-line safe-phrase allowlist (so arbitrary private content
 * cannot ride along) and, as defense in depth, must contain none of the raw
 * secret shapes below even if the allowlist ever admits one.
 */
export const DiagnosticSafeText = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(512),
  Schema.filter((value) => SAFE_TEXT_ALLOWLIST.test(value), {
    message: () =>
      "Diagnostic text must be a single-line safe summary built from sanitized facts (disallowed characters or private content present).",
  }),
  Schema.filter(isSecretFree, {
    message: () => "Diagnostic text still contains unredacted sensitive material.",
  }),
);
export type DiagnosticSafeText = typeof DiagnosticSafeText.Type;

/**
 * Bounded component/version fact for the failing host and the candidate build
 * a reviewer reproduces against. Values are short, opaque tokens rather than
 * paths or free text.
 */
export const DiagnosticComponentVersion = Schema.Struct({
  component: Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(64),
    Schema.pattern(/^[@a-z][a-z0-9@/._-]*$/),
    Schema.filter(isSecretFree, {
      message: () => "Component identity still contains unredacted sensitive material.",
    }),
  ),
  version: Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(64),
    Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/),
    Schema.filter(isSecretFree, {
      message: () => "Version fact still contains unredacted sensitive material.",
    }),
  ),
}).annotations(strict);
export type DiagnosticComponentVersion = typeof DiagnosticComponentVersion.Type;

/** Correlation anchor tying the packet to a replayable event/command trail. */
export const DiagnosticCorrelation = Schema.Struct({
  correlationId: CorrelationId,
  observedAt: UtcTimestamp,
}).annotations(strict);
export type DiagnosticCorrelation = typeof DiagnosticCorrelation.Type;

/** A single actionable, redacted recovery fact for the reviewer. */
export const DiagnosticRecoveryFact = Schema.Struct({
  action: DiagnosticSafeText,
  automated: Schema.Boolean,
}).annotations(strict);
export type DiagnosticRecoveryFact = typeof DiagnosticRecoveryFact.Type;

/**
 * A supported, fully redacted diagnostics evidence packet. `redacted` is a
 * literal `true` so a packet can never claim it skipped redaction, and no field
 * can hold credentials, keys, pairing/session material, sensitive roots, raw
 * stores, or private thread/file content.
 */
export const DiagnosticEvidencePacket = Schema.Struct({
  packetVersion: Schema.Literal(DIAGNOSTICS_PACKET_VERSION),
  packetId: DiagnosticPacketId,
  domain: DiagnosticFailureDomain,
  failureCode: DiagnosticFailureCode,
  summary: DiagnosticSafeText,
  hostVersions: Schema.Array(DiagnosticComponentVersion).pipe(
    Schema.minItems(1),
    Schema.maxItems(MAX_DIAGNOSTIC_VERSIONS),
  ),
  candidateVersions: Schema.Array(DiagnosticComponentVersion).pipe(
    Schema.minItems(1),
    Schema.maxItems(MAX_DIAGNOSTIC_VERSIONS),
  ),
  correlations: Schema.Array(DiagnosticCorrelation).pipe(
    Schema.minItems(1),
    Schema.maxItems(MAX_DIAGNOSTIC_CORRELATIONS),
  ),
  recovery: Schema.Array(DiagnosticRecoveryFact).pipe(
    Schema.minItems(1),
    Schema.maxItems(MAX_DIAGNOSTIC_RECOVERY_FACTS),
  ),
  redactions: Schema.Array(DiagnosticRedactionTag).pipe(Schema.maxItems(MAX_DIAGNOSTIC_REDACTIONS)),
  redacted: Schema.Literal(true),
  generatedAt: UtcTimestamp,
}).annotations(strict);
export type DiagnosticEvidencePacket = typeof DiagnosticEvidencePacket.Type;

/**
 * Typed, closed reasons an export cannot produce a complete secret-free packet.
 * Every failure path lands here rather than emitting partial or fabricated
 * evidence.
 */
export const DiagnosticsExportFailure = Schema.Union(
  Schema.Struct({
    category: Schema.Literal("invalid-input"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("incomplete"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("unredactable"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("misleading-success"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("unsupported-domain"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
  Schema.Struct({
    category: Schema.Literal("persistence-failed"),
    message: Schema.NonEmptyTrimmedString,
  }).annotations(strict),
).annotations(strict);
export type DiagnosticsExportFailure = typeof DiagnosticsExportFailure.Type;

/**
 * Wire request for the authenticated diagnostics export command. The
 * client supplies the reported failure correlation, domain, and a short
 * free-text summary of what happened; the host assembles version and recovery
 * facts, and every field still passes through the diagnostics redaction and
 * sealing policy before a packet is sealed.
 */
export const DiagnosticsExportRequest = Schema.Struct({
  correlationId: CorrelationId,
  domain: DiagnosticFailureDomain,
  summary: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(2_000)),
}).annotations(strict);
export type DiagnosticsExportRequest = typeof DiagnosticsExportRequest.Type;

/**
 * SHA-256 hex digest of a sealed packet's canonical JSON. Lets a receipt
 * prove which exact packet content was sealed without persisting that
 * content itself.
 */
export const DiagnosticsExportContentDigest = Schema.NonEmptyTrimmedString.pipe(
  Schema.length(64),
  Schema.pattern(/^[0-9a-f]{64}$/),
  Schema.brand("DiagnosticsExportContentDigest"),
);
export type DiagnosticsExportContentDigest = typeof DiagnosticsExportContentDigest.Type;

/**
 * The only state the diagnostics export may durably persist: bounded
 * identifiers, the
 * closed redaction-tag set, and a content digest. No summary, recovery text,
 * correlation, or version fact is representable here, so the store can never
 * hold free text or private content even by accident.
 */
export const DiagnosticsExportReceipt = Schema.Struct({
  packetId: DiagnosticPacketId,
  domain: DiagnosticFailureDomain,
  failureCode: DiagnosticFailureCode,
  redactions: Schema.Array(DiagnosticRedactionTag).pipe(Schema.maxItems(MAX_DIAGNOSTIC_REDACTIONS)),
  contentDigest: DiagnosticsExportContentDigest,
  generatedAt: UtcTimestamp,
  createdAt: UtcTimestamp,
}).annotations(strict);
export type DiagnosticsExportReceipt = typeof DiagnosticsExportReceipt.Type;

/** Original v1 payload retained so journal rebuild can decode historical incidents. */
export const DiagnosticsFailureIncidentRecordedV1 = Schema.Struct({
  domain: DiagnosticFailureDomain,
  outcome: Schema.Literal("failed"),
}).annotations(strict);
export type DiagnosticsFailureIncidentRecordedV1 = typeof DiagnosticsFailureIncidentRecordedV1.Type;

/**
 * A bounded, server-recorded failure anchor. The journal envelope supplies the
 * correlation identity and observed timestamp; this v2 payload additionally
 * keeps the source operation's stable typed failure code, never raw text.
 */
export const DiagnosticsFailureIncidentRecorded = Schema.Struct({
  domain: DiagnosticFailureDomain,
  failureCode: DiagnosticFailureCode,
  outcome: Schema.Literal("failed"),
}).annotations(strict);
export type DiagnosticsFailureIncidentRecorded = typeof DiagnosticsFailureIncidentRecorded.Type;

/** Durable journal payload for a bounded exported-packet receipt. */
export const DiagnosticsExportReceiptRecorded = Schema.Struct({
  receipt: DiagnosticsExportReceipt,
}).annotations(strict);
export type DiagnosticsExportReceiptRecorded = typeof DiagnosticsExportReceiptRecorded.Type;

/**
 * Transport-level outcome of one export attempt. `exported` never appears
 * without both a fully redacted, schema-valid packet and its receipt; every
 * other path is a typed `DiagnosticsExportFailure`, never a partial result.
 */
export const DiagnosticsExportOutcome = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("exported"),
    packet: DiagnosticEvidencePacket,
    receipt: DiagnosticsExportReceipt,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    failure: DiagnosticsExportFailure,
  }).annotations(strict),
);
export type DiagnosticsExportOutcome = typeof DiagnosticsExportOutcome.Type;

export const decodeDiagnosticPacketId = Schema.decodeUnknownSync(DiagnosticPacketId);
export const decodeDiagnosticFailureDomain = Schema.decodeUnknownSync(DiagnosticFailureDomain);
export const decodeDiagnosticFailureCode = Schema.decodeUnknownSync(DiagnosticFailureCode);
export const decodeDiagnosticRedactionTag = Schema.decodeUnknownSync(DiagnosticRedactionTag);
export const decodeDiagnosticSafeText = Schema.decodeUnknownSync(DiagnosticSafeText);
export const decodeDiagnosticComponentVersion = Schema.decodeUnknownSync(
  DiagnosticComponentVersion,
);
export const decodeDiagnosticCorrelation = Schema.decodeUnknownSync(DiagnosticCorrelation);
export const decodeDiagnosticRecoveryFact = Schema.decodeUnknownSync(DiagnosticRecoveryFact);
export const decodeDiagnosticEvidencePacket = Schema.decodeUnknownSync(DiagnosticEvidencePacket);
export const decodeDiagnosticsExportFailure = Schema.decodeUnknownSync(DiagnosticsExportFailure);
export const decodeDiagnosticsExportRequest = Schema.decodeUnknownSync(DiagnosticsExportRequest);
export const decodeDiagnosticsExportContentDigest = Schema.decodeUnknownSync(
  DiagnosticsExportContentDigest,
);
export const decodeDiagnosticsExportReceipt = Schema.decodeUnknownSync(DiagnosticsExportReceipt);
export const decodeDiagnosticsFailureIncidentRecorded = Schema.decodeUnknownSync(
  DiagnosticsFailureIncidentRecorded,
);
export const decodeDiagnosticsFailureIncidentRecordedV1 = Schema.decodeUnknownSync(
  DiagnosticsFailureIncidentRecordedV1,
);
export const decodeDiagnosticsExportReceiptRecorded = Schema.decodeUnknownSync(
  DiagnosticsExportReceiptRecorded,
);
export const decodeDiagnosticsExportOutcome = Schema.decodeUnknownSync(DiagnosticsExportOutcome);
