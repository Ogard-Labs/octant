import { Schema } from "effect";
import { CodeCheckoutId, CodeFileId, CodeProjectFilePath, CodeThreadId, CodeDigest } from "./code";
import { ProjectId } from "./projects";
import type { ProviderToolDefinition } from "./providers";

/**
 * Language reads for one file of a Code thread: diagnostics and
 * go-to-definition, answered by a confined language server the host runs for
 * the thread's checkout. Canonical: docs/design/language-services.md.
 *
 * These are Octant's own shapes. Language Server Protocol payloads stop at
 * the server's adapter, so a renderer never sees a URI or a protocol field it
 * did not ask for. Every structured path is checkout-relative. A diagnostic
 * message is the server's free text and can name a host path (TypeScript's
 * "Cannot read file '/Users/…/tsconfig.base.json'"), so the adapter rewrites
 * those before building a result; the schema cannot. Results are ephemeral
 * reads, never journaled.
 */

const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const MAX_CODE_LANGUAGE_DIAGNOSTICS = 1_000;
export const MAX_CODE_LANGUAGE_DIAGNOSTIC_MESSAGE_LENGTH = 2_048;
export const MAX_CODE_LANGUAGE_DEFINITION_TARGETS = 64;
export const MAX_CODE_LANGUAGE_REFERENCES = 1_000;
export const MAX_CODE_LANGUAGE_REFERENCE_FILES = 64;
const MAX_POSITION = 2_147_483_647;

const scope = { threadId: CodeThreadId, checkoutId: CodeCheckoutId, fileId: CodeFileId };

/** Zero-based line and UTF-16 character offset, as the editor counts them. */
export const CodeLanguagePosition = Schema.Struct({
  line: Schema.Int.pipe(Schema.between(0, MAX_POSITION)),
  character: Schema.Int.pipe(Schema.between(0, MAX_POSITION)),
}).annotations(strict);
export type CodeLanguagePosition = typeof CodeLanguagePosition.Type;

export const CodeLanguageRange = Schema.Struct({
  start: CodeLanguagePosition,
  end: CodeLanguagePosition,
})
  .annotations(strict)
  .pipe(
    Schema.filter(
      ({ start, end }) =>
        end.line > start.line || (end.line === start.line && end.character >= start.character),
    ),
  );
export type CodeLanguageRange = typeof CodeLanguageRange.Type;

export const CodeLanguageEditFile = Schema.Struct({
  path: CodeProjectFilePath,
  fileId: CodeFileId,
  identity: Schema.Struct({
    device: Schema.NonEmptyTrimmedString,
    inode: Schema.NonEmptyTrimmedString,
  }),
  digest: CodeDigest,
  before: Schema.String.pipe(Schema.maxLength(256 * 1024)),
  after: Schema.String.pipe(Schema.maxLength(256 * 1024)),
}).annotations(strict);
export type CodeLanguageEditFile = typeof CodeLanguageEditFile.Type;

export const CodeLanguageEditPreview = Schema.Struct({
  title: Schema.String.pipe(Schema.maxLength(256)),
  files: Schema.Array(CodeLanguageEditFile).pipe(Schema.maxItems(16)),
}).annotations(strict);
export type CodeLanguageEditPreview = typeof CodeLanguageEditPreview.Type;

export const CodeIntelligenceFeature = Schema.Literal(
  "completion",
  "hover",
  "signature",
  "symbols",
  "formatting",
);
export type CodeIntelligenceFeature = typeof CodeIntelligenceFeature.Type;
export const CodeIntelligenceItem = Schema.Struct({
  label: Schema.String.pipe(Schema.maxLength(512)),
  text: Schema.optional(Schema.String.pipe(Schema.maxLength(16_384))),
  detail: Schema.optional(Schema.String.pipe(Schema.maxLength(8_192))),
  kind: Schema.optional(Schema.Int.pipe(Schema.between(1, 26))),
  range: Schema.optional(CodeLanguageRange),
  parameters: Schema.optional(
    Schema.Array(Schema.String.pipe(Schema.maxLength(512))).pipe(Schema.maxItems(64)),
  ),
}).annotations(strict);
export type CodeIntelligenceItem = typeof CodeIntelligenceItem.Type;
export const CodeIntelligenceAnswer = Schema.Struct({
  status: Schema.Literal("intelligence"),
  feature: CodeIntelligenceFeature,
  ...scope,
  documentVersion: Schema.Int.pipe(Schema.positive()),
  documentRevision: Schema.UUID,
  items: Schema.Array(CodeIntelligenceItem).pipe(Schema.maxItems(256)),
  activeSignature: Schema.optional(Schema.Int.pipe(Schema.between(0, 255))),
  activeParameter: Schema.optional(Schema.Int.pipe(Schema.between(0, 63))),
  truncated: Schema.Boolean,
}).annotations(strict);
export type CodeIntelligenceAnswer = typeof CodeIntelligenceAnswer.Type;

export const CodeLanguageReadRequest = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("intelligence"),
    feature: CodeIntelligenceFeature,
    formatting: Schema.optional(
      Schema.Struct({
        tabSize: Schema.Int.pipe(Schema.between(1, 8)),
        insertSpaces: Schema.Boolean,
      }).annotations(strict),
    ),
    ...scope,
    position: CodeLanguagePosition,
    expectedVersion: Schema.Int.pipe(Schema.positive()),
    expectedRevision: Schema.UUID,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("rename"),
    ...scope,
    position: CodeLanguagePosition,
    newName: Schema.NonEmptyTrimmedString.pipe(
      Schema.maxLength(256),
      Schema.filter((name) => !name.includes("\r") && !name.includes("\n") && !name.includes("\0")),
    ),
    expectedVersion: Schema.Int.pipe(Schema.positive()),
    expectedRevision: Schema.UUID,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("quick-fixes"),
    ...scope,
    position: CodeLanguagePosition,
    expectedVersion: Schema.Int.pipe(Schema.positive()),
    expectedRevision: Schema.UUID,
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("diagnostics"), ...scope }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("definition"),
    ...scope,
    position: CodeLanguagePosition,
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("capabilities"), ...scope }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("references"),
    ...scope,
    position: CodeLanguagePosition,
    includeDeclaration: Schema.Boolean,
    expectedVersion: Schema.Int.pipe(Schema.positive()),
    expectedRevision: Schema.UUID,
  }).annotations(strict),
);
export type CodeLanguageReadRequest = typeof CodeLanguageReadRequest.Type;

export const CodeLanguageDiagnosticSeverity = Schema.Literal(
  "error",
  "warning",
  "information",
  "hint",
);
export type CodeLanguageDiagnosticSeverity = typeof CodeLanguageDiagnosticSeverity.Type;

export const CodeLanguageDiagnostic = Schema.Struct({
  path: CodeProjectFilePath,
  range: CodeLanguageRange,
  severity: CodeLanguageDiagnosticSeverity,
  message: Schema.String.pipe(Schema.maxLength(MAX_CODE_LANGUAGE_DIAGNOSTIC_MESSAGE_LENGTH)),
  /**
   * The label the server gives its diagnostics, such as `typescript`. A label
   * is a name, never a location, so a path separator is refused.
   */
  source: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(64), Schema.pattern(/^[^/\\]+$/)),
}).annotations(strict);
export type CodeLanguageDiagnostic = typeof CodeLanguageDiagnostic.Type;

/**
 * Where a definition lives. A target inside the checkout, `node_modules`
 * included, is an ordinary location. Anything else carries only a label: the
 * person learns a definition exists, never where on the host it is or what it
 * says.
 */
export const CodeLanguageDefinitionTarget = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("checkout-location"),
    path: CodeProjectFilePath,
    range: CodeLanguageRange,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("outside-checkout"),
    label: Schema.Literal("bundled-library", "elsewhere"),
  }).annotations(strict),
);
export type CodeLanguageDefinitionTarget = typeof CodeLanguageDefinitionTarget.Type;

/**
 * Why a read is refused. Authority reasons come first; the last group is the
 * launch policy's (`@octant/domain` language-server launch policy), carried
 * unchanged. A component that is installed but not effective reads as
 * `no-language-server`, since a disabled component contributes nothing.
 */
export const CodeLanguageRefusalReason = Schema.Literal(
  "thread-inactive",
  "checkout-unavailable",
  "checkout-mismatch",
  "file-outside-thread",
  "path-outside-checkout",
  "no-reach",
  "turned-off",
  "no-language-server",
  "confinement-unavailable",
  "unsupported-platform",
  "plan-read-only",
  "local-host-required",
  "approval-required",
);
export type CodeLanguageRefusalReason = typeof CodeLanguageRefusalReason.Type;

/** A state the person can wait out or retry, not a refusal. */
export const CodeLanguageUnavailableReason = Schema.Literal("starting", "crashed", "timed-out");
export type CodeLanguageUnavailableReason = typeof CodeLanguageUnavailableReason.Type;

export const CodeLanguageReferenceSupport = Schema.Literal("supported", "unsupported", "unknown");
export type CodeLanguageReferenceSupport = typeof CodeLanguageReferenceSupport.Type;

export const CodeLanguageReadResult = Schema.Union(
  CodeIntelligenceAnswer,
  Schema.Struct({
    status: Schema.Literal("capabilities"),
    ...scope,
    references: CodeLanguageReferenceSupport,
    rename: Schema.optional(CodeLanguageReferenceSupport),
    quickFixes: Schema.optional(CodeLanguageReferenceSupport),
    intelligence: Schema.optional(Schema.Array(CodeIntelligenceFeature).pipe(Schema.maxItems(5))),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("edit-previews"),
    ...scope,
    documentVersion: Schema.Int.pipe(Schema.positive()),
    documentRevision: Schema.UUID,
    previews: Schema.Array(CodeLanguageEditPreview).pipe(Schema.maxItems(16)),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("edit-unavailable"),
    reason: Schema.Literal("unsafe-edit", "unsaved-edits", "invalid-edit", "too-large"),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("references"),
    ...scope,
    documentVersion: Schema.Int.pipe(Schema.positive()),
    documentRevision: Schema.UUID,
    targets: Schema.Array(CodeLanguageDefinitionTarget).pipe(
      Schema.maxItems(MAX_CODE_LANGUAGE_REFERENCES),
      Schema.filter(
        (targets) =>
          new Set(
            targets
              .filter((target) => target.kind === "checkout-location")
              .map((target) => target.path),
          ).size <= MAX_CODE_LANGUAGE_REFERENCE_FILES,
      ),
    ),
    truncated: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("unsupported"),
    capability: Schema.Literal("references", "rename", "quick-fixes", "intelligence"),
    support: Schema.Literal("unsupported", "unknown"),
  }).annotations(strict),
  Schema.Struct({ status: Schema.Literal("stale") }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("diagnostics"),
    ...scope,
    diagnostics: Schema.Array(CodeLanguageDiagnostic).pipe(
      Schema.maxItems(MAX_CODE_LANGUAGE_DIAGNOSTICS),
    ),
    truncated: Schema.Boolean,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("definition"),
    ...scope,
    targets: Schema.Array(CodeLanguageDefinitionTarget).pipe(
      Schema.maxItems(MAX_CODE_LANGUAGE_DEFINITION_TARGETS),
    ),
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: CodeLanguageUnavailableReason,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: CodeLanguageRefusalReason,
  }).annotations(strict),
);
export type CodeLanguageReadResult = typeof CodeLanguageReadResult.Type;

/**
 * The longest document text the editor may hand the language server, in
 * UTF-16 code units: the editor's own bound on an editable file. A document
 * within it whose protocol frame would still exceed the server's frame cap is
 * answered `too-large` instead of being sent.
 */
export const MAX_CODE_LANGUAGE_DOCUMENT_TEXT_LENGTH = 5 * 1024 * 1024;

const documentText = Schema.String.pipe(Schema.maxLength(MAX_CODE_LANGUAGE_DOCUMENT_TEXT_LENGTH));

/**
 * What the editor has open, so the server analyses the person's text rather
 * than only the saved file. `open` is the one request that names a file by
 * path: a checkout-relative path the host confines, from which it derives the
 * file reference every later request uses. A read names only that reference,
 * and a reference with no open document belongs to no file the server holds.
 * Text lives in memory for as long as the document is open and is never
 * written to disk.
 */
export const CodeLanguageDocumentRequest = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal("open"),
    threadId: CodeThreadId,
    checkoutId: CodeCheckoutId,
    path: CodeProjectFilePath,
    text: documentText,
  }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("change"),
    ...scope,
    text: documentText,
    expectedRevision: Schema.optional(Schema.UUID),
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("close"), ...scope }).annotations(strict),
);
export type CodeLanguageDocumentRequest = typeof CodeLanguageDocumentRequest.Type;

export const CodeLanguageDocumentResult = Schema.Union(
  Schema.Struct({ status: Schema.Literal("stale") }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("synced"),
    ...scope,
    // Older hosts may omit it; new cross-file reads require a known version.
    documentVersion: Schema.optional(Schema.Int.pipe(Schema.positive())),
    documentRevision: Schema.optional(Schema.UUID),
  }).annotations(strict),
  /** The text is past the server's frame cap, so it is not sent. */
  Schema.Struct({ status: Schema.Literal("too-large"), ...scope }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    reason: CodeLanguageUnavailableReason,
  }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: CodeLanguageRefusalReason,
  }).annotations(strict),
);
export type CodeLanguageDocumentResult = typeof CodeLanguageDocumentResult.Type;

/**
 * The agent-facing language reads: one tool, `octant_code`, with an
 * operation, as every Octant capability family is (`code-language` in the
 * closed tool catalog). An agent names a file by its checkout-relative path,
 * as its other file tools do, and never by a file reference: it holds no
 * editor document. Lines and columns are one-based, as the agent's file reads
 * and searches number them; the host converts them to the zero-based
 * positions above. A column counts UTF-16 code units, as the editor does.
 */
export const CODE_LANGUAGE_TOOL_NAME = "octant_code";

/**
 * The most places one agent `references` read returns. The editor's bound is
 * larger, but a tool result has to fit the provider's result budget whole,
 * and a name used more often than this is better narrowed by a search.
 */
export const MAX_CODE_LANGUAGE_AGENT_REFERENCES = 200;

const OneBased = Schema.Int.pipe(Schema.between(1, MAX_POSITION));

export const CodeLanguageToolArguments = Schema.Union(
  Schema.Struct({
    operation: Schema.Literal("diagnostics"),
    path: CodeProjectFilePath,
  }).annotations(strict),
  Schema.Struct({
    operation: Schema.Literal("definition"),
    path: CodeProjectFilePath,
    line: OneBased,
    column: OneBased,
  }).annotations(strict),
  Schema.Struct({
    operation: Schema.Literal("references"),
    path: CodeProjectFilePath,
    line: OneBased,
    column: OneBased,
    includeDeclaration: Schema.optional(Schema.Boolean),
  }).annotations(strict),
);
export type CodeLanguageToolArguments = typeof CodeLanguageToolArguments.Type;

export const decodeCodeLanguageToolArguments = Schema.decodeUnknownSync(CodeLanguageToolArguments);

/**
 * Every operation answers for the file as saved on disk, so its lines match
 * what the agent's own file reads show. It reads; it never changes a file.
 */
export const CODE_LANGUAGE_TOOL_DEFINITION: ProviderToolDefinition = {
  name: CODE_LANGUAGE_TOOL_NAME,
  description: `Ask the language server about a saved file of this checkout. It reads the file with the Project's own configuration and the checkout's other files. diagnostics: the file's errors and warnings. definition: where the name at line and column is defined. references: every place the name at line and column is used across the checkout, at most ${MAX_CODE_LANGUAGE_AGENT_REFERENCES}; truncated says when there are more. Lines and columns are one-based. A place outside the checkout is named only by a label. Read-only, and allowed in Plan.`,
  inputSchema: {
    type: "object",
    properties: {
      operation: { type: "string", enum: ["diagnostics", "definition", "references"] },
      path: {
        type: "string",
        description:
          "A file of this thread's checkout, relative to its root, such as src/index.ts.",
      },
      line: { type: "integer", minimum: 1, description: "For definition and references." },
      column: {
        type: "integer",
        minimum: 1,
        description: "For definition and references, in UTF-16 code units, as editors count.",
      },
      includeDeclaration: {
        type: "boolean",
        description: "For references: also list the declaration itself. Off by default.",
      },
    },
    required: ["operation", "path"],
  },
};

/**
 * How far a person's approval of a `repo-tooling` server reaches: the one
 * checkout the editor's file is in, or every checkout of the Code Project.
 */
export const CodeLanguageApprovalScope = Schema.Literal("checkout", "project");
export type CodeLanguageApprovalScope = typeof CodeLanguageApprovalScope.Type;

/**
 * A person at a local window approves the server that would read this file
 * to run the repository's tooling. It names the file by path, as `open` does,
 * because a server that needs an approval never opened the document; the host
 * confines the path and picks the server from it, never from the request.
 */
export const CodeLanguageApprovalRequest = Schema.Struct({
  threadId: CodeThreadId,
  checkoutId: CodeCheckoutId,
  path: CodeProjectFilePath,
  scope: CodeLanguageApprovalScope,
}).annotations(strict);
export type CodeLanguageApprovalRequest = typeof CodeLanguageApprovalRequest.Type;

export const CodeLanguageApprovalResult = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("approved"),
    threadId: CodeThreadId,
    checkoutId: CodeCheckoutId,
    scope: CodeLanguageApprovalScope,
  }).annotations(strict),
  /** The server that reads this file is `static`: it falls in no approval category. */
  Schema.Struct({ status: Schema.Literal("not-required") }).annotations(strict),
  Schema.Struct({
    status: Schema.Literal("refused"),
    reason: CodeLanguageRefusalReason,
  }).annotations(strict),
  /** The journal did not take the approval, so it is not in force. */
  Schema.Struct({ status: Schema.Literal("not-recorded") }).annotations(strict),
);
export type CodeLanguageApprovalResult = typeof CodeLanguageApprovalResult.Type;

/**
 * Approvals are journaled on their Project's aggregate. A `repo-tooling`
 * server's egress records use the payloads harness launches use
 * (`@octant/contracts` tool egress), on one aggregate per launch, so a
 * language server's connections are audited exactly as a `proxied` command's
 * are while the thread egress store, which taints and proposes from its own
 * records, never reads them.
 */
export const CODE_LANGUAGE_SERVER_APPROVAL_AGGREGATE = "code-language-server-approval";
export const CODE_LANGUAGE_SERVER_EGRESS_AGGREGATE = "code-language-server-egress";
export const CODE_LANGUAGE_SERVER_EVENT_NAMES = {
  approvalGranted: "code.language-server-approval-granted@1",
  egressLaunchStarted: "code.language-server-egress-launch-started@1",
  egressDecisionsRecorded: "code.language-server-egress-decisions-recorded@1",
  egressLaunchSummarized: "code.language-server-egress-launch-summarized@1",
} as const;

/**
 * The shell-command approval for one server. `component` names the reviewed
 * package state the person approved (its extension, component, digest, and
 * lifecycle version), so an update, a switch, or a change of trust is a new
 * question rather than an approval carried over. It names no thread: the
 * approval is the checkout's or the Project's, and a thread purge leaves it.
 */
export const CodeLanguageServerApprovalGranted = Schema.Struct({
  approvalId: Schema.UUID,
  projectId: ProjectId,
  approvalClass: Schema.Literal("shell-commands"),
  component: Schema.NonEmptyTrimmedString.pipe(Schema.maxLength(512)),
  scope: Schema.Union(
    Schema.Struct({ kind: Schema.Literal("checkout"), checkoutId: CodeCheckoutId }).annotations(
      strict,
    ),
    Schema.Struct({ kind: Schema.Literal("project") }).annotations(strict),
  ),
}).annotations(strict);
export type CodeLanguageServerApprovalGranted = typeof CodeLanguageServerApprovalGranted.Type;

export const decodeCodeLanguageApprovalRequest = Schema.decodeUnknownSync(
  CodeLanguageApprovalRequest,
);
export const decodeCodeLanguageApprovalResult = Schema.decodeUnknownSync(
  CodeLanguageApprovalResult,
);
export const decodeCodeLanguageServerApprovalGranted = Schema.decodeUnknownSync(
  CodeLanguageServerApprovalGranted,
);
export const decodeCodeLanguageReadRequest = Schema.decodeUnknownSync(CodeLanguageReadRequest);
export const decodeCodeLanguageReadResult = Schema.decodeUnknownSync(CodeLanguageReadResult);
export const decodeCodeLanguageDocumentRequest = Schema.decodeUnknownSync(
  CodeLanguageDocumentRequest,
);
export const decodeCodeLanguageDocumentResult = Schema.decodeUnknownSync(
  CodeLanguageDocumentResult,
);
