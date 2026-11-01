import { ApprovalOutsideContent } from "./contentProvenance";
import { personDecides } from "./hostAnswer";
import { Schema } from "effect";
import { AggregateVersion, EventVersion, GlobalSequence, UtcTimestamp } from "./events";
import {
  ExtensionActivationScope,
  ExtensionCapability,
  ExtensionCatalogId,
  ExtensionCatalogEpoch,
  ExtensionComponentId,
  ExtensionComponentKind,
  ExtensionCompatibility,
  ExtensionContentDigest,
  ExtensionDiagnostic,
  ExtensionEffectivePackageState,
  ExtensionLanguageServerDeclaration,
  ExtensionDebugAdapterDeclaration,
  ExtensionLicense,
  ExtensionPackageId,
  ExtensionPackageState,
  ExtensionPackageVersion,
  ExtensionSlug,
  ExtensionSkillCollision,
  ExtensionSource,
  ExtensionProvenance,
  ExtensionPublisherKeyFingerprint,
  SourceQualifiedSkill,
  StandaloneSkillRecord,
} from "./extensions";
import { ExtensionToolGrantId, ExtensionToolGrantRecorded } from "./extensionEvents";
import { ToolExtensionId } from "./toolActions";
import { ProjectId } from "./projects";
import { SecretStoreItemReference, SecretStoreKind } from "./secretStores";

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const boundedText = (maximumLength: number) =>
  Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(maximumLength));
const opaqueCursor = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(256),
  Schema.pattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
);
const packageTarget = {
  extensionId: ToolExtensionId,
  packageId: ExtensionPackageId,
};
const versionedTarget = {
  ...packageTarget,
  version: ExtensionPackageVersion,
  digest: ExtensionContentDigest,
};
const stateCommandVersion = EventVersion.pipe(Schema.filter((version) => version === 1));
const desiredStateMutation = {
  commandVersion: stateCommandVersion,
  extensionId: ToolExtensionId,
  expectedStateVersion: AggregateVersion,
};

export const ExtensionEffectiveStateQuery = Schema.Struct({
  scope: ExtensionActivationScope,
  expectedCatalogEpoch: Schema.optional(ExtensionCatalogEpoch),
}).annotations(strict);
export type ExtensionEffectiveStateQuery = typeof ExtensionEffectiveStateQuery.Type;

export const ExtensionToolApproval = Schema.Struct({
  approvalId: Schema.UUID,
  threadId: Schema.UUID,
  projectId: Schema.optional(Schema.UUID),
  extensionId: ToolExtensionId,
  packageId: ExtensionPackageId,
  componentId: ExtensionComponentId,
  /** The MCP server's own name, as its package configuration declares it. */
  serverName: boundedText(128),
  providerToolName: boundedText(256),
  mcpToolName: boundedText(256),
  inputJson: Schema.String.pipe(Schema.maxLength(64 * 1024)),
  requestedAt: UtcTimestamp,
  /**
   * Whether this prompt may be answered with `remember`. False when the
   * thread has no Project, on a Plan turn, on a turn the host started as
   * itself, and for a network tool on a thread that took in outside content:
   * those are approved one call at a time.
   */
  rememberable: Schema.Boolean,
  /** Present when the thread has taken in outside content; see `ApprovalOutsideContent`. */
  outsideContent: Schema.optional(ApprovalOutsideContent),
}).annotations({ ...strict, ...personDecides });
export type ExtensionToolApproval = typeof ExtensionToolApproval.Type;

export const ExtensionToolApprovalList = Schema.Array(ExtensionToolApproval);
export type ExtensionToolApprovalList = typeof ExtensionToolApprovalList.Type;

export const ExtensionToolApprovalDecision = Schema.Struct({
  approvalId: Schema.UUID,
  decision: Schema.Literal("approved", "denied"),
  /** Always allow this tool in this Project. Only an approval can be remembered. */
  remember: Schema.optional(Schema.Boolean),
})
  .annotations(strict)
  .pipe(Schema.filter((answer) => answer.remember !== true || answer.decision === "approved"));
export type ExtensionToolApprovalDecision = typeof ExtensionToolApprovalDecision.Type;

/** A remembered approval of one MCP tool in one Project, as Settings lists it. */
export const ExtensionToolGrant = Schema.Struct({
  ...ExtensionToolGrantRecorded.fields,
  grantedAt: UtcTimestamp,
}).annotations({ ...strict, ...personDecides });
export type ExtensionToolGrant = typeof ExtensionToolGrant.Type;

export const ExtensionToolGrantList = Schema.Array(ExtensionToolGrant).pipe(Schema.maxItems(4096));
export type ExtensionToolGrantList = typeof ExtensionToolGrantList.Type;

/**
 * What a local window may ask of remembered approvals: read them, or take one
 * away. Nothing here creates one; that happens only by answering a prompt.
 */
export const ExtensionToolGrantRequest = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("list") }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("revoke"), grantId: ExtensionToolGrantId }).annotations(
    strict,
  ),
);
export type ExtensionToolGrantRequest = typeof ExtensionToolGrantRequest.Type;

/**
 * An MCP server the person adds by hand: a command to start, or an address to
 * connect to. A value marked secret is kept in the host credential broker and
 * never written into the package; the package carries a reference instead.
 */
const userAddedSecretValue = Schema.Struct({
  name: boundedText(128).pipe(Schema.pattern(/^[A-Za-z_][A-Za-z0-9_-]*$/)),
  value: Schema.String.pipe(Schema.maxLength(8192)),
  secret: Schema.Boolean,
  /**
   * A secret that comes from a linked secret store: the host keeps this item
   * reference instead of a value and fetches the value when the server is
   * launched. `value` is empty and `secret` is true.
   */
  linked: Schema.optional(
    Schema.Struct({ store: SecretStoreKind, reference: SecretStoreItemReference }).annotations(
      strict,
    ),
  ),
}).annotations(strict);
export const UserAddedMcpServerRequest = Schema.Struct({
  name: boundedText(64),
  /**
   * The catalog connector this server is, when it was added from Connectors.
   * The host checks it against the bundled catalog and names the package after
   * it, so the package stays recognizable whatever its display name is.
   */
  connectorId: Schema.optional(boundedText(64)),
  server: Schema.Union(
    Schema.Struct({
      type: Schema.Literal("stdio"),
      command: boundedText(1024),
      args: Schema.Array(Schema.String.pipe(Schema.maxLength(1024))).pipe(Schema.maxItems(64)),
      env: Schema.Array(userAddedSecretValue).pipe(Schema.maxItems(64)),
    }).annotations(strict),
    Schema.Struct({
      type: Schema.Literal("streamable-http"),
      url: boundedText(2048),
      headers: Schema.Array(userAddedSecretValue).pipe(Schema.maxItems(32)),
    }).annotations(strict),
  ),
}).annotations(strict);
export type UserAddedMcpServerRequest = typeof UserAddedMcpServerRequest.Type;
export const decodeUserAddedMcpServerRequest = Schema.decodeUnknownSync(UserAddedMcpServerRequest);

/**
 * MCP servers and plugins another agent tool on this computer already knows,
 * listed for the person to add. The listing carries no path and no value:
 * an opaque id names each item, and the host keeps what it points at.
 */
export const DiscoveredAgentToolingOrigin = Schema.Literal("claude-code", "codex");
export type DiscoveredAgentToolingOrigin = typeof DiscoveredAgentToolingOrigin.Type;
const discoveredId = boundedText(128).pipe(Schema.pattern(/^[a-z]+-[a-f0-9]{32}$/));
export const DiscoveredMcpServer = Schema.Struct({
  id: discoveredId,
  origin: DiscoveredAgentToolingOrigin,
  /** Where the other tool keeps it: for the person, or for one Project's folder. */
  scope: Schema.Literal("user", "project"),
  name: boundedText(128),
  transport: Schema.Literal("stdio", "streamable-http"),
  /** The command line or the address, for the row; never a secret. */
  summary: boundedText(512),
  /** Variables the other tool reads from its environment that this host could not find. */
  needsValues: Schema.Array(boundedText(128)).pipe(Schema.maxItems(32)),
  /**
   * Variables the other tool expands inside the command, its arguments or the
   * address. Octant never copies a host value into those fields, so a server
   * that has any cannot be added from here.
   */
  unsupportedPlaceholders: Schema.Array(boundedText(128)).pipe(Schema.maxItems(32)),
  /** Values that will be kept in the credential store rather than the package. */
  secretNames: Schema.Array(boundedText(128)).pipe(Schema.maxItems(32)),
}).annotations(strict);
export type DiscoveredMcpServer = typeof DiscoveredMcpServer.Type;
export const DiscoveredPlugin = Schema.Struct({
  id: discoveredId,
  origin: DiscoveredAgentToolingOrigin,
  name: boundedText(128),
  version: Schema.optional(boundedText(64)),
  format: Schema.Literal("agent-plugins", "codex-plugin", "claude-plugin"),
  /** Whether the other tool has it switched on. */
  enabledThere: Schema.Boolean,
}).annotations(strict);
export type DiscoveredPlugin = typeof DiscoveredPlugin.Type;
export const DiscoveredAgentToolingListing = Schema.Struct({
  servers: Schema.Array(DiscoveredMcpServer).pipe(Schema.maxItems(256)),
  plugins: Schema.Array(DiscoveredPlugin).pipe(Schema.maxItems(256)),
  /** What was found but cannot be offered, in plain words. */
  notes: Schema.Array(boundedText(256)).pipe(Schema.maxItems(64)),
}).annotations(strict);
export type DiscoveredAgentToolingListing = typeof DiscoveredAgentToolingListing.Type;
export const decodeDiscoveredAgentToolingListing = Schema.decodeUnknownSync(
  DiscoveredAgentToolingListing,
);
/**
 * Signing in to a hosted MCP server a person added. The view never carries a
 * token; the host keeps the grant in the credential broker and attaches the
 * bearer when it connects.
 */
const signInTarget = {
  extensionId: ToolExtensionId,
  componentId: ExtensionComponentId,
};
export const McpServerSignInRequest = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("status"), ...signInTarget }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("begin"), ...signInTarget }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("poll"),
    ...signInTarget,
    attemptId: Schema.UUID,
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("sign-out"), ...signInTarget }).annotations(strict),
);
export type McpServerSignInRequest = typeof McpServerSignInRequest.Type;
export const decodeMcpServerSignInRequest = Schema.decodeUnknownSync(McpServerSignInRequest);
export const McpServerSignInView = Schema.Union(
  /** A server reached by a command, or one that answered without asking for a sign-in. */
  Schema.Struct({ kind: Schema.Literal("not-applicable") }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("signed-out") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("awaiting-consent"),
    attemptId: Schema.UUID,
    authorizationUrl: boundedText(4096),
    expiresAt: UtcTimestamp,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("signed-in"),
    /** The authorization server that issued the grant, for the row. */
    issuer: boundedText(256),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("sign-in-again"),
    reason: Schema.Literal("revoked", "expired", "refresh-reused"),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.Literal(
      "no-sign-in-offered",
      "client-registration-unavailable",
      "issuer-unsupported",
      "denied",
      "timeout",
      "unavailable",
      "local-host-required",
      "invalid",
    ),
    message: boundedText(512),
  }).annotations(strict),
);
export type McpServerSignInView = typeof McpServerSignInView.Type;
export const decodeMcpServerSignInView = Schema.decodeUnknownSync(McpServerSignInView);

/**
 * Plugins pinned to Projects: a pin offers the plugin on every Work or Code
 * turn in that Project without a per-send selection. The listing names the
 * Projects a local window may pin to, so Settings can show a switch per
 * Project.
 */
export const ExtensionProjectPin = Schema.Struct({
  projectId: ProjectId,
  extensionId: ToolExtensionId,
}).annotations(strict);
export type ExtensionProjectPin = typeof ExtensionProjectPin.Type;
export const ExtensionProjectPinListing = Schema.Struct({
  projects: Schema.Array(
    Schema.Struct({
      projectId: ProjectId,
      name: boundedText(256),
      type: Schema.Literal("work", "code"),
    }).annotations(strict),
  ).pipe(Schema.maxItems(512)),
  pins: Schema.Array(ExtensionProjectPin).pipe(Schema.maxItems(4096)),
}).annotations(strict);
export type ExtensionProjectPinListing = typeof ExtensionProjectPinListing.Type;
export const decodeExtensionProjectPinListing = Schema.decodeUnknownSync(
  ExtensionProjectPinListing,
);
export const ExtensionProjectPinRequest = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("list") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("set"),
    projectId: ProjectId,
    extensionId: ToolExtensionId,
    pinned: Schema.Boolean,
  }).annotations(strict),
);
export type ExtensionProjectPinRequest = typeof ExtensionProjectPinRequest.Type;
export const decodeExtensionProjectPinRequest = Schema.decodeUnknownSync(
  ExtensionProjectPinRequest,
);

export const DiscoveredAgentToolingRequest = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("list") }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("add-server"), id: discoveredId }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("import-plugin"), id: discoveredId }).annotations(strict),
);
export type DiscoveredAgentToolingRequest = typeof DiscoveredAgentToolingRequest.Type;
export const decodeDiscoveredAgentToolingRequest = Schema.decodeUnknownSync(
  DiscoveredAgentToolingRequest,
);

export const ExtensionCommand = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("search-catalog"),
    query: boundedText(256),
    catalogId: Schema.optional(ExtensionCatalogId),
    cursor: Schema.optional(opaqueCursor),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("search-skills"),
    query: boundedText(256),
    cursor: Schema.optional(opaqueCursor),
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("preview-skill"), source: ExtensionSource }).annotations(
    strict,
  ),
  Schema.Struct({ kind: Schema.Literal("preview-package"), source: ExtensionSource }).annotations(
    strict,
  ),
  /**
   * Looks a package up on the npm registry the person's npm configuration
   * names, downloads and checks it, and answers with the review a person reads
   * before installing. `range` is an exact version, a range, or a dist-tag;
   * without it the `latest` tag is used. Nothing is installed.
   */
  Schema.Struct({
    kind: Schema.Literal("resolve-npm-package"),
    packageName: boundedText(214),
    range: Schema.optional(boundedText(128)),
    /**
     * The installed package this lookup is an update of. The host then asks
     * the registry that package was installed from, whatever the npm settings
     * name now, and refuses a result that is not the same package.
     */
    updateOf: Schema.optional(ToolExtensionId),
  }).annotations(strict),
  /** Asks the registry an installed npm package came from whether a newer version exists. Installs nothing. */
  Schema.Struct({
    kind: Schema.Literal("check-npm-update"),
    extensionId: ToolExtensionId,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("inspect-package"),
    source: ExtensionSource,
    expectedDigest: Schema.optional(ExtensionContentDigest),
  }).annotations(strict),
  /**
   * `trust` installs and trusts in one confirmed step, journaled as both.
   * Enabling stays its own switch. Left out, the package installs untrusted.
   */
  Schema.Struct({
    kind: Schema.Literal("install-package"),
    ...versionedTarget,
    trust: Schema.optional(Schema.Boolean),
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("update-package"), ...versionedTarget }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("rollback-package"), ...versionedTarget }).annotations(
    strict,
  ),
  Schema.Struct({ kind: Schema.Literal("uninstall-package"), ...packageTarget }).annotations(
    strict,
  ),
  Schema.Struct({
    kind: Schema.Literal("install-skill"),
    ...versionedTarget,
    trust: Schema.optional(Schema.Boolean),
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("update-skill"), ...versionedTarget }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("remove-skill"), ...packageTarget }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("reconcile-skills") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("review-skill"),
    qualifiedId: boundedText(1024),
    digest: ExtensionContentDigest,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("trust-skill-source"),
    qualifiedId: boundedText(1024),
    digest: ExtensionContentDigest,
    trusted: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("set-skill-desired"),
    qualifiedId: boundedText(1024),
    digest: ExtensionContentDigest,
    desired: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("select-skill-collision"),
    name: boundedText(64),
    qualifiedId: boundedText(1024),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("set-source-trust"),
    ...desiredStateMutation,
    trusted: Schema.Boolean,
  }).annotations(strict),
  /**
   * Re-trusts an outside provider driver held because a key other than the
   * pinned one signed it. `publisherKey` is the new key the person saw beside
   * the pinned one; the host refuses any other.
   */
  Schema.Struct({
    kind: Schema.Literal("trust-new-publisher"),
    ...desiredStateMutation,
    publisherKey: ExtensionPublisherKeyFingerprint,
  }).annotations(strict),
  /** Forgets the publisher key pinned for a package, installed or not. */
  Schema.Struct({
    kind: Schema.Literal("forget-publisher"),
    ...desiredStateMutation,
    publisherKey: ExtensionPublisherKeyFingerprint,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("set-plugin-desired"),
    ...desiredStateMutation,
    desired: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("set-component-desired"),
    ...desiredStateMutation,
    componentId: ExtensionComponentId,
    desired: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("query-effective-state"),
    commandVersion: stateCommandVersion,
    ...ExtensionEffectiveStateQuery.fields,
  }).annotations(strict),
);
export type ExtensionCommand = typeof ExtensionCommand.Type;

export const ExtensionSnapshot = Schema.Struct({
  sequence: GlobalSequence,
  snapshotAt: UtcTimestamp,
  packages: Schema.Array(ExtensionPackageState).pipe(Schema.maxItems(4096)),
  skills: Schema.optional(Schema.Array(StandaloneSkillRecord).pipe(Schema.maxItems(4096))),
  collisions: Schema.Array(ExtensionSkillCollision).pipe(Schema.maxItems(4096)),
}).annotations(strict);
export type ExtensionSnapshot = typeof ExtensionSnapshot.Type;

export const ExtensionEffectiveSnapshot = Schema.Struct({
  sequence: GlobalSequence,
  snapshotAt: UtcTimestamp,
  scope: ExtensionActivationScope,
  catalogEpoch: ExtensionCatalogEpoch,
  catalogStatus: Schema.Literal("available", "offline"),
  stale: Schema.Boolean,
  packages: Schema.Array(ExtensionEffectivePackageState).pipe(Schema.maxItems(4096)),
  collisions: Schema.Array(ExtensionSkillCollision).pipe(Schema.maxItems(4096)),
}).annotations(strict);
export type ExtensionEffectiveSnapshot = typeof ExtensionEffectiveSnapshot.Type;

export const ExtensionCatalogEntry = Schema.Struct({
  extensionId: ToolExtensionId,
  packageId: ExtensionPackageId,
  slug: ExtensionSlug,
  displayName: boundedText(128),
  version: ExtensionPackageVersion,
  digest: ExtensionContentDigest,
  source: ExtensionSource,
}).annotations(strict);
export type ExtensionCatalogEntry = typeof ExtensionCatalogEntry.Type;

export const MAX_SKILL_PREVIEW_INSTRUCTIONS_LENGTH = 128 * 1024;

/**
 * A file inside the package, named by its package-relative path: never an
 * absolute path, a `.` or `..` segment, or a backslash, so the review names
 * what the package holds and nothing about where this host keeps it.
 */
const PackageRelativePath = Schema.String.pipe(
  Schema.maxLength(1024),
  Schema.filter(
    (path) =>
      path.length > 0 &&
      !path.startsWith("/") &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
  ),
);

/**
 * What a person reviews before a language server can run: the binary the host
 * will start, that file's own digest, the languages it serves, and its launch
 * class, which decides its confinement.
 */
export const ExtensionPackageReviewLanguageServer = Schema.Struct({
  ...ExtensionLanguageServerDeclaration.fields,
  binary: PackageRelativePath,
  binaryDigest: ExtensionContentDigest,
}).annotations(strict);
export type ExtensionPackageReviewLanguageServer = typeof ExtensionPackageReviewLanguageServer.Type;
export const decodeExtensionPackageReviewLanguageServer = Schema.decodeUnknownSync(
  ExtensionPackageReviewLanguageServer,
);

/**
 * What a person reviews before a debug adapter can run: the binary the host
 * will start, that file's own digest, the runtimes it labels, the `launch`
 * body it sends with its placeholders, whether it takes a debug port, and
 * whether it also debugs the child processes of the program it starts.
 */
export const ExtensionPackageReviewDebugAdapter = Schema.Struct({
  runtimes: ExtensionDebugAdapterDeclaration.from.fields.runtimes,
  launchArguments: ExtensionDebugAdapterDeclaration.from.fields.launchArguments,
  importTypes: ExtensionDebugAdapterDeclaration.from.fields.importTypes,
  debugPorts: ExtensionDebugAdapterDeclaration.from.fields.debugPorts,
  childSessions: ExtensionDebugAdapterDeclaration.from.fields.childSessions,
  childAnnouncement: ExtensionDebugAdapterDeclaration.from.fields.childAnnouncement,
  binary: PackageRelativePath,
  binaryDigest: ExtensionContentDigest,
}).annotations(strict);
export type ExtensionPackageReviewDebugAdapter = typeof ExtensionPackageReviewDebugAdapter.Type;
export const decodeExtensionPackageReviewDebugAdapter = Schema.decodeUnknownSync(
  ExtensionPackageReviewDebugAdapter,
);

export const ExtensionPackageReviewComponent = Schema.Struct({
  id: ExtensionComponentId,
  kind: ExtensionComponentKind,
  displayName: boundedText(128),
  declaredCapabilities: Schema.Array(ExtensionCapability).pipe(Schema.maxItems(32)),
  instructions: Schema.optional(boundedText(MAX_SKILL_PREVIEW_INSTRUCTIONS_LENGTH)),
  languageServer: Schema.optional(ExtensionPackageReviewLanguageServer),
  debugAdapter: Schema.optional(ExtensionPackageReviewDebugAdapter),
}).annotations(strict);
export type ExtensionPackageReviewComponent = typeof ExtensionPackageReviewComponent.Type;

export const ExtensionPackageReview = Schema.Struct({
  description: Schema.optional(boundedText(4096)),
  provenance: ExtensionProvenance,
  license: ExtensionLicense,
  compatibility: ExtensionCompatibility,
  declaredCapabilities: Schema.Array(ExtensionCapability).pipe(Schema.maxItems(32)),
  components: Schema.Array(ExtensionPackageReviewComponent).pipe(
    Schema.minItems(1),
    Schema.maxItems(256),
  ),
}).annotations(strict);
export type ExtensionPackageReview = typeof ExtensionPackageReview.Type;

export const ExtensionPackagePreview = Schema.Struct({
  entry: ExtensionCatalogEntry,
  review: ExtensionPackageReview,
  diagnostics: Schema.Array(ExtensionDiagnostic).pipe(Schema.maxItems(128)),
}).annotations(strict);
export type ExtensionPackagePreview = typeof ExtensionPackagePreview.Type;

export const SkillMarketplaceEntry = Schema.Struct({
  skill: SourceQualifiedSkill,
  source: ExtensionSource,
  version: ExtensionPackageVersion,
  displayName: boundedText(128),
  description: Schema.optional(boundedText(2048)),
  provenance: ExtensionProvenance,
}).annotations(strict);
export type SkillMarketplaceEntry = typeof SkillMarketplaceEntry.Type;

export const SkillPackagePreview = Schema.Struct({
  entry: SkillMarketplaceEntry,
  extensionId: ToolExtensionId,
  packageId: ExtensionPackageId,
  license: ExtensionLicense,
  instructions: Schema.optional(boundedText(MAX_SKILL_PREVIEW_INSTRUCTIONS_LENGTH)),
  diagnostics: Schema.Array(ExtensionDiagnostic).pipe(Schema.maxItems(128)),
}).annotations(strict);
export type SkillPackagePreview = typeof SkillPackagePreview.Type;

export const ExtensionCommandFailure = Schema.Struct({
  category: Schema.Literal(
    "invalid",
    "unauthorized",
    "blocked",
    "stale",
    "unavailable",
    "interrupted",
    "waiting",
    "failed",
  ),
  message: boundedText(1024).pipe(
    Schema.filter(
      (message) => !message.includes("/") && !message.includes("\\") && !message.includes("\0"),
    ),
  ),
}).annotations(strict);
export type ExtensionCommandFailure = typeof ExtensionCommandFailure.Type;

export const ExtensionCommandResult = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("catalog-search-results"),
    entries: Schema.Array(ExtensionCatalogEntry).pipe(Schema.maxItems(256)),
    nextCursor: Schema.optional(opaqueCursor),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("skill-search-results"),
    entries: Schema.Array(SkillMarketplaceEntry).pipe(Schema.maxItems(256)),
    nextCursor: Schema.optional(opaqueCursor),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("skill-package-preview"),
    preview: SkillPackagePreview,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("package-preview"),
    preview: ExtensionPackagePreview,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("package-inspected"),
    preview: ExtensionPackagePreview,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("npm-update-checked"),
    extensionId: ToolExtensionId,
    installedVersion: ExtensionPackageVersion,
    /** The newest version the registry offers, when it is newer than the installed one. */
    available: Schema.optional(ExtensionPackageVersion),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("extension-state-updated"),
    snapshot: ExtensionSnapshot,
    /** Set only when the update was a user-added server: the package that add created. */
    addedPackage: Schema.optional(
      Schema.Struct({
        extensionId: ToolExtensionId,
        componentId: Schema.optional(ExtensionComponentId),
      }).annotations(strict),
    ),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("extension-effective-state"),
    snapshot: ExtensionEffectiveSnapshot,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("extension-command-failed"),
    failure: ExtensionCommandFailure,
  }).annotations(strict),
);
export type ExtensionCommandResult = typeof ExtensionCommandResult.Type;

export const decodeExtensionCommand = Schema.decodeUnknownSync(ExtensionCommand);
export const decodeExtensionSnapshot = Schema.decodeUnknownSync(ExtensionSnapshot);
export const decodeExtensionEffectiveStateQuery = Schema.decodeUnknownSync(
  ExtensionEffectiveStateQuery,
);
export const decodeExtensionEffectiveSnapshot = Schema.decodeUnknownSync(
  ExtensionEffectiveSnapshot,
);
export const decodeExtensionCommandResult = Schema.decodeUnknownSync(ExtensionCommandResult);
export const decodeExtensionCommandFailure = Schema.decodeUnknownSync(ExtensionCommandFailure);
export const decodeExtensionToolApproval = Schema.decodeUnknownSync(ExtensionToolApproval);
export const decodeExtensionToolApprovalList = Schema.decodeUnknownSync(ExtensionToolApprovalList);
export const decodeExtensionToolApprovalDecision = Schema.decodeUnknownSync(
  ExtensionToolApprovalDecision,
);
export const decodeExtensionToolGrant = Schema.decodeUnknownSync(ExtensionToolGrant);
export const decodeExtensionToolGrantList = Schema.decodeUnknownSync(ExtensionToolGrantList);
export const decodeExtensionToolGrantRequest = Schema.decodeUnknownSync(ExtensionToolGrantRequest);
