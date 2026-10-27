import { fileURLToPath } from "node:url";
import { isAbsolute, normalize, relative, sep } from "node:path";
import {
  MAX_CODE_LANGUAGE_DEFINITION_TARGETS,
  MAX_CODE_LANGUAGE_DIAGNOSTIC_MESSAGE_LENGTH,
  MAX_CODE_LANGUAGE_DIAGNOSTICS,
  type CodeLanguageDefinitionTarget,
  type CodeLanguageDiagnostic,
  type CodeLanguageDiagnosticSeverity,
  type CodeLanguageRange,
} from "@octant/contracts/code-language";
import { decodeCodeRelativePath, type CodeRelativePath } from "@octant/contracts";
import { classifyPathContainment } from "@octant/domain";

/**
 * Language Server Protocol results turned into Octant's read contracts.
 * Canonical: docs/design/language-services.md § Seam and launch decision.
 *
 * A server's answer is data from a program reading the repository, so nothing
 * in it is trusted to stay inside the checkout. Locations are resolved and
 * contained: inside the checkout they become checkout-relative, inside the
 * server's own install they become `bundled-library`, and anything else is
 * `elsewhere` with no path. Messages are free text, so every host path or
 * `file:` URI in one is rewritten the same way before it leaves the host.
 */

export const OUTSIDE_CHECKOUT_TEXT = "<outside checkout>";

export interface LanguageServerResultRoots {
  /** The canonical checkout root the server was launched on. */
  readonly checkoutRoot: string;
  /** The server's own install, read-only; definitions there are its bundled library. */
  readonly installRoot: string;
}

const MAX_POSITION = 2_147_483_647;
const SEVERITIES: Readonly<Record<number, CodeLanguageDiagnosticSeverity>> = {
  1: "error",
  2: "warning",
  3: "information",
  4: "hint",
};

/**
 * One alternation, so a rewritten span is never scanned again:
 *
 * - A quoted span that starts like a path is one path, spaces included. The
 *   TypeScript server quotes the paths it names, and a checkout under a folder
 *   such as `My Projects` otherwise left `Projects/...` behind in the text.
 * - A `file:` URI in any letter case, with or without `//`.
 * - An absolute path (optionally `~`-relative) that is not the tail of a word,
 *   a relative path, an alias such as `@/x`, or a URL. A path straight after a
 *   `:` (`error:/home/...`) is still one; `://` is a URL.
 *
 * Quotes, brackets, whitespace, `,`, and `;` end the unquoted forms, and a
 * bare path also ends at the `:` compiler output puts before a line number.
 * An unquoted path with a space in it is cut at the space; the part after it
 * stays as written.
 */
const HOST_PATH_PATTERN =
  /(['"`])((?:file:|~?\/)[^'"`\r\n]+)\1|(?<!\w)file:[^\s'"`<>()[\]{},;]+|(?:(?<=:)(?!\/\/)|(?<![\w.~\-/:@+%\\]))~?\/[^\s'"`<>()[\]{},;:]+/gi;

export function rewriteHostPaths(message: string, checkoutRoot: string): string {
  return message.replace(
    HOST_PATH_PATTERN,
    (match: string, quote: string | undefined, quoted: string | undefined) => {
      if (quote !== undefined && quoted !== undefined) {
        return `${quote}${hostPathText(quoted, checkoutRoot)}${quote}`;
      }
      // A sentence that ends on a path keeps its full stop outside the path.
      const trimmed = match.replace(/\.+$/, "");
      const trailing = match.slice(trimmed.length);
      return `${hostPathText(trimmed, checkoutRoot)}${trailing}`;
    },
  );
}

function hostPathText(match: string, checkoutRoot: string): string {
  if (match.startsWith("~")) return OUTSIDE_CHECKOUT_TEXT;
  let path: string;
  if (/^file:/i.test(match)) {
    try {
      path = fileURLToPath(match);
    } catch {
      return OUTSIDE_CHECKOUT_TEXT;
    }
  } else {
    path = match;
  }
  // Text is judged by where it points, not followed: nothing is read here.
  const normalized = normalize(path);
  if (classifyPathContainment(checkoutRoot, normalized) !== "contained") {
    return OUTSIDE_CHECKOUT_TEXT;
  }
  const inside = relative(checkoutRoot, normalized).split(sep).join("/");
  return inside === "" ? "." : inside;
}

export function boundedDiagnosticMessage(message: string, checkoutRoot: string): string {
  const rewritten = rewriteHostPaths(message, checkoutRoot);
  if (rewritten.length <= MAX_CODE_LANGUAGE_DIAGNOSTIC_MESSAGE_LENGTH) return rewritten;
  let cut = rewritten.slice(0, MAX_CODE_LANGUAGE_DIAGNOSTIC_MESSAGE_LENGTH - 1);
  // Never end on half of a surrogate pair.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

export function toDiagnostics(input: {
  readonly items: ReadonlyArray<unknown>;
  readonly path: CodeRelativePath;
  readonly checkoutRoot: string;
  readonly defaultSource: string;
}): { readonly diagnostics: ReadonlyArray<CodeLanguageDiagnostic>; readonly truncated: boolean } {
  const diagnostics: CodeLanguageDiagnostic[] = [];
  let truncated = false;
  for (const item of input.items) {
    if (!isRecord(item) || typeof item.message !== "string") continue;
    const range = toRange(item.range);
    if (range === undefined) continue;
    if (diagnostics.length === MAX_CODE_LANGUAGE_DIAGNOSTICS) {
      truncated = true;
      break;
    }
    diagnostics.push({
      path: input.path,
      range,
      severity:
        typeof item.severity === "number" ? (SEVERITIES[item.severity] ?? "error") : "error",
      message: boundedDiagnosticMessage(item.message, input.checkoutRoot),
      source: sourceLabel(item.source, input.defaultSource),
    });
  }
  return { diagnostics, truncated };
}

/**
 * A definition answer is a Location, an array of Locations, or an array of
 * LocationLinks. Each target is placed by its resolved path, so a symlink
 * inside the checkout that leads out of it is reported as `elsewhere`.
 */
export async function toDefinitionTargets(input: {
  readonly result: unknown;
  readonly roots: LanguageServerResultRoots;
  readonly realpath: (path: string) => Promise<string>;
}): Promise<ReadonlyArray<CodeLanguageDefinitionTarget>> {
  const entries = Array.isArray(input.result)
    ? input.result
    : input.result === null || input.result === undefined
      ? []
      : [input.result];
  const targets: CodeLanguageDefinitionTarget[] = [];
  for (const entry of entries.slice(0, MAX_CODE_LANGUAGE_DEFINITION_TARGETS)) {
    if (!isRecord(entry)) continue;
    const uri = typeof entry.uri === "string" ? entry.uri : entry.targetUri;
    const range = toRange(
      typeof entry.uri === "string"
        ? entry.range
        : (entry.targetSelectionRange ?? entry.targetRange),
    );
    if (typeof uri !== "string" || range === undefined) continue;
    targets.push(await placeTarget(uri, range, input.roots, input.realpath));
  }
  return targets;
}

async function placeTarget(
  uri: string,
  range: CodeLanguageRange,
  roots: LanguageServerResultRoots,
  realpath: (path: string) => Promise<string>,
): Promise<CodeLanguageDefinitionTarget> {
  let path: string;
  try {
    path = fileURLToPath(uri);
  } catch {
    return { kind: "outside-checkout", label: "elsewhere" };
  }
  if (!isAbsolute(path)) return { kind: "outside-checkout", label: "elsewhere" };
  let resolved: string;
  try {
    resolved = await realpath(path);
  } catch {
    // A target that no longer exists is placed by its name alone; it cannot
    // lead anywhere through a link that is not there.
    resolved = normalize(path);
  }
  if (classifyPathContainment(roots.checkoutRoot, resolved) === "contained") {
    const inside = relative(roots.checkoutRoot, resolved).split(sep).join("/");
    try {
      return { kind: "checkout-location", path: decodeCodeRelativePath(inside), range };
    } catch {
      return { kind: "outside-checkout", label: "elsewhere" };
    }
  }
  if (classifyPathContainment(roots.installRoot, resolved) === "contained") {
    return { kind: "outside-checkout", label: "bundled-library" };
  }
  return { kind: "outside-checkout", label: "elsewhere" };
}

function toRange(value: unknown): CodeLanguageRange | undefined {
  if (!isRecord(value)) return undefined;
  const start = toPosition(value.start);
  const end = toPosition(value.end);
  if (start === undefined || end === undefined) return undefined;
  if (end.line < start.line || (end.line === start.line && end.character < start.character)) {
    return undefined;
  }
  return { start, end };
}

function toPosition(value: unknown): { line: number; character: number } | undefined {
  if (!isRecord(value)) return undefined;
  const { line, character } = value;
  if (!isPosition(line) || !isPosition(character)) return undefined;
  return { line, character };
}

function isPosition(value: unknown): value is number {
  return (
    typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_POSITION
  );
}

function sourceLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed.length === 0 || trimmed.length > 64 || /[/\\]/.test(trimmed) ? fallback : trimmed;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
