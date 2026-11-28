import { GithubMcpPermissionProfile, McpOAuthClientRegistration } from "./hostOAuth";
import { GuidString, NonNegativeInt, PositiveInt, STRICT_DECODE_OPTIONS } from "./schemaPrimitives";
import { ApprovalOutsideContent } from "./contentProvenance";
import { SkillFolderPath } from "./shell";
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
  ExtensionSelection,
  ExtensionPublisherKeyFingerprint,
  SourceQualifiedSkill,
  SourceQualifiedSkillId,
  StandaloneSkillRecord,
} from "./extensions";
import { ExtensionToolGrantId, extensionToolGrantRecordedFields } from "./extensionEvents";
import { ToolExtensionId } from "./toolActions";
import { OctantMode } from "./modes";
import { ProjectId } from "./projects";
import { SecretStoreItemReference, SecretStoreKind } from "./secretStores";

const boundedText = (maximumLength: number) =>
  Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(maximumLength));
const opaqueCursor = Schema.Trimmed.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
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
const stateCommandVersion = EventVersion.check(Schema.makeFilter((version) => version === 1));
const desiredStateMutation = {
  commandVersion: stateCommandVersion,
  extensionId: ToolExtensionId,
  expectedStateVersion: AggregateVersion,
};

export const ExtensionEffectiveStateQuery = Schema.Struct({
  scope: ExtensionActivationScope,
  expectedCatalogEpoch: Schema.optional(ExtensionCatalogEpoch),
});
export type ExtensionEffectiveStateQuery = typeof ExtensionEffectiveStateQuery.Type;

export const ExtensionToolApproval = Schema.Struct({
  approvalId: GuidString,
  threadId: GuidString,
  projectId: Schema.optional(GuidString),
  extensionId: ToolExtensionId,
  packageId: ExtensionPackageId,
  componentId: ExtensionComponentId,
  /** The MCP server's own name, as its package configuration declares it. */
  serverName: boundedText(128),
  providerToolName: boundedText(256),
  mcpToolName: boundedText(256),
  inputJson: Schema.String.check(Schema.isMaxLength(64 * 1024)),
  requestedAt: UtcTimestamp,
  /**
   * Whether an approval is kept for the Project, or for the account on a
   * thread with no `projectId`, so `remember` may also narrow it to this tool.
   * False on a Plan turn, on a turn the host started as itself or a paired
   * device sent, and for a network tool on a thread that took in outside
   * content.
   */
  rememberable: Schema.Boolean,
  /**
   * What approving lets run afterwards: every tool of the tool's server
   * (`server`, the same as `rememberable`), every tool of that server for the
   * rest of this thread (`server-on-thread`), or this call alone (`call`).
   * Absent from a host that predates it, where an approval covers this call.
   */
  answerCovers: Schema.optional(Schema.Literals(["call", "server", "server-on-thread"])),
  /** Present when the thread has taken in outside content; see `ApprovalOutsideContent`. */
  outsideContent: Schema.optional(ApprovalOutsideContent),
}).annotate(personDecides);
export type ExtensionToolApproval = typeof ExtensionToolApproval.Type;

export const ExtensionToolApprovalList = Schema.Array(ExtensionToolApproval);
export type ExtensionToolApprovalList = typeof ExtensionToolApprovalList.Type;

export const ExtensionToolApprovalDecision = Schema.Struct({
  approvalId: GuidString,
  decision: Schema.Literals(["approved", "denied"]),
  /**
   * Names what the approval is kept for, where the prompt is `rememberable`.
   * Left out, an approval there is kept for every tool of the server. Only
   * an approval can be remembered.
   */
  remember: Schema.optional(Schema.Boolean),
  /**
   * What `remember` covers: this tool alone, or every tool of its server.
   * Absent means this tool, which is all an older client can ask for.
   */
  rememberScope: Schema.optional(Schema.Literals(["tool", "server"])),
}).check(
  Schema.makeFilter(
    (answer) =>
      (answer.remember !== true || answer.decision === "approved") &&
      (answer.rememberScope === undefined || answer.remember === true),
  ),
);
export type ExtensionToolApprovalDecision = typeof ExtensionToolApprovalDecision.Type;

/**
 * A remembered approval as Settings lists it: one MCP tool or a whole server,
 * in one Project or for the account.
 */
export const ExtensionToolGrant = Schema.Struct({
  ...extensionToolGrantRecordedFields,
  grantedAt: UtcTimestamp,
}).annotate(personDecides);
export type ExtensionToolGrant = typeof ExtensionToolGrant.Type;

export const ExtensionToolGrantList = Schema.Array(ExtensionToolGrant).check(
  Schema.isMaxLength(4096),
);
export type ExtensionToolGrantList = typeof ExtensionToolGrantList.Type;

/**
 * What a local window may ask of remembered approvals: read them, or take one
 * away. Nothing here creates one; that happens only by answering a prompt.
 */
export const ExtensionToolGrantRequest = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("list") }),
  Schema.Struct({ kind: Schema.Literal("revoke"), grantId: ExtensionToolGrantId }),
]);
export type ExtensionToolGrantRequest = typeof ExtensionToolGrantRequest.Type;

/**
 * An MCP server the person adds by hand: a command to start, or an address to
 * connect to. A value marked secret is kept in the host credential broker and
 * never written into the package; the package carries a reference instead.
 */
const userAddedSecretValue = Schema.Struct({
  name: boundedText(128).check(Schema.isPattern(/^[A-Za-z_][A-Za-z0-9_-]*$/)),
  value: Schema.String.check(Schema.isMaxLength(8192)),
  secret: Schema.Boolean,
  /**
   * A secret that comes from a linked secret store: the host keeps this item
   * reference instead of a value and fetches the value when the server is
   * launched. `value` is empty and `secret` is true.
   */
  linked: Schema.optional(
    Schema.Struct({ store: SecretStoreKind, reference: SecretStoreItemReference }),
  ),
});
export const UserAddedMcpServerRequest = Schema.Struct({
  name: boundedText(64),
  /**
   * Adds the server without trusting it or turning it on, leaving both as
   * the person's own steps. Left out, the one confirmation of adding it
   * installs, trusts and turns it on.
   */
  installOnly: Schema.optional(Schema.Boolean),
  /**
   * The catalog connector this server is, when it was added from Connectors.
   * The host checks it against the bundled catalog and names the package after
   * it, so the package stays recognizable whatever its display name is.
   */
  connectorId: Schema.optional(boundedText(64)),
  /** A bundled local setup; never a hosted OAuth connector. */
  localSetupId: Schema.optional(Schema.Literal("paper")),
  server: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("stdio"),
      command: boundedText(1024),
      args: Schema.Array(Schema.String.check(Schema.isMaxLength(1024))).check(
        Schema.isMaxLength(64),
      ),
      env: Schema.Array(userAddedSecretValue).check(Schema.isMaxLength(64)),
    }),
    Schema.Struct({
      type: Schema.Literal("streamable-http"),
      url: boundedText(2048),
      headers: Schema.Array(userAddedSecretValue).check(Schema.isMaxLength(32)),
    }),
  ]),
});
export type UserAddedMcpServerRequest = typeof UserAddedMcpServerRequest.Type;
export const decodeUserAddedMcpServerRequest = Schema.decodeUnknownSync(
  UserAddedMcpServerRequest,
  STRICT_DECODE_OPTIONS,
);

/**
 * MCP servers and plugins another agent tool on this computer already knows,
 * listed for the person to add. The listing carries no path and no value:
 * an opaque id names each item, and the host keeps what it points at.
 */
export const DiscoveredAgentToolingOrigin = Schema.Literals(["claude-code", "codex"]);
export type DiscoveredAgentToolingOrigin = typeof DiscoveredAgentToolingOrigin.Type;
const discoveredId = boundedText(128).check(Schema.isPattern(/^[a-z]+-[a-f0-9]{32}$/));
export const DiscoveredMcpServer = Schema.Struct({
  id: discoveredId,
  origin: DiscoveredAgentToolingOrigin,
  /** Where the other tool keeps it: for the person, or for one Project's folder. */
  scope: Schema.Literals(["user", "project"]),
  name: boundedText(128),
  transport: Schema.Literals(["stdio", "streamable-http"]),
  /** The command line or the address, for the row; never a secret. */
  summary: boundedText(512),
  /** Variables the other tool reads from its environment that this host could not find. */
  needsValues: Schema.Array(boundedText(128)).check(Schema.isMaxLength(32)),
  /**
   * Variables the other tool expands inside the command, its arguments or the
   * address. Octant never copies a host value into those fields, so a server
   * that has any cannot be added from here.
   */
  unsupportedPlaceholders: Schema.Array(boundedText(128)).check(Schema.isMaxLength(32)),
  /** Values that will be kept in the credential store rather than the package. */
  secretNames: Schema.Array(boundedText(128)).check(Schema.isMaxLength(32)),
});
export type DiscoveredMcpServer = typeof DiscoveredMcpServer.Type;
export const DiscoveredPlugin = Schema.Struct({
  id: discoveredId,
  origin: DiscoveredAgentToolingOrigin,
  name: boundedText(128),
  version: Schema.optional(boundedText(64)),
  format: Schema.Literals(["agent-plugins", "codex-plugin", "claude-plugin"]),
  /** Whether the other tool has it switched on. */
  enabledThere: Schema.Boolean,
});
export type DiscoveredPlugin = typeof DiscoveredPlugin.Type;
export const DiscoveredAgentToolingListing = Schema.Struct({
  servers: Schema.Array(DiscoveredMcpServer).check(Schema.isMaxLength(256)),
  plugins: Schema.Array(DiscoveredPlugin).check(Schema.isMaxLength(256)),
  /** What was found but cannot be offered, in plain words. */
  notes: Schema.Array(boundedText(256)).check(Schema.isMaxLength(64)),
});
export type DiscoveredAgentToolingListing = typeof DiscoveredAgentToolingListing.Type;
export const decodeDiscoveredAgentToolingListing = Schema.decodeUnknownSync(
  DiscoveredAgentToolingListing,
  STRICT_DECODE_OPTIONS,
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
/** A linked store item address, never the secret value or a caller-created broker id. */
export const McpClientSetupInput = Schema.Struct({
  binding: Schema.Struct({
    resource: boundedText(2048),
    issuer: boundedText(2048),
    tokenEndpoint: boundedText(2048),
    callback: boundedText(256),
    mcpPermissionProfile: Schema.optional(GithubMcpPermissionProfile),
  }),
  kind: Schema.Literals(["registered", "metadata-document"]),
  clientId: boundedText(2048),
  authentication: Schema.Literals(["none", "client_secret_post", "client_secret_basic"]),
  secret: Schema.optional(
    Schema.Struct({ store: SecretStoreKind, reference: SecretStoreItemReference }),
  ),
});
export type McpClientSetupInput = typeof McpClientSetupInput.Type;

export const McpServerSignInRequest = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("prepare-client"), ...signInTarget }),
  Schema.Struct({
    kind: Schema.Literal("save-client"),
    ...signInTarget,
    setup: McpClientSetupInput,
  }),
  Schema.Struct({
    kind: Schema.Literal("configure-client"),
    ...signInTarget,
    registration: McpOAuthClientRegistration,
  }),
  Schema.Struct({ kind: Schema.Literal("status"), ...signInTarget }),
  Schema.Struct({ kind: Schema.Literal("begin"), ...signInTarget }),
  Schema.Struct({
    kind: Schema.Literal("poll"),
    ...signInTarget,
    attemptId: GuidString,
  }),
  Schema.Struct({ kind: Schema.Literal("sign-out"), ...signInTarget }),
]);
export type McpServerSignInRequest = typeof McpServerSignInRequest.Type;
export const decodeMcpServerSignInRequest = Schema.decodeUnknownSync(
  McpServerSignInRequest,
  STRICT_DECODE_OPTIONS,
);
/** Optional last-reported account facts; never token/JWT fields or inferred names. */
export const McpReportedAccount = Schema.Struct({
  workspaceId: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9]{1,128}$/))),
  userId: Schema.optional(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9]{1,128}$/))),
  grantedScopes: Schema.optional(
    Schema.Array(
      Schema.String.check(Schema.isMaxLength(128), Schema.isPattern(/^[\x21\x23-\x5B\x5D-\x7E]+$/)),
    ).check(Schema.isMaxLength(64)),
  ),
});
export type McpReportedAccount = typeof McpReportedAccount.Type;
export const decodeMcpReportedAccount = Schema.decodeUnknownSync(
  McpReportedAccount,
  STRICT_DECODE_OPTIONS,
);

export const McpServerSignInView = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("client-configured") }),
  Schema.Struct({
    kind: Schema.Literal("client-setup"),
    mcpPermissionProfile: Schema.optional(GithubMcpPermissionProfile),
    resource: boundedText(2048),
    issuer: boundedText(2048),
    tokenEndpoint: boundedText(2048),
    callback: boundedText(256),
    metadataClientSupported: Schema.Boolean,
    authenticationMethods: Schema.Array(
      Schema.Literals(["none", "client_secret_post", "client_secret_basic"]),
    ),
    secretStoreAvailable: Schema.Boolean,
    registration: Schema.optional(McpOAuthClientRegistration),
  }),
  Schema.Struct({ kind: Schema.Literal("not-applicable") }),
  Schema.Struct({ kind: Schema.Literal("signed-out") }),
  Schema.Struct({
    kind: Schema.Literal("client-setup-required"),
    message: boundedText(512),
  }),
  Schema.Struct({ kind: Schema.Literal("cancel-pending"), message: boundedText(512) }),
  Schema.Struct({
    kind: Schema.Literal("sign-out-pending"),
    message: boundedText(512),
  }),
  Schema.Struct({
    kind: Schema.Literal("status-unavailable"),
    message: boundedText(512),
  }),
  Schema.Struct({
    kind: Schema.Literal("awaiting-consent"),
    attemptId: GuidString,
    flow: Schema.optional(Schema.Literals(["authorization-code-pkce", "relay"])),
    relayable: Schema.optional(Schema.Boolean),
    authorizationUrl: boundedText(4096),
    expiresAt: UtcTimestamp,
  }),
  Schema.Struct({
    kind: Schema.Literal("awaiting-device-code"),
    attemptId: GuidString,
    issuerHost: boundedText(256),
    verificationUri: boundedText(2048),
    verificationUriComplete: Schema.optional(boundedText(2048)),
    userCode: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9-]{1,64}$/)),
    expiresAt: UtcTimestamp,
  }),
  Schema.Struct({
    kind: Schema.Literal("signed-in"),
    /** The authorization server that issued the grant, for the row. */
    issuer: boundedText(256),
    account: Schema.optional(McpReportedAccount),
  }),
  Schema.Struct({
    kind: Schema.Literal("sign-in-again"),
    reason: Schema.Literals([
      "revoked",
      "expired",
      "refresh-reused",
      "account-changed",
      "permission-missing",
      "permission-mismatch",
      "identity-unavailable",
    ]),
  }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.Literals([
      "no-sign-in-offered",
      "client-registration-unavailable",
      "issuer-unsupported",
      "denied",
      "timeout",
      "unavailable",
      "local-host-required",
      "sign-in-settled",
      "invalid",
    ]),
    message: boundedText(512),
  }),
]);
export type McpServerSignInView = typeof McpServerSignInView.Type;
export const decodeMcpServerSignInView = Schema.decodeUnknownSync(
  McpServerSignInView,
  STRICT_DECODE_OPTIONS,
);

/**
 * One-time callback relay sent by the paired device that began a PKCE attempt.
 * The callback address travels once inside the signed session and is never
 * logged, journaled, or returned.
 */
export const McpServerSignInRelayRequest = Schema.Struct({
  attemptId: GuidString,
  callbackUrl: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4352)),
});
export type McpServerSignInRelayRequest = typeof McpServerSignInRelayRequest.Type;
export const decodeMcpServerSignInRelayRequest = Schema.decodeUnknownSync(
  McpServerSignInRelayRequest,
  STRICT_DECODE_OPTIONS,
);

export const McpServerSignInRelayResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("signed-in"),
    issuer: boundedText(256),
    account: Schema.optional(McpReportedAccount),
  }),
  Schema.Struct({
    kind: Schema.Literal("sign-in-again"),
    reason: Schema.Literals([
      "revoked",
      "expired",
      "refresh-reused",
      "account-changed",
      "permission-missing",
      "permission-mismatch",
      "identity-unavailable",
    ]),
  }),
  Schema.Struct({
    kind: Schema.Literal("retry"),
    remainingAttempts: Schema.Literals([1, 2]),
    message: boundedText(512),
  }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.Literals([
      "sign-in-settled",
      "denied",
      "timeout",
      "unavailable",
      "local-host-required",
      "invalid",
    ]),
    message: boundedText(512),
  }),
]);
export type McpServerSignInRelayResult = typeof McpServerSignInRelayResult.Type;
export const decodeMcpServerSignInRelayResult = Schema.decodeUnknownSync(
  McpServerSignInRelayResult,
  STRICT_DECODE_OPTIONS,
);

/**
 * How each installed MCP server is connecting, as the host last saw it. The
 * listing is built from retained facts only: the package's switches, the
 * stored sign-in record, and what the last connection attempt reported.
 * Reading it never connects, signs in, or asks a server for its tools.
 */
export const McpServerConnectionState = Schema.Literals([
  "connected",
  "connecting",
  "ready",
  "needs-sign-in",
  "failed",
  "off",
  "blocked",
]);
export type McpServerConnectionState = typeof McpServerConnectionState.Type;
export const McpServerConnection = Schema.Struct({
  extensionId: ToolExtensionId,
  packageId: ExtensionPackageId,
  componentId: ExtensionComponentId,
  /** The package's name, then the server's own name inside it. */
  packageName: boundedText(256),
  serverName: boundedText(256),
  transport: Schema.Literals(["stdio", "streamable-http", "unknown"]),
  state: McpServerConnectionState,
  /** One plain sentence on why the server is not connected; absent when nothing is wrong. */
  reason: Schema.optional(boundedText(512)),
  /** When the host last saw a connection open or fail. */
  checkedAt: Schema.optional(UtcTimestamp),
  /**
   * In a `thread-sign-in` answer, the request's own `references` that name
   * this server, so the composer resolves only those again once it is signed in.
   */
  references: Schema.optional(Schema.Array(boundedText(256)).check(Schema.isMaxLength(32))),
});
export type McpServerConnection = typeof McpServerConnection.Type;
export const McpServerConnectionListing = Schema.Struct({
  servers: Schema.Array(McpServerConnection).check(Schema.isMaxLength(512)),
});
export type McpServerConnectionListing = typeof McpServerConnectionListing.Type;
export const decodeMcpServerConnectionListing = Schema.decodeUnknownSync(
  McpServerConnectionListing,
  STRICT_DECODE_OPTIONS,
);
/**
 * Reading the listing, or asking the host to drop a server's connection and
 * its failure so the next task connects fresh. Reconnect is a person's act
 * in a local window; it never replays a call that failed. `thread-sign-in`
 * answers with only the servers one thread's next turn would get and cannot
 * use until someone signs in. `selections` are the ones that turn would carry,
 * and `references` the `@` names in its draft the composer could not select.
 */
export const McpServerConnectionRequest = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("list") }),
  Schema.Struct({ kind: Schema.Literal("reconnect"), ...signInTarget }),
  Schema.Struct({
    kind: Schema.Literal("thread-sign-in"),
    mode: OctantMode,
    threadId: GuidString,
    selections: Schema.Array(ExtensionSelection).check(Schema.isMaxLength(32)),
    references: Schema.Array(boundedText(256)).check(Schema.isMaxLength(32)),
  }),
]);
export type McpServerConnectionRequest = typeof McpServerConnectionRequest.Type;
export const decodeMcpServerConnectionRequest = Schema.decodeUnknownSync(
  McpServerConnectionRequest,
  STRICT_DECODE_OPTIONS,
);
export const McpServerReconnectResult = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("reconnecting") }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.Literals(["not-found", "local-host-required"]),
    message: boundedText(512),
  }),
]);
export type McpServerReconnectResult = typeof McpServerReconnectResult.Type;
export const decodeMcpServerReconnectResult = Schema.decodeUnknownSync(
  McpServerReconnectResult,
  STRICT_DECODE_OPTIONS,
);

/**
 * Plugins pinned to Projects: a pin offers the plugin on every Work or Code
 * turn in that Project without a per-send selection. The listing names the
 * Projects a local window may pin to, so Settings can show a switch per
 * Project.
 */
export const ExtensionProjectPin = Schema.Struct({
  projectId: ProjectId,
  extensionId: ToolExtensionId,
});
export type ExtensionProjectPin = typeof ExtensionProjectPin.Type;
export const ExtensionProjectPinListing = Schema.Struct({
  projects: Schema.Array(
    Schema.Struct({
      projectId: ProjectId,
      name: boundedText(256),
      type: Schema.Literals(["work", "code"]),
    }),
  ).check(Schema.isMaxLength(512)),
  pins: Schema.Array(ExtensionProjectPin).check(Schema.isMaxLength(4096)),
});
export type ExtensionProjectPinListing = typeof ExtensionProjectPinListing.Type;
export const decodeExtensionProjectPinListing = Schema.decodeUnknownSync(
  ExtensionProjectPinListing,
  STRICT_DECODE_OPTIONS,
);
export const ExtensionProjectPinRequest = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("list") }),
  Schema.Struct({
    kind: Schema.Literal("set"),
    projectId: ProjectId,
    extensionId: ToolExtensionId,
    pinned: Schema.Boolean,
  }),
]);
export type ExtensionProjectPinRequest = typeof ExtensionProjectPinRequest.Type;
export const decodeExtensionProjectPinRequest = Schema.decodeUnknownSync(
  ExtensionProjectPinRequest,
  STRICT_DECODE_OPTIONS,
);

/**
 * What the person's own Claude Code and Codex files say about compacting, read
 * from those files and never written: whether Claude Code compacts by itself
 * and the window it was given, and the token limit Codex was given. A value
 * the file does not set is absent, which means the runtime's own default.
 */
export const RuntimeCompactionDefaults = Schema.Struct({
  claude: Schema.Struct({
    /** `false` when `autoCompactEnabled` is off, or `DISABLE_AUTO_COMPACT` is set in its settings. */
    autoCompact: Schema.Boolean,
    autoCompactWindow: Schema.optional(PositiveInt),
  }),
  codex: Schema.Struct({
    autoCompactTokenLimit: Schema.optional(PositiveInt),
  }),
});
export type RuntimeCompactionDefaults = typeof RuntimeCompactionDefaults.Type;

export const DiscoveredAgentToolingRequest = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("list") }),
  Schema.Struct({ kind: Schema.Literal("compaction-defaults") }),
  Schema.Struct({ kind: Schema.Literal("add-server"), id: discoveredId }),
  Schema.Struct({ kind: Schema.Literal("import-plugin"), id: discoveredId }),
]);
export type DiscoveredAgentToolingRequest = typeof DiscoveredAgentToolingRequest.Type;
export const decodeDiscoveredAgentToolingRequest = Schema.decodeUnknownSync(
  DiscoveredAgentToolingRequest,
  STRICT_DECODE_OPTIONS,
);

export const ExtensionCommand = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("search-catalog"),
    query: boundedText(256),
    catalogId: Schema.optional(ExtensionCatalogId),
    cursor: Schema.optional(opaqueCursor),
  }),
  Schema.Struct({
    kind: Schema.Literal("search-skills"),
    query: boundedText(256),
    cursor: Schema.optional(opaqueCursor),
  }),
  Schema.Struct({ kind: Schema.Literal("preview-skill"), source: ExtensionSource }),
  Schema.Struct({ kind: Schema.Literal("preview-package"), source: ExtensionSource }),
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
  }),
  Schema.Struct({
    kind: Schema.Literal("check-npm-update"),
    extensionId: ToolExtensionId,
  }),
  Schema.Struct({
    kind: Schema.Literal("inspect-package"),
    source: ExtensionSource,
    expectedDigest: Schema.optional(ExtensionContentDigest),
  }),
  Schema.Struct({
    kind: Schema.Literal("install-package"),
    ...versionedTarget,
    trust: Schema.optional(Schema.Boolean),
    enable: Schema.optional(Schema.Boolean),
  }).check(Schema.makeFilter((install) => install.enable !== true || install.trust === true)),
  Schema.Struct({ kind: Schema.Literal("update-package"), ...versionedTarget }),
  Schema.Struct({
    kind: Schema.Literal("rollback-package"),
    ...versionedTarget,
    restoreTrust: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ kind: Schema.Literal("uninstall-package"), ...packageTarget }),
  Schema.Struct({
    kind: Schema.Literal("install-skill"),
    ...versionedTarget,
    trust: Schema.optional(Schema.Boolean),
    enable: Schema.optional(Schema.Boolean),
  }).check(Schema.makeFilter((install) => install.enable !== true || install.trust === true)),
  Schema.Struct({ kind: Schema.Literal("update-skill"), ...versionedTarget }),
  Schema.Struct({ kind: Schema.Literal("remove-skill"), ...packageTarget }),
  Schema.Struct({ kind: Schema.Literal("reconcile-skills") }),
  Schema.Struct({
    kind: Schema.Literal("review-skill"),
    qualifiedId: boundedText(1024),
    digest: ExtensionContentDigest,
  }),
  Schema.Struct({
    kind: Schema.Literal("trust-skill-source"),
    qualifiedId: boundedText(1024),
    digest: ExtensionContentDigest,
    trusted: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("set-skill-desired"),
    qualifiedId: boundedText(1024),
    digest: ExtensionContentDigest,
    desired: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("select-skill-collision"),
    name: boundedText(64),
    qualifiedId: boundedText(1024),
  }),
  Schema.Struct({
    kind: Schema.Literal("set-source-trust"),
    ...desiredStateMutation,
    trusted: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("trust-new-publisher"),
    ...desiredStateMutation,
    publisherKey: ExtensionPublisherKeyFingerprint,
  }),
  Schema.Struct({
    kind: Schema.Literal("forget-publisher"),
    ...desiredStateMutation,
    publisherKey: ExtensionPublisherKeyFingerprint,
  }),
  Schema.Struct({
    kind: Schema.Literal("set-plugin-desired"),
    ...desiredStateMutation,
    desired: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("set-component-desired"),
    ...desiredStateMutation,
    componentId: ExtensionComponentId,
    desired: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("query-effective-state"),
    commandVersion: stateCommandVersion,
    ...ExtensionEffectiveStateQuery.fields,
  }),
]);
export type ExtensionCommand = typeof ExtensionCommand.Type;

/** Host diagnostics for explicitly enabled provider/added skill roots; never a path or grant. */
export const SkillRootStatus = Schema.Struct({
  sourceRef: Schema.Trimmed.check(
    Schema.isNonEmpty(),
    Schema.isMaxLength(256),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  ),
  displayName: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
  status: Schema.Literals(["ready", "missing", "unreadable", "symlink", "not-directory"]),
  skillCount: NonNegativeInt,
  watching: Schema.Boolean,
});
export type SkillRootStatus = typeof SkillRootStatus.Type;
export const SkillFolderSelection = Schema.Struct({ folderPath: SkillFolderPath });
export type SkillFolderSelection = typeof SkillFolderSelection.Type;

/**
 * Two same-named skills were both on where one thread would see both, and the
 * host kept the Project's copy and turned the other off.
 */
export const ProjectSkillInUse = Schema.Struct({
  name: Schema.Trimmed.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
  used: SourceQualifiedSkillId,
  gaveWay: SourceQualifiedSkillId,
});
export type ProjectSkillInUse = typeof ProjectSkillInUse.Type;

export const ExtensionSnapshot = Schema.Struct({
  sequence: GlobalSequence,
  snapshotAt: UtcTimestamp,
  packages: Schema.Array(ExtensionPackageState).check(Schema.isMaxLength(4096)),
  skills: Schema.optional(Schema.Array(StandaloneSkillRecord).check(Schema.isMaxLength(4096))),
  skillRoots: Schema.optional(Schema.Array(SkillRootStatus).check(Schema.isMaxLength(34))),
  collisions: Schema.Array(ExtensionSkillCollision).check(Schema.isMaxLength(4096)),
  /** Absent when the host chose no Project copy over another skill. */
  projectSkillsInUse: Schema.optional(
    Schema.Array(ProjectSkillInUse).check(Schema.isMaxLength(4096)),
  ),
});
export type ExtensionSnapshot = typeof ExtensionSnapshot.Type;

export const ExtensionEffectiveSnapshot = Schema.Struct({
  sequence: GlobalSequence,
  snapshotAt: UtcTimestamp,
  scope: ExtensionActivationScope,
  catalogEpoch: ExtensionCatalogEpoch,
  catalogStatus: Schema.Literals(["available", "offline"]),
  stale: Schema.Boolean,
  packages: Schema.Array(ExtensionEffectivePackageState).check(Schema.isMaxLength(4096)),
  collisions: Schema.Array(ExtensionSkillCollision).check(Schema.isMaxLength(4096)),
});
export type ExtensionEffectiveSnapshot = typeof ExtensionEffectiveSnapshot.Type;

export const ExtensionCatalogEntry = Schema.Struct({
  extensionId: ToolExtensionId,
  packageId: ExtensionPackageId,
  slug: ExtensionSlug,
  displayName: boundedText(128),
  version: ExtensionPackageVersion,
  digest: ExtensionContentDigest,
  source: ExtensionSource,
});
export type ExtensionCatalogEntry = typeof ExtensionCatalogEntry.Type;

export const MAX_SKILL_PREVIEW_INSTRUCTIONS_LENGTH = 128 * 1024;

/**
 * A file inside the package, named by its package-relative path: never an
 * absolute path, a `.` or `..` segment, or a backslash, so the review names
 * what the package holds and nothing about where this host keeps it.
 */
const PackageRelativePath = Schema.String.check(
  Schema.isMaxLength(1024),
  Schema.makeFilter(
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
});
export type ExtensionPackageReviewLanguageServer = typeof ExtensionPackageReviewLanguageServer.Type;
export const decodeExtensionPackageReviewLanguageServer = Schema.decodeUnknownSync(
  ExtensionPackageReviewLanguageServer,
  STRICT_DECODE_OPTIONS,
);

/**
 * What a person reviews before a debug adapter can run: the binary the host
 * will start, that file's own digest, the runtimes it labels, the `launch`
 * body it sends with its placeholders, whether it takes a debug port, and
 * whether it also debugs the child processes of the program it starts.
 */
export const ExtensionPackageReviewDebugAdapter = Schema.Struct({
  runtimes: ExtensionDebugAdapterDeclaration.fields.runtimes,
  launchArguments: ExtensionDebugAdapterDeclaration.fields.launchArguments,
  importTypes: ExtensionDebugAdapterDeclaration.fields.importTypes,
  debugPorts: ExtensionDebugAdapterDeclaration.fields.debugPorts,
  childSessions: ExtensionDebugAdapterDeclaration.fields.childSessions,
  childAnnouncement: ExtensionDebugAdapterDeclaration.fields.childAnnouncement,
  binary: PackageRelativePath,
  binaryDigest: ExtensionContentDigest,
});
export type ExtensionPackageReviewDebugAdapter = typeof ExtensionPackageReviewDebugAdapter.Type;
export const decodeExtensionPackageReviewDebugAdapter = Schema.decodeUnknownSync(
  ExtensionPackageReviewDebugAdapter,
  STRICT_DECODE_OPTIONS,
);

export const ExtensionPackageReviewComponent = Schema.Struct({
  id: ExtensionComponentId,
  kind: ExtensionComponentKind,
  displayName: boundedText(128),
  declaredCapabilities: Schema.Array(ExtensionCapability).check(Schema.isMaxLength(32)),
  instructions: Schema.optional(boundedText(MAX_SKILL_PREVIEW_INSTRUCTIONS_LENGTH)),
  languageServer: Schema.optional(ExtensionPackageReviewLanguageServer),
  debugAdapter: Schema.optional(ExtensionPackageReviewDebugAdapter),
});
export type ExtensionPackageReviewComponent = typeof ExtensionPackageReviewComponent.Type;

export const ExtensionPackageReview = Schema.Struct({
  description: Schema.optional(boundedText(4096)),
  provenance: ExtensionProvenance,
  license: ExtensionLicense,
  compatibility: ExtensionCompatibility,
  declaredCapabilities: Schema.Array(ExtensionCapability).check(Schema.isMaxLength(32)),
  components: Schema.Array(ExtensionPackageReviewComponent).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
  ),
});
export type ExtensionPackageReview = typeof ExtensionPackageReview.Type;

export const ExtensionPackagePreview = Schema.Struct({
  entry: ExtensionCatalogEntry,
  review: ExtensionPackageReview,
  diagnostics: Schema.Array(ExtensionDiagnostic).check(Schema.isMaxLength(128)),
});
export type ExtensionPackagePreview = typeof ExtensionPackagePreview.Type;

export const SkillMarketplaceEntry = Schema.Struct({
  skill: SourceQualifiedSkill,
  source: ExtensionSource,
  version: ExtensionPackageVersion,
  displayName: boundedText(128),
  description: Schema.optional(boundedText(2048)),
  provenance: ExtensionProvenance,
});
export type SkillMarketplaceEntry = typeof SkillMarketplaceEntry.Type;

export const SkillPackagePreview = Schema.Struct({
  entry: SkillMarketplaceEntry,
  extensionId: ToolExtensionId,
  packageId: ExtensionPackageId,
  license: ExtensionLicense,
  instructions: Schema.optional(boundedText(MAX_SKILL_PREVIEW_INSTRUCTIONS_LENGTH)),
  diagnostics: Schema.Array(ExtensionDiagnostic).check(Schema.isMaxLength(128)),
});
export type SkillPackagePreview = typeof SkillPackagePreview.Type;

export const ExtensionCommandFailure = Schema.Struct({
  category: Schema.Literals([
    "invalid",
    "unauthorized",
    "blocked",
    "stale",
    "unavailable",
    "interrupted",
    "waiting",
    "failed",
  ]),
  message: boundedText(1024).check(
    Schema.makeFilter(
      (message) => !message.includes("/") && !message.includes("\\") && !message.includes("\0"),
    ),
  ),
});
export type ExtensionCommandFailure = typeof ExtensionCommandFailure.Type;

export const ExtensionCommandResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("catalog-search-results"),
    entries: Schema.Array(ExtensionCatalogEntry).check(Schema.isMaxLength(256)),
    nextCursor: Schema.optional(opaqueCursor),
  }),
  Schema.Struct({
    kind: Schema.Literal("skill-search-results"),
    entries: Schema.Array(SkillMarketplaceEntry).check(Schema.isMaxLength(256)),
    nextCursor: Schema.optional(opaqueCursor),
  }),
  Schema.Struct({
    kind: Schema.Literal("skill-package-preview"),
    preview: SkillPackagePreview,
  }),
  Schema.Struct({
    kind: Schema.Literal("package-preview"),
    preview: ExtensionPackagePreview,
  }),
  Schema.Struct({
    kind: Schema.Literal("package-inspected"),
    preview: ExtensionPackagePreview,
  }),
  Schema.Struct({
    kind: Schema.Literal("npm-update-checked"),
    extensionId: ToolExtensionId,
    installedVersion: ExtensionPackageVersion,
    /** The newest version the registry offers, when it is newer than the installed one. */
    available: Schema.optional(ExtensionPackageVersion),
  }),
  Schema.Struct({
    kind: Schema.Literal("extension-state-updated"),
    snapshot: ExtensionSnapshot,
    /**
     * Set only when the one install-trust-enable flow stopped early: the step
     * the host refused. The steps before it stand, as the snapshot shows.
     */
    stoppedAt: Schema.optional(Schema.Literals(["trust", "enable"])),
    /** Set only when the update was a user-added server: the package that add created. */
    addedPackage: Schema.optional(
      Schema.Struct({
        extensionId: ToolExtensionId,
        componentId: Schema.optional(ExtensionComponentId),
      }),
    ),
  }),
  Schema.Struct({
    kind: Schema.Literal("extension-effective-state"),
    snapshot: ExtensionEffectiveSnapshot,
  }),
  Schema.Struct({
    kind: Schema.Literal("extension-command-failed"),
    failure: ExtensionCommandFailure,
  }),
]);
export type ExtensionCommandResult = typeof ExtensionCommandResult.Type;

export const decodeExtensionCommand = Schema.decodeUnknownSync(
  ExtensionCommand,
  STRICT_DECODE_OPTIONS,
);
export const decodeExtensionSnapshot = Schema.decodeUnknownSync(
  ExtensionSnapshot,
  STRICT_DECODE_OPTIONS,
);
export const decodeExtensionEffectiveStateQuery = Schema.decodeUnknownSync(
  ExtensionEffectiveStateQuery,
  STRICT_DECODE_OPTIONS,
);
export const decodeExtensionEffectiveSnapshot = Schema.decodeUnknownSync(
  ExtensionEffectiveSnapshot,
  STRICT_DECODE_OPTIONS,
);
export const decodeExtensionCommandResult = Schema.decodeUnknownSync(
  ExtensionCommandResult,
  STRICT_DECODE_OPTIONS,
);
export const decodeExtensionCommandFailure = Schema.decodeUnknownSync(
  ExtensionCommandFailure,
  STRICT_DECODE_OPTIONS,
);
export const decodeExtensionToolApproval = Schema.decodeUnknownSync(
  ExtensionToolApproval,
  STRICT_DECODE_OPTIONS,
);
export const decodeExtensionToolApprovalList = Schema.decodeUnknownSync(
  ExtensionToolApprovalList,
  STRICT_DECODE_OPTIONS,
);
export const decodeExtensionToolApprovalDecision = Schema.decodeUnknownSync(
  ExtensionToolApprovalDecision,
  STRICT_DECODE_OPTIONS,
);
export const decodeExtensionToolGrant = Schema.decodeUnknownSync(
  ExtensionToolGrant,
  STRICT_DECODE_OPTIONS,
);
export const decodeExtensionToolGrantList = Schema.decodeUnknownSync(
  ExtensionToolGrantList,
  STRICT_DECODE_OPTIONS,
);
export const decodeExtensionToolGrantRequest = Schema.decodeUnknownSync(
  ExtensionToolGrantRequest,
  STRICT_DECODE_OPTIONS,
);
