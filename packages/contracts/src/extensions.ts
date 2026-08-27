import { Schema } from "effect";
import { AggregateVersion, UtcTimestamp } from "./events";
import { HostId } from "./host";
import { OctantMode } from "./modes";
import { ProjectId } from "./projects";
import { ToolExtensionId } from "./toolActions";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const brandedUuid = <B extends string>(brand: B) => Schema.UUID.pipe(Schema.brand(brand));
const boundedToken = (maximumLength: number) =>
  Schema.NonEmptyTrimmedString.pipe(
    Schema.maxLength(maximumLength),
    Schema.pattern(/^[a-z][a-z0-9-]*$/),
  );
const boundedText = (maximumLength: number) =>
  Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(maximumLength));
const opaqueReference = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(256),
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
);
const entryPointReference = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(256),
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
);

export const ExtensionPackageId = brandedUuid("ExtensionPackageId");
export type ExtensionPackageId = typeof ExtensionPackageId.Type;
export const ExtensionComponentId = boundedToken(64).pipe(Schema.brand("ExtensionComponentId"));
export type ExtensionComponentId = typeof ExtensionComponentId.Type;
export const ExtensionSlug = boundedToken(64).pipe(Schema.brand("ExtensionSlug"));
export type ExtensionSlug = typeof ExtensionSlug.Type;
export const ExtensionCatalogId = boundedToken(96).pipe(Schema.brand("ExtensionCatalogId"));
export type ExtensionCatalogId = typeof ExtensionCatalogId.Type;
export const ExtensionCatalogEntryId = boundedToken(96).pipe(
  Schema.brand("ExtensionCatalogEntryId"),
);
export type ExtensionCatalogEntryId = typeof ExtensionCatalogEntryId.Type;
export const ExtensionSourceReference = opaqueReference.pipe(
  Schema.brand("ExtensionSourceReference"),
);
export type ExtensionSourceReference = typeof ExtensionSourceReference.Type;
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
export const ExtensionPackageVersion = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(64),
  Schema.pattern(semverPattern),
  Schema.brand("ExtensionPackageVersion"),
);
export type ExtensionPackageVersion = typeof ExtensionPackageVersion.Type;
export const ExtensionContentDigest = Schema.String.pipe(
  Schema.pattern(/^sha256:[a-f0-9]{64}$/),
  Schema.brand("ExtensionContentDigest"),
);
export type ExtensionContentDigest = typeof ExtensionContentDigest.Type;
export const ExtensionCatalogEpoch = Schema.String.pipe(
  Schema.pattern(/^sha256:[a-f0-9]{64}$/),
  Schema.brand("ExtensionCatalogEpoch"),
);
export type ExtensionCatalogEpoch = typeof ExtensionCatalogEpoch.Type;
export const ExtensionManifestVersion = Schema.Int.pipe(
  Schema.positive(),
  Schema.lessThanOrEqualTo(1),
  Schema.brand("ExtensionManifestVersion"),
);
export type ExtensionManifestVersion = typeof ExtensionManifestVersion.Type;
const isToolExtensionId = Schema.is(ToolExtensionId);
const isExtensionComponentId = Schema.is(ExtensionComponentId);
export const ExtensionComponentQualifiedId = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(128),
  Schema.filter((value) => {
    const separator = value.indexOf("/");
    return (
      separator > 0 &&
      value.indexOf("/", separator + 1) === -1 &&
      isToolExtensionId(value.slice(0, separator)) &&
      isExtensionComponentId(value.slice(separator + 1))
    );
  }),
  Schema.brand("ExtensionComponentQualifiedId"),
);
export type ExtensionComponentQualifiedId = typeof ExtensionComponentQualifiedId.Type;
export const SourceQualifiedSkillId = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(512),
  Schema.pattern(/^[a-z][a-z0-9-]*:[A-Za-z0-9._~:-]+:[a-z][a-z0-9-]*:sha256:[a-f0-9]{64}$/),
  Schema.brand("SourceQualifiedSkillId"),
);
export type SourceQualifiedSkillId = typeof SourceQualifiedSkillId.Type;

export const ExtensionSourceKind = Schema.Literal(
  "bundled",
  "catalog",
  "local-folder",
  "agents-skills-directory",
  "plugin-package",
  "provider-native",
);
export type ExtensionSourceKind = typeof ExtensionSourceKind.Type;

export const ExtensionSource = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("bundled"),
    sourceRef: ExtensionSourceReference,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("catalog"),
    catalogId: ExtensionCatalogId,
    entryId: ExtensionCatalogEntryId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("local-folder"),
    sourceRef: ExtensionSourceReference,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("agents-skills-directory"),
    sourceRef: ExtensionSourceReference,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("plugin-package"),
    sourceRef: ExtensionSourceReference,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("provider-native"),
    sourceRef: ExtensionSourceReference,
  }).annotations(strict),
);
export type ExtensionSource = typeof ExtensionSource.Type;

const canonicalHttpUrl = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(2048),
  Schema.filter((value) => {
    try {
      const parsed = new URL(value);
      return (
        (parsed.protocol === "https:" || parsed.protocol === "http:") &&
        parsed.username.length === 0 &&
        parsed.password.length === 0
      );
    } catch {
      return false;
    }
  }),
);

export const ExtensionProvenance = Schema.Struct({
  canonicalUrl: Schema.optional(canonicalHttpUrl),
  publisher: Schema.optional(boundedText(256)),
  sourceCommit: Schema.optional(
    Schema.String.pipe(Schema.pattern(/^[a-f0-9]{7,64}$/), Schema.maxLength(64)),
  ),
  reviewed: Schema.Boolean,
  reviewedAt: Schema.optional(UtcTimestamp),
}).annotations(strict);
export type ExtensionProvenance = typeof ExtensionProvenance.Type;

export const ExtensionLicense = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("spdx"),
    identifier: Schema.NonEmptyTrimmedString.pipe(
      Schema.maxLength(128),
      Schema.pattern(/^[A-Za-z0-9-.+]+$/),
    ),
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("custom"), label: boundedText(256) }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("unreported") }).annotations(strict),
);
export type ExtensionLicense = typeof ExtensionLicense.Type;

export const ExtensionPlatform = Schema.Literal("macos", "linux", "windows");
export type ExtensionPlatform = typeof ExtensionPlatform.Type;
export const ExtensionProviderFamily = boundedToken(96).pipe(
  Schema.brand("ExtensionProviderFamily"),
);
export type ExtensionProviderFamily = typeof ExtensionProviderFamily.Type;

function compareNumericIdentifiers(left: string, right: string): number {
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function comparePackageVersions(left: string, right: string): number {
  const parse = (version: string) => {
    const match = semverPattern.exec(version)!;
    return {
      core: [match[1]!, match[2]!, match[3]!],
      prerelease: match[4]?.split("."),
    };
  };
  const leftVersion = parse(left);
  const rightVersion = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = compareNumericIdentifiers(
      leftVersion.core[index]!,
      rightVersion.core[index]!,
    );
    if (difference !== 0) return difference;
  }
  if (leftVersion.prerelease === undefined) return rightVersion.prerelease === undefined ? 0 : 1;
  if (rightVersion.prerelease === undefined) return -1;
  const identifiers = Math.max(leftVersion.prerelease.length, rightVersion.prerelease.length);
  for (let index = 0; index < identifiers; index += 1) {
    const leftIdentifier = leftVersion.prerelease[index];
    const rightIdentifier = rightVersion.prerelease[index];
    if (leftIdentifier === undefined) return -1;
    if (rightIdentifier === undefined) return 1;
    if (leftIdentifier === rightIdentifier) continue;
    const leftNumeric = /^\d+$/.test(leftIdentifier);
    const rightNumeric = /^\d+$/.test(rightIdentifier);
    if (leftNumeric && rightNumeric) {
      return compareNumericIdentifiers(leftIdentifier, rightIdentifier);
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftIdentifier < rightIdentifier ? -1 : 1;
  }
  return 0;
}

const ExtensionAppCompatibility = Schema.Struct({
  minimum: ExtensionPackageVersion,
  maximumExclusive: Schema.optional(ExtensionPackageVersion),
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      (range) =>
        range.maximumExclusive === undefined ||
        comparePackageVersions(range.minimum, range.maximumExclusive) < 0,
    ),
  );

export const ExtensionCompatibility = Schema.Struct({
  app: Schema.optional(ExtensionAppCompatibility),
  platforms: Schema.Array(ExtensionPlatform).pipe(Schema.minItems(1), Schema.maxItems(3)),
  modes: Schema.Array(OctantMode).pipe(Schema.minItems(1), Schema.maxItems(3)),
  providerFamilies: Schema.Array(ExtensionProviderFamily).pipe(Schema.maxItems(64)),
}).annotations(strict);
export type ExtensionCompatibility = typeof ExtensionCompatibility.Type;

export const ExtensionCapability = Schema.Literal(
  "instructions",
  "mcp",
  "filesystem",
  "shell",
  "network",
  "browser",
  "computer-use",
  "credentials",
  "external-application",
  "hooks",
  "apps",
  "agents",
  "apple-development",
);
export type ExtensionCapability = typeof ExtensionCapability.Type;

export const ExtensionComponentKind = Schema.Literal(
  "skill-instructions",
  "mcp-server",
  "mcp-tool",
  "mcp-prompt",
  "mcp-resource",
  "hook",
  "app",
  "agent",
  "apple-development-adapter",
  "board",
  "integration",
  "ui-surface",
  "appearance-pack",
  "preview-viewer",
  "provider-driver",
);
export type ExtensionComponentKind = typeof ExtensionComponentKind.Type;
export const ExtensionSkillName = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(64),
  Schema.pattern(/^[a-z0-9][a-z0-9-]{0,63}$/),
);
export type ExtensionSkillName = typeof ExtensionSkillName.Type;

export const ExtensionComponent = Schema.Struct({
  id: ExtensionComponentId,
  kind: ExtensionComponentKind,
  displayName: boundedText(128),
  description: Schema.optional(boundedText(2048)),
  declaredCapabilities: Schema.Array(ExtensionCapability).pipe(Schema.maxItems(32)),
  entryPoint: Schema.optional(entryPointReference),
  configurationReference: Schema.optional(opaqueReference),
  contentReference: Schema.optional(opaqueReference),
  skillName: Schema.optional(ExtensionSkillName),
  parentComponentId: Schema.optional(ExtensionComponentId),
}).annotations(strict);
export type ExtensionComponent = typeof ExtensionComponent.Type;

const executableKinds = new Set<ExtensionComponentKind>([
  "mcp-server",
  "hook",
  "app",
  "agent",
  "apple-development-adapter",
  "board",
  "integration",
  "provider-driver",
]);
const mcpChildKinds = new Set<ExtensionComponentKind>(["mcp-tool", "mcp-prompt", "mcp-resource"]);

export const ExtensionContributionPoint = Schema.Literal(
  "sidebar.destination",
  "settings.section",
  "workspace.tab",
  "thread.pane",
  "preview.viewer",
  "appearance.preset",
  "board.view",
);
export type ExtensionContributionPoint = typeof ExtensionContributionPoint.Type;

export const ExtensionPreviewViewerKind = Schema.Literal(
  "text",
  "markdown",
  "image",
  "pdf",
  "table",
  "workbook",
  "document",
  "slides",
);
export type ExtensionPreviewViewerKind = typeof ExtensionPreviewViewerKind.Type;

export const ExtensionBoardMode = Schema.Literal("work", "code");
export type ExtensionBoardMode = typeof ExtensionBoardMode.Type;

export const ExtensionSidebarDestinationContribution = Schema.Struct({
  point: Schema.Literal("sidebar.destination"),
  componentId: ExtensionComponentId,
  destinationId: boundedToken(64),
  label: boundedText(64),
  modes: Schema.Array(OctantMode).pipe(Schema.minItems(1), Schema.maxItems(3)),
  /** Optional module entry point the renderer loads to render or handle the destination. */
  entryPoint: Schema.optional(entryPointReference),
}).annotations(strict);
export type ExtensionSidebarDestinationContribution =
  typeof ExtensionSidebarDestinationContribution.Type;

export const ExtensionSettingsSectionContribution = Schema.Struct({
  point: Schema.Literal("settings.section"),
  componentId: ExtensionComponentId,
  sectionId: boundedToken(64),
  label: boundedText(64),
  scope: Schema.Literal("app", "host", "mode", "project", "thread"),
  keywords: boundedText(512),
  /** Optional module entry point the renderer loads for the section's panel. */
  entryPoint: Schema.optional(entryPointReference),
  description: Schema.optional(boundedText(2048)),
}).annotations(strict);
export type ExtensionSettingsSectionContribution = typeof ExtensionSettingsSectionContribution.Type;

export const ExtensionWorkspaceTabContribution = Schema.Struct({
  point: Schema.Literal("workspace.tab"),
  componentId: ExtensionComponentId,
  tabId: boundedToken(64),
  label: boundedText(64),
  modes: Schema.Array(OctantMode).pipe(Schema.minItems(1), Schema.maxItems(3)),
}).annotations(strict);
export type ExtensionWorkspaceTabContribution = typeof ExtensionWorkspaceTabContribution.Type;

export const ExtensionThreadPaneContribution = Schema.Struct({
  point: Schema.Literal("thread.pane"),
  componentId: ExtensionComponentId,
  paneId: boundedToken(64),
  label: boundedText(64),
  modes: Schema.Array(OctantMode).pipe(Schema.minItems(1), Schema.maxItems(3)),
}).annotations(strict);
export type ExtensionThreadPaneContribution = typeof ExtensionThreadPaneContribution.Type;

export const ExtensionPreviewViewerContribution = Schema.Struct({
  point: Schema.Literal("preview.viewer"),
  componentId: ExtensionComponentId,
  viewerId: boundedToken(64),
  label: boundedText(64),
  kinds: Schema.Array(ExtensionPreviewViewerKind).pipe(Schema.minItems(1), Schema.maxItems(16)),
}).annotations(strict);
export type ExtensionPreviewViewerContribution = typeof ExtensionPreviewViewerContribution.Type;

export const ExtensionAppearancePresetContribution = Schema.Struct({
  point: Schema.Literal("appearance.preset"),
  componentId: ExtensionComponentId,
  presetId: boundedToken(64),
  label: boundedText(64),
}).annotations(strict);
export type ExtensionAppearancePresetContribution =
  typeof ExtensionAppearancePresetContribution.Type;

export const ExtensionBoardViewContribution = Schema.Struct({
  point: Schema.Literal("board.view"),
  componentId: ExtensionComponentId,
  viewId: boundedToken(64),
  label: boundedText(64),
  modes: Schema.Array(ExtensionBoardMode).pipe(Schema.minItems(1), Schema.maxItems(2)),
}).annotations(strict);
export type ExtensionBoardViewContribution = typeof ExtensionBoardViewContribution.Type;

export const ExtensionContribution = Schema.Union(
  ExtensionSidebarDestinationContribution,
  ExtensionSettingsSectionContribution,
  ExtensionWorkspaceTabContribution,
  ExtensionThreadPaneContribution,
  ExtensionPreviewViewerContribution,
  ExtensionAppearancePresetContribution,
  ExtensionBoardViewContribution,
);
export type ExtensionContribution = typeof ExtensionContribution.Type;

export const ExtensionPackageManifest = Schema.Struct({
  manifestVersion: ExtensionManifestVersion,
  extensionId: ToolExtensionId,
  packageId: ExtensionPackageId,
  slug: ExtensionSlug,
  displayName: boundedText(128),
  description: Schema.optional(boundedText(4096)),
  version: ExtensionPackageVersion,
  digest: ExtensionContentDigest,
  source: ExtensionSource,
  provenance: ExtensionProvenance,
  license: ExtensionLicense,
  compatibility: ExtensionCompatibility,
  declaredCapabilities: Schema.Array(ExtensionCapability).pipe(Schema.maxItems(32)),
  primaryComponentId: Schema.optional(ExtensionComponentId),
  components: Schema.Array(ExtensionComponent).pipe(Schema.minItems(1), Schema.maxItems(256)),
  contributions: Schema.optional(Schema.Array(ExtensionContribution).pipe(Schema.maxItems(32))),
})
  .annotations(strict)
  .pipe(
    Schema.filter((manifest) => {
      const components = new Map(manifest.components.map((component) => [component.id, component]));
      if (components.size !== manifest.components.length) return false;
      if (
        manifest.primaryComponentId !== undefined &&
        !components.has(manifest.primaryComponentId)
      ) {
        return false;
      }
      if (
        manifest.contributions !== undefined &&
        !manifest.contributions.every((contribution) => components.has(contribution.componentId))
      ) {
        return false;
      }
      const packageCapabilities = new Set(manifest.declaredCapabilities);
      return manifest.components.every((component) => {
        if (
          component.declaredCapabilities.some((capability) => !packageCapabilities.has(capability))
        ) {
          return false;
        }
        const executable = executableKinds.has(component.kind);
        const mcpChild = mcpChildKinds.has(component.kind);
        if (component.kind === "mcp-server") {
          if (
            component.entryPoint === undefined &&
            component.configurationReference === undefined
          ) {
            return false;
          }
        } else if (executable !== (component.entryPoint !== undefined)) {
          return false;
        }
        if (
          component.kind !== "skill-instructions" &&
          component.kind !== "mcp-server" &&
          component.configurationReference !== undefined
        ) {
          return false;
        }
        if (component.kind !== "skill-instructions" && component.contentReference !== undefined) {
          return false;
        }
        if (component.kind !== "skill-instructions" && component.skillName !== undefined) {
          return false;
        }
        if (mcpChild !== (component.parentComponentId !== undefined)) return false;
        if (!mcpChild) return true;
        return components.get(component.parentComponentId!)?.kind === "mcp-server";
      });
    }),
  );
export type ExtensionPackageManifest = typeof ExtensionPackageManifest.Type;

export const ExtensionActivationState = Schema.Struct({
  installed: Schema.Boolean,
  trusted: Schema.Boolean,
  pluginDesired: Schema.Boolean,
  componentDesired: Schema.Boolean,
  compatible: Schema.Boolean,
  policyAllowed: Schema.Boolean,
  quarantined: Schema.Boolean,
  draining: Schema.Boolean,
  broken: Schema.Boolean,
  unavailable: Schema.Boolean,
  interrupted: Schema.Boolean,
  waiting: Schema.Boolean,
}).annotations(strict);
export type ExtensionActivationState = typeof ExtensionActivationState.Type;

export const ExtensionBlockReason = Schema.Literal(
  "host-prohibited",
  "mode-prohibited",
  "project-prohibited",
  "thread-prohibited",
  "stale-catalog-epoch",
  "not-installed",
  "untrusted",
  "plugin-disabled",
  "component-disabled",
  "incompatible",
  "quarantined",
  "draining",
  "broken",
  "unavailable",
  "interrupted",
  "waiting",
);
export type ExtensionBlockReason = typeof ExtensionBlockReason.Type;

export const ExtensionEffectiveState = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("effective") }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("blocked"), reason: ExtensionBlockReason }).annotations(
    strict,
  ),
);
export type ExtensionEffectiveState = typeof ExtensionEffectiveState.Type;

export const ExtensionActivationScope = Schema.Struct({
  hostId: HostId,
  mode: OctantMode,
  projectId: Schema.NullOr(ProjectId),
  threadId: Schema.NullOr(Schema.UUID),
  providerFamily: ExtensionProviderFamily,
}).annotations(strict);
export type ExtensionActivationScope = typeof ExtensionActivationScope.Type;

export const ExtensionActivationPolicyFacts = Schema.Struct({
  revision: Schema.Int.pipe(Schema.nonNegative()),
  projectRevision: Schema.Int.pipe(Schema.nonNegative()),
  threadRevision: Schema.Int.pipe(Schema.nonNegative()),
  hostAllowed: Schema.Boolean,
  modeAllowed: Schema.Boolean,
  projectAllowed: Schema.Boolean,
  threadAllowed: Schema.Boolean,
  policyAllowed: Schema.Boolean,
}).annotations(strict);
export type ExtensionActivationPolicyFacts = typeof ExtensionActivationPolicyFacts.Type;

export const ExtensionContextContribution = Schema.Struct({
  kind: Schema.Literal("zero"),
  reason: Schema.Union(ExtensionBlockReason, Schema.Literal("not-selected")),
}).annotations(strict);
export type ExtensionContextContribution = typeof ExtensionContextContribution.Type;

export const ExtensionDiagnostic = Schema.Struct({
  code: boundedToken(128),
  message: boundedText(1024).pipe(
    Schema.filter(
      (message) => !message.includes("/") && !message.includes("\\") && !message.includes("\0"),
    ),
  ),
}).annotations(strict);
export type ExtensionDiagnostic = typeof ExtensionDiagnostic.Type;

export const SourceQualifiedSkill = Schema.Struct({
  qualifiedId: SourceQualifiedSkillId,
  name: boundedToken(64),
  sourceKind: ExtensionSourceKind,
  digest: ExtensionContentDigest,
  available: Schema.Boolean,
  diagnostic: Schema.optional(ExtensionDiagnostic),
}).annotations(strict);
export type SourceQualifiedSkill = typeof SourceQualifiedSkill.Type;

export const ExtensionSkillCollision = Schema.Struct({
  name: boundedToken(64),
  candidates: Schema.Array(SourceQualifiedSkillId).pipe(Schema.minItems(2), Schema.maxItems(64)),
}).annotations(strict);
export type ExtensionSkillCollision = typeof ExtensionSkillCollision.Type;

export const StandaloneSkillScope = Schema.Struct({
  mode: Schema.Literal("work", "code"),
  projectId: ProjectId,
  threadRef: opaqueReference,
}).annotations(strict);
export type StandaloneSkillScope = typeof StandaloneSkillScope.Type;

export const StandaloneSkillRecord = Schema.Struct({
  skill: SourceQualifiedSkill,
  source: ExtensionSource,
  version: Schema.optional(ExtensionPackageVersion),
  displayName: boundedText(128),
  description: Schema.optional(boundedText(2048)),
  provenance: ExtensionProvenance,
  contentBytes: Schema.Int.pipe(Schema.nonNegative()),
  reviewed: Schema.Boolean,
  desiredEnabled: Schema.Boolean,
  effectiveState: ExtensionEffectiveState,
  scope: Schema.optional(StandaloneSkillScope),
  /**
   * Raw, provider-published Canvas skill contribution document, when the skill
   * ships parsed Canvas presentation metadata. Carried as an opaque value and
   * re-validated at the server trust boundary (see the Canvas skill
   * contribution loader) so a contribution never asserts its own trust and the
   * contracts package avoids a dependency cycle on the Canvas skill schema.
   */
  canvasContribution: Schema.optional(Schema.Unknown),
}).annotations(strict);
export type StandaloneSkillRecord = typeof StandaloneSkillRecord.Type;

export const ExtensionSelectionOrigin = Schema.Struct({
  kind: Schema.Literal("draft", "turn"),
  reference: opaqueReference,
}).annotations(strict);
export type ExtensionSelectionOrigin = typeof ExtensionSelectionOrigin.Type;

export const ExtensionSelection = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("plugin"),
    extensionId: ToolExtensionId,
    packageId: ExtensionPackageId,
    componentId: Schema.optional(ExtensionComponentId),
    packageVersion: ExtensionPackageVersion,
    packageDigest: ExtensionContentDigest,
    catalogEpoch: ExtensionCatalogEpoch,
    origin: ExtensionSelectionOrigin,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("skill"),
    skillId: SourceQualifiedSkillId,
    packageVersion: Schema.optional(ExtensionPackageVersion),
    packageDigest: ExtensionContentDigest,
    catalogEpoch: ExtensionCatalogEpoch,
    origin: ExtensionSelectionOrigin,
  }).annotations(strict),
);
export type ExtensionSelection = typeof ExtensionSelection.Type;

export const ExtensionPackageState = Schema.Struct({
  extensionId: ToolExtensionId,
  packageId: ExtensionPackageId,
  slug: Schema.optional(ExtensionSlug),
  displayName: Schema.optional(boundedText(128)),
  stateVersion: AggregateVersion,
  version: ExtensionPackageVersion,
  digest: ExtensionContentDigest,
  source: ExtensionSource,
  compatibility: ExtensionCompatibility,
  activation: ExtensionActivationState,
  components: Schema.Array(
    Schema.Struct({
      component: ExtensionComponent,
      activation: ExtensionActivationState,
      effectiveState: ExtensionEffectiveState,
    }).annotations(strict),
  ).pipe(Schema.maxItems(256)),
  diagnostics: Schema.Array(ExtensionDiagnostic).pipe(Schema.maxItems(128)),
}).annotations(strict);
export type ExtensionPackageState = typeof ExtensionPackageState.Type;

export const ExtensionEffectivePackageState = Schema.Struct({
  extensionId: ToolExtensionId,
  packageId: ExtensionPackageId,
  slug: Schema.optional(ExtensionSlug),
  displayName: Schema.optional(boundedText(128)),
  stateVersion: AggregateVersion,
  version: ExtensionPackageVersion,
  digest: ExtensionContentDigest,
  source: ExtensionSource,
  compatibility: ExtensionCompatibility,
  activation: ExtensionActivationState,
  components: Schema.Array(
    Schema.Struct({
      component: ExtensionComponent,
      activation: ExtensionActivationState,
      policy: ExtensionActivationPolicyFacts,
      effectiveState: ExtensionEffectiveState,
      contextContribution: ExtensionContextContribution,
    }).annotations(strict),
  ).pipe(Schema.maxItems(256)),
  diagnostics: Schema.Array(ExtensionDiagnostic).pipe(Schema.maxItems(128)),
}).annotations(strict);
export type ExtensionEffectivePackageState = typeof ExtensionEffectivePackageState.Type;

export const decodeExtensionPackageId = Schema.decodeUnknownSync(ExtensionPackageId);
export const decodeExtensionComponentId = Schema.decodeUnknownSync(ExtensionComponentId);
export const decodeExtensionContentDigest = Schema.decodeUnknownSync(ExtensionContentDigest);
export const decodeExtensionPackageManifest = Schema.decodeUnknownSync(ExtensionPackageManifest);
export const decodeExtensionActivationState = Schema.decodeUnknownSync(ExtensionActivationState);
export const decodeExtensionSelection = Schema.decodeUnknownSync(ExtensionSelection);
export const decodeSourceQualifiedSkill = Schema.decodeUnknownSync(SourceQualifiedSkill);
export const decodeSourceQualifiedSkillId = Schema.decodeUnknownSync(SourceQualifiedSkillId);
export const decodeStandaloneSkillRecord = Schema.decodeUnknownSync(StandaloneSkillRecord);
export const decodeExtensionComponentQualifiedId = Schema.decodeUnknownSync(
  ExtensionComponentQualifiedId,
);
