/**
 * Pure policy for starting a project from a curated scaffold.
 *
 * The catalog says what a scaffold is; this module decides whether one may run
 * here and what command line it becomes. The composition lives here, away from
 * the catalog, so a catalog entry can never contribute a flag, a path, or a
 * shell fragment — it contributes a pinned package and a preset, and the host
 * writes the rest.
 */

import type { ScaffoldEntry } from "@octant/contracts/scaffolds";
import type { ProviderExecutionPolicy } from "@octant/contracts/providers";

export type ScaffoldRefusal =
  | "plan-mode-is-read-only"
  | "tool-unavailable"
  | "directory-exists"
  | "directory-name-refused";

export type ScaffoldPlan =
  | {
      readonly status: "planned";
      readonly argv: readonly [string, ...ReadonlyArray<string>];
      /** Where the generator runs, relative to the checkout root. */
      readonly relativeCwd: string;
      /** The single directory the run is allowed to create, checkout-relative. */
      readonly createsPath: string;
      /**
       * Whether the host makes the directory before the generator runs. Package
       * generators make their own; a toolchain that initializes the directory
       * it is already standing in needs one to exist first.
       */
      readonly hostCreatesDirectory: boolean;
    }
  | { readonly status: "refused"; readonly reason: ScaffoldRefusal };

export interface ScaffoldPlanFacts {
  readonly entry: ScaffoldEntry;
  readonly directoryName: string;
  readonly posture: ProviderExecutionPolicy;
  /** Tools the host found on this machine. */
  readonly availableTools: ReadonlyArray<string>;
  /** Whether the checkout already has an entry at the target name. */
  readonly targetExists: boolean;
}

/**
 * Names a scaffold may not create.
 *
 * Git's own directory and the two traversal names are refused here rather than
 * only in the schema, because a plan that reaches the filesystem with one of
 * them is a scaffold writing over the repository it was asked to sit inside.
 */
const REFUSED_DIRECTORY_NAMES = new Set([".git", ".", "..", "node_modules"]);

/**
 * Whether this scaffold may run, and the exact command it becomes.
 *
 * Plan mode refuses first: a scaffold writes a directory full of files, and no
 * approval makes that a read. After that the refusals are the ones the user can
 * fix — a missing tool, a name already taken — each named rather than left to
 * fail halfway through a generator.
 */
export function planScaffold(facts: ScaffoldPlanFacts): ScaffoldPlan {
  if (facts.posture === "plan") return { status: "refused", reason: "plan-mode-is-read-only" };
  const name = facts.directoryName;
  if (
    name.length === 0 ||
    name.includes("/") ||
    name.includes("\\") ||
    name.startsWith(".") ||
    name.startsWith("-") ||
    REFUSED_DIRECTORY_NAMES.has(name)
  ) {
    return { status: "refused", reason: "directory-name-refused" };
  }
  if (!facts.availableTools.includes(facts.entry.requiresTool)) {
    return { status: "refused", reason: "tool-unavailable" };
  }
  if (facts.targetExists) return { status: "refused", reason: "directory-exists" };
  const toolchain = facts.entry.generator.kind === "toolchain";
  return {
    status: "planned",
    argv: scaffoldArgv(facts.entry, name),
    relativeCwd: toolchain ? name : ".",
    createsPath: name,
    hostCreatesDirectory: toolchain,
  };
}

/**
 * The command line for one scaffold.
 *
 * A package generator takes the directory as its first positional argument and
 * creates it. A toolchain generator initializes the directory it is standing
 * in, so it gets the name as a value instead. Either way the name reaches the
 * generator as one argument that cannot begin with `-`, so nothing the user
 * typed can be read as a flag.
 */
function scaffoldArgv(
  entry: ScaffoldEntry,
  directoryName: string,
): readonly [string, ...ReadonlyArray<string>] {
  const generator = entry.generator;
  if (generator.kind === "toolchain") {
    return [generator.tool, ...generator.presetArguments, "--name", directoryName];
  }
  const pinned = `${generator.packageName}@${generator.version}`;
  return generator.runner === "bun"
    ? ["bunx", "--bun", pinned, directoryName, ...generator.presetArguments]
    : ["npx", "--yes", pinned, directoryName, ...generator.presetArguments];
}

/** What the user is told when a scaffold is refused, in the words of the state. */
export function scaffoldRefusalText(reason: ScaffoldRefusal, entry: ScaffoldEntry): string {
  switch (reason) {
    case "plan-mode-is-read-only":
      return "Plan mode does not write files. Leave Plan mode to start a project.";
    case "tool-unavailable":
      return `This scaffold needs ${entry.requiresTool}, which is not on this machine.`;
    case "directory-exists":
      return "Something already exists at that name. Choose another.";
    case "directory-name-refused":
      return "That name cannot be used for a new project directory.";
  }
}
