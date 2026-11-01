import { Schema } from "effect";
import { CodeCheckoutId, CodeProjectFilePath, CodeThreadId } from "./code";
import {
  ExtensionComponentId,
  ExtensionContentDigest,
  ExtensionPackageVersion,
  ToolExtensionId,
} from "./extensionIdentity";
import { ExtensionComponentQualifiedId, ExtensionDebugRuntimeId } from "./extensions";
import { ProjectId } from "./projects";

/**
 * Debug configurations for a Code thread: Octant's own record of what a debug
 * session runs. Canonical: docs/design/language-services.md § Debug
 * configurations.
 *
 * A configuration is never another product's launch file and is never written
 * back to the repository. A repository file only proposes one; the person
 * confirms it at a local window, and the host keeps the confirmed record with
 * its approval. Every path is checkout-relative, contained again with symlinks
 * resolved when the configuration is confirmed and at every start.
 */

const strict = { parseOptions: { onExcessProperty: "error" as const } };
const textEncoder = new TextEncoder();

export const MAX_CODE_DEBUG_CONFIGURATION_NAME_LENGTH = 128;
export const MAX_CODE_DEBUG_ARGUMENTS = 64;
export const MAX_CODE_DEBUG_ARGUMENT_BYTES = 1_024;
export const MAX_CODE_DEBUG_ENVIRONMENT_ENTRIES = 32;
export const MAX_CODE_DEBUG_ENVIRONMENT_VALUE_BYTES = 1_024;
export const MAX_CODE_DEBUG_UNUSED_FIELDS = 64;
export const MAX_CODE_DEBUG_UNUSED_FIELD_LENGTH = 128;

/**
 * Credential variables the host keeps from every child it starts: provider
 * keys and tokens, and the GitHub tokens its own `gh` reads, the enterprise
 * ones included. A configuration may not name one, so a value typed or
 * imported under that name never reads as the host's credential, and Octant
 * never has to decide whether to pass it.
 */
export const HOST_CREDENTIAL_ENVIRONMENT_KEYS = [
  "AI_GATEWAY_API_KEY",
  "AIROUTER_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_OAUTH_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AZURE_OPENAI_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLINE_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "CODEX_API_KEY",
  "DEEPSEEK_API_KEY",
  "GEMINI_API_KEY",
  "GH_ENTERPRISE_TOKEN",
  "GH_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GITHUB_TOKEN",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "MOONSHOT_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "Z_AI_API_KEY",
] as const;
const hostCredentialKeys: ReadonlySet<string> = new Set(HOST_CREDENTIAL_ENVIRONMENT_KEYS);

const boundedBytes = (maximumBytes: number) =>
  Schema.String.pipe(
    Schema.filter(
      (value) => !value.includes("\0") && textEncoder.encode(value).byteLength <= maximumBytes,
    ),
  );

/**
 * An environment variable name a configuration may set. `OCTANT_` names, in
 * any case, are Octant's own and never reach a session.
 */
export const CodeDebugEnvironmentKey = Schema.String.pipe(
  Schema.pattern(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
  Schema.filter(
    (key) => !key.toUpperCase().startsWith("OCTANT_") && !hostCredentialKeys.has(key.toUpperCase()),
  ),
  Schema.brand("CodeDebugEnvironmentKey"),
);
export type CodeDebugEnvironmentKey = typeof CodeDebugEnvironmentKey.Type;

export const CodeDebugEnvironmentEntry = Schema.Struct({
  key: CodeDebugEnvironmentKey,
  value: boundedBytes(MAX_CODE_DEBUG_ENVIRONMENT_VALUE_BYTES),
}).annotations(strict);
export type CodeDebugEnvironmentEntry = typeof CodeDebugEnvironmentEntry.Type;

export const CodeDebugConfigurationName = Schema.NonEmptyTrimmedString.pipe(
  Schema.maxLength(MAX_CODE_DEBUG_CONFIGURATION_NAME_LENGTH),
);
export type CodeDebugConfigurationName = typeof CodeDebugConfigurationName.Type;

/**
 * What a debug session runs. `adapter` names an installed `debug-adapter`
 * component. `program` and `cwd` are checkout-relative; an absent `cwd` is the
 * checkout's root. The `launch` request is the only one Octant sends, so the
 * record has no `request` field.
 */
export const CodeDebugConfiguration = Schema.Struct({
  name: CodeDebugConfigurationName,
  adapter: ExtensionComponentQualifiedId,
  program: CodeProjectFilePath,
  args: Schema.Array(boundedBytes(MAX_CODE_DEBUG_ARGUMENT_BYTES)).pipe(
    Schema.maxItems(MAX_CODE_DEBUG_ARGUMENTS),
  ),
  cwd: Schema.optional(CodeProjectFilePath),
  env: Schema.Array(CodeDebugEnvironmentEntry).pipe(
    Schema.maxItems(MAX_CODE_DEBUG_ENVIRONMENT_ENTRIES),
    Schema.filter((entries) => new Set(entries.map((entry) => entry.key)).size === entries.length),
  ),
  stopOnEntry: Schema.Boolean,
}).annotations(strict);
export type CodeDebugConfiguration = typeof CodeDebugConfiguration.Type;

/** The SHA-256 digest of one confirmed configuration, which its approval covers. */
export const CodeDebugConfigurationDigest = Schema.String.pipe(
  Schema.pattern(/^sha256:[a-f0-9]{64}$/),
  Schema.brand("CodeDebugConfigurationDigest"),
);
export type CodeDebugConfigurationDigest = typeof CodeDebugConfigurationDigest.Type;

/**
 * Why a debug session does not start, in the order the host checks. The
 * thread and checkout checks a language read makes come first, then whether
 * the configuration's adapter is effective in Code (one that is installed but
 * not reviewed or switched on reads the same as none); the launch
 * decision's reasons (`@octant/domain` debug session start policy) follow
 * unchanged; `confinement-unavailable` is last, so nothing launches until all
 * pass.
 */
export const CodeDebugStartRefusalReason = Schema.Literal(
  "no-reach",
  "thread-inactive",
  "checkout-mismatch",
  "checkout-unavailable",
  "no-debug-adapter",
  "unsupported-platform",
  "mode-prohibited",
  "plan-read-only",
  "local-host-required",
  "approval-required",
  "configuration-invalid",
  "confinement-unavailable",
);
export type CodeDebugStartRefusalReason = typeof CodeDebugStartRefusalReason.Type;

/**
 * Why an entry of an imported launch file proposes nothing. `not-launch`:
 * its request is not `launch`. `no-adapter` and `adapter-ambiguous`: its
 * `type` matches no effective adapter, or more than one. `unsupported-variable`:
 * it uses a variable outside the closed set. `needs-open-file`: it uses a
 * current-file variable with no file open. `outside-checkout`: its program or
 * folder resolves outside the checkout. `invalid`: a mapped value is missing,
 * of the wrong type, or out of bounds.
 */
export const CodeDebugImportUnmappableReason = Schema.Literal(
  "not-launch",
  "no-adapter",
  "adapter-ambiguous",
  "unsupported-variable",
  "needs-open-file",
  "outside-checkout",
  "invalid",
);
export type CodeDebugImportUnmappableReason = typeof CodeDebugImportUnmappableReason.Type;

/**
 * One entry of a repository launch file, as Octant would run it. A proposal
 * runs nothing until the person confirms it. `unusedFields` names every field
 * the entry holds that Octant does not use, so the person sees what the file
 * asked for and Octant will not do.
 */
export const CodeDebugConfigurationProposal = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("proposed"),
    configuration: CodeDebugConfiguration,
    unusedFields: Schema.Array(
      Schema.String.pipe(Schema.minLength(1), Schema.maxLength(MAX_CODE_DEBUG_UNUSED_FIELD_LENGTH)),
    ).pipe(Schema.maxItems(MAX_CODE_DEBUG_UNUSED_FIELDS)),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("unmappable"),
    name: Schema.optional(CodeDebugConfigurationName),
    reason: CodeDebugImportUnmappableReason,
  }).annotations(strict),
);
export type CodeDebugConfigurationProposal = typeof CodeDebugConfigurationProposal.Type;

export const decodeCodeDebugConfiguration = Schema.decodeUnknownSync(CodeDebugConfiguration);
export const decodeCodeDebugConfigurationProposal = Schema.decodeUnknownSync(
  CodeDebugConfigurationProposal,
);

/*
 * The session host. Canonical: docs/design/language-services.md § Approval
 * and starting, § Protocol, § Debugger data and privacy.
 *
 * These are Octant's own shapes: Debug Adapter Protocol payloads stop at the
 * host's adapter connection. Every structured path is checkout-relative, and
 * lines and columns are one-based, as the editor numbers them. Values a
 * stopped program holds (variables, stack frames, output, evaluated results,
 * fetched sources) are answered to the window that asked and never journaled.
 */

export const MAX_CODE_DEBUG_FRAMES = 200;
export const MAX_CODE_DEBUG_VARIABLES = 200;
export const MAX_CODE_DEBUG_NAME_LENGTH = 256;
export const MAX_CODE_DEBUG_VALUE_LENGTH = 4_096;
export const MAX_CODE_DEBUG_SOURCE_LENGTH = 1_048_576;
export const MAX_CODE_DEBUG_OUTPUT_TEXT_LENGTH = 65_536;
export const MAX_CODE_DEBUG_OUTPUT_ENTRIES = 512;
export const MAX_CODE_DEBUG_EXPRESSION_BYTES = 4_096;
export const MAX_CODE_DEBUG_MESSAGE_LENGTH = 2_048;
export const MAX_CODE_DEBUG_BREAKPOINT_FILES = 64;
export const MAX_CODE_DEBUG_BREAKPOINTS_PER_FILE = 256;
export const MAX_CODE_DEBUG_APPROVED_CONFIGURATIONS = 256;
/** A session debugs at most this many of its program's children at once. */
export const MAX_CODE_DEBUG_CHILDREN_AT_ONCE = 8;
/** And at most this many over its life; later announcements run undebugged. */
export const MAX_CODE_DEBUG_CHILDREN_PER_SESSION = 32;
const MAX_LINE = 2_147_483_647;
/** DAP references and identifiers are non-negative 32-bit integers. */
const MAX_REFERENCE = 2_147_483_647;

const boundedText = (maximum: number) => Schema.String.pipe(Schema.maxLength(maximum));
const DebugReference = Schema.Int.pipe(Schema.between(0, MAX_REFERENCE));
const DebugLine = Schema.Int.pipe(Schema.between(1, MAX_LINE));

/** Where a confirmation applies: this checkout, or every checkout of the thread's Project. */
export const CodeDebugApprovalScope = Schema.Literal("checkout", "project");
export type CodeDebugApprovalScope = typeof CodeDebugApprovalScope.Type;

/** Names one debug session, and its egress launch, across the journal. */
export const CodeDebugSessionId = Schema.UUID.pipe(Schema.brand("CodeDebugSessionId"));
export type CodeDebugSessionId = typeof CodeDebugSessionId.Type;

/**
 * Names one child process a session debugs: its place in the order the
 * session attached its children, from 1. Canonical:
 * docs/design/language-services.md § Child processes.
 */
export const CodeDebugChildId = Schema.Int.pipe(
  Schema.between(1, MAX_CODE_DEBUG_CHILDREN_PER_SESSION),
  Schema.brand("CodeDebugChildId"),
);
export type CodeDebugChildId = typeof CodeDebugChildId.Type;

/**
 * Why a session ended. `stopped` is the person's Stop; `program-exited` the
 * adapter reporting the program done; `adapter-exited` the adapter ending on
 * its own; `protocol-violation` a frame over the cap or one that is not a
 * frame; `start-failed` a session that never reached its program. The rest
 * are the authority changes that end a session at once, and the host's own
 * stop: `host-shutdown` when it stops cleanly, `host-restarted` for a session
 * a previous run left open.
 */
export const CodeDebugSessionEndReason = Schema.Literal(
  "stopped",
  "program-exited",
  "adapter-exited",
  "protocol-violation",
  "start-failed",
  "thread-inactive",
  "plan-read-only",
  "network-changed",
  "checkout-unavailable",
  "approval-ended",
  "project-erased",
  "host-shutdown",
  "host-restarted",
);
export type CodeDebugSessionEndReason = typeof CodeDebugSessionEndReason.Type;

/**
 * Journal records. A configuration's approval lives on its Project's
 * aggregate; each session's start and end on an aggregate of its own; each
 * session's egress records, which use the payloads a `proxied` harness
 * launch uses with the session's id as the launch id, on another.
 */
export const CODE_DEBUG_CONFIGURATION_AGGREGATE = "code-debug-configuration";
export const CODE_DEBUG_SESSION_AGGREGATE = "code-debug-session";
export const CODE_DEBUG_EGRESS_AGGREGATE = "code-debug-egress";
export const CODE_DEBUG_EVENT_NAMES = {
  configurationApproved: "code.debug-configuration-approved@1",
  sessionStarted: "code.debug-session-started@1",
  sessionEnded: "code.debug-session-ended@1",
  egressLaunchStarted: "code.debug-egress-launch-started@1",
  egressDecisionsRecorded: "code.debug-egress-decisions-recorded@1",
  egressLaunchSummarized: "code.debug-egress-launch-summarized@1",
} as const;

/** One adapter in one reviewed package state: what a confirmation covers. */
export const CodeDebugAdapterPackageState = Schema.Struct({
  extensionId: ToolExtensionId,
  componentId: ExtensionComponentId,
  packageDigest: ExtensionContentDigest,
  lifecycleVersion: Schema.Int.pipe(Schema.nonNegative()),
}).annotations(strict);
export type CodeDebugAdapterPackageState = typeof CodeDebugAdapterPackageState.Type;

/**
 * A person's confirmation of one configuration, in the `shell-commands`
 * approval class. It holds the configuration itself, because it is the
 * record of what the person allowed to run; it names no thread, so a thread
 * purge leaves it and a Project erase removes it.
 */
export const CodeDebugConfigurationApproved = Schema.Struct({
  approvalId: Schema.UUID,
  projectId: ProjectId,
  approvalClass: Schema.Literal("shell-commands"),
  configurationDigest: CodeDebugConfigurationDigest,
  configuration: CodeDebugConfiguration,
  adapter: CodeDebugAdapterPackageState,
  scope: Schema.Union(
    Schema.Struct({ kind: Schema.Literal("checkout"), checkoutId: CodeCheckoutId }).annotations(
      strict,
    ),
    Schema.Struct({ kind: Schema.Literal("project") }).annotations(strict),
  ),
}).annotations(strict);
export type CodeDebugConfigurationApproved = typeof CodeDebugConfigurationApproved.Type;

/** A session's lifecycle names its Project, thread, and configuration, and nothing it showed. */
export const CodeDebugSessionStarted = Schema.Struct({
  sessionId: CodeDebugSessionId,
  projectId: ProjectId,
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  configurationDigest: CodeDebugConfigurationDigest,
  network: Schema.Literal("proxied", "allow"),
}).annotations(strict);
export type CodeDebugSessionStarted = typeof CodeDebugSessionStarted.Type;

export const CodeDebugSessionEnded = Schema.Struct({
  sessionId: CodeDebugSessionId,
  projectId: ProjectId,
  threadId: CodeThreadId,
  configurationDigest: CodeDebugConfigurationDigest,
  endReason: CodeDebugSessionEndReason,
  /** How many child processes the session attached over its life, as a count only. */
  childSessions: Schema.optional(
    Schema.Int.pipe(Schema.between(0, MAX_CODE_DEBUG_CHILDREN_PER_SESSION)),
  ),
}).annotations(strict);
export type CodeDebugSessionEnded = typeof CodeDebugSessionEnded.Type;

const threadScope = { threadId: CodeThreadId, checkoutId: CodeCheckoutId };

/**
 * What the Run and debug panel lists: the effective adapters, the
 * configurations an approval on record covers here with the adapter as it
 * stands, and what the repository's launch file proposes. The file is read
 * only for this answer and never run, written, or watched.
 */
export const CodeDebugConfigurationsRequest = Schema.Struct({
  ...threadScope,
  /** The editor's current file, which a launch file's current-file variables name. */
  currentFile: Schema.optional(CodeProjectFilePath),
}).annotations(strict);
export type CodeDebugConfigurationsRequest = typeof CodeDebugConfigurationsRequest.Type;

export const CodeDebugAdapterSummary = Schema.Struct({
  adapter: ExtensionComponentQualifiedId,
  displayName: boundedText(128),
  runtimes: Schema.Array(ExtensionDebugRuntimeId).pipe(Schema.maxItems(8)),
  /**
   * The installed package as Settings names it, and its version, so the
   * confirmation card says which adapter it allows when two share a name.
   */
  packageName: boundedText(128),
  packageVersion: ExtensionPackageVersion,
}).annotations(strict);
export type CodeDebugAdapterSummary = typeof CodeDebugAdapterSummary.Type;

export const CodeDebugApprovedConfiguration = Schema.Struct({
  configurationDigest: CodeDebugConfigurationDigest,
  configuration: CodeDebugConfiguration,
  scope: CodeDebugApprovalScope,
}).annotations(strict);
export type CodeDebugApprovedConfiguration = typeof CodeDebugApprovedConfiguration.Type;

export const CodeDebugLaunchFileReading = Schema.Union(
  Schema.Struct({ status: Schema.Literal("absent") }).annotations(strict),
  /** Not JSON with comments, past 256 KiB, or holding no configuration list. */
  Schema.Struct({ status: Schema.Literal("unreadable") }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("read"),
    proposals: Schema.Array(CodeDebugConfigurationProposal).pipe(Schema.maxItems(64)),
    truncated: Schema.Boolean,
  }).annotations(strict),
);
export type CodeDebugLaunchFileReading = typeof CodeDebugLaunchFileReading.Type;

/** Every refusal a debug request can answer, in the order the host checks. */
export const CodeDebugRefusalReason = Schema.Union(
  CodeDebugStartRefusalReason,
  /** The session named is not this thread's running session. */
  Schema.Literal("no-session"),
);
export type CodeDebugRefusalReason = typeof CodeDebugRefusalReason.Type;

const refused = Schema.Struct({
  status: Schema.Literal("refused"),
  reason: CodeDebugRefusalReason,
}).annotations(strict);

export const CodeDebugConfigurationsResult = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("listed"),
    adapters: Schema.Array(CodeDebugAdapterSummary).pipe(Schema.maxItems(64)),
    approved: Schema.Array(CodeDebugApprovedConfiguration).pipe(
      Schema.maxItems(MAX_CODE_DEBUG_APPROVED_CONFIGURATIONS),
    ),
    launchFile: CodeDebugLaunchFileReading,
  }).annotations(strict),
  refused,
);
export type CodeDebugConfigurationsResult = typeof CodeDebugConfigurationsResult.Type;

/** The person at a local window confirms one configuration for a checkout or a Project. */
export const CodeDebugApprovalRequest = Schema.Struct({
  ...threadScope,
  configuration: CodeDebugConfiguration,
  scope: CodeDebugApprovalScope,
}).annotations(strict);
export type CodeDebugApprovalRequest = typeof CodeDebugApprovalRequest.Type;

export const CodeDebugApprovalResult = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("approved"),
    configurationDigest: CodeDebugConfigurationDigest,
    scope: CodeDebugApprovalScope,
  }).annotations(strict),
  refused,
  /** The journal did not take the confirmation, so it is not in force. */
  Schema.Struct({ status: Schema.Literal("not-recorded") }).annotations(strict),
);
export type CodeDebugApprovalResult = typeof CodeDebugApprovalResult.Type;

export const CodeDebugBreakpoint = Schema.Struct({
  line: DebugLine,
  condition: Schema.optional(boundedBytes(MAX_CODE_DEBUG_EXPRESSION_BYTES)),
}).annotations(strict);
export type CodeDebugBreakpoint = typeof CodeDebugBreakpoint.Type;

/** One file's breakpoints, the window's state for the thread. */
export const CodeDebugFileBreakpoints = Schema.Struct({
  path: CodeProjectFilePath,
  breakpoints: Schema.Array(CodeDebugBreakpoint).pipe(
    Schema.maxItems(MAX_CODE_DEBUG_BREAKPOINTS_PER_FILE),
  ),
}).annotations(strict);
export type CodeDebugFileBreakpoints = typeof CodeDebugFileBreakpoints.Type;

/** A person's Start, with the window's breakpoints for the thread. */
export const CodeDebugStartRequest = Schema.Struct({
  ...threadScope,
  configuration: CodeDebugConfiguration,
  breakpoints: Schema.Array(CodeDebugFileBreakpoints).pipe(
    Schema.maxItems(MAX_CODE_DEBUG_BREAKPOINT_FILES),
  ),
}).annotations(strict);
export type CodeDebugStartRequest = typeof CodeDebugStartRequest.Type;

export const CodeDebugStartResult = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("started"),
    sessionId: CodeDebugSessionId,
  }).annotations(strict),
  refused,
  /**
   * The thread already holds a session (the panel asks to stop it first), or
   * this host already runs as many sessions as it allows.
   */
  Schema.Struct({
    status: Schema.Literal("busy"),
    reason: Schema.Literal("thread-has-session", "host-limit"),
  }).annotations(strict),
  /**
   * Nothing runs. `adapter-unverified`: the stored adapter no longer matches
   * the digest the person reviewed. `launch-failed`: the capsule, its
   * receipt, its egress, or its start record could not be made.
   * `adapter-refused`: the adapter answered `initialize` or `launch` with an
   * error, or not in time.
   */
  Schema.Struct({
    status: Schema.Literal("failed"),
    reason: Schema.Literal("adapter-unverified", "launch-failed", "adapter-refused"),
  }).annotations(strict),
);
export type CodeDebugStartResult = typeof CodeDebugStartResult.Type;

const programThread = { programThreadId: DebugReference };

/** What the panel asks a running session. Each maps to one request on Octant's closed list. */
export const CodeDebugSessionRequest = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("state"),
    /** The last output sequence the window holds; only later output is answered. */
    afterOutput: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("set-breakpoints"),
    file: CodeDebugFileBreakpoints,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("set-exception-breakpoints"),
    filters: Schema.Array(boundedText(128)).pipe(Schema.maxItems(16)),
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("threads") }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("stack-trace"),
    ...programThread,
    startFrame: Schema.optional(DebugReference),
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("scopes"), frameId: DebugReference }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("variables"),
    variablesReference: DebugReference,
    start: Schema.optional(DebugReference),
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("source"),
    sourceReference: DebugReference,
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("exception-info"), ...programThread }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("continue", "next", "step-in", "step-out", "pause"),
    ...programThread,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("evaluate"),
    /** Only an expression the person typed, or a watch they added. */
    expression: boundedBytes(MAX_CODE_DEBUG_EXPRESSION_BYTES).pipe(Schema.minLength(1)),
    frameId: Schema.optional(DebugReference),
    context: Schema.Literal("repl", "watch", "hover"),
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("stop") }).annotations(strict),
);
export type CodeDebugSessionRequest = typeof CodeDebugSessionRequest.Type;

export const CodeDebugSessionCall = Schema.Struct({
  ...threadScope,
  sessionId: CodeDebugSessionId,
  /**
   * The session's child the request is for; absent for the program the
   * session started. Breakpoints reach the program and every child whichever
   * is named, and `stop` on a child ends that child only.
   */
  child: Schema.optional(CodeDebugChildId),
  request: CodeDebugSessionRequest,
}).annotations(strict);
export type CodeDebugSessionCall = typeof CodeDebugSessionCall.Type;

export const CodeDebugExceptionFilter = Schema.Struct({
  filter: boundedText(128),
  label: boundedText(MAX_CODE_DEBUG_NAME_LENGTH),
  default: Schema.Boolean,
}).annotations(strict);
export type CodeDebugExceptionFilter = typeof CodeDebugExceptionFilter.Type;

export const CodeDebugSessionState = Schema.Union(
  Schema.Struct({ status: Schema.Literal("starting") }).annotations(strict),
  Schema.Struct({ status: Schema.Literal("running") }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("stopped"),
    ...programThread,
    reason: boundedText(64),
    description: Schema.optional(boundedText(MAX_CODE_DEBUG_MESSAGE_LENGTH)),
    allThreadsStopped: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("ended"),
    endReason: CodeDebugSessionEndReason,
    exitCode: Schema.optional(Schema.Int),
  }).annotations(strict),
);
export type CodeDebugSessionState = typeof CodeDebugSessionState.Type;

/** A child process the session debugs now, as the panel lists it under the session. */
export const CodeDebugChildSummary = Schema.Struct({
  child: CodeDebugChildId,
  name: boundedText(MAX_CODE_DEBUG_NAME_LENGTH),
  status: Schema.Literal("starting", "running", "stopped"),
}).annotations(strict);
export type CodeDebugChildSummary = typeof CodeDebugChildSummary.Type;

export const CodeDebugOutputEntry = Schema.Struct({
  sequence: Schema.Int.pipe(Schema.positive()),
  category: Schema.Literal("console", "stdout", "stderr", "important"),
  text: boundedText(MAX_CODE_DEBUG_OUTPUT_TEXT_LENGTH),
}).annotations(strict);
export type CodeDebugOutputEntry = typeof CodeDebugOutputEntry.Type;

/**
 * Where a frame's code is: a checkout file, or outside the checkout with a
 * label and no path. `adapter-source` is code the adapter can hand over by
 * reference; Octant opens no file outside the checkout itself.
 */
export const CodeDebugSourceLocation = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("checkout"),
    path: CodeProjectFilePath,
    line: DebugLine,
    column: DebugLine,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("outside-checkout"),
    label: Schema.Literal("elsewhere", "adapter-source"),
    sourceReference: Schema.optional(DebugReference),
    line: Schema.optional(DebugLine),
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("none") }).annotations(strict),
);
export type CodeDebugSourceLocation = typeof CodeDebugSourceLocation.Type;

export const CodeDebugStackFrame = Schema.Struct({
  id: DebugReference,
  name: boundedText(MAX_CODE_DEBUG_NAME_LENGTH),
  location: CodeDebugSourceLocation,
}).annotations(strict);
export type CodeDebugStackFrame = typeof CodeDebugStackFrame.Type;

export const CodeDebugScope = Schema.Struct({
  name: boundedText(MAX_CODE_DEBUG_NAME_LENGTH),
  variablesReference: DebugReference,
  expensive: Schema.Boolean,
}).annotations(strict);
export type CodeDebugScope = typeof CodeDebugScope.Type;

/** A value cut at 4 KiB says so; `variablesReference` above zero expands it. */
export const CodeDebugVariable = Schema.Struct({
  name: boundedText(MAX_CODE_DEBUG_NAME_LENGTH),
  value: boundedText(MAX_CODE_DEBUG_VALUE_LENGTH),
  truncated: Schema.Boolean,
  type: Schema.optional(boundedText(MAX_CODE_DEBUG_NAME_LENGTH)),
  variablesReference: DebugReference,
}).annotations(strict);
export type CodeDebugVariable = typeof CodeDebugVariable.Type;

export const CodeDebugSessionResult = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("state"),
    state: CodeDebugSessionState,
    /** Moves whenever the adapter reports a change the panel should read again. */
    revision: Schema.Int.pipe(Schema.nonNegative()),
    exceptionFilters: Schema.Array(CodeDebugExceptionFilter).pipe(Schema.maxItems(16)),
    output: Schema.Array(CodeDebugOutputEntry).pipe(Schema.maxItems(MAX_CODE_DEBUG_OUTPUT_ENTRIES)),
    /** Output past `afterOutput` the ring no longer holds, or more than one answer carries. */
    outputDropped: Schema.Boolean,
    /**
     * The children the session debugs now, whichever the request named;
     * present when the adapter declares children. `state`, `revision`, and
     * `exceptionFilters` are those of the child the request named.
     */
    children: Schema.optional(
      Schema.Array(CodeDebugChildSummary).pipe(Schema.maxItems(MAX_CODE_DEBUG_CHILDREN_AT_ONCE)),
    ),
    /** Children the adapter announced past either bound, which ran undebugged. */
    undebuggedChildren: Schema.optional(Schema.Int.pipe(Schema.nonNegative())),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("breakpoints"),
    breakpoints: Schema.Array(
      Schema.Struct({
        verified: Schema.Boolean,
        line: Schema.optional(DebugLine),
      }).annotations(strict),
    ).pipe(Schema.maxItems(MAX_CODE_DEBUG_BREAKPOINTS_PER_FILE)),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("threads"),
    threads: Schema.Array(
      Schema.Struct({
        id: DebugReference,
        name: boundedText(MAX_CODE_DEBUG_NAME_LENGTH),
      }).annotations(strict),
    ).pipe(Schema.maxItems(MAX_CODE_DEBUG_FRAMES)),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("stack"),
    frames: Schema.Array(CodeDebugStackFrame).pipe(Schema.maxItems(MAX_CODE_DEBUG_FRAMES)),
    truncated: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("scopes"),
    scopes: Schema.Array(CodeDebugScope).pipe(Schema.maxItems(MAX_CODE_DEBUG_VARIABLES)),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("variables"),
    variables: Schema.Array(CodeDebugVariable).pipe(Schema.maxItems(MAX_CODE_DEBUG_VARIABLES)),
    truncated: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("source"),
    text: boundedText(MAX_CODE_DEBUG_SOURCE_LENGTH),
    truncated: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("exception"),
    exceptionId: boundedText(MAX_CODE_DEBUG_NAME_LENGTH),
    description: Schema.optional(boundedText(MAX_CODE_DEBUG_MESSAGE_LENGTH)),
    breakMode: boundedText(64),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("evaluated"),
    result: CodeDebugVariable,
  }).annotations(strict),
  /** The adapter accepted a step, a continue, a pause, or exception filters. */
  Schema.Struct({ status: Schema.Literal("done") }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("ended"),
    endReason: CodeDebugSessionEndReason,
  }).annotations(strict),
  refused,
  /**
   * The adapter did not answer: `timed-out` after the request deadline,
   * `failed` with its own message (host paths rewritten), `ended` because the
   * session ended before it answered.
   */
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: Schema.Literal("timed-out", "failed", "ended"),
    message: Schema.optional(boundedText(MAX_CODE_DEBUG_MESSAGE_LENGTH)),
  }).annotations(strict),
);
export type CodeDebugSessionResult = typeof CodeDebugSessionResult.Type;

export const decodeCodeDebugConfigurationApproved = Schema.decodeUnknownSync(
  CodeDebugConfigurationApproved,
);
export const decodeCodeDebugSessionStarted = Schema.decodeUnknownSync(CodeDebugSessionStarted);
export const decodeCodeDebugSessionEnded = Schema.decodeUnknownSync(CodeDebugSessionEnded);
export const decodeCodeDebugConfigurationDigest = Schema.decodeUnknownSync(
  CodeDebugConfigurationDigest,
);
export const decodeCodeDebugSessionId = Schema.decodeUnknownSync(CodeDebugSessionId);
export const decodeCodeDebugChildId = Schema.decodeUnknownSync(CodeDebugChildId);
export const decodeCodeDebugConfigurationsRequest = Schema.decodeUnknownSync(
  CodeDebugConfigurationsRequest,
);
export const decodeCodeDebugConfigurationsResult = Schema.decodeUnknownSync(
  CodeDebugConfigurationsResult,
);
export const decodeCodeDebugApprovalRequest = Schema.decodeUnknownSync(CodeDebugApprovalRequest);
export const decodeCodeDebugApprovalResult = Schema.decodeUnknownSync(CodeDebugApprovalResult);
export const decodeCodeDebugStartRequest = Schema.decodeUnknownSync(CodeDebugStartRequest);
export const decodeCodeDebugStartResult = Schema.decodeUnknownSync(CodeDebugStartResult);
export const decodeCodeDebugSessionCall = Schema.decodeUnknownSync(CodeDebugSessionCall);
export const decodeCodeDebugSessionResult = Schema.decodeUnknownSync(CodeDebugSessionResult);
