import { Schema } from "effect";
import type { CodeRelativePath } from "@octant/contracts/code";
import {
  CodeDebugConfiguration,
  CodeDebugConfigurationName,
  MAX_CODE_DEBUG_UNUSED_FIELD_LENGTH,
  MAX_CODE_DEBUG_UNUSED_FIELDS,
  type CodeDebugConfigurationProposal,
  type CodeDebugImportUnmappableReason,
} from "@octant/contracts/code-debug";
import type { ExtensionComponentQualifiedId } from "@octant/contracts/extensions";

/**
 * Proposals from a repository's `.vscode/launch.json`, already parsed by the
 * host. Canonical: docs/design/language-services.md § Debug configurations
 * (Decision DB2).
 *
 * The file is data the repository already holds. Each entry is mapped to an
 * Octant configuration the person may confirm, or named as unmappable, and
 * nothing here runs, writes, or watches anything. Only six fields map; every
 * other field is listed by name as unused, so a task, a runtime executable,
 * or an adapter-specific option is visible and never honoured. Variables
 * resolve from a closed set; any other variable anywhere in an entry makes it
 * unmappable, because each reads host state or runs an editor command.
 */

/** The most proposals one file yields; entries past it are left out and the reading says so. */
export const MAX_DEBUG_LAUNCH_FILE_PROPOSALS = 64;

export interface DebugLaunchFileImportContext {
  /** The checkout's absolute folder on the host, which `${workspaceFolder}` names. */
  readonly checkoutRoot: string;
  /** The file open in the editor, which the current-file variables name. */
  readonly currentFile?: CodeRelativePath;
  /** The effective `debug-adapter` components in Code and the launch types each imports. */
  readonly adapters: ReadonlyArray<{
    readonly adapter: ExtensionComponentQualifiedId;
    readonly importTypes: ReadonlyArray<string>;
  }>;
}

export type DebugLaunchFileImport =
  | {
      readonly status: "read";
      readonly proposals: ReadonlyArray<CodeDebugConfigurationProposal>;
      readonly truncated: boolean;
    }
  | { readonly status: "unreadable" };

const MAPPED_FIELDS: ReadonlySet<string> = new Set([
  "name",
  "type",
  "request",
  "program",
  "args",
  "cwd",
  "env",
  "stopOnEntry",
]);
const WORKSPACE_VARIABLES: ReadonlySet<string> = new Set([
  "workspaceFolder",
  "workspaceFolderBasename",
]);
const CURRENT_FILE_VARIABLES: ReadonlySet<string> = new Set([
  "file",
  "relativeFile",
  "fileDirname",
]);
const VARIABLE = /\$\{([^}]*)\}/g;

const decodeConfiguration = Schema.decodeUnknownEither(CodeDebugConfiguration);
const isConfigurationName = Schema.is(CodeDebugConfigurationName);

export function proposeDebugConfigurations(
  launchFile: unknown,
  context: DebugLaunchFileImportContext,
): DebugLaunchFileImport {
  if (!isRecord(launchFile) || !Array.isArray(launchFile.configurations)) {
    return { status: "unreadable" };
  }
  const entries: ReadonlyArray<unknown> = launchFile.configurations;
  return {
    status: "read",
    proposals: entries
      .slice(0, MAX_DEBUG_LAUNCH_FILE_PROPOSALS)
      .map((entry) => proposeEntry(entry, context)),
    truncated: entries.length > MAX_DEBUG_LAUNCH_FILE_PROPOSALS,
  };
}

function proposeEntry(
  entry: unknown,
  context: DebugLaunchFileImportContext,
): CodeDebugConfigurationProposal {
  if (!isRecord(entry) || !isConfigurationName(entry.name)) {
    return { status: "unmappable", reason: "invalid" };
  }
  const name = entry.name;
  const unmappable = (reason: CodeDebugImportUnmappableReason): CodeDebugConfigurationProposal => ({
    status: "unmappable",
    name,
    reason,
  });
  if (entry.request !== "launch") return unmappable("not-launch");
  const adapters = context.adapters.filter(
    (candidate) => typeof entry.type === "string" && candidate.importTypes.includes(entry.type),
  );
  const [adapter, ...others] = adapters;
  if (adapter === undefined) return unmappable("no-adapter");
  if (others.length > 0) return unmappable("adapter-ambiguous");
  if (!usesOnlyClosedVariables(entry)) return unmappable("unsupported-variable");

  const { program, cwd, stopOnEntry } = entry;
  const rawArgs = entry.args ?? [];
  const env = entry.env ?? {};
  if (
    typeof program !== "string" ||
    (cwd !== undefined && typeof cwd !== "string") ||
    (stopOnEntry !== undefined && typeof stopOnEntry !== "boolean") ||
    !Array.isArray(rawArgs) ||
    !rawArgs.every((arg) => typeof arg === "string") ||
    !isRecord(env) ||
    !Object.values(env).every((value) => typeof value === "string")
  ) {
    return unmappable("invalid");
  }
  const args = rawArgs.flatMap((arg) => (typeof arg === "string" ? [arg] : []));
  const environment = Object.entries(env).flatMap(([key, value]) =>
    typeof value === "string" ? [{ key, value }] : [],
  );
  const mappedText = [
    program,
    ...(cwd === undefined ? [] : [cwd]),
    ...args,
    ...environment.map(({ value }) => value),
  ];
  if (
    context.currentFile === undefined &&
    mappedText.some((text) => variablesIn(text).some((name) => CURRENT_FILE_VARIABLES.has(name)))
  ) {
    return unmappable("needs-open-file");
  }

  const root = normalizedAbsolute(context.checkoutRoot);
  if (root === undefined) return unmappable("invalid");
  const resolve = (text: string) => substitute(text, root, context.currentFile);
  const programPath = checkoutRelative(resolve(program), root);
  const cwdPath = cwd === undefined ? "" : checkoutRelative(resolve(cwd), root);
  if (programPath === undefined || cwdPath === undefined) return unmappable("outside-checkout");

  const unusedFields = Object.keys(entry)
    .filter((field) => entry[field] !== undefined && !MAPPED_FIELDS.has(field))
    .sort();
  if (
    unusedFields.length > MAX_CODE_DEBUG_UNUSED_FIELDS ||
    unusedFields.some(
      (field) => field.length === 0 || field.length > MAX_CODE_DEBUG_UNUSED_FIELD_LENGTH,
    )
  ) {
    return unmappable("invalid");
  }
  const configuration = decodeConfiguration({
    name,
    adapter: adapter.adapter,
    program: programPath,
    args: args.map(resolve),
    ...(cwdPath === "" ? {} : { cwd: cwdPath }),
    env: environment.map(({ key, value }) => ({ key, value: resolve(value) })),
    stopOnEntry: stopOnEntry === true,
  });
  if (configuration._tag === "Left") return unmappable("invalid");
  return { status: "proposed", configuration: configuration.right, unusedFields };
}

/**
 * Whether every variable in the entry, in any field and at any depth, is one
 * the closed set resolves. Walked without recursion, since a parsed file can
 * nest deeper than a call stack.
 */
function usesOnlyClosedVariables(entry: Readonly<Record<string, unknown>>): boolean {
  const pending: unknown[] = [entry];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value === "string") {
      if (value.replace(VARIABLE, "").includes("${")) return false;
      if (
        variablesIn(value).some(
          (name) => !WORKSPACE_VARIABLES.has(name) && !CURRENT_FILE_VARIABLES.has(name),
        )
      ) {
        return false;
      }
    } else if (Array.isArray(value)) {
      pending.push(...value);
    } else if (isRecord(value)) {
      pending.push(...Object.keys(value), ...Object.values(value));
    }
  }
  return true;
}

function variablesIn(text: string): ReadonlyArray<string> {
  return [...text.matchAll(VARIABLE)].map((match) => match[1] ?? "");
}

function substitute(text: string, root: string, currentFile: CodeRelativePath | undefined): string {
  const file = currentFile === undefined ? undefined : `${root}/${String(currentFile)}`;
  return text.replace(VARIABLE, (whole, name: string) => {
    if (name === "workspaceFolder") return root;
    if (name === "workspaceFolderBasename") return root.split("/").pop() ?? "";
    if (name === "relativeFile" && currentFile !== undefined) return String(currentFile);
    if (name === "file" && file !== undefined) return file;
    if (name === "fileDirname" && file !== undefined) return file.slice(0, file.lastIndexOf("/"));
    return whole;
  });
}

/**
 * A path as a checkout-relative one, `""` for the root itself, or undefined
 * when it leaves the checkout. A relative path is taken from the root. This
 * is lexical only; the host contains the result again with symlinks resolved
 * when the person confirms it and at every start.
 */
function checkoutRelative(path: string, root: string): string | undefined {
  const absolute = normalizedAbsolute(path.startsWith("/") ? path : `${root}/${path}`);
  if (absolute === undefined) return undefined;
  if (absolute === root) return "";
  return absolute.startsWith(`${root}/`) ? absolute.slice(root.length + 1) : undefined;
}

function normalizedAbsolute(path: string): string | undefined {
  if (!path.startsWith("/")) return undefined;
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.pop() === undefined) return undefined;
    } else {
      segments.push(segment);
    }
  }
  return `/${segments.join("/")}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
