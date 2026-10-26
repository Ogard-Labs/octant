import { Schema } from "effect";
import { CodeCheckoutId, CodeFileId, CodeRelativePath, CodeThreadId } from "./code";

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

export const CodeLanguageReadRequest = Schema.Union(
  Schema.Struct({ kind: Schema.Literal("diagnostics"), ...scope }).annotations(strict),
  Schema.Struct({
    kind: Schema.Literal("definition"),
    ...scope,
    position: CodeLanguagePosition,
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
  path: CodeRelativePath,
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
    path: CodeRelativePath,
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

export const CodeLanguageReadResult = Schema.Union(
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
 * whose protocol frame would still pass the server's frame cap is answered
 * `too-large` instead of being sent.
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
    path: CodeRelativePath,
    text: documentText,
  }).annotations(strict),
  Schema.Struct({ kind: Schema.Literal("change"), ...scope, text: documentText }).annotations(
    strict,
  ),
  Schema.Struct({ kind: Schema.Literal("close"), ...scope }).annotations(strict),
);
export type CodeLanguageDocumentRequest = typeof CodeLanguageDocumentRequest.Type;

export const CodeLanguageDocumentResult = Schema.Union(
  Schema.Struct({ status: Schema.Literal("synced"), ...scope }).annotations(strict),
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

export const decodeCodeLanguageReadRequest = Schema.decodeUnknownSync(CodeLanguageReadRequest);
export const decodeCodeLanguageReadResult = Schema.decodeUnknownSync(CodeLanguageReadResult);
export const decodeCodeLanguageDocumentRequest = Schema.decodeUnknownSync(
  CodeLanguageDocumentRequest,
);
export const decodeCodeLanguageDocumentResult = Schema.decodeUnknownSync(
  CodeLanguageDocumentResult,
);
