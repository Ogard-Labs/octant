/**
 * Curated workspace presets.
 *
 * A preset is an arrangement the host offers for a kind of work: pick one, and
 * the host opens the panes it pinned. The host owns the catalog and composes
 * every operation from the pinned record, so a renderer selects a preset and
 * never authors one — the same rule the curated scaffolds already follow, for
 * the same reason.
 *
 * A preset also names the skills that kind of work usually wants. Naming is
 * all it does. A preset never installs, trusts, enables, or elevates anything:
 * it reports which of those skills the thread can already use and which it
 * cannot, and enabling one stays the deliberate act it is everywhere else.
 */

import { Schema } from "effect";
import { CodeCheckoutId, CodeThreadId } from "./code";
import { AggregateVersion, UtcTimestamp } from "./events";
import { ScaffoldId } from "./scaffolds";

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const MAX_WORKSPACE_PRESET_PANES = 6;
export const MAX_WORKSPACE_PRESET_SKILLS = 8;

export const WorkspacePresetId = Schema.String.pipe(
  Schema.pattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  Schema.maxLength(64),
  Schema.brand("WorkspacePresetId"),
);
export type WorkspacePresetId = typeof WorkspacePresetId.Type;

/**
 * A pane a preset may open.
 *
 * Deliberately a closed list of surfaces a Code thread can already open for
 * itself: a preset arranges what the thread has, and is never a way to reach a
 * surface the thread could not open on its own.
 */
export const WorkspacePresetPane = Schema.Literal(
  "code-overview",
  "browser",
  "side-chat",
  "files",
  "code-terminal",
);
export type WorkspacePresetPane = typeof WorkspacePresetPane.Type;

const WorkspacePresetSkillName = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(64),
  Schema.pattern(/^[a-z0-9][a-z0-9-]*$/),
);

export const WorkspacePreset = Schema.Struct({
  id: WorkspacePresetId,
  displayName: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(80)),
  summary: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(240)),
  /** Code for now: the panes a preset arranges are a Code thread's. */
  mode: Schema.Literal("code"),
  /** The scaffold this preset starts from, when it starts from one. */
  scaffoldId: Schema.optional(ScaffoldId),
  panes: Schema.Array(WorkspacePresetPane).pipe(
    Schema.filter(
      (panes) =>
        panes.length > 0 &&
        panes.length <= MAX_WORKSPACE_PRESET_PANES &&
        new Set(panes).size === panes.length,
    ),
  ),
  /** Skills this kind of work usually wants. Named, never enabled. */
  defaultSkills: Schema.Array(WorkspacePresetSkillName).pipe(
    Schema.filter(
      (names) =>
        names.length <= MAX_WORKSPACE_PRESET_SKILLS && new Set(names).size === names.length,
    ),
  ),
}).annotations(strict);
export type WorkspacePreset = typeof WorkspacePreset.Type;

/**
 * The presets this host offers. Authoritative and may be empty. A renderer
 * submits a preset's id back; it never submits a preset.
 */
export const WorkspacePresetCatalogListing = Schema.Struct({
  kind: Schema.Literal("workspace-preset-catalog-listing"),
  presets: Schema.Array(WorkspacePreset).pipe(
    Schema.filter((presets) => new Set(presets.map((p) => p.id)).size === presets.length),
  ),
  observedAt: UtcTimestamp,
}).annotations(strict);
export type WorkspacePresetCatalogListing = typeof WorkspacePresetCatalogListing.Type;

/**
 * Where one named skill stands for the thread the preset was applied to.
 *
 * `active` means the thread can already use it. The other two are statements
 * about what is missing, not steps the preset took: applying a preset installs
 * nothing, trusts nothing, and enables nothing.
 */
export const WorkspacePresetSkillStatus = Schema.Literal(
  "active",
  "installed-not-enabled",
  "not-installed",
);
export type WorkspacePresetSkillStatus = typeof WorkspacePresetSkillStatus.Type;

export const WorkspacePresetSkillReport = Schema.Struct({
  name: WorkspacePresetSkillName,
  status: WorkspacePresetSkillStatus,
}).annotations(strict);
export type WorkspacePresetSkillReport = typeof WorkspacePresetSkillReport.Type;

/**
 * Apply one preset to a Code thread this window already has open.
 *
 * The request carries no workspace version. A preset performs several
 * operations in sequence, and only the first could be guarded by a version the
 * caller knew; the host reads the version it is actually at and reports the
 * one it ended on. Nothing here describes a layout, so there is no stale
 * renderer state for a guard to catch.
 */
export const WorkspacePresetApplyRequest = Schema.Struct({
  presetId: WorkspacePresetId,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
}).annotations(strict);
export type WorkspacePresetApplyRequest = typeof WorkspacePresetApplyRequest.Type;

export const WorkspacePresetApplied = Schema.Struct({
  kind: Schema.Literal("workspace-preset-applied"),
  presetId: WorkspacePresetId,
  version: AggregateVersion,
  /** Panes the host opened, in the order it opened them. */
  opened: Schema.Array(WorkspacePresetPane),
  skills: Schema.Array(WorkspacePresetSkillReport),
}).annotations(strict);
export type WorkspacePresetApplied = typeof WorkspacePresetApplied.Type;

export const decodeWorkspacePresetId = Schema.decodeUnknownSync(WorkspacePresetId);
export const decodeWorkspacePreset = Schema.decodeUnknownSync(WorkspacePreset);
export const decodeWorkspacePresetCatalogListing = Schema.decodeUnknownSync(
  WorkspacePresetCatalogListing,
);
export const decodeWorkspacePresetApplyRequest = Schema.decodeUnknownSync(
  WorkspacePresetApplyRequest,
);
export const decodeWorkspacePresetApplied = Schema.decodeUnknownSync(WorkspacePresetApplied);
