import { Schema } from "effect";
import { STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { CanvasBlockKind, CanvasDesignSize, CanvasSourceKind } from "./canvas";
import { CanvasCardSchemaVersion } from "./canvasCards";
import {
  ExtensionContentDigest,
  ExtensionPackageVersion,
  ExtensionSourceKind,
  SourceQualifiedSkillId,
  StandaloneSkillScope,
} from "./extensions";

// A Canvas skill contribution is the schema-only, provider-neutral description
// of what a *trusted and enabled* skill offers: reusable layouts, the source
// *kinds* it can present, declarative presentation rules, and document recipes.
// It deliberately carries no authority, capabilities, concrete source
// references, hosts, projects, credentials, queries, or executable code. A
// contribution therefore cannot grant authority: installing, selecting, or
// mentioning a skill only ever contributes presentation metadata that the
// server reauthorizes. A recipe is a starting shape, not a document.

export const CANVAS_SKILL_MAX_SUPPORTED_SOURCES = 8;
export const CANVAS_SKILL_MAX_LAYOUTS = 16;
export const CANVAS_SKILL_MAX_SLOTS = 64;
export const CANVAS_SKILL_MAX_PRESENTATION_RULES = 64;
export const CANVAS_SKILL_DIRECTIVE_MAX_CHARS = 512;
export const CANVAS_SKILL_LABEL_MAX_CHARS = 256;
export const CANVAS_DOCUMENT_RECIPE_MAX = 16;
export const CANVAS_DOCUMENT_RECIPE_SKELETON_MAX = 12;
export const CANVAS_DOCUMENT_RECIPE_WHEN_MAX_CHARS = 280;
export const CANVAS_DOCUMENT_RECIPE_ROLE_MAX_CHARS = 120;
export const CANVAS_DOCUMENT_RECIPE_SUMMARY_MAX_CHARS = 140;

const boundedToken = <B extends string>(brand: Parameters<typeof Schema.brand<B>>[0]) =>
  Schema.Trimmed.pipe(
    Schema.check(
      Schema.isNonEmpty(),
      Schema.isMaxLength(96),
      Schema.isPattern(/^[a-z][a-z0-9-]*$/),
    ),
    Schema.brand<B>(brand),
  );
const boundedText = (maximum: number) =>
  Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(maximum));

export const CanvasSkillLayoutId = boundedToken("CanvasSkillLayoutId");
export type CanvasSkillLayoutId = typeof CanvasSkillLayoutId.Type;
export const CanvasSkillPresentationRuleId = boundedToken("CanvasSkillPresentationRuleId");
export type CanvasSkillPresentationRuleId = typeof CanvasSkillPresentationRuleId.Type;

/**
 * A layout slot names a first-party block kind and, optionally, the Canvas
 * source *kind* it is designed to present. The source kind is a category, never
 * a concrete source reference, so a layout can never widen authority to a
 * specific host artifact.
 */
export const CanvasSkillLayoutSlot = Schema.Struct({
  blockKind: CanvasBlockKind,
  sourceKind: Schema.optional(CanvasSourceKind),
  label: Schema.optional(boundedText(CANVAS_SKILL_LABEL_MAX_CHARS)),
});
export type CanvasSkillLayoutSlot = typeof CanvasSkillLayoutSlot.Type;

export const CanvasSkillLayout = Schema.Struct({
  layoutId: CanvasSkillLayoutId,
  title: boundedText(CANVAS_SKILL_LABEL_MAX_CHARS),
  slots: Schema.Array(CanvasSkillLayoutSlot).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(CANVAS_SKILL_MAX_SLOTS),
  ),
});
export type CanvasSkillLayout = typeof CanvasSkillLayout.Type;

export const CanvasSkillPresentationRuleKind = Schema.Literals([
  "emphasis",
  "ordering",
  "grouping",
  "formatting",
  "annotation",
]);
export type CanvasSkillPresentationRuleKind = typeof CanvasSkillPresentationRuleKind.Type;

/**
 * A presentation rule is a declarative hint bound to a first-party block kind.
 * The `directive` is an opaque, bounded descriptor the renderer interprets as
 * presentation only; it is never evaluated, fetched, or executed.
 */
export const CanvasSkillPresentationRule = Schema.Struct({
  ruleId: CanvasSkillPresentationRuleId,
  kind: CanvasSkillPresentationRuleKind,
  target: CanvasBlockKind,
  directive: boundedText(CANVAS_SKILL_DIRECTIVE_MAX_CHARS),
});
export type CanvasSkillPresentationRule = typeof CanvasSkillPresentationRule.Type;

/**
 * One block in a document recipe.
 *
 * `kind` must already exist in the block catalogue. `role` says what that
 * block is for. A `design` slot may also name the `size` it is drawn at,
 * because a document, a phone screen, and a slide are different pieces of
 * work under one kind. A skeleton carries neither a source id nor a body, so
 * a recipe cannot attach a file, invent a reference, or name a block that
 * does not exist.
 */
export const CanvasDocumentRecipeId = boundedToken("CanvasDocumentRecipeId");
export type CanvasDocumentRecipeId = typeof CanvasDocumentRecipeId.Type;

export const CanvasDocumentRecipeSkeletonBlock = Schema.Struct({
  kind: CanvasBlockKind,
  role: boundedText(CANVAS_DOCUMENT_RECIPE_ROLE_MAX_CHARS),
  size: Schema.optional(CanvasDesignSize),
}).check(
  Schema.makeFilter((block) => block.size === undefined || block.kind === "design", {
    message: "Only a design slot names a size.",
  }),
);
export type CanvasDocumentRecipeSkeletonBlock = typeof CanvasDocumentRecipeSkeletonBlock.Type;

export const CanvasDocumentRecipe = Schema.Struct({
  id: CanvasDocumentRecipeId,
  title: boundedText(CANVAS_SKILL_LABEL_MAX_CHARS),
  /**
   * One line a person reads when choosing where a Canvas starts. `whenToUse`
   * is written for an agent matching a request, so a chooser that showed it
   * would read "When someone asks…" beside every recipe. A contributed recipe
   * may omit it; the chooser then shows `whenToUse`.
   */
  summary: Schema.optional(boundedText(CANVAS_DOCUMENT_RECIPE_SUMMARY_MAX_CHARS)),
  whenToUse: boundedText(CANVAS_DOCUMENT_RECIPE_WHEN_MAX_CHARS),
  skeleton: Schema.NonEmptyArray(CanvasDocumentRecipeSkeletonBlock).check(
    Schema.isMaxLength(CANVAS_DOCUMENT_RECIPE_SKELETON_MAX),
  ),
});
export type CanvasDocumentRecipe = typeof CanvasDocumentRecipe.Type;

/**
 * The recipes a host offers a person starting a Canvas: the in-tree catalog
 * and what admitted skills add, the same list describe gives an agent.
 */
export const CanvasDocumentRecipeCatalog = Schema.Struct({
  recipes: Schema.Array(CanvasDocumentRecipe),
});
export type CanvasDocumentRecipeCatalog = typeof CanvasDocumentRecipeCatalog.Type;

export const CanvasSkillContribution = Schema.Struct({
  schemaVersion: CanvasCardSchemaVersion,
  kind: Schema.Literal("canvas-skill-contribution"),
  /** Canonical source/name/digest identity, not the package UUID alone. */
  qualifiedId: SourceQualifiedSkillId,
  /** Bundled/provider-native skills may have no package version; identity is
   * still pinned by qualifiedId and digest. */
  version: Schema.optional(ExtensionPackageVersion),
  digest: ExtensionContentDigest,
  sourceKind: ExtensionSourceKind,
  supportedSources: Schema.Array(CanvasSourceKind)
    .check(Schema.isMinLength(1), Schema.isMaxLength(CANVAS_SKILL_MAX_SUPPORTED_SOURCES))
    .check(
      Schema.makeFilter((kinds) => new Set(kinds).size === kinds.length, {
        message: "Canvas skill supported sources must be unique.",
      }),
    ),
  layouts: Schema.Array(CanvasSkillLayout).check(Schema.isMaxLength(CANVAS_SKILL_MAX_LAYOUTS)),
  presentationRules: Schema.Array(CanvasSkillPresentationRule).check(
    Schema.isMaxLength(CANVAS_SKILL_MAX_PRESENTATION_RULES),
  ),
  recipes: Schema.optional(
    Schema.Array(CanvasDocumentRecipe).check(
      Schema.isMaxLength(CANVAS_DOCUMENT_RECIPE_MAX),
      Schema.makeFilter(
        (recipes) => new Set(recipes.map((recipe) => String(recipe.id))).size === recipes.length,
        { message: "Canvas document recipe ids must be unique." },
      ),
    ),
  ),
  scope: Schema.optional(StandaloneSkillScope),
}).pipe(
  // Provenance integrity: `digest` and `sourceKind` are audit-critical, so
  // they must be consistent with the canonical `qualifiedId` rather than
  // decoded independently. A qualified id is
  // `<sourceKind>:<name>:<skill>:sha256:<digest>`; binding both fields to it
  // prevents a contribution from decoding with an identity that ends in
  // digest A while declaring digest B or a mismatched source kind (spoofed
  // source/digest audit metadata).
  Schema.check(
    Schema.makeFilter(
      (contribution) => {
        const qualifiedId = String(contribution.qualifiedId);
        const separator = qualifiedId.indexOf(":");
        const embeddedSourceKind = separator > 0 ? qualifiedId.slice(0, separator) : "";
        return (
          embeddedSourceKind === String(contribution.sourceKind) &&
          qualifiedId.endsWith(`:${String(contribution.digest)}`)
        );
      },
      { message: "Canvas skill sourceKind and digest must match the qualified skill identity." },
    ),
  ),
);
export type CanvasSkillContribution = typeof CanvasSkillContribution.Type;

export const CanvasSkillContributionDenialCode = Schema.Literals([
  "malformed",
  "untrusted",
  "not-enabled",
  "not-effective",
  "identity-mismatch",
  "version-mismatch",
  "unsupported-source",
  "scope-mismatch",
]);
export type CanvasSkillContributionDenialCode = typeof CanvasSkillContributionDenialCode.Type;

export const CanvasSkillContributionResolution = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("admitted"),
    contribution: CanvasSkillContribution,
  }),
  Schema.Struct({
    kind: Schema.Literal("denied"),
    denialCode: CanvasSkillContributionDenialCode,
    message: boundedText(1_024),
  }),
]);
export type CanvasSkillContributionResolution = typeof CanvasSkillContributionResolution.Type;

export const decodeCanvasSkillLayout = Schema.decodeUnknownSync(
  CanvasSkillLayout,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasSkillPresentationRule = Schema.decodeUnknownSync(
  CanvasSkillPresentationRule,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasDocumentRecipe = Schema.decodeUnknownSync(
  CanvasDocumentRecipe,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasDocumentRecipeCatalog = Schema.decodeUnknownSync(
  CanvasDocumentRecipeCatalog,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasSkillContribution = Schema.decodeUnknownSync(
  CanvasSkillContribution,
  STRICT_DECODE_OPTIONS,
);
export const decodeCanvasSkillContributionResolution = Schema.decodeUnknownSync(
  CanvasSkillContributionResolution,
  STRICT_DECODE_OPTIONS,
);
