import type {
  DiagnosticComponentVersion,
  DiagnosticCorrelation,
  DiagnosticEvidencePacket,
  DiagnosticFailureDomain,
  DiagnosticRecoveryFact,
  DiagnosticRedactionTag,
  DiagnosticsExportFailure,
} from "@octant/contracts";
import {
  MAX_DIAGNOSTIC_CORRELATIONS,
  MAX_DIAGNOSTIC_RECOVERY_FACTS,
  MAX_DIAGNOSTIC_VERSIONS,
  DIAGNOSTICS_PACKET_VERSION,
  decodeDiagnosticEvidencePacket,
  decodeDiagnosticSafeText,
} from "@octant/contracts";

/**
 * Pure diagnostics/evidence policy. Redaction and packet
 * assembly happen here without touching Electron, the filesystem, the network,
 * a database, or a provider process. The server owns the surrounding transport
 * and durable persistence; this module only decides what a secret-free,
 * reproducible packet may contain and refuses to fabricate one otherwise.
 */

/** The closed set of failure domains the diagnostics export supports. */
export const SUPPORTED_DIAGNOSTIC_DOMAINS: ReadonlyArray<DiagnosticFailureDomain> = [
  "provider",
  "storage",
  "network",
  "remote-auth",
  "migration",
  "confinement",
  "process-cleanup",
];

export interface RedactionResult {
  readonly text: string;
  readonly tags: ReadonlyArray<DiagnosticRedactionTag>;
}

interface RedactionRule {
  readonly pattern: RegExp;
  readonly tag: DiagnosticRedactionTag;
  readonly replacement: string;
}

/**
 * Ordered redaction rules. Specific pairing/session material is stripped before
 * the generic credential sweep so it is tagged precisely. Replacements never
 * reintroduce a `keyword: value` or `user:pass@` shape that the contract's
 * defense-in-depth `DiagnosticSafeText` filter would reject.
 */
const REDACTION_RULES: ReadonlyArray<RedactionRule> = [
  {
    pattern:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gi,
    tag: "private-key",
    replacement: "[redacted-private-key]",
  },
  {
    pattern: /\bpairing[-_ ]?(?:code|token|ticket|secret)\b['":=\s]+[^\s'"]+/gi,
    tag: "pairing-material",
    replacement: "[redacted-pairing-material]",
  },
  {
    pattern: /\bsession[-_ ]?(?:id|token|key|secret)\b['":=\s]+[^\s'"]+/gi,
    tag: "session-material",
    replacement: "[redacted-session-material]",
  },
  {
    pattern: /\bauthorization\b['":=\s]+(?:[a-z]+\s+)?[^\s'"]+/gi,
    tag: "credential",
    replacement: "[redacted-credential]",
  },
  {
    pattern:
      /\b(?:bearer|password|secret|token|api[-_ ]?key|access[-_ ]?token)\b['":=\s]+[^\s'"]+/gi,
    tag: "credential",
    replacement: "[redacted-credential]",
  },
  {
    // Multipart provider keys (`sk-proj-...`, `sk-ant-...`) keep hyphens and
    // underscores inside the token, so the body must span them.
    pattern: /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{14,}[A-Za-z0-9]\b/g,
    tag: "credential",
    replacement: "[redacted-credential]",
  },
  {
    pattern: /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi,
    tag: "credential",
    replacement: "$1[redacted-credential]@",
  },
  {
    pattern: /(?:\/Users\/|\/home\/|\/root\/|[A-Za-z]:\\Users\\)[^\s'"]*/g,
    tag: "sensitive-root",
    replacement: "[redacted-sensitive-root]",
  },
];

/**
 * Residual patterns that must never survive redaction. Mirrors the contract's
 * `DiagnosticSafeText` guard so the policy can fail closed before assembly.
 */
const RESIDUAL_SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/i,
  /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{14,}[A-Za-z0-9]\b/,
  // Natural-language assignments are deliberately fail-closed. Redacting only
  // the keyword could leave the value behind (for example, "password is hunter2").
  /\b(?:password|secret|token|api[-_ ]?key|access[-_ ]?token|pairing[-_ ]?(?:code|token|ticket|secret))\b(?:['":=\s]+(?:is|was|for)\b)?['":=\s]+\S+/i,
  /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
  /(?:^|[\s"'([{])(?:\/Users\/|\/home\/|\/root\/|[A-Za-z]:\\Users\\)/,
];

const AMBIGUOUS_SECRET_ASSIGNMENT =
  /\b(?:password|secret|token|api[-_ ]?key|access[-_ ]?token|pairing[-_ ]?(?:code|token|ticket|secret))\b(?:['":=\s]+(?:is|was|for)\b)?['":=\s]+\S+/i;

function sortedUniqueTags(
  tags: ReadonlyArray<DiagnosticRedactionTag>,
): ReadonlyArray<DiagnosticRedactionTag> {
  return [...new Set(tags)].sort();
}

/**
 * Redact known sensitive material from free text, returning the cleaned text
 * and the deterministic, sorted, unique set of redaction classes applied.
 */
export function redactDiagnosticText(raw: string): RedactionResult {
  let text = raw;
  const tags: DiagnosticRedactionTag[] = [];
  for (const rule of REDACTION_RULES) {
    if (rule.pattern.test(text)) {
      tags.push(rule.tag);
      text = text.replace(rule.pattern, rule.replacement);
    }
  }
  return { text, tags: sortedUniqueTags(tags) };
}

/**
 * The exact UTF-8 JSON text handed to a reviewer. Keep this canonical byte
 * representation shared by every delivery surface so a receipt digest names
 * the packet bytes that were actually exported.
 */
export function serializeDiagnosticsEvidencePacket(packet: DiagnosticEvidencePacket): string {
  return JSON.stringify({
    packetVersion: packet.packetVersion,
    packetId: packet.packetId,
    domain: packet.domain,
    failureCode: packet.failureCode,
    summary: packet.summary,
    hostVersions: packet.hostVersions,
    candidateVersions: packet.candidateVersions,
    correlations: packet.correlations,
    recovery: packet.recovery,
    redactions: packet.redactions,
    redacted: packet.redacted,
    generatedAt: packet.generatedAt,
  });
}

function stillContainsSecret(text: string): boolean {
  return RESIDUAL_SECRET_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Whether redacted text conforms to the contract's `DiagnosticSafeText`
 * allowlist. Redaction only strips known secret shapes; this closes the gap for
 * arbitrary private thread/file content by requiring the surviving text to be a
 * single-line safe phrase rather than trusting it because it matched no secret.
 */
function isSafeSummaryText(text: string): boolean {
  try {
    decodeDiagnosticSafeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Version facts are structured identifiers, not free text, so they are never run
 * through {@link redactDiagnosticText}. A caller that accidentally supplies a
 * credential or private identifier as a component/version must therefore be
 * rejected outright rather than silently sealed into a `redacted: true` packet.
 */
function versionFactsContainSecret(
  list: ReadonlyArray<{ readonly component: string; readonly version: string }>,
): boolean {
  return list.some(
    (entry) => stillContainsSecret(entry.component) || stillContainsSecret(entry.version),
  );
}

export interface RawDiagnosticInput {
  readonly packetId: string;
  readonly domain: string;
  readonly failureCode: string;
  readonly summary: string;
  readonly hostVersions: ReadonlyArray<{ readonly component: string; readonly version: string }>;
  readonly candidateVersions: ReadonlyArray<{
    readonly component: string;
    readonly version: string;
  }>;
  readonly correlations: ReadonlyArray<{
    readonly correlationId: string;
    readonly observedAt: string;
  }>;
  readonly recovery: ReadonlyArray<{ readonly action: string; readonly automated: boolean }>;
  readonly generatedAt: string;
  /** When the underlying operation actually succeeded, no failure packet exists. */
  readonly succeeded?: boolean;
}

export type DiagnosticsPacketResult =
  | { readonly kind: "packet"; readonly packet: DiagnosticEvidencePacket }
  | { readonly kind: "failed"; readonly failure: DiagnosticsExportFailure };

function fail(
  category: DiagnosticsExportFailure["category"],
  message: string,
): DiagnosticsPacketResult {
  return { kind: "failed", failure: { category, message } };
}

function normalizeVersions(
  list: ReadonlyArray<{ readonly component: string; readonly version: string }>,
): ReadonlyArray<{ readonly component: string; readonly version: string }> {
  const seen = new Set<string>();
  const out: Array<{ readonly component: string; readonly version: string }> = [];
  for (const entry of list) {
    const key = `${entry.component}@${entry.version}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(entry);
    }
  }
  return out.sort((a, b) =>
    a.component === b.component
      ? a.version.localeCompare(b.version)
      : a.component.localeCompare(b.component),
  );
}

function normalizeCorrelations(
  list: ReadonlyArray<{ readonly correlationId: string; readonly observedAt: string }>,
): ReadonlyArray<{ readonly correlationId: string; readonly observedAt: string }> {
  const seen = new Set<string>();
  const out: Array<{ readonly correlationId: string; readonly observedAt: string }> = [];
  for (const entry of list) {
    if (!seen.has(entry.correlationId)) {
      seen.add(entry.correlationId);
      out.push(entry);
    }
  }
  return out.sort((a, b) =>
    a.observedAt === b.observedAt
      ? a.correlationId.localeCompare(b.correlationId)
      : a.observedAt.localeCompare(b.observedAt),
  );
}

/**
 * Build a deterministic, complete, secret-free evidence packet from raw failure
 * facts, or fail closed. The function never emits partial evidence and never
 * fabricates a success or a failure it was not given.
 */
export function buildDiagnosticsPacket(input: RawDiagnosticInput): DiagnosticsPacketResult {
  if (!SUPPORTED_DIAGNOSTIC_DOMAINS.includes(input.domain as DiagnosticFailureDomain)) {
    return fail("unsupported-domain", `Unsupported diagnostic domain: ${input.domain}.`);
  }
  if (input.succeeded === true) {
    return fail(
      "misleading-success",
      "Refusing to emit a failure packet for a successful outcome.",
    );
  }
  if (input.summary.trim().length === 0) {
    return fail("incomplete", "A diagnostic summary is required.");
  }
  if (input.correlations.length === 0) {
    return fail("incomplete", "At least one correlation reference is required for replay.");
  }
  if (input.hostVersions.length === 0) {
    return fail("incomplete", "At least one host version fact is required.");
  }
  if (input.candidateVersions.length === 0) {
    return fail("incomplete", "At least one candidate version fact is required.");
  }
  if (input.recovery.length === 0) {
    return fail("incomplete", "At least one actionable recovery fact is required.");
  }
  if (
    input.correlations.length > MAX_DIAGNOSTIC_CORRELATIONS ||
    input.hostVersions.length > MAX_DIAGNOSTIC_VERSIONS ||
    input.candidateVersions.length > MAX_DIAGNOSTIC_VERSIONS ||
    input.recovery.length > MAX_DIAGNOSTIC_RECOVERY_FACTS
  ) {
    return fail("invalid-input", "Diagnostic facts exceed the bounded packet limits.");
  }
  if (
    versionFactsContainSecret(input.hostVersions) ||
    versionFactsContainSecret(input.candidateVersions)
  ) {
    return fail(
      "unredactable",
      "A version fact carried sensitive material and cannot be represented as a component identity.",
    );
  }

  if (
    [input.summary, ...input.recovery.map((fact) => fact.action)].some((text) =>
      AMBIGUOUS_SECRET_ASSIGNMENT.test(text),
    )
  ) {
    return fail(
      "unredactable",
      "Diagnostic text resembled a natural-language secret assignment and was rejected.",
    );
  }

  const summaryRedaction = redactDiagnosticText(input.summary);
  const recoveryRedactions = input.recovery.map((fact) => ({
    action: redactDiagnosticText(fact.action),
    automated: fact.automated,
  }));

  const collectedTags = sortedUniqueTags([
    ...summaryRedaction.tags,
    ...recoveryRedactions.flatMap((entry) => entry.action.tags),
  ]);

  const redactedTexts = [
    summaryRedaction.text,
    ...recoveryRedactions.map((entry) => entry.action.text),
  ];
  if (redactedTexts.some(stillContainsSecret)) {
    return fail("unredactable", "Sensitive material could not be safely redacted.");
  }
  if (!redactedTexts.every(isSafeSummaryText)) {
    return fail(
      "unredactable",
      "Diagnostic text could not be reduced to a safe, single-line summary from sanitized facts.",
    );
  }

  const recovery: ReadonlyArray<DiagnosticRecoveryFact> = recoveryRedactions.map((entry) => ({
    action: entry.action.text,
    automated: entry.automated,
  })) as ReadonlyArray<DiagnosticRecoveryFact>;

  const candidate = {
    packetVersion: DIAGNOSTICS_PACKET_VERSION,
    packetId: input.packetId,
    domain: input.domain,
    failureCode: input.failureCode,
    summary: summaryRedaction.text,
    hostVersions: normalizeVersions(
      input.hostVersions,
    ) as ReadonlyArray<DiagnosticComponentVersion>,
    candidateVersions: normalizeVersions(
      input.candidateVersions,
    ) as ReadonlyArray<DiagnosticComponentVersion>,
    correlations: normalizeCorrelations(input.correlations) as ReadonlyArray<DiagnosticCorrelation>,
    recovery,
    redactions: collectedTags,
    redacted: true as const,
    generatedAt: input.generatedAt,
  };

  try {
    const packet = decodeDiagnosticEvidencePacket(candidate);
    return { kind: "packet", packet };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("unredacted sensitive material")) {
      return fail("unredactable", "Assembled packet still contained sensitive material.");
    }
    return fail("invalid-input", "Diagnostic facts could not form a valid packet.");
  }
}

export type PersistenceOutcome =
  | { readonly kind: "persisted" }
  | { readonly kind: "failed"; readonly reason: string };

export type SealedExportResult =
  | { readonly kind: "sealed"; readonly packet: DiagnosticEvidencePacket }
  | { readonly kind: "failed"; readonly failure: DiagnosticsExportFailure };

/**
 * Redact a persistence failure reason through the same boundary as packet text.
 * Raw OS/SQLite/network/Keychain errors routinely embed absolute data paths,
 * credentialed URLs, or tokens, so the reason is swept for secrets and then
 * validated against `DiagnosticSafeText`; anything that still cannot be proven
 * safe collapses to a closed, generic detail rather than leaking.
 */
function toSafePersistenceDetail(reason: string): string {
  const redacted = redactDiagnosticText(reason).text.trim();
  if (redacted.length === 0 || stillContainsSecret(redacted)) {
    return "a redacted internal error";
  }
  try {
    return decodeDiagnosticSafeText(redacted);
  } catch {
    return "a redacted internal error";
  }
}

/**
 * Seal a built packet against its persistence outcome. When persistence failed,
 * the export fails closed and returns no packet at all, so a reviewer never
 * receives partial or silently fabricated evidence. The failure reason is
 * redacted before it is surfaced so the fail-closed path cannot itself leak.
 */
export function sealDiagnosticsExport(
  packet: DiagnosticEvidencePacket,
  persistence: PersistenceOutcome,
): SealedExportResult {
  if (persistence.kind === "failed") {
    return {
      kind: "failed",
      failure: {
        category: "persistence-failed",
        message: `Diagnostics export was not persisted: ${toSafePersistenceDetail(persistence.reason)}.`,
      },
    };
  }
  return { kind: "sealed", packet };
}
