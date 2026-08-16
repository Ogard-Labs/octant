import type { OctantMode } from "@octant/contracts/modes";
import type { CodeThreadId } from "@octant/contracts/code";
import type { ProjectId, ProjectType } from "@octant/contracts/projects";
import type {
  PreviewCapabilityFlags,
  PreviewFidelity,
  PreviewHostId,
  PreviewKind,
  PreviewManifest,
  PreviewSelection,
  PreviewSourceVersion,
  PreviewTarget,
  PreviewTargetId,
  PreviewTargetKind,
} from "@octant/contracts/previews";

type PreviewTabAuthority = "bound" | "unavailable";

/**
 * Authority posture of the active thread. Plan mode is always read-only,
 * including when Full access is remembered for a Code Project.
 */
export type PreviewPosture = "plan" | "approval-gated" | "full";

export type PreviewAuthorityDecision = "allow" | "deny";

export interface PreviewAuthorityInput {
  readonly mode: OctantMode;
  readonly projectType: ProjectType;
  readonly activeProjectId: ProjectId;
  readonly activeHostId: PreviewHostId;
  // Optional: the active Code thread when mode is `code`. Lets the pure
  // authority policy fail closed across worktrees within the same Code
  // Project; the host still enforces worktree containment.
  readonly activeThreadId?: CodeThreadId;
  readonly target: PreviewTarget;
}

const WORK_AND_CODE_TARGETS: ReadonlyArray<PreviewTargetKind> = [
  "file",
  "artifact-version",
  "validation-evidence",
];

const CHAT_TARGETS: ReadonlyArray<PreviewTargetKind> = ["attachment", "artifact-version"];

/**
 * Decide whether the active mode, host, and Project may request a preview for
 * the given opaque target. The host re-runs this check before every read; the
 * renderer never receives a host path and never performs containment itself.
 *
 * Fails closed when: the target belongs to another Project, the active mode
 * does not match the Project type, the target was minted for a different host,
 * or (for Code targets bound to a thread) the active thread differs.
 */
export function authorizePreviewTarget(input: PreviewAuthorityInput): PreviewAuthorityDecision {
  if (input.target.projectId !== input.activeProjectId) return "deny";
  if (input.mode !== input.projectType) return "deny";
  if (input.target.hostId !== input.activeHostId) return "deny";
  if (input.mode === "code") {
    // Fail closed: a Code target bound to a thread requires the active
    // thread to be supplied and to match. A bound target with no active
    // thread is denied so restored/remote requests cannot cross worktrees.
    if (input.target.boundCodeThreadId !== undefined) {
      if (input.activeThreadId === undefined) return "deny";
      if (input.target.boundCodeThreadId !== input.activeThreadId) return "deny";
    }
  }
  if (input.mode === "chat") {
    return CHAT_TARGETS.includes(input.target.kind) ? "allow" : "deny";
  }
  return WORK_AND_CODE_TARGETS.includes(input.target.kind) ? "allow" : "deny";
}

export interface PreviewCapabilityInput {
  readonly mode: OctantMode;
  readonly posture: PreviewPosture;
  readonly kind: PreviewKind;
  readonly baseCapabilities: PreviewCapabilityFlags;
}

/**
 * Authority input for an external-application preview handoff. Adds the
 * active thread posture and the transport principal kind to the ordinary
 * preview target authority so host side effects (Finder reveal, Quick Look,
 * open-external) fail closed in plan mode and for remote least-authority
 * principals.
 */
export interface PreviewHandoffAuthorityInput {
  readonly mode: OctantMode;
  readonly projectType: ProjectType;
  readonly activeProjectId: ProjectId;
  readonly activeHostId: PreviewHostId;
  readonly activeThreadId?: CodeThreadId;
  readonly target: PreviewTarget;
  readonly posture: PreviewPosture;
  readonly principalKind: "local-window" | "remote-device";
}

/**
 * Authorize an external-application preview handoff. Fails closed whenever
 * the underlying preview target authority denies, in plan mode (Finder
 * reveal, Quick Look, and open-external are host side effects plan mode must
 * never trigger even when a manifest flag slipped through), and for remote
 * least-authority principals (the native execution path is local-host only;
 * remote clients may preview read-only but never command the host to open
 * applications or reveal files). Renderer capability flags are cosmetic
 * presentation; this check is the server-enforced authority.
 */
export function authorizePreviewHandoff(
  input: PreviewHandoffAuthorityInput,
): PreviewAuthorityDecision {
  if (input.posture === "plan") return "deny";
  if (input.principalKind !== "local-window") return "deny";
  return authorizePreviewTarget(input);
}

/**
 * Resolve the effective, visible capability set for a preview. Format-derived
 * base capabilities are filtered by the active posture: plan mode removes
 * Monaco edit and all external-application handoff (Finder reveal, Quick Look,
 * and open-externally) while preserving in-renderer read-only navigation,
 * search, selection, and zoom. Plan mode must never trigger macOS Finder or
 * Quick Look side effects.
 */
export function resolvePreviewCapabilities(input: PreviewCapabilityInput): PreviewCapabilityFlags {
  const base = input.baseCapabilities;
  const plan = input.posture === "plan";
  const canEditInMonaco =
    !plan && input.posture === "full" && input.kind === "text" && base.canEditInMonaco;
  const canOpenExternally = !plan && base.canOpenExternally;
  const canRevealInFinder = !plan && base.canRevealInFinder;
  const canQuickLook = !plan && base.canQuickLook;
  return {
    canSearch: base.canSearch,
    canSelect: base.canSelect,
    canZoom: base.canZoom,
    canRevealInFinder,
    canOpenExternally,
    canQuickLook,
    canEditInMonaco,
  };
}

const INHERENTLY_LIMITED_KINDS: ReadonlyArray<PreviewKind> = ["workbook", "document", "slides"];

const INHERENT_LIMIT_NOTICES: Readonly<Record<string, string>> = {
  workbook:
    "Workbook preview shows stored values and formulas without execution; advanced charts and embedded objects may be omitted",
  document:
    "Document preview preserves structure and text; complex layout, fonts, fields, and tracked changes may require external handoff",
  slides:
    "Slide preview shows thumbnails, text, and notes; transitions, media playback, and pixel-perfect layout are not guaranteed",
};

/**
 * Classify preview fidelity. Office formats are inherently limited; any
 * configured-budget exhaustion downgrades the fidelity to limited with an
 * actionable notice. Unsupported kinds always report limited fidelity.
 */
export function classifyFidelity(
  kind: PreviewKind,
  exceedsBudget: boolean,
  notice?: string,
): PreviewFidelity {
  if (kind === "unsupported") {
    return { level: "limited", notice: notice ?? "No safe in-app viewer for this format" };
  }
  if (exceedsBudget) {
    return {
      level: "limited",
      notice: notice ?? "Configured preview budget exceeded; content may be truncated",
    };
  }
  if (INHERENTLY_LIMITED_KINDS.includes(kind)) {
    return { level: "limited", notice: notice ?? INHERENT_LIMIT_NOTICES[kind] };
  }
  return { level: "full" };
}

export type PreviewSelectionValidationCode =
  | "target-mismatch"
  | "source-version-mismatch"
  | "kind-mismatch"
  | "out-of-bounds"
  | "unknown-kind";

export interface PreviewSelectionValidation {
  readonly ok: boolean;
  readonly code?: PreviewSelectionValidationCode;
}

function sameVersion(a: PreviewSourceVersion, b: PreviewSourceVersion): boolean {
  return a.contentSha256 === b.contentSha256;
}

function requireBound(value: number, bound: number | undefined): boolean {
  return bound !== undefined && value <= bound;
}

/**
 * Validate a structured selection against the manifest. Selections are
 * target-bound, source-versioned, kind-aligned, and bounded; a selection can
 * never escape its target, source version, the manifest's preview kind, or
 * the manifest's content bounds. Bounded formats (pdf/table/workbook/slides)
 * fail closed when the manifest omits the relevant count rather than fail
 * open.
 */
export function validatePreviewSelection(
  selection: PreviewSelection,
  manifest: PreviewManifest,
): PreviewSelectionValidation {
  if (selection.targetId !== manifest.target.targetId) {
    return { ok: false, code: "target-mismatch" };
  }
  if (!sameVersion(selection.sourceVersion, manifest.sourceVersion)) {
    return { ok: false, code: "source-version-mismatch" };
  }
  if (selection.kind !== manifest.kind) {
    return { ok: false, code: "kind-mismatch" };
  }
  const bounds = manifest.bounds;
  switch (selection.kind) {
    case "text":
    case "markdown":
      return { ok: true };
    case "pdf":
      return requireBound(selection.page, bounds.pages)
        ? { ok: true }
        : { ok: false, code: "out-of-bounds" };
    case "table":
      return requireBound(selection.endRow, bounds.rows) &&
        requireBound(selection.endColumn, bounds.columns)
        ? { ok: true }
        : { ok: false, code: "out-of-bounds" };
    case "workbook":
      return requireBound(selection.worksheet, bounds.worksheets) &&
        requireBound(selection.endRow, bounds.rows) &&
        requireBound(selection.endColumn, bounds.columns)
        ? { ok: true }
        : { ok: false, code: "out-of-bounds" };
    case "document":
      return requireBound(selection.blockIndex, bounds.blocks)
        ? { ok: true }
        : { ok: false, code: "out-of-bounds" };
    case "slides":
      return requireBound(selection.slide, bounds.slides)
        ? { ok: true }
        : { ok: false, code: "out-of-bounds" };
    default:
      return { ok: false, code: "unknown-kind" };
  }
}

export type PreviewRestoreState = "restorable" | "stale";

/**
 * Classify whether persisted viewer state is safe to restore against the
 * current target and source version. A target mismatch or version mismatch
 * restores as stale, never as a preview of a guessed replacement.
 */
export function classifyViewerStateRestore(
  state: { readonly targetId: PreviewTargetId; readonly sourceVersion: PreviewSourceVersion },
  currentTargetId: PreviewTargetId,
  currentVersion: PreviewSourceVersion,
): PreviewRestoreState {
  if (state.targetId !== currentTargetId) return "stale";
  return sameVersion(state.sourceVersion, currentVersion) ? "restorable" : "stale";
}

export type PreviewSourceAvailability = "available" | "stale" | "unavailable";

/**
 * Classify source availability from the current and previously known source
 * versions. A missing current version is unavailable; a changed content hash
 * is stale; otherwise the source is available.
 */
export function classifySourceAvailability(
  current: PreviewSourceVersion | undefined,
  known: PreviewSourceVersion | undefined,
): PreviewSourceAvailability {
  if (current === undefined) return "unavailable";
  if (known === undefined) return "available";
  return sameVersion(current, known) ? "available" : "stale";
}

/**
 * Check whether a preview tab's Project matches the active workspace context.
 * Returns `bound` when the active context is bound to the same Project,
 * `unavailable` otherwise. The host still reauthorizes the opaque target
 * on every open/chunk/refresh after the tab is presented.
 */
export function classifyPreviewTabAuthority(input: {
  readonly tabProjectId: ProjectId;
  readonly activeProjectId: ProjectId | null;
}): PreviewTabAuthority {
  return input.activeProjectId === input.tabProjectId ? "bound" : "unavailable";
}
