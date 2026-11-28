import { Schema } from "effect";
import {
  NonEmptyTrimmedString,
  NonNegativeInt,
  PositiveInt,
  STRICT_DECODE_OPTIONS,
} from "./schemaPrimitives";
import { CodeDebugSessionEndReason } from "./codeDebug";
import { CorrelationId, UtcTimestamp } from "./events";

const brandedUuid = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.String.pipe(Schema.check(Schema.isGUID()), Schema.brand<B>(brand));

/**
 * Wire version for the redacted diagnostics evidence packet. A second reviewer
 * reproduces a failure from a packet only when its structural version matches;
 * the number bumps whenever the packet shape changes in a breaking way.
 */
export const DIAGNOSTICS_PACKET_VERSION = 1 as const;

/**
 * Version of a packet that carries `journalGrowth` or `hostHealth`. A version 1
 * decoder rejects either extra field, so a packet with one says so; version 1
 * packets with neither stay valid.
 */
export const DIAGNOSTICS_PACKET_VERSION_WITH_JOURNAL_GROWTH = 2 as const;

/**
 * Version of a packet that carries `debugSessions`, which a version 1 or 2
 * decoder rejects. It may carry the version 2 sections too.
 */
export const DIAGNOSTICS_PACKET_VERSION_WITH_DEBUG_SESSIONS = 3 as const;

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
export const DiagnosticFailureDomain = Schema.Literals([
  "provider",
  "storage",
  "network",
  "remote-auth",
  "migration",
  "confinement",
  "process-cleanup",
]);
export type DiagnosticFailureDomain = typeof DiagnosticFailureDomain.Type;

/**
 * Bounded, provider-neutral failure code. Free-text exception messages never
 * cross the wire through the code; a redacted summary carries any safe hint.
 */
export const DiagnosticFailureCode = Schema.Trimmed.pipe(
  Schema.check(Schema.isNonEmpty(), Schema.isMaxLength(64), Schema.isPattern(/^[a-z][a-z0-9-]*$/)),
  Schema.brand("DiagnosticFailureCode"),
);
export type DiagnosticFailureCode = typeof DiagnosticFailureCode.Type;

/**
 * Categories of sensitive material a packet declares it removed. Presence in a
 * packet records that redaction ran for that class; the raw value is never
 * representable in the schema.
 */
export const DiagnosticRedactionTag = Schema.Literals([
  "credential",
  "private-key",
  "pairing-material",
  "session-material",
  "sensitive-root",
  "private-content",
  "raw-store",
]);
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
export const DiagnosticSafeText = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(512),
  Schema.makeFilter((value) => SAFE_TEXT_ALLOWLIST.test(value), {
    message:
      "Diagnostic text must be a single-line safe summary built from sanitized facts (disallowed characters or private content present).",
  }),
  Schema.makeFilter(isSecretFree, {
    message: "Diagnostic text still contains unredacted sensitive material.",
  }),
);
export type DiagnosticSafeText = typeof DiagnosticSafeText.Type;

/**
 * Bounded component/version fact for the failing host and the candidate build
 * a reviewer reproduces against. Values are short, opaque tokens rather than
 * paths or free text.
 */
export const DiagnosticComponentVersion = Schema.Struct({
  component: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(64),
    Schema.isPattern(/^[@a-z][a-z0-9@/._-]*$/),
    Schema.makeFilter(isSecretFree, {
      message: "Component identity still contains unredacted sensitive material.",
    }),
  ),
  version: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(64),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/),
    Schema.makeFilter(isSecretFree, {
      message: "Version fact still contains unredacted sensitive material.",
    }),
  ),
});
export type DiagnosticComponentVersion = typeof DiagnosticComponentVersion.Type;

/** Correlation anchor tying the packet to a replayable event/command trail. */
export const DiagnosticCorrelation = Schema.Struct({
  correlationId: CorrelationId,
  observedAt: UtcTimestamp,
});
export type DiagnosticCorrelation = typeof DiagnosticCorrelation.Type;

/**
 * Counts since the host process started: statements and event-loop stalls
 * that ran over their logging thresholds. Numbers only, so no SQL text or
 * route name can ride along.
 */
export const DiagnosticHostHealth = Schema.Struct({
  slowStatementCount: NonNegativeInt,
  slowStatementWorstMs: NonNegativeInt,
  eventLoopLagCount: NonNegativeInt,
  eventLoopLagWorstMs: NonNegativeInt,
});
export type DiagnosticHostHealth = typeof DiagnosticHostHealth.Type;

/** A single actionable, redacted recovery fact for the reviewer. */
export const DiagnosticRecoveryFact = Schema.Struct({
  action: DiagnosticSafeText,
  automated: Schema.Boolean,
});
export type DiagnosticRecoveryFact = typeof DiagnosticRecoveryFact.Type;

/** Days of journal growth an export reports, today included. */
export const JOURNAL_GROWTH_WINDOW_DAYS = 14;
/** Aggregate kinds are a small closed vocabulary; the cap denies an unbounded dump. */
export const MAX_JOURNAL_GROWTH_KINDS = 128;

/**
 * One aggregate kind's journal events per day. `counts` lines up with the
 * report's `days`, oldest first. Only the kind name and counts are
 * representable: no payload, identifier, or thread or project name.
 */
export const JournalGrowthKind = Schema.Struct({
  kind: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(64),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  ),
  counts: Schema.Array(NonNegativeInt).check(
    Schema.isBetweenLength(JOURNAL_GROWTH_WINDOW_DAYS, JOURNAL_GROWTH_WINDOW_DAYS),
  ),
  total: NonNegativeInt,
});
export type JournalGrowthKind = typeof JournalGrowthKind.Type;

/**
 * Journal growth over the last {@link JOURNAL_GROWTH_WINDOW_DAYS} days, plus
 * the journal head sequence and the database file size. Journal growth
 * twice hit a limit before anyone saw it, so the export and Settings show it.
 */
export const JournalGrowth = Schema.Struct({
  generatedAt: UtcTimestamp,
  /** UTC calendar days, oldest first, as YYYY-MM-DD. */
  days: Schema.Array(Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))).check(
    Schema.isBetweenLength(JOURNAL_GROWTH_WINDOW_DAYS, JOURNAL_GROWTH_WINDOW_DAYS),
  ),
  kinds: Schema.Array(JournalGrowthKind).check(Schema.isMaxLength(MAX_JOURNAL_GROWTH_KINDS)),
  /** Highest journal sequence: O(1) to read, and the row count when nothing was purged. */
  journalHead: NonNegativeInt,
  databaseBytes: NonNegativeInt,
});
export type JournalGrowth = typeof JournalGrowth.Type;

/** How many debug sessions ended for one reason. */
export const DiagnosticDebugSessionEnding = Schema.Struct({
  endReason: CodeDebugSessionEndReason,
  count: PositiveInt,
});
export type DiagnosticDebugSessionEnding = typeof DiagnosticDebugSessionEnding.Type;

/**
 * Debug sessions started, and ended by reason, in the journal growth window.
 * Counts and the closed end reasons only: no session, configuration, thread,
 * or Project, and nothing a session showed. Canonical:
 * docs/design/language-services.md § Debugger data and privacy.
 */
export const DiagnosticDebugSessions = Schema.Struct({
  /** The first UTC day counted, as YYYY-MM-DD. */
  since: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)),
  started: NonNegativeInt,
  ended: Schema.Array(DiagnosticDebugSessionEnding).check(
    Schema.isMaxLength(CodeDebugSessionEndReason.literals.length),
    Schema.makeFilter(
      (endings) => new Set(endings.map((ending) => ending.endReason)).size === endings.length,
      { message: "Each end reason is counted once." },
    ),
  ),
});
export type DiagnosticDebugSessions = typeof DiagnosticDebugSessions.Type;

/**
 * A supported, fully redacted diagnostics evidence packet. `redacted` is a
 * literal `true` so a packet can never claim it skipped redaction, and no field
 * can hold credentials, keys, pairing/session material, sensitive roots, raw
 * stores, or private thread/file content.
 */
export const DiagnosticEvidencePacket = Schema.Struct({
  packetVersion: Schema.Literals([
    DIAGNOSTICS_PACKET_VERSION,
    DIAGNOSTICS_PACKET_VERSION_WITH_JOURNAL_GROWTH,
    DIAGNOSTICS_PACKET_VERSION_WITH_DEBUG_SESSIONS,
  ]),
  packetId: DiagnosticPacketId,
  domain: DiagnosticFailureDomain,
  failureCode: DiagnosticFailureCode,
  summary: DiagnosticSafeText,
  hostVersions: Schema.Array(DiagnosticComponentVersion).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_DIAGNOSTIC_VERSIONS),
  ),
  candidateVersions: Schema.Array(DiagnosticComponentVersion).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_DIAGNOSTIC_VERSIONS),
  ),
  correlations: Schema.Array(DiagnosticCorrelation).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_DIAGNOSTIC_CORRELATIONS),
  ),
  recovery: Schema.Array(DiagnosticRecoveryFact).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(MAX_DIAGNOSTIC_RECOVERY_FACTS),
  ),
  redactions: Schema.Array(DiagnosticRedactionTag).check(
    Schema.isMaxLength(MAX_DIAGNOSTIC_REDACTIONS),
  ),
  redacted: Schema.Literal(true),
  /** Version 2 or later; absent when the host reports no counters. */
  hostHealth: Schema.optional(DiagnosticHostHealth),
  generatedAt: UtcTimestamp,
  /** Version 2 or later; absent when the host could not read the journal. */
  journalGrowth: Schema.optional(JournalGrowth),
  /**
   * Required in a version 3 packet and refused in any other. Absent, so the
   * packet stays version 1 or 2, when no session started or ended in the window.
   */
  debugSessions: Schema.optional(DiagnosticDebugSessions),
}).check(
  Schema.makeFilter(
    (packet) =>
      packet.packetVersion === DIAGNOSTICS_PACKET_VERSION_WITH_DEBUG_SESSIONS
        ? packet.debugSessions !== undefined
        : packet.debugSessions === undefined &&
          (packet.packetVersion === DIAGNOSTICS_PACKET_VERSION_WITH_JOURNAL_GROWTH ||
            (packet.journalGrowth === undefined && packet.hostHealth === undefined)),
    {
      message:
        "Only a version 2 or 3 packet carries journal growth or host health, and only a version 3 packet carries debug sessions.",
    },
  ),
);
export type DiagnosticEvidencePacket = typeof DiagnosticEvidencePacket.Type;

/**
 * Typed, closed reasons an export cannot produce a complete secret-free packet.
 * Every failure path lands here rather than emitting partial or fabricated
 * evidence.
 */
export const DiagnosticsExportFailure = Schema.Union([
  Schema.Struct({
    category: Schema.Literal("invalid-input"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("incomplete"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("unredactable"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("misleading-success"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("unsupported-domain"),
    message: NonEmptyTrimmedString,
  }),
  Schema.Struct({
    category: Schema.Literal("persistence-failed"),
    message: NonEmptyTrimmedString,
  }),
]);
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
  summary: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(2_000)),
});
export type DiagnosticsExportRequest = typeof DiagnosticsExportRequest.Type;

/**
 * SHA-256 hex digest of a sealed packet's canonical JSON. Lets a receipt
 * prove which exact packet content was sealed without persisting that
 * content itself.
 */
export const DiagnosticsExportContentDigest = Schema.Trimmed.pipe(
  Schema.check(
    Schema.isNonEmpty(),
    Schema.isBetweenLength(64, 64),
    Schema.isPattern(/^[0-9a-f]{64}$/),
  ),
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
  redactions: Schema.Array(DiagnosticRedactionTag).check(
    Schema.isMaxLength(MAX_DIAGNOSTIC_REDACTIONS),
  ),
  contentDigest: DiagnosticsExportContentDigest,
  generatedAt: UtcTimestamp,
  createdAt: UtcTimestamp,
});
export type DiagnosticsExportReceipt = typeof DiagnosticsExportReceipt.Type;

/** Original v1 payload retained so journal rebuild can decode historical incidents. */
export const DiagnosticsFailureIncidentRecordedV1 = Schema.Struct({
  domain: DiagnosticFailureDomain,
  outcome: Schema.Literal("failed"),
});
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
});
export type DiagnosticsFailureIncidentRecorded = typeof DiagnosticsFailureIncidentRecorded.Type;

/** Durable journal payload for a bounded exported-packet receipt. */
export const DiagnosticsExportReceiptRecorded = Schema.Struct({
  receipt: DiagnosticsExportReceipt,
});
export type DiagnosticsExportReceiptRecorded = typeof DiagnosticsExportReceiptRecorded.Type;

/**
 * Transport-level outcome of one export attempt. `exported` never appears
 * without both a fully redacted, schema-valid packet and its receipt; every
 * other path is a typed `DiagnosticsExportFailure`, never a partial result.
 */
export const DiagnosticsExportOutcome = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("exported"),
    packet: DiagnosticEvidencePacket,
    receipt: DiagnosticsExportReceipt,
  }),
  Schema.Struct({
    kind: Schema.Literal("failed"),
    failure: DiagnosticsExportFailure,
  }),
]);
export type DiagnosticsExportOutcome = typeof DiagnosticsExportOutcome.Type;

export const decodeDiagnosticPacketId = Schema.decodeUnknownSync(
  DiagnosticPacketId,
  STRICT_DECODE_OPTIONS,
);
export const decodeDiagnosticFailureDomain = Schema.decodeUnknownSync(
  DiagnosticFailureDomain,
  STRICT_DECODE_OPTIONS,
);
export const decodeDiagnosticFailureCode = Schema.decodeUnknownSync(
  DiagnosticFailureCode,
  STRICT_DECODE_OPTIONS,
);
export const decodeDiagnosticRedactionTag = Schema.decodeUnknownSync(
  DiagnosticRedactionTag,
  STRICT_DECODE_OPTIONS,
);
export const decodeDiagnosticSafeText = Schema.decodeUnknownSync(
  DiagnosticSafeText,
  STRICT_DECODE_OPTIONS,
);
export const decodeDiagnosticComponentVersion = Schema.decodeUnknownSync(
  DiagnosticComponentVersion,
  STRICT_DECODE_OPTIONS,
);
export const decodeDiagnosticCorrelation = Schema.decodeUnknownSync(
  DiagnosticCorrelation,
  STRICT_DECODE_OPTIONS,
);
export const decodeDiagnosticRecoveryFact = Schema.decodeUnknownSync(
  DiagnosticRecoveryFact,
  STRICT_DECODE_OPTIONS,
);
export const decodeDiagnosticEvidencePacket = Schema.decodeUnknownSync(
  DiagnosticEvidencePacket,
  STRICT_DECODE_OPTIONS,
);
export const decodeDiagnosticsExportFailure = Schema.decodeUnknownSync(
  DiagnosticsExportFailure,
  STRICT_DECODE_OPTIONS,
);
export const decodeDiagnosticsExportRequest = Schema.decodeUnknownSync(
  DiagnosticsExportRequest,
  STRICT_DECODE_OPTIONS,
);
export const decodeDiagnosticsExportContentDigest = Schema.decodeUnknownSync(
  DiagnosticsExportContentDigest,
  STRICT_DECODE_OPTIONS,
);
export const decodeDiagnosticsExportReceipt = Schema.decodeUnknownSync(
  DiagnosticsExportReceipt,
  STRICT_DECODE_OPTIONS,
);
export const decodeDiagnosticsFailureIncidentRecorded = Schema.decodeUnknownSync(
  DiagnosticsFailureIncidentRecorded,
  STRICT_DECODE_OPTIONS,
);
export const decodeDiagnosticsFailureIncidentRecordedV1 = Schema.decodeUnknownSync(
  DiagnosticsFailureIncidentRecordedV1,
  STRICT_DECODE_OPTIONS,
);
export const decodeDiagnosticsExportReceiptRecorded = Schema.decodeUnknownSync(
  DiagnosticsExportReceiptRecorded,
  STRICT_DECODE_OPTIONS,
);
export const decodeDiagnosticsExportOutcome = Schema.decodeUnknownSync(
  DiagnosticsExportOutcome,
  STRICT_DECODE_OPTIONS,
);
export const decodeJournalGrowth = Schema.decodeUnknownSync(JournalGrowth, STRICT_DECODE_OPTIONS);
export const decodeDiagnosticDebugSessions = Schema.decodeUnknownSync(
  DiagnosticDebugSessions,
  STRICT_DECODE_OPTIONS,
);
