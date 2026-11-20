import {
  MAX_PULL_REQUEST_REVIEW_COMMENT_BYTES,
  MAX_PULL_REQUEST_REVIEW_FINDINGS_PER_RUN,
  MAX_PULL_REQUEST_REVIEW_PROMPT_BYTES,
  PULL_REQUEST_REVIEWER_CONTRIBUTION_KIND,
  decodePullRequestReviewFindingProposal,
  decodePullRequestReviewerId,
  type CodeReviewFinding,
  type PullRequestReviewDiffSnapshot,
  type PullRequestReviewFindingProposal,
  type PullRequestReviewRequest,
  type PullRequestReviewer,
} from "@octant/plugin-api/pull-request-reviewer";

const encoder = new TextEncoder();

export const SECOND_MODEL_PULL_REQUEST_REVIEWER_ID = decodePullRequestReviewerId(
  "octant/second-model-pull-request-reviewer",
);
export const SECOND_MODEL_PULL_REQUEST_REVIEWER_DISPLAY_NAME = "Second-model PR reviewer";

const SYSTEM_INSTRUCTIONS = [
  "You are an independent second-model pull request reviewer running inside Octant at Plan's read-only gate.",
  "You cannot edit files, run write commands, modify Git state, or approve or request changes on GitHub.",
  "Review ONLY the diff supplied for the exact head commit. Look for bugs, security/authority flaws, regressions, missing edge-case handling, and broken invariants.",
  "Ignore formatting nitpicks. Prefer fewer, high-signal findings.",
  "Respond with JSON only using this exact shape:",
  '{"findings":[{"path":"relative/path.ts","line":42,"side":"modified","severity":"error"|"warning"|"note","summary":"Concrete, actionable finding."}]}',
  'Use severity "error" only for blocking defects that should be fixed before merge, "warning" for real risks, and "note" for minor suggestions.',
  'If you find no issues, respond with {"findings":[]}.',
].join("\n");

function truncateUtf8(value: string, maxBytes: number): string {
  if (encoder.encode(value).byteLength <= maxBytes) return value;
  let bytes = 0;
  const kept: string[] = [];
  for (const ch of value) {
    const width = encoder.encode(ch).byteLength;
    if (bytes + width > maxBytes) break;
    kept.push(ch);
    bytes += width;
  }
  return kept.join("");
}

function buildReviewPrompt(
  request: PullRequestReviewRequest,
  diff: PullRequestReviewDiffSnapshot,
): string {
  const headerLines = [
    `Pull request: ${String(request.target.repositoryOwner)}/${String(request.target.repositoryName)}#${request.target.number}`,
    `Head commit: ${request.headSha}`,
    `Base ref: ${request.baseRef}${request.baseSha === undefined ? "" : ` (${request.baseSha})`}`,
    `Worker model: ${String(request.workerRoute.modelId)}`,
    `Changed files (${diff.files.length}${diff.truncated === true ? ", truncated" : ""}):`,
    "",
  ];
  const header = headerLines.join("\n");
  const budget = MAX_PULL_REQUEST_REVIEW_PROMPT_BYTES - 1_024;
  let totalBytes = encoder.encode(header).byteLength;
  const sections: string[] = [header];

  for (const file of diff.files) {
    const patch = file.patch ?? "";
    const entryHeader = `--- FILE: ${String(file.path)} (${file.status}${file.truncated === true ? ", patch truncated" : ""}) ---\n`;
    const entry = `${entryHeader}${patch}\n`;
    const entryBytes = encoder.encode(entry).byteLength;
    if (totalBytes + entryBytes > budget) {
      const remaining = budget - totalBytes - 128;
      if (remaining > 256) {
        sections.push(`${truncateUtf8(entry, remaining)}\n[diff truncated]\n`);
      }
      break;
    }
    sections.push(entry);
    totalBytes += entryBytes;
  }

  return truncateUtf8(sections.join(""), MAX_PULL_REQUEST_REVIEW_PROMPT_BYTES);
}

interface ParsedProposalCandidate {
  readonly path?: unknown;
  readonly line?: unknown;
  readonly side?: unknown;
  readonly severity?: unknown;
  readonly summary?: unknown;
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start === -1 || end <= start) return undefined;
    try {
      return JSON.parse(candidate.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

export function parseReviewerFindings(
  text: string,
  diff: PullRequestReviewDiffSnapshot,
): ReadonlyArray<PullRequestReviewFindingProposal> {
  const parsed = extractJsonObject(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return [];
  }
  const findingsRaw = (parsed as { readonly findings?: unknown }).findings;
  if (!Array.isArray(findingsRaw)) return [];

  const validPaths = new Set(diff.files.map((file) => String(file.path)));
  const proposals: PullRequestReviewFindingProposal[] = [];

  for (const raw of findingsRaw) {
    if (proposals.length >= MAX_PULL_REQUEST_REVIEW_FINDINGS_PER_RUN) break;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
    const item = raw as ParsedProposalCandidate;
    if (typeof item.path !== "string" || !validPaths.has(item.path)) continue;
    if (typeof item.line !== "number" || !Number.isInteger(item.line) || item.line < 1) continue;
    const side = item.side === "original" ? "original" : "modified";
    const severity =
      item.severity === "error" || item.severity === "warning" || item.severity === "note"
        ? item.severity
        : "warning";
    if (typeof item.summary !== "string") continue;
    const summary = item.summary.replaceAll("\u0000", "").trim();
    if (summary.length === 0) continue;
    try {
      proposals.push(
        decodePullRequestReviewFindingProposal({
          path: item.path,
          location: { kind: "line", line: item.line },
          side,
          severity,
          summary: truncateUtf8(summary, 4_000),
        }),
      );
    } catch {
      // Skip malformed proposals rather than discarding valid ones.
    }
  }

  return proposals;
}

export function formatSummaryComment(input: {
  readonly request: PullRequestReviewRequest;
  readonly modelId: string;
  readonly findings: ReadonlyArray<CodeReviewFinding>;
}): string {
  const shortSha = input.request.headSha.slice(0, 7);
  const errors = input.findings.filter((finding) => finding.severity === "error");
  const warnings = input.findings.filter((finding) => finding.severity === "warning");
  const notes = input.findings.filter((finding) => finding.severity === "note");

  const lines: string[] = [`### Second-model review (${input.modelId} on \`${shortSha}\`)`, ""];
  if (input.findings.length === 0) {
    lines.push("No issues reported for this head commit.");
  } else {
    lines.push(
      `Found ${input.findings.length} ${input.findings.length === 1 ? "item" : "items"} (${errors.length} blocking, ${warnings.length} warnings, ${notes.length} notes):`,
      "",
    );
    for (const finding of input.findings) {
      const loc =
        finding.location.kind === "line"
          ? `L${finding.location.line}`
          : `L${finding.location.startLine}-L${finding.location.endLine}`;
      const label =
        finding.severity === "error"
          ? "Blocking"
          : finding.severity === "warning"
            ? "Warning"
            : "Note";
      lines.push(`- **${label}** \`${String(finding.path)}:${loc}\`: ${finding.summary}`);
    }
  }
  lines.push(
    "",
    "_Informational summary posted by Octant's second-model PR reviewer. This comment does not approve or request changes._",
  );
  return truncateUtf8(lines.join("\n"), MAX_PULL_REQUEST_REVIEW_COMMENT_BYTES);
}

/**
 * Bundled second-model pull request reviewer plugin contribution.
 *
 * Uses only the narrow `@octant/plugin-api/pull-request-reviewer` host port:
 * reads the host-verified PR diff snapshot, runs one host-enforced read-only
 * review turn at Plan's gate, records structured findings into the host's
 * `CodeReviewFinding` journal, and honors the host's per-Project summary
 * comment and per-PR worker hand-back opt-ins.
 */
export function createSecondModelPullRequestReviewer(): PullRequestReviewer {
  return {
    kind: PULL_REQUEST_REVIEWER_CONTRIBUTION_KIND,
    review: async (request, host, signal) => {
      if (signal.aborted) return { status: "cancelled" };
      if (request.configuredRoute === undefined) {
        return {
          status: "refused",
          reason: "no-route-configured",
          detail:
            "No reviewer model is configured. Pick a provider and model to run second-model pull request reviews.",
        };
      }

      const diffResult = await host.readPullRequestDiff(signal);
      if (signal.aborted) return { status: "cancelled" };
      if (diffResult.status === "stale") {
        return diffResult.currentHeadSha === undefined
          ? { status: "stale" }
          : { status: "stale", currentHeadSha: diffResult.currentHeadSha };
      }
      if (diffResult.status === "unavailable") {
        return {
          status: "refused",
          reason: diffResult.reason === "not-effective" ? "not-effective" : "unsupported",
          detail:
            diffResult.reason === "not-effective"
              ? "The second-model pull request reviewer plugin is disabled or untrusted."
              : "The pull request diff is unavailable for this head commit.",
        };
      }

      if (diffResult.diff.files.length === 0) {
        return {
          status: "completed",
          findingIds: [],
          summaryCommentPosted: false,
          handedBackToWorker: false,
        };
      }

      const prompt = buildReviewPrompt(request, diffResult.diff);
      const turn = await host.runReadOnlyReviewTurn(
        { prompt, systemInstructions: SYSTEM_INSTRUCTIONS },
        signal,
      );
      if (signal.aborted || turn.status === "cancelled") {
        return { status: "cancelled" };
      }
      if (turn.status === "refused") {
        if (turn.reason === "head-stale") {
          return { status: "stale" };
        }
        return { status: "refused", reason: turn.reason, detail: turn.detail };
      }
      if (turn.status === "failed") {
        return { status: "failed", detail: turn.detail };
      }

      const proposals = parseReviewerFindings(turn.text, diffResult.diff);
      const recorded = await host.recordFindings(
        { findings: proposals, runId: turn.runId },
        signal,
      );
      if (signal.aborted) return { status: "cancelled" };
      if (recorded.status === "stale") {
        return recorded.currentHeadSha === undefined
          ? { status: "stale" }
          : { status: "stale", currentHeadSha: recorded.currentHeadSha };
      }
      if (recorded.status === "refused") {
        return recorded.reason === "not-effective"
          ? {
              status: "refused",
              reason: "not-effective",
              detail: "The second-model pull request reviewer is no longer active.",
            }
          : {
              status: "failed",
              detail: recorded.detail ?? "Findings could not be recorded for this review.",
            };
      }

      let summaryCommentPosted = false;
      if (request.optIns.postSummaryComment) {
        const comment = await host.postSummaryComment(
          {
            body: formatSummaryComment({
              request,
              modelId: String(turn.modelId),
              findings: recorded.findings,
            }),
          },
          signal,
        );
        if (signal.aborted) return { status: "cancelled" };
        if (comment.status === "stale") {
          return comment.currentHeadSha === undefined
            ? { status: "stale" }
            : { status: "stale", currentHeadSha: comment.currentHeadSha };
        }
        summaryCommentPosted = comment.status === "posted";
      }

      let handedBackToWorker = false;
      const blockingIds = recorded.findings
        .filter((finding) => finding.severity === "error")
        .map((finding) => finding.id);
      if (request.optIns.sendBlockingFindingsToWorker && blockingIds.length > 0) {
        const handBack = await host.handBackBlockingFindings({ findingIds: blockingIds }, signal);
        if (signal.aborted) return { status: "cancelled" };
        if (handBack.status === "stale") {
          return handBack.currentHeadSha === undefined
            ? { status: "stale" }
            : { status: "stale", currentHeadSha: handBack.currentHeadSha };
        }
        handedBackToWorker = handBack.status === "handed-back";
      }

      return {
        status: "completed",
        findingIds: recorded.findings.map((finding) => finding.id),
        runId: turn.runId,
        summaryCommentPosted,
        handedBackToWorker,
      };
    },
  };
}
