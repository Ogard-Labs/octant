import type { CanvasId, CanvasVersion } from "@octant/contracts";
import { validateCanvasVersion } from "./canvasPolicy";

/**
 * Pure Canvas lifecycle transitions. The journal is authoritative; these
 * policies guard create/version-append sequencing before an event is appended
 * or applied to a projection. They perform no I/O and hold no authority.
 */

export type CanvasLifecycleRejectionCode =
  | "invalid-first-sequence"
  | "canvas-id-mismatch"
  | "schema-version-mismatch"
  | "non-incrementing-sequence"
  | "duplicate-version-id";

export class CanvasLifecyclePolicyRejected extends Error {
  override readonly name = "CanvasLifecyclePolicyRejected";

  constructor(
    readonly code: CanvasLifecycleRejectionCode,
    message: string,
  ) {
    super(message);
  }
}

function reject(code: CanvasLifecycleRejectionCode, message: string): never {
  throw new CanvasLifecyclePolicyRejected(code, message);
}

function sameId(left: CanvasId, right: CanvasId): boolean {
  return String(left) === String(right);
}

function sameVersionId(left: CanvasVersion, right: CanvasVersion): boolean {
  return String(left.versionId) === String(right.versionId);
}

/**
 * Validate the first Canvas version emitted by a `canvas.created@1` event.
 * The version envelope is re-validated through the A1 budget/cross-reference
 * policy so a hostile or oversized payload fails closed before persistence.
 */
export function assertCanvasCreate(canvasId: CanvasId, versionInput: CanvasVersion): CanvasVersion {
  const version = validateCanvasVersion(versionInput);
  if (version.sequence !== 1) {
    reject("invalid-first-sequence", "Canvas create must start at sequence 1.");
  }
  if (!sameId(version.canvasId, canvasId)) {
    reject("canvas-id-mismatch", "Canvas create version envelope must match the event canvasId.");
  }
  return version;
}

/**
 * Validate a subsequent Canvas version emitted by a `canvas.version-appended@1`
 * event against the current head version. The next sequence must increment by
 * exactly one, the canvas identity must match, the schema version must agree,
 * and the versionId must be a new immutable identity.
 */
export function assertCanvasVersionAppend(
  canvasId: CanvasId,
  current: CanvasVersion,
  nextInput: CanvasVersion,
): CanvasVersion {
  const next = validateCanvasVersion(nextInput);
  if (!sameId(next.canvasId, canvasId) || !sameId(next.canvasId, current.canvasId)) {
    reject("canvas-id-mismatch", "Canvas version append must match the current canvas identity.");
  }
  if (next.schemaVersion !== current.schemaVersion) {
    reject(
      "schema-version-mismatch",
      "Canvas version append must share the current schema version.",
    );
  }
  if (next.sequence !== current.sequence + 1) {
    reject(
      "non-incrementing-sequence",
      "Canvas version append must increment sequence by exactly one.",
    );
  }
  if (sameVersionId(next, current)) {
    reject("duplicate-version-id", "Canvas version append must carry a new immutable versionId.");
  }
  return next;
}
