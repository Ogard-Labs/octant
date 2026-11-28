import {
  MAX_PULL_REQUEST_GUIDE_STOPS,
  PULL_REQUEST_GUIDE_WRITER_CONTRIBUTION_KIND,
  type PullRequestGuideStopProposal,
  type PullRequestGuideWriteRequest,
  type PullRequestGuideWriter,
} from "@octant/plugin-api/pull-request-guide-writer";
import {
  MAX_PULL_REQUEST_REVIEW_PROMPT_BYTES,
  type PullRequestReviewDiffSnapshot,
} from "@octant/plugin-api/pull-request-reviewer";

const encoder = new TextEncoder();

export const BUNDLED_PULL_REQUEST_GUIDE_WRITER_ID =
  "octant/bundled-pull-request-guide-writer" as const;
export const BUNDLED_PULL_REQUEST_GUIDE_WRITER_DISPLAY_NAME = "PR review guide writer" as const;

const SYSTEM_INSTRUCTIONS = [
  "You write a review guide for a person reading a pull request inside Octant, at Plan's read-only gate.",
  "A guide walks the reader through the change in the order that makes it easiest to understand: start where the change begins, end with tests and cleanup.",
  `Write at most ${MAX_PULL_REQUEST_GUIDE_STOPS} stops. Each stop has a short title, a few sentences on why this part matters, needsDecision true only when the reader must make a judgement call (a tradeoff, a risky default, a behaviour change), and anchors into the diff.`,
  "An anchor is a path from the diff and a line range on the new side of a hunk. Anchors outside the diff are dropped.",
  "Respond with JSON only, in this exact shape:",
  '{"stops":[{"title":"…","why":"…","needsDecision":false,"anchors":[{"path":"relative/path.ts","startLine":10,"endLine":24}]}]}',
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

/** The diff as the model reads it, cut to the review prompt budget with the cut stated. */
export function buildGuidePrompt(
  request: PullRequestGuideWriteRequest,
  diff: PullRequestReviewDiffSnapshot,
): string {
  const header = [
    `Pull request: ${String(request.target.repositoryOwner)}/${String(request.target.repositoryName)}#${request.target.number}`,
    `Head commit: ${request.headSha}`,
    `Base: ${request.baseRef}`,
    `Changed files (${diff.files.length}${diff.truncated === true ? ", truncated" : ""}):`,
    "",
  ].join("\n");
  const budget = MAX_PULL_REQUEST_REVIEW_PROMPT_BYTES - 1_024;
  let used = encoder.encode(header).byteLength;
  const sections = [header];
  for (const file of diff.files) {
    const entry = `--- FILE: ${String(file.path)} (${file.status}) ---\n${file.patch ?? ""}\n`;
    const size = encoder.encode(entry).byteLength;
    if (used + size > budget) {
      sections.push(
        `${truncateUtf8(entry, Math.max(0, budget - used - 128))}\n[diff truncated: the rest of the change is not shown]\n`,
      );
      break;
    }
    sections.push(entry);
    used += size;
  }
  return truncateUtf8(sections.join(""), MAX_PULL_REQUEST_REVIEW_PROMPT_BYTES);
}

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/**
 * Reads the model's `{ stops: [...] }` reply. Fields of the wrong type are
 * left out rather than guessed; the host validates what remains.
 */
export function parseGuideStops(
  text: string,
): ReadonlyArray<PullRequestGuideStopProposal> | undefined {
  const trimmed = text.trim();
  // The bare reply first, then one fence around all of it, then the reply's
  // only fence: a stop may quote a fenced snippet inside its JSON, and that
  // snippet is not the reply.
  const fenced = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)];
  const candidates = [
    trimmed,
    /^```(?:json)?\s*([\s\S]*)```$/i.exec(trimmed)?.[1],
    fenced.length === 1 ? fenced[0]?.[1] : undefined,
  ];
  let stops: ReadonlyArray<unknown> | undefined;
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    try {
      const value = record(JSON.parse(candidate))?.stops;
      if (Array.isArray(value)) {
        stops = value;
        break;
      }
    } catch {
      // Not this candidate.
    }
  }
  if (stops === undefined) return undefined;
  const proposals: PullRequestGuideStopProposal[] = [];
  for (const raw of stops) {
    const stop = record(raw);
    if (stop === undefined || typeof stop.title !== "string") continue;
    const anchors = Array.isArray(stop.anchors) ? stop.anchors : [];
    proposals.push({
      title: stop.title,
      why: typeof stop.why === "string" ? stop.why : "",
      needsDecision: stop.needsDecision === true,
      anchors: anchors.flatMap((value) => {
        const anchor = record(value);
        return anchor !== undefined &&
          typeof anchor.path === "string" &&
          typeof anchor.startLine === "number" &&
          typeof anchor.endLine === "number"
          ? [{ path: anchor.path, startLine: anchor.startLine, endLine: anchor.endLine }]
          : [];
      }),
    });
  }
  return proposals;
}

/**
 * Octant's bundled guide writer. It uses only the narrow guide host port: one
 * diff read and one read-only turn on the person's guide model.
 */
export function createBundledPullRequestGuideWriter(): PullRequestGuideWriter {
  return {
    kind: PULL_REQUEST_GUIDE_WRITER_CONTRIBUTION_KIND,
    write: async (request, host, signal) => {
      const diff = await host.readPullRequestDiff(signal);
      if (signal.aborted) return { status: "cancelled" };
      if (diff.status === "stale") return { status: "stale" };
      if (diff.status === "unavailable") {
        return { status: "failed", detail: "The pull request's diff could not be read." };
      }
      if (diff.diff.files.length === 0) return { status: "written", stops: [] };
      const turn = await host.runReadOnlyGuideTurn(
        { prompt: buildGuidePrompt(request, diff.diff), systemInstructions: SYSTEM_INSTRUCTIONS },
        signal,
      );
      if (signal.aborted || turn.status === "cancelled") return { status: "cancelled" };
      if (turn.status === "refused") {
        return turn.reason === "head-stale"
          ? { status: "stale" }
          : { status: "refused", detail: turn.detail };
      }
      if (turn.status === "failed") return { status: "failed", detail: turn.detail };
      const stops = parseGuideStops(turn.text);
      return stops === undefined
        ? { status: "invalid-output", detail: 'The reply was not JSON of the form {"stops":[…]}.' }
        : { status: "written", stops };
    },
  };
}
