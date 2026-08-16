import { Schema } from "effect";
import { CanvasBlockKind, CanvasSourceKind } from "./canvas";
import { CanvasCardSchemaVersion } from "./canvasCards";
import {
  ExtensionContentDigest,
  ExtensionPackageVersion,
  ExtensionSourceKind,
  SourceQualifiedSkillId,
  StandaloneSkillScope,
} from "./extensions";

// A Canvas skill contribution is the schema-only, provider-neutral description
// of what a *trusted and enabled* skill offers to the Canvas renderer: reusable
// layouts, the source *kinds* it can present, and declarative presentation
// rules. It deliberately carries no authority, capabilities, concrete source
// references, hosts, projects, credentials, queries, or executable code. A
// contribution therefore cannot grant authority: installing, selecting, or
// mentioning a skill only ever contributes presentation metadata that the
// server reauthorizes and the renderer applies without side effects.
const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const CANVAS_SKILL_MAX_SUPPORTED_SOURCES = 8;
export const CANVAS_SKILL_MAX_LAYOUTS = 16;
export const CANVAS_SKILL_MAX_SLOTS = 64;
export const CANVAS_SKILL_MAX_PRESENTATION_RULES = 64;
export const CANVAS_SKILL_DIRECTIVE_MAX_CHARS = 512;
export const CANVAS_SKILL_LABEL_MAX_CHARS = 256;

const boundedToken = <B extends string>(brand: B) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(96),
    Schema.pattern(/^[a-z][a-z0-9-]*$/),
    Schema.brand(brand),
  );
const boundedText = (maximum: number) =>
  Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(maximum));

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
}).annotations(strict);
export type CanvasSkillLayoutSlot = typeof CanvasSkillLayoutSlot.Type;

export const CanvasSkillLayout = Schema.Struct({
  layoutId: CanvasSkillLayoutId,
  title: boundedText(CANVAS_SKILL_LABEL_MAX_CHARS),
  slots: Schema.Array(CanvasSkillLayoutSlot).pipe(
    Schema.minItems(1),
    Schema.maxItems(CANVAS_SKILL_MAX_SLOTS),
  ),
}).annotations(strict);
export type CanvasSkillLayout = typeof CanvasSkillLayout.Type;

export const CanvasSkillPresentationRuleKind = Schema.Literal(
  "emphasis",
  "ordering",
  "grouping",
  "formatting",
  "annotation",
);
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
}).annotations(strict);
export type CanvasSkillPresentationRule = typeof CanvasSkillPresentationRule.Type;

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
    .pipe(Schema.minItems(1), Schema.maxItems(CANVAS_SKILL_MAX_SUPPORTED_SOURCES))
    .pipe(
      Schema.filter((kinds) => new Set(kinds).size === kinds.length, {
        message: () => "Canvas skill supported sources must be unique.",
      }),
    ),
  layouts: Schema.Array(CanvasSkillLayout).pipe(Schema.maxItems(CANVAS_SKILL_MAX_LAYOUTS)),
  presentationRules: Schema.Array(CanvasSkillPresentationRule).pipe(
    Schema.maxItems(CANVAS_SKILL_MAX_PRESENTATION_RULES),
  ),
  scope: Schema.optional(StandaloneSkillScope),
})
  .annotations(strict)
  .pipe(
    // Provenance integrity: `digest` and `sourceKind` are audit-critical, so
    // they must be consistent with the canonical `qualifiedId` rather than
    // decoded independently. A qualified id is
    // `<sourceKind>:<name>:<skill>:sha256:<digest>`; binding both fields to it
    // prevents a contribution from decoding with an identity that ends in
    // digest A while declaring digest B or a mismatched source kind (spoofed
    // source/digest audit metadata).
    Schema.filter(
      (contribution) => {
        const qualifiedId = String(contribution.qualifiedId);
        const separator = qualifiedId.indexOf(":");
        const embeddedSourceKind = separator > 0 ? qualifiedId.slice(0, separator) : "";
        return (
          embeddedSourceKind === String(contribution.sourceKind) &&
          qualifiedId.endsWith(`:${String(contribution.digest)}`)
        );
      },
      {
        message: () =>
          "Canvas skill sourceKind and digest must match the qualified skill identity.",
      },
    ),
  );
export type CanvasSkillContribution = typeof CanvasSkillContribution.Type;

export const CanvasSkillContributionDenialCode = Schema.Literal(
  "malformed",
  "untrusted",
  "not-enabled",
  "not-effective",
  "identity-mismatch",
  "version-mismatch",
  "unsupported-source",
  "scope-mismatch",
);
export type CanvasSkillContributionDenialCode = typeof CanvasSkillContributionDenialCode.Type;

export const CanvasSkillContributionResolution = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("admitted"),
    contribution: CanvasSkillContribution,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("denied"),
    denialCode: CanvasSkillContributionDenialCode,
    message: boundedText(1_024),
  }).annotations(strict),
);
export type CanvasSkillContributionResolution = typeof CanvasSkillContributionResolution.Type;

export const decodeCanvasSkillLayout = Schema.decodeUnknownSync(CanvasSkillLayout);
export const decodeCanvasSkillPresentationRule = Schema.decodeUnknownSync(
  CanvasSkillPresentationRule,
);
export const decodeCanvasSkillContribution = Schema.decodeUnknownSync(CanvasSkillContribution);
export const decodeCanvasSkillContributionResolution = Schema.decodeUnknownSync(
  CanvasSkillContributionResolution,
);
