import type {
  CodeLanguageDefinitionTarget,
  CodeLanguageDiagnostic,
  CodeLanguagePosition,
  CodeLanguageRange,
  CodeLanguageRefusalReason,
} from "@octant/contracts/code-language";
import type {
  MonacoDefinitionLink,
  MonacoEditorMarker,
  MonacoEditorPosition,
  MonacoEditorRange,
} from "./MonacoEditorAdapter";

/**
 * The editor's view of the host's language services for one open file:
 * Octant contracts in, Monaco's one-based shapes out. Canonical:
 * docs/design/language-services.md (editor wiring).
 *
 * The host counts lines from zero and characters in UTF-16 code units, and
 * Monaco counts both from one in the same units, so a position moves by one
 * on each axis and nothing else.
 */

/** What the editor shows about the language server serving one file. */
export type CodeLanguageEditorState =
  /** No server reads this file, or this client cannot ask: Monaco's own services stay. */
  | { readonly kind: "inactive" }
  | { readonly kind: "starting" }
  | { readonly kind: "ready"; readonly problems: number; readonly truncated: boolean }
  /** The person turned the server off in Settings › Code. */
  | { readonly kind: "off" }
  | { readonly kind: "unsupported-platform" }
  | { readonly kind: "refused"; readonly reason: CodeLanguageRefusalReason }
  /** Past its crash budget; opening the file again is the retry. */
  | { readonly kind: "crashed" }
  | { readonly kind: "timed-out" }
  /** Too large to hand the server; Monaco's own services stay. */
  | { readonly kind: "too-large" };

export function toEditorRange(range: CodeLanguageRange): MonacoEditorRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

export function toLanguagePosition(position: MonacoEditorPosition): CodeLanguagePosition {
  return {
    line: Math.max(0, position.lineNumber - 1),
    character: Math.max(0, position.column - 1),
  };
}

/**
 * Markers for the file in this editor. A diagnostic about another file is
 * that file's to show, so it is left out here rather than drawn on the wrong
 * lines.
 */
export function toEditorMarkers(
  diagnostics: ReadonlyArray<CodeLanguageDiagnostic>,
  path: string,
): ReadonlyArray<MonacoEditorMarker> {
  return diagnostics
    .filter((diagnostic) => diagnostic.path === path)
    .map((diagnostic) => ({
      range: toEditorRange(diagnostic.range),
      severity: diagnostic.severity,
      message: diagnostic.message,
      source: diagnostic.source,
    }));
}

/**
 * Where each definition target sends the person. A location in this file is
 * revealed in place, one elsewhere in the checkout opens that file, and one
 * outside the checkout carries only its label, which the editor turns into a
 * notice because the host never says where it is.
 */
export function toDefinitionLinks(
  targets: ReadonlyArray<CodeLanguageDefinitionTarget>,
  path: string,
): ReadonlyArray<MonacoDefinitionLink> {
  return targets.map((target) => {
    if (target.kind === "outside-checkout") return { kind: "outside", label: target.label };
    const range = toEditorRange(target.range);
    return target.path === path
      ? { kind: "this-file", range }
      : { kind: "other-file", path: target.path, range };
  });
}

/** The state a refusal puts the editor in. */
export function refusedState(reason: CodeLanguageRefusalReason): CodeLanguageEditorState {
  switch (reason) {
    case "turned-off":
      return { kind: "off" };
    case "unsupported-platform":
      return { kind: "unsupported-platform" };
    // A file no server declares is an ordinary file, not a failure to report.
    case "no-language-server":
      return { kind: "inactive" };
    default:
      return { kind: "refused", reason };
  }
}

const REFUSAL_TEXT: Readonly<Record<CodeLanguageRefusalReason, string>> = {
  "thread-inactive": "this thread is no longer active",
  "checkout-unavailable": "the checkout is unavailable",
  "checkout-mismatch": "the thread moved to another checkout",
  "file-outside-thread": "the host no longer holds this file open",
  "path-outside-checkout": "the file resolves outside the checkout",
  "no-reach": "this window cannot reach the thread",
  "turned-off": "they are off in Settings › Code",
  "no-language-server": "no language server reads this file",
  "confinement-unavailable": "the host cannot confine a language server",
  "unsupported-platform": "this host's platform is not supported",
  "plan-read-only": "Plan threads are read-only",
  "local-host-required": "only the host's own windows can start this server",
  "approval-required": "this server needs an approval first",
};

/** The status line for a state, or nothing when there is nothing to say. */
export function languageStatusText(state: CodeLanguageEditorState): string | undefined {
  switch (state.kind) {
    case "inactive":
      return undefined;
    case "starting":
      return "Language services are starting…";
    case "ready":
      if (state.problems === 0) return "No problems found";
      return `${state.problems.toLocaleString()} ${state.problems === 1 ? "problem" : "problems"}${
        state.truncated ? " (first 1,000 shown)" : ""
      }`;
    case "off":
      return "Language services are off. Turn them on in Settings › Code.";
    case "unsupported-platform":
      return "Language services are not available on this host's platform.";
    case "refused":
      return `Language services are unavailable: ${REFUSAL_TEXT[state.reason]}.`;
    case "crashed":
      return "The language server stopped.";
    case "timed-out":
      return "The language server did not answer in time.";
    case "too-large":
      return "This file is too large for language services.";
  }
}

export function outsideCheckoutNotice(label: "bundled-library" | "elsewhere"): string {
  return label === "bundled-library"
    ? "The definition is in the language server's bundled library, outside this checkout."
    : "The definition is outside this checkout.";
}
