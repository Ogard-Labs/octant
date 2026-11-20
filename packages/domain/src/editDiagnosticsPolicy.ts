import type { CodeLanguageDiagnostic } from "@octant/contracts/code-language";

/**
 * Formatting and bounds for language-server errors attached to Octant Harness
 * edit results (`write`, `edit`, `editFiles`). Canonical:
 * docs/design/language-services.md § Agent read rules.
 */

/** Maximum time an edit tool waits for language-server diagnostics after writing. */
export const EDIT_DIAGNOSTICS_TIMEOUT_MS = 3_500;

/** Maximum number of errors listed for one edited file. */
export const MAX_EDIT_DIAGNOSTIC_ERRORS = 5;

/** Maximum character length of one error message in an edit result. */
export const MAX_EDIT_DIAGNOSTIC_MESSAGE_LENGTH = 200;

/** Collapses multi-line whitespace and bounds a diagnostic message to 200 characters. */
export function truncateEditDiagnosticMessage(message: string): string {
  const singleLine = message.replace(/\s+/g, " ").trim();
  if (singleLine.length <= MAX_EDIT_DIAGNOSTIC_MESSAGE_LENGTH) return singleLine;
  let cut = singleLine.slice(0, MAX_EDIT_DIAGNOSTIC_MESSAGE_LENGTH - 1);
  // Never end on half of a UTF-16 surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * Formats one edited file's language-server diagnostics for the edit result:
 * errors only, up to five `path:line:col message` lines (one-based positions,
 * messages bounded to 200 characters) followed by `and N more`, or
 * `No errors in <file>` when a server answered with no errors.
 */
export function formatEditDiagnostics(
  filePath: string,
  diagnostics: ReadonlyArray<CodeLanguageDiagnostic>,
): string {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  if (errors.length === 0) return `No errors in ${filePath}`;
  const lines = errors.slice(0, MAX_EDIT_DIAGNOSTIC_ERRORS).map((diagnostic) => {
    const line = diagnostic.range.start.line + 1;
    const column = diagnostic.range.start.character + 1;
    const displayPath = filePath.length > 0 ? filePath : diagnostic.path;
    return `${displayPath}:${line}:${column} ${truncateEditDiagnosticMessage(diagnostic.message)}`;
  });
  if (errors.length > MAX_EDIT_DIAGNOSTIC_ERRORS) {
    lines.push(`and ${errors.length - MAX_EDIT_DIAGNOSTIC_ERRORS} more`);
  }
  return lines.join("\n");
}
