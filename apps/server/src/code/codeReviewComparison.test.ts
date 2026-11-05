import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  decodeCodeEvidenceReference,
  decodeCodeOperationId,
  decodeCodeThreadId,
  decodeCodeCheckoutId,
  UtcTimestamp,
} from "@octant/contracts";
import { Schema } from "effect";
import { retainedReviewTarget, type RetainedCodeReview } from "./codeReviewComparison";

const threadId = decodeCodeThreadId("10000000-0000-4000-8000-000000000001");
const checkoutId = decodeCodeCheckoutId("10000000-0000-4000-8000-000000000002");
function retained(text: string): RetainedCodeReview {
  return {
    operationId: decodeCodeOperationId("10000000-0000-4000-8000-000000000003"),
    text,
    evidence: decodeCodeEvidenceReference({
      contentId: "10000000-0000-4000-8000-000000000004",
      digest: createHash("sha256").update(text).digest("hex"),
      byteLength: Buffer.byteLength(text),
      truncated: false,
    }),
    revision: { kind: "working-tree", stateToken: "a".repeat(64) },
    capturedAt: Schema.decodeUnknownSync(UtcTimestamp)("2026-11-02T12:00:00.000Z"),
  };
}
it("anchors real original/modified lines across separated hunks and refuses uncaptured gaps", () => {
  const snapshot = retained(
    "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -4 +7 @@\n-old\n+new\n@@ -200 +203 @@\n-tail old\n+tail new\n",
  );
  const select = (side: "original" | "modified", line: number) =>
    retainedReviewTarget(snapshot, { threadId, checkoutId, path: "file.ts", side, line });
  expect(select("original", 4)?.target.location).toEqual({ kind: "line", line: 4 });
  expect(select("modified", 203)?.excerpt).toContain("203: tail new");
  expect(select("original", 1)).toBeUndefined();
  expect(select("original", 50)).toBeUndefined();
  expect(select("original", 7)).toBeUndefined();
  expect(select("original", 200)?.target.fileDigest).not.toBe(
    select("modified", 203)?.target.fileDigest,
  );
});
it("supports retained original lines of a deleted file, with no modified or binary anchor", () => {
  const snapshot = retained(
    "diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -4 +0,0 @@\n-old\n",
  );
  expect(
    retainedReviewTarget(snapshot, {
      threadId,
      checkoutId,
      path: "gone.ts",
      side: "original",
      line: 4,
    })?.excerpt,
  ).toBe("4: old");
  expect(
    retainedReviewTarget(snapshot, {
      threadId,
      checkoutId,
      path: "gone.ts",
      side: "modified",
      line: 4,
    }),
  ).toBeUndefined();
  expect(
    retainedReviewTarget(retained("diff --git a/image.png b/image.png\nBinary files differ\n"), {
      threadId,
      checkoutId,
      path: "image.png",
      side: "original",
      line: 1,
    }),
  ).toBeUndefined();
});
it("refuses truncated or tampered retained evidence before preparing any line", () => {
  const snapshot = retained(
    "diff --git a/file.ts b/file.ts\n--- a/file.ts\n+++ b/file.ts\n@@ -4 +4 @@\n-old\n+new\n",
  );
  const selection = { threadId, checkoutId, path: "file.ts", side: "original" as const, line: 4 };
  expect(
    retainedReviewTarget(
      { ...snapshot, evidence: { ...snapshot.evidence, truncated: true } },
      selection,
    ),
  ).toBeUndefined();
  expect(
    retainedReviewTarget(
      { ...snapshot, text: snapshot.text.replace("old", "tampered") },
      selection,
    ),
  ).toBeUndefined();
});
