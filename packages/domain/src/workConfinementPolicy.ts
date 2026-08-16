import type {
  WorkArtifactFormat,
  WorkCapabilityFlags,
  WorkCapabilityReport,
  WorkFidelity,
} from "@octant/contracts/work-artifacts";
import { classifySourceAvailability } from "./previewPolicy";

/**
 * Re-exported source-availability classifier so Work confinement authority
 * has one discoverable entry point. A Work mutation re-runs this against
 * the artifact's known source version before committing; a stale or
 * unavailable source never silently overwrites a newer version.
 */
export const classifyWorkSourceAvailability = classifySourceAvailability;

/**
 * Mutation posture for a Work thread. Work is the active local
 * knowledge-work surface, so it has no read-only plan posture: mutations are
 * either `full` (the user is acting directly) or `approval-gated` (an agent
 * is acting and the user must approve side effects). Destructive and lossy
 * changes require explicit approval regardless of posture.
 */
export type WorkMutationPosture = "approval-gated" | "full";

/**
 * Normalized mutation kind used by the pure confinement authority. The
 * contract `WorkMutationRequest` carries renderer-facing `*-artifact`
 * literals; the server maps them to this short form before invoking policy.
 */
export type WorkMutationKind =
  | "create"
  | "revise"
  | "transform"
  | "rename"
  | "delete"
  | "version"
  | "export";

export type WorkConfinementRejectionCode =
  | "invalid-relative-path"
  | "traversal-rejected"
  | "oversize-relative-path";

export class WorkConfinementRejected extends Error {
  override readonly name = "WorkConfinementRejected";

  constructor(
    readonly code: WorkConfinementRejectionCode,
    message: string,
  ) {
    super(message);
  }
}

function reject(code: WorkConfinementRejectionCode, message: string): never {
  throw new WorkConfinementRejected(code, message);
}

const textEncoder = new TextEncoder();
export const MAX_WORK_RELATIVE_PATH_BYTES = 4_096;

/**
 * Canonicalize a Work-relative artifact path. The host supplies the raw
 * relative path; this pure function validates and normalizes it into a
 * confined POSIX relative path. Rejects absolute paths, backslash separators,
 * null bytes, parent traversal (`..`), trailing separators, non-NFC forms,
 * and oversize byte lengths. The result is safe to join with the canonical
 * Work root for confinement checks.
 */
export function canonicalizeWorkRelativePath(raw: string): string {
  if (
    raw.length === 0 ||
    raw.includes("\0") ||
    raw.includes("\\") ||
    raw.startsWith("/") ||
    raw.endsWith("/") ||
    raw.normalize("NFC") !== raw ||
    textEncoder.encode(raw).byteLength > MAX_WORK_RELATIVE_PATH_BYTES
  ) {
    reject("invalid-relative-path", "Work relative path is not a confined POSIX path");
  }
  const segments: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      reject("traversal-rejected", "Work relative path must not traverse the parent");
    }
    segments.push(segment);
  }
  if (segments.length === 0) {
    reject("invalid-relative-path", "Work relative path must name at least one segment");
  }
  return segments.join("/");
}

export type WorkPathContainment = "contained" | "escapes-root";

/**
 * Classify whether a canonicalized absolute path is strictly inside the
 * canonical Work root. Inputs must already be canonicalized by the host
 * (realpath-resolved, symlink-expanded); this pure function performs the
 * boundary check. A sibling path that shares a prefix but is not inside the
 * root fails closed as `escapes-root`. A filesystem-root (`/`) canonical
 * root is rejected as `escapes-root` for any candidate because a Work
 * binding confined to `/` would classify every absolute path as contained,
 * which violates the fail-closed confinement boundary; the host must bind a
 * non-root directory.
 */
export function classifyPathContainment(
  root: string,
  candidateCanonicalAbsolute: string,
): WorkPathContainment {
  const rootNorm = root.replace(/\/+$/, "");
  if (rootNorm === "" || rootNorm === "/") return "escapes-root";
  if (candidateCanonicalAbsolute === rootNorm) return "contained";
  return candidateCanonicalAbsolute.startsWith(`${rootNorm}/`) ? "contained" : "escapes-root";
}

/**
 * Classify whether a symlink's resolved target is contained by the canonical
 * Work root. Symlink containment is a pure classification over the host's
 * realpath-resolved target; the host performs the actual `readlink`/`realpath`
 * and the policy fails closed when the target escapes the root.
 */
export function classifySymlinkContainment(
  root: string,
  symlinkTargetCanonicalAbsolute: string,
): WorkPathContainment {
  return classifyPathContainment(root, symlinkTargetCanonicalAbsolute);
}

/**
 * Detect that the canonical Work root has moved since an artifact reference
 * was minted. The binding history carries the previous canonical root; a
 * mismatch means the artifact may be missing or relocated and the server
 * must re-resolve rather than silently write to the old location.
 */
export function detectMovedRoot(
  current: { readonly canonicalRoot: string },
  known: { readonly canonicalRoot: string },
): boolean {
  return current.canonicalRoot !== known.canonicalRoot;
}

export type WorkRootRevocationReason =
  | "binding-unavailable"
  | "binding-superseded"
  | "binding-unverified";

export type WorkRootRevocation =
  | { readonly status: "available" }
  | { readonly status: "revoked"; readonly reason: WorkRootRevocationReason };

/**
 * Detect that the Work root binding has been revoked. A binding whose
 * availability is `unavailable` is revoked because the root is no longer
 * accessible; a binding receipt that has been superseded by a newer revision
 * is revoked because the artifact reference was minted against a stale
 * binding; an `unverified` binding is revoked because the host has not
 * confirmed the root is accessible and authoritative after restore/reconnect,
 * and authority must fail closed rather than allow writes against an
 * ambiguous root. Either revoked case fails closed for mutation authority.
 */
export function detectRevokedRoot(input: {
  readonly availability: "available" | "unavailable" | "unverified";
  readonly bindingSuperseded: boolean;
}): WorkRootRevocation {
  if (input.availability === "unverified") {
    return { status: "revoked", reason: "binding-unverified" };
  }
  if (input.availability === "unavailable") {
    return { status: "revoked", reason: "binding-unavailable" };
  }
  if (input.bindingSuperseded) {
    return { status: "revoked", reason: "binding-superseded" };
  }
  return { status: "available" };
}

export type WorkChangeClass = "safe" | "destructive" | "lossy";

export interface WorkChangeClassification {
  readonly change: WorkChangeClass;
  readonly requiresApproval: boolean;
  readonly notice?: string;
}

const LOSSY_TRANSFORMS: ReadonlyArray<readonly [WorkArtifactFormat, WorkArtifactFormat]> = [
  ["docx", "markdown"],
  ["pptx", "markdown-deck"],
  ["xlsx", "csv"],
  ["pdf", "image"],
];

/**
 * Classify a mutation as safe, destructive, or lossy. Destructive and lossy
 * changes require explicit user approval regardless of posture; the
 * classification carries an actionable notice the renderer can present in the
 * approval path. Delete is destructive. A format-changing transform is lossy
 * when the target format cannot preserve the source's fidelity (e.g.,
 * DOCX -> Markdown loses layout). Create, revise, rename, version, and
 * export are safe because prior versions are retained and export produces a
 * derived copy.
 */
export function classifyDestructiveChange(input: {
  readonly kind: WorkMutationKind;
  readonly format?: WorkArtifactFormat;
  readonly targetFormat?: WorkArtifactFormat;
}): WorkChangeClassification {
  switch (input.kind) {
    case "delete":
      return {
        change: "destructive",
        requiresApproval: true,
        notice: "Deletion removes the artifact from the confined Work root",
      };
    case "transform": {
      const from = input.format;
      const to = input.targetFormat;
      if (from === undefined || to === undefined) {
        return {
          change: "lossy",
          requiresApproval: true,
          notice: "Transform source or target format is unknown; approve to proceed",
        };
      }
      if (from === to) {
        return { change: "safe", requiresApproval: false };
      }
      const lossy = LOSSY_TRANSFORMS.some(([src, dst]) => src === from && dst === to);
      if (lossy) {
        return {
          change: "lossy",
          requiresApproval: true,
          notice: `Transforming ${from} to ${to} may lose fidelity; approve to proceed`,
        };
      }
      return { change: "safe", requiresApproval: false };
    }
    case "create":
    case "revise":
    case "rename":
    case "version":
    case "export":
      return { change: "safe", requiresApproval: false };
  }
}

const INHERENTLY_LIMITED_WORK_FORMATS: ReadonlyArray<WorkArtifactFormat> = ["docx", "xlsx", "pptx"];

const INHERENT_LIMIT_NOTICES: Readonly<Record<string, string>> = {
  docx: "Document round-trip preserves text and structure; complex layout, fields, and tracked changes may be lost",
  xlsx: "Workbook round-trip preserves stored values and formulas without execution; charts and embedded objects may be omitted",
  pptx: "Presentation round-trip preserves slides and text; transitions, media, and pixel-perfect layout are not guaranteed",
};

/**
 * Classify Work fidelity for a format interaction. Office formats are
 * inherently limited; any configured-budget exhaustion downgrades the
 * fidelity to limited with an actionable notice. Mirrors `classifyFidelity`
 * from the preview policy so the renderer reuses one fidelity
 * presentation across preview and mutation surfaces.
 */
export function classifyWorkFidelity(
  format: WorkArtifactFormat,
  exceedsBudget: boolean,
  notice?: string,
): WorkFidelity {
  if (exceedsBudget) {
    return {
      level: "limited",
      notice: notice ?? "Configured Work budget exceeded; content may be truncated",
    };
  }
  if (INHERENTLY_LIMITED_WORK_FORMATS.includes(format)) {
    return { level: "limited", notice: notice ?? INHERENT_LIMIT_NOTICES[format] };
  }
  return { level: "full" };
}

/**
 * Resolve the effective, visible capability set for a Work format under
 * the active posture. Work has no read-only plan posture; both `full` and
 * `approval-gated` preserve the format-derived capabilities because approval
 * is enforced per-mutation by `classifyMutationAuthority`, not by hiding
 * capabilities. The function never reports a capability the base format does
 * not support.
 */
export function resolveWorkCapabilities(input: {
  readonly posture: WorkMutationPosture;
  readonly base: WorkCapabilityFlags;
}): WorkCapabilityFlags {
  void input.posture;
  return input.base;
}

function mutationKindSupported(kind: WorkMutationKind, flags: WorkCapabilityFlags): boolean {
  switch (kind) {
    case "create":
      return flags.canCreate;
    case "revise":
    case "transform":
    case "rename":
    case "delete":
      return flags.canMutate;
    case "version":
      return flags.canVersion;
    case "export":
      return flags.canExport;
  }
}

/**
 * Classify whether a transform target format is supported by the capability
 * report. A same-format transform requires `canRoundTrip`; a cross-format
 * transform requires the target to be in the report's `exportFormats` list.
 * Unknown targets fail closed as unsupported.
 */
function transformTargetSupported(
  capability: WorkCapabilityReport,
  targetFormat: WorkArtifactFormat | undefined,
): boolean {
  if (targetFormat === undefined) return false;
  if (targetFormat === capability.format) {
    return capability.capabilities.canRoundTrip;
  }
  return capability.exportFormats.includes(targetFormat);
}

/**
 * Classify whether an export target format is supported by the capability
 * report. An export to the same format is always supported when `canExport`
 * is true; an export to a different format requires the target to be in the
 * report's `exportFormats` list. Unknown targets fail closed as unsupported.
 */
function exportTargetSupported(
  capability: WorkCapabilityReport,
  exportFormat: WorkArtifactFormat | undefined,
): boolean {
  if (exportFormat === undefined) return false;
  if (exportFormat === capability.format) return true;
  return capability.exportFormats.includes(exportFormat);
}

export type WorkMutationAuthorityDecision = "allow" | "deny" | "needs-approval";

/**
 * Decide whether a Work mutation may proceed. This is the pure confinement
 * authority check the server runs before every side effect; the host re-runs
 * it after canonicalization and symlink policy. Fails closed (`deny`) when
 * the root has been revoked or has moved since the artifact reference was
 * minted, the candidate path escapes the root, the format does not support
 * the mutation kind, a transform target is not supported by the capability
 * report, an export target is not advertised in `exportFormats`, or the
 * source is stale or unavailable for a non-create mutation. In
 * `approval-gated` posture (an agent is acting), every side effect requires
 * explicit user approval. In `full` posture (the user is acting directly),
 * destructive changes, lossy changes, and mutations on limited-fidelity
 * formats require explicit approval so the renderer can present the fidelity
 * notice before the side effect.
 */
export function classifyMutationAuthority(input: {
  readonly posture: WorkMutationPosture;
  readonly mutationKind: WorkMutationKind;
  readonly capability: WorkCapabilityReport;
  readonly change: WorkChangeClassification;
  readonly rootRevocation: WorkRootRevocation;
  readonly pathContainment: WorkPathContainment;
  readonly rootMoved: boolean;
  readonly sourceAvailability: "available" | "stale" | "unavailable";
  readonly transformTarget?: WorkArtifactFormat | undefined;
  readonly exportFormat?: WorkArtifactFormat | undefined;
}): WorkMutationAuthorityDecision {
  if (input.rootRevocation.status === "revoked") return "deny";
  if (input.rootMoved) return "deny";
  if (input.pathContainment === "escapes-root") return "deny";
  if (!mutationKindSupported(input.mutationKind, input.capability.capabilities)) {
    return "deny";
  }
  if (
    input.mutationKind === "transform" &&
    !transformTargetSupported(input.capability, input.transformTarget)
  ) {
    return "deny";
  }
  if (
    input.mutationKind === "export" &&
    !exportTargetSupported(input.capability, input.exportFormat)
  ) {
    return "deny";
  }
  if (input.mutationKind !== "create" && input.sourceAvailability !== "available") {
    return "deny";
  }
  if (input.posture === "approval-gated") return "needs-approval";
  if (input.change.requiresApproval) return "needs-approval";
  if (input.capability.fidelity.level === "limited") return "needs-approval";
  return "allow";
}
