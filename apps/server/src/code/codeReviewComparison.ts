import { createHash } from "node:crypto";
import {
  decodeCodeReviewTarget,
  type CodeReviewTarget,
  type CodeReviewFinding,
  type CodeReviewRevision,
  type CodeEvidenceReference,
  type CodeOperationId,
  type UtcTimestamp,
  type CodeThreadId,
  type CodeCheckoutId,
} from "@octant/contracts";
import { parseUnifiedDiff, diffSourceLines } from "@octant/domain";
import { deriveCodeFileId } from "./codeFileIdentity";

export interface RetainedCodeReview {
  readonly operationId: CodeOperationId;
  readonly evidence: CodeEvidenceReference;
  readonly revision: CodeReviewRevision;
  readonly capturedAt: UtcTimestamp;
  readonly text: string;
}
const digest = (text: string) => createHash("sha256").update(text).digest("hex");

/** A real source line in a captured hunk, never a reconstructed Monaco row number. */
export function retainedReviewTarget(
  snapshot: RetainedCodeReview,
  input: {
    readonly threadId: CodeThreadId;
    readonly checkoutId: CodeCheckoutId;
    readonly path: string;
    readonly side: "original" | "modified";
    readonly line: number;
  },
): { readonly target: CodeReviewTarget; readonly excerpt: string } | undefined {
  if (
    snapshot.evidence.truncated === true ||
    digest(snapshot.text) !== snapshot.evidence.digest ||
    Buffer.byteLength(snapshot.text) !== snapshot.evidence.byteLength
  )
    return undefined;
  const file = parseUnifiedDiff(snapshot.text).find((candidate) => candidate.path === input.path);
  if (file === undefined || file.binary) return undefined;
  const lines = diffSourceLines(file, input.side);
  const at = lines.findIndex((line) => line.line === input.line);
  if (at < 0) return undefined;
  // The line map is part of the identity: identical text at another line cannot alias this anchor.
  const fileDigest = digest(JSON.stringify({ path: file.path, side: input.side, lines }));
  const target = decodeCodeReviewTarget({
    fileId: deriveCodeFileId(input.threadId, input.checkoutId, file.path),
    path: file.path,
    fileDigest,
    location: { kind: "line", line: input.line },
    anchor: {
      kind: "captured-diff",
      reviewOperationId: snapshot.operationId,
      diff: snapshot.evidence,
      revision: snapshot.revision,
      side: input.side,
      capturedAt: snapshot.capturedAt,
    },
  });
  const excerpt = lines
    .slice(Math.max(0, at - 2), at + 3)
    .map((line) => `${line.line}: ${line.text}`)
    .join("\n");
  return { target, excerpt };
}

/** Stable ordering binds the original anchor without depending on JSON field order. */
export function reviewFindingAnchorDigest(
  finding: Pick<
    CodeReviewFinding,
    "threadId" | "checkoutId" | "fileId" | "path" | "fileDigest" | "location" | "anchor"
  >,
): string {
  const anchor = finding.anchor;
  return digest(
    JSON.stringify({
      threadId: finding.threadId,
      checkoutId: finding.checkoutId,
      fileId: finding.fileId,
      path: finding.path,
      fileDigest: finding.fileDigest,
      location:
        finding.location.kind === "line"
          ? { kind: "line", line: finding.location.line }
          : {
              kind: "selection",
              startLine: finding.location.startLine,
              startColumn: finding.location.startColumn,
              endLine: finding.location.endLine,
              endColumn: finding.location.endColumn,
            },
      anchor:
        anchor === undefined
          ? undefined
          : {
              kind: anchor.kind,
              reviewOperationId: anchor.reviewOperationId,
              diff: {
                contentId: anchor.diff.contentId,
                digest: anchor.diff.digest,
                byteLength: anchor.diff.byteLength,
                truncated: anchor.diff.truncated,
              },
              revision:
                anchor.revision.kind === "working-tree"
                  ? { kind: anchor.revision.kind, stateToken: anchor.revision.stateToken }
                  : anchor.revision.kind === "branch"
                    ? {
                        kind: anchor.revision.kind,
                        head: anchor.revision.head,
                        base: anchor.revision.base,
                        baseRef: anchor.revision.baseRef,
                      }
                    : {
                        kind: anchor.revision.kind,
                        operationId: anchor.revision.operationId,
                        captureCursor: anchor.revision.captureCursor,
                        version: anchor.revision.version,
                        baseline: anchor.revision.baseline,
                        tree: anchor.revision.tree,
                      },
              side: anchor.side,
              capturedAt: anchor.capturedAt,
            },
    }),
  );
}

export function reviewFindingLabel(finding: CodeReviewFinding): string {
  const location =
    finding.location.kind === "line"
      ? `line ${finding.location.line}`
      : `lines ${finding.location.startLine}–${finding.location.endLine}`;
  const revision = finding.anchor?.revision;
  return `${finding.path} · ${finding.anchor?.side ?? "legacy file"} ${location}${revision?.kind === "turn-capture" ? ` · turn capture ${revision.version}, start tree ${revision.baseline}` : ""}`;
}

export function boundReviewText(
  text: string,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  if (Buffer.byteLength(text) <= maxBytes) return { text, truncated: false };
  let bytes = 0;
  const kept: string[] = [];
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > maxBytes) break;
    kept.push(character);
    bytes += size;
  }
  return { text: kept.join(""), truncated: true };
}
