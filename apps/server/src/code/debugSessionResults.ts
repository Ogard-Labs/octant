import { isAbsolute, normalize, relative, sep } from "node:path";
import { decodeCodeRelativePath } from "@octant/contracts";
import {
  MAX_CODE_DEBUG_BREAKPOINTS_PER_FILE,
  MAX_CODE_DEBUG_FRAMES,
  MAX_CODE_DEBUG_MESSAGE_LENGTH,
  MAX_CODE_DEBUG_NAME_LENGTH,
  MAX_CODE_DEBUG_VALUE_LENGTH,
  MAX_CODE_DEBUG_VARIABLES,
  type CodeDebugExceptionFilter,
  type CodeDebugScope,
  type CodeDebugSourceLocation,
  type CodeDebugStackFrame,
  type CodeDebugVariable,
} from "@octant/contracts/code-debug";
import { classifyPathContainment } from "@octant/domain";
import { rewriteHostPaths } from "./languageServerResults";

/**
 * Debug Adapter Protocol answers turned into Octant's session contracts.
 * Canonical: docs/design/language-services.md § Protocol.
 *
 * An adapter's answer is data from a program the person runs, so nothing in
 * it is trusted to stay inside the checkout or inside its bounds. A frame's
 * source is placed by its resolved path: inside the checkout it is
 * checkout-relative; anything else is `outside-checkout` with no path. Host
 * paths in frame names, messages, and output are rewritten as diagnostic
 * messages are. Values are cut at their bounds and say so.
 */

const MAX_REFERENCE = 2_147_483_647;

export interface DebugResultRoots {
  /** The canonical checkout root the session runs in. */
  readonly checkoutRoot: string;
  readonly realpath: (path: string) => Promise<string>;
}

/** Cuts text at a bound, never on half of a surrogate pair, and says whether it did. */
export function boundText(
  text: string,
  maximum: number,
): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= maximum) return { text, truncated: false };
  let cut = text.slice(0, maximum);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return { text: cut, truncated: true };
}

/** Free text from the adapter, with host paths rewritten and cut at its bound. */
export function adapterText(text: string, checkoutRoot: string, maximum: number): string {
  return boundText(rewriteHostPaths(text, checkoutRoot), maximum).text;
}

export async function toStackFrames(
  body: unknown,
  roots: DebugResultRoots,
): Promise<{ readonly frames: ReadonlyArray<CodeDebugStackFrame>; readonly truncated: boolean }> {
  const entries = isRecord(body) && Array.isArray(body.stackFrames) ? body.stackFrames : [];
  const frames: CodeDebugStackFrame[] = [];
  for (const entry of entries.slice(0, MAX_CODE_DEBUG_FRAMES)) {
    if (!isRecord(entry)) continue;
    const id = reference(entry.id);
    if (id === undefined) continue;
    frames.push({
      id,
      name: adapterText(stringOf(entry.name), roots.checkoutRoot, MAX_CODE_DEBUG_NAME_LENGTH),
      location: await placeSource(entry.source, entry.line, entry.column, roots),
    });
  }
  const total = isRecord(body) && typeof body.totalFrames === "number" ? body.totalFrames : 0;
  return {
    frames,
    truncated: entries.length > MAX_CODE_DEBUG_FRAMES || total > frames.length,
  };
}

export function toScopes(body: unknown, checkoutRoot: string): ReadonlyArray<CodeDebugScope> {
  const entries = isRecord(body) && Array.isArray(body.scopes) ? body.scopes : [];
  const scopes: CodeDebugScope[] = [];
  for (const entry of entries.slice(0, MAX_CODE_DEBUG_VARIABLES)) {
    if (!isRecord(entry)) continue;
    const variablesReference = reference(entry.variablesReference);
    if (variablesReference === undefined) continue;
    scopes.push({
      name: adapterText(stringOf(entry.name), checkoutRoot, MAX_CODE_DEBUG_NAME_LENGTH),
      variablesReference,
      expensive: entry.expensive === true,
    });
  }
  return scopes;
}

export function toVariables(body: unknown): {
  readonly variables: ReadonlyArray<CodeDebugVariable>;
  readonly truncated: boolean;
} {
  const entries = isRecord(body) && Array.isArray(body.variables) ? body.variables : [];
  const variables: CodeDebugVariable[] = [];
  for (const entry of entries.slice(0, MAX_CODE_DEBUG_VARIABLES)) {
    if (!isRecord(entry)) continue;
    const variable = toVariable(entry.name, entry.value, entry.type, entry.variablesReference);
    if (variable !== undefined) variables.push(variable);
  }
  return { variables, truncated: entries.length > MAX_CODE_DEBUG_VARIABLES };
}

/** An `evaluate` answer, shown as a variable named by the expression. */
export function toEvaluated(body: unknown, expression: string): CodeDebugVariable | undefined {
  if (!isRecord(body)) return undefined;
  return toVariable(expression, body.result, body.type, body.variablesReference);
}

export function toThreads(
  body: unknown,
  checkoutRoot: string,
): ReadonlyArray<{ readonly id: number; readonly name: string }> {
  const entries = isRecord(body) && Array.isArray(body.threads) ? body.threads : [];
  const threads: Array<{ readonly id: number; readonly name: string }> = [];
  for (const entry of entries.slice(0, MAX_CODE_DEBUG_FRAMES)) {
    if (!isRecord(entry)) continue;
    const id = reference(entry.id);
    if (id === undefined) continue;
    threads.push({
      id,
      name: adapterText(stringOf(entry.name), checkoutRoot, MAX_CODE_DEBUG_NAME_LENGTH),
    });
  }
  return threads;
}

export function toBreakpoints(
  body: unknown,
): ReadonlyArray<{ readonly verified: boolean; readonly line?: number }> {
  const entries = isRecord(body) && Array.isArray(body.breakpoints) ? body.breakpoints : [];
  return entries.slice(0, MAX_CODE_DEBUG_BREAKPOINTS_PER_FILE).map((entry) => {
    if (!isRecord(entry)) return { verified: false };
    const line = lineOf(entry.line);
    return { verified: entry.verified === true, ...(line === undefined ? {} : { line }) };
  });
}

/** The exception filters an adapter advertised in its capabilities; only these are ever sent. */
export function toExceptionFilters(capabilities: unknown): ReadonlyArray<CodeDebugExceptionFilter> {
  const entries =
    isRecord(capabilities) && Array.isArray(capabilities.exceptionBreakpointFilters)
      ? capabilities.exceptionBreakpointFilters
      : [];
  const filters: CodeDebugExceptionFilter[] = [];
  for (const entry of entries.slice(0, 16)) {
    if (!isRecord(entry) || typeof entry.filter !== "string") continue;
    if (entry.filter.length === 0 || entry.filter.length > 128) continue;
    filters.push({
      filter: entry.filter,
      label: boundText(stringOf(entry.label), MAX_CODE_DEBUG_NAME_LENGTH).text,
      default: entry.default === true,
    });
  }
  return filters;
}

export function toExceptionInfo(
  body: unknown,
  checkoutRoot: string,
):
  | { readonly exceptionId: string; readonly description?: string; readonly breakMode: string }
  | undefined {
  if (!isRecord(body)) return undefined;
  const description =
    typeof body.description === "string"
      ? adapterText(body.description, checkoutRoot, MAX_CODE_DEBUG_MESSAGE_LENGTH)
      : undefined;
  return {
    exceptionId: adapterText(stringOf(body.exceptionId), checkoutRoot, MAX_CODE_DEBUG_NAME_LENGTH),
    ...(description === undefined ? {} : { description }),
    breakMode: boundText(stringOf(body.breakMode), 64).text,
  };
}

function toVariable(
  name: unknown,
  value: unknown,
  type: unknown,
  variablesReference: unknown,
): CodeDebugVariable | undefined {
  const reference_ = reference(variablesReference ?? 0);
  if (reference_ === undefined) return undefined;
  const bounded = boundText(stringOf(value), MAX_CODE_DEBUG_VALUE_LENGTH);
  return {
    name: boundText(stringOf(name), MAX_CODE_DEBUG_NAME_LENGTH).text,
    value: bounded.text,
    truncated: bounded.truncated,
    ...(typeof type === "string" && type.length > 0
      ? { type: boundText(type, MAX_CODE_DEBUG_NAME_LENGTH).text }
      : {}),
    variablesReference: reference_,
  };
}

/**
 * Places a frame's source by its resolved path, so a link inside the checkout
 * that leads out of it is outside. Source the adapter holds by reference is
 * offered by that reference alone.
 */
async function placeSource(
  source: unknown,
  line: unknown,
  column: unknown,
  roots: DebugResultRoots,
): Promise<CodeDebugSourceLocation> {
  if (!isRecord(source)) return { kind: "none" };
  const sourceReference = reference(source.sourceReference);
  const placedLine = lineOf(line);
  const outside = (): CodeDebugSourceLocation => ({
    kind: "outside-checkout",
    label: sourceReference !== undefined && sourceReference > 0 ? "adapter-source" : "elsewhere",
    ...(sourceReference !== undefined && sourceReference > 0 ? { sourceReference } : {}),
    ...(placedLine === undefined ? {} : { line: placedLine }),
  });
  if (typeof source.path !== "string" || !isAbsolute(source.path) || placedLine === undefined) {
    return outside();
  }
  let resolved: string;
  try {
    resolved = await roots.realpath(source.path);
  } catch {
    resolved = normalize(source.path);
  }
  if (classifyPathContainment(roots.checkoutRoot, resolved) !== "contained") return outside();
  try {
    return {
      kind: "checkout",
      path: decodeCodeRelativePath(relative(roots.checkoutRoot, resolved).split(sep).join("/")),
      line: placedLine,
      column: lineOf(column) ?? 1,
    };
  } catch {
    return outside();
  }
}

function reference(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_REFERENCE
    ? value
    : undefined;
}

function lineOf(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_REFERENCE
    ? value
    : undefined;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
