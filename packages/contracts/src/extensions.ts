import { Schema } from "effect";
import { AggregateVersion, UtcTimestamp } from "./events";
import { HostId } from "./host";
import { OctantMode } from "./modes";
import { ProjectId } from "./projects";
import { ToolExtensionId } from "./toolActions";
import {
  ExtensionComponentId,
  ExtensionContentDigest,
  ExtensionPackageId,
  ExtensionPackageVersion,
  ExtensionPublisherKeyFingerprint,
  extensionSemverPattern,
} from "./extensionIdentity";

export {
  ExtensionComponentId,
  ExtensionContentDigest,
  ExtensionPackageId,
  ExtensionPackageVersion,
  ExtensionPublisherKeyFingerprint,
} from "./extensionIdentity";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
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
  "user-added",
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
  /**
   * A package the host wrote for an MCP server the person added by hand in
   * Settings. The reference names the host's own folder for it; uninstalling
   * removes that folder and the secrets the server was given.
   */
  Schema.Struct({
    kind: Schema.Literal("user-added"),
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

/**
 * Why an installed outside provider driver is held for its publisher: the
 * selected version is not signed by the key pinned for its package name and
 * source. Only re-trusting the new publisher or forgetting the pin lifts it.
 */
export const ExtensionPublisherHoldReason = Schema.Literal("publisher-changed");
export type ExtensionPublisherHoldReason = typeof ExtensionPublisherHoldReason.Type;

export const ExtensionProvenance = Schema.Struct({
  canonicalUrl: Schema.optional(canonicalHttpUrl),
  publisher: Schema.optional(boundedText(256)),
  /** The key whose signature the host verified, set by the host only. */
  publisherKey: Schema.optional(ExtensionPublisherKeyFingerprint),
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
    const match = extensionSemverPattern.exec(version)!;
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
  "replica-store",
  "desktop-provider",
  "language-server",
  "debug-adapter",
);
export type ExtensionComponentKind = typeof ExtensionComponentKind.Type;
export const ExtensionSkillName = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(64),
  Schema.pattern(/^[a-z0-9][a-z0-9-]{0,63}$/),
);
export type ExtensionSkillName = typeof ExtensionSkillName.Type;

/**
 * How a language server is confined. `static` reads the checkout and writes
 * only its own cache, execs nothing but its own binary, and has no network.
 * `repo-tooling` may run the repository's own tooling, so it is approved,
 * refused in Plan, and confined as a terminal is. The class is the whole
 * grant: a server that declares `static` and needs more fails rather than
 * getting more. Canonical: docs/design/language-services.md § Launch classes.
 */
export const ExtensionLanguageServerClass = Schema.Literal("static", "repo-tooling");
export type ExtensionLanguageServerClass = typeof ExtensionLanguageServerClass.Type;

/** A Language Server Protocol language identifier, such as `typescript`. */
export const ExtensionLanguageId = Schema.String.pipe(
  Schema.pattern(/^[a-z][a-z0-9-]{0,63}$/),
  Schema.brand("ExtensionLanguageId"),
);
export type ExtensionLanguageId = typeof ExtensionLanguageId.Type;

export const ExtensionLanguageServerDeclaration = Schema.Struct({
  languages: Schema.Array(ExtensionLanguageId).pipe(Schema.minItems(1), Schema.maxItems(32)),
  launchClass: ExtensionLanguageServerClass,
}).annotations(strict);
export type ExtensionLanguageServerDeclaration = typeof ExtensionLanguageServerDeclaration.Type;

/**
 * An Octant runtime label for a debug adapter, such as `node`, `python`, or
 * `native`. It names the adapter in the configuration picker and chooses
 * nothing. Canonical: docs/design/language-services.md § Component and package.
 */
export const ExtensionDebugRuntimeId = Schema.String.pipe(
  Schema.pattern(/^[a-z][a-z0-9-]{0,31}$/),
  Schema.brand("ExtensionDebugRuntimeId"),
);
export type ExtensionDebugRuntimeId = typeof ExtensionDebugRuntimeId.Type;

/**
 * The `type` of an entry in an imported repository launch file that this
 * adapter may be proposed for. A matching label only: it starts nothing.
 */
export const ExtensionDebugImportType = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/),
  Schema.brand("ExtensionDebugImportType"),
);
export type ExtensionDebugImportType = typeof ExtensionDebugImportType.Type;

/**
 * The values Octant fills into a debug adapter's `launch` body, each from a
 * configuration it has checked or a port it chose. A string in the body is
 * either a literal or exactly one of these, whole.
 */
export const EXTENSION_DEBUG_LAUNCH_PLACEHOLDERS = [
  "{{program}}",
  "{{args}}",
  "{{cwd}}",
  "{{env}}",
  "{{stopOnEntry}}",
  "{{debugPort}}",
] as const;
export const MAX_EXTENSION_DEBUG_LAUNCH_ARGUMENTS_BYTES = 8 * 1024;
const MAX_DEBUG_LAUNCH_ARGUMENTS_DEPTH = 16;
const debugLaunchPlaceholders: ReadonlySet<string> = new Set(EXTENSION_DEBUG_LAUNCH_PLACEHOLDERS);

export type ExtensionDebugLaunchValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<ExtensionDebugLaunchValue>
  | { readonly [key: string]: ExtensionDebugLaunchValue };
type DebugLaunchObject = { readonly [key: string]: ExtensionDebugLaunchValue };

/**
 * Whether a string names a placeholder only partly: braces that are not
 * exactly one whole placeholder. Refused so a configuration's text is never
 * spliced into a longer value or into a key.
 */
function holdsPartialPlaceholder(value: string): boolean {
  return (value.includes("{{") || value.includes("}}")) && !debugLaunchPlaceholders.has(value);
}

function isDebugLaunchValue(value: unknown, depth: number): value is ExtensionDebugLaunchValue {
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return !holdsPartialPlaceholder(value);
  if (typeof value !== "object" || depth > MAX_DEBUG_LAUNCH_ARGUMENTS_DEPTH) return false;
  if (Array.isArray(value)) return value.every((entry) => isDebugLaunchValue(entry, depth + 1));
  return isDebugLaunchObject(value, depth);
}

function isDebugLaunchObject(value: object, depth: number): value is DebugLaunchObject {
  if (Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  return Reflect.ownKeys(value).every((key) => {
    // `__proto__` arrives as an own key from parsed JSON, and a decoder or a
    // later spread would turn it into a prototype rather than a value.
    if (
      typeof key !== "string" ||
      key === "__proto__" ||
      key.includes("{{") ||
      key.includes("}}")
    ) {
      return false;
    }
    const descriptor = descriptors[key];
    return (
      descriptor !== undefined &&
      "value" in descriptor &&
      isDebugLaunchValue(descriptor.value, depth + 1)
    );
  });
}

function placeholdersIn(value: ExtensionDebugLaunchValue, found: Set<string>): Set<string> {
  if (typeof value === "string") {
    if (debugLaunchPlaceholders.has(value)) found.add(value);
  } else if (Array.isArray(value)) {
    for (const entry of value) placeholdersIn(entry, found);
  } else if (typeof value === "object" && value !== null) {
    for (const entry of Object.values(value)) placeholdersIn(entry, found);
  }
  return found;
}

function isDebugLaunchArguments(input: unknown): input is DebugLaunchObject {
  if (typeof input !== "object" || input === null || !isDebugLaunchObject(input, 0)) return false;
  const encoded = JSON.stringify(input);
  return new TextEncoder().encode(encoded).byteLength <= MAX_EXTENSION_DEBUG_LAUNCH_ARGUMENTS_BYTES;
}

/**
 * The body of the Debug Adapter Protocol `launch` request this adapter needs,
 * as a JSON object of at most 8 KiB. Octant fills only the placeholders, each
 * as a whole value, so nothing a configuration holds reaches another key.
 */
export const ExtensionDebugLaunchArguments = Schema.declare(isDebugLaunchArguments);
export type ExtensionDebugLaunchArguments = typeof ExtensionDebugLaunchArguments.Type;

/**
 * What a `debug-adapter` component needs to start a session. The adapter and
 * the program it launches share one confined capsule, so the declaration has
 * no field that widens confinement; `debugPorts` only asks for one loopback
 * port to reach the program. Canonical: docs/design/language-services.md
 * § Component and package.
 */
export const ExtensionDebugAdapterDeclaration = Schema.Struct({
  runtimes: Schema.Array(ExtensionDebugRuntimeId).pipe(Schema.minItems(1), Schema.maxItems(8)),
  launchArguments: ExtensionDebugLaunchArguments,
  importTypes: Schema.Array(ExtensionDebugImportType).pipe(Schema.maxItems(8)),
  debugPorts: Schema.Literal(0, 1),
})
  .annotations(strict)
  .pipe(
    Schema.filter((declaration) => {
      const placeholders = placeholdersIn(declaration.launchArguments, new Set());
      // The body must run the program the person confirmed, and a port is
      // declared exactly when the body hands it to the adapter: an unfilled
      // port is a grant nothing uses, and an undeclared one is never chosen.
      return (
        placeholders.has("{{program}}") &&
        placeholders.has("{{debugPort}}") === (declaration.debugPorts === 1)
      );
    }),
  );
export type ExtensionDebugAdapterDeclaration = typeof ExtensionDebugAdapterDeclaration.Type;

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
  /** Present exactly when `kind` is `language-server`. */
  languageServer: Schema.optional(ExtensionLanguageServerDeclaration),
  /** Present exactly when `kind` is `debug-adapter`. */
  debugAdapter: Schema.optional(ExtensionDebugAdapterDeclaration),
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
  "desktop-provider",
  "language-server",
  "debug-adapter",
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
        if ((component.kind === "language-server") !== (component.languageServer !== undefined)) {
          return false;
        }
        if ((component.kind === "debug-adapter") !== (component.debugAdapter !== undefined)) {
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
  "review-required",
  "plugin-disabled",
  "component-disabled",
  "superseded",
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
  // Informational: the catalog epoch hashes what the policy allows,
  // not how many times the Project or thread changed.
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

/**
 * The Project a skill found at a Project root belongs to: every thread of that
 * Project shares it, and no other Project or Chat thread sees it. It is a field
 * of its own rather than a `scope` without `threadRef`, because a client that
 * predates it requires `threadRef` in `scope` and would refuse the whole
 * snapshot, while it drops an unknown field.
 */
export const StandaloneSkillProjectScope = Schema.Struct({
  mode: Schema.Literal("work", "code"),
  projectId: ProjectId,
}).annotations(strict);
export type StandaloneSkillProjectScope = typeof StandaloneSkillProjectScope.Type;

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
  /** A skill found below a Project root, for the one thread whose directory reaches it. */
  scope: Schema.optional(StandaloneSkillScope),
  /** A skill found at a Project root. A record carries `scope` or this, never both. */
  projectScope: Schema.optional(StandaloneSkillProjectScope),
  /**
   * Raw skill instructions text, carried only for discovered/bundled skills
   * that the host has already read from disk. Trust is still enforced by the
   * activation ladder before this text reaches any provider context.
   */
  instructions: Schema.optional(Schema.String.pipe(Schema.maxLength(256 * 1024))),
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
  /**
   * Present only on a package this host wrote itself for an MCP server the
   * person added in Settings, by hand or from Connectors. The installed
   * `source` reads `plugin-package` for those too, and a slug can be chosen by
   * any plugin author, so neither tells them apart; the host sets this from
   * its own record of the folders it wrote, never from the package.
   */
  addedInSettings: Schema.optional(Schema.Literal(true)),
  compatibility: ExtensionCompatibility,
  activation: ExtensionActivationState,
  /**
   * An outside provider driver's publisher keys: the one pinned for its
   * package name and source, the one that signed the selected version, and
   * the hold when they differ. Absent when neither key exists.
   */
  publisher: Schema.optional(
    Schema.Struct({
      pinned: Schema.optional(ExtensionPublisherKeyFingerprint),
      selected: Schema.optional(ExtensionPublisherKeyFingerprint),
      held: Schema.optional(ExtensionPublisherHoldReason),
    }).annotations(strict),
  ),
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
export const decodeExtensionPublisherKeyFingerprint = Schema.decodeUnknownSync(
  ExtensionPublisherKeyFingerprint,
);
export const decodeExtensionPackageManifest = Schema.decodeUnknownSync(ExtensionPackageManifest);
export const decodeExtensionActivationState = Schema.decodeUnknownSync(ExtensionActivationState);
export const decodeExtensionSelection = Schema.decodeUnknownSync(ExtensionSelection);
export const decodeSourceQualifiedSkill = Schema.decodeUnknownSync(SourceQualifiedSkill);
export const decodeSourceQualifiedSkillId = Schema.decodeUnknownSync(SourceQualifiedSkillId);
export const decodeStandaloneSkillRecord = Schema.decodeUnknownSync(StandaloneSkillRecord);
export const decodeExtensionComponentQualifiedId = Schema.decodeUnknownSync(
  ExtensionComponentQualifiedId,
);
