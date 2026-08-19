import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Case-insensitive path collision gate.
 *
 * `main` is developed and shipped on macOS, whose filesystem is case-insensitive
 * by default, and verified on Linux, whose filesystem is not. Git stores the
 * case a file was committed with, so two names that Linux reads as two files can
 * reach a Mac as one, and CI has no way to see it: the Linux runner checks out
 * both names, resolves every import to the file its author meant, and passes.
 *
 * The break this gate answers to was a model at `routineCalendar.ts` beside a
 * component at `RoutineCalendar.tsx`. Nothing on Linux minded. On a Mac,
 * `import { RoutineCalendar } from "./RoutineCalendar"` matched the model first
 * and the build failed with a missing export — a red build for every maintainer,
 * from a green pull request.
 *
 * So the rule is written against what a resolver on a case-insensitive
 * filesystem sees, not against the literal paths: two tracked files collide when
 * the names an import would use are the same once letter case stops
 * distinguishing them. That covers the plain collision, where the whole path
 * repeats in another case and the two files cannot coexist in a checkout at all,
 * and the resolution collision above, where the extensions differ so the paths
 * survive but the module names do not.
 *
 * Two files whose names differ only by extension — `theme.ts` beside
 * `theme.tsx` — are ambiguous in the same way, but they are ambiguous
 * identically everywhere, so CI already sees whatever they do. This gate is for
 * what CI cannot see.
 */

export interface PathCollision {
  readonly path: string;
  readonly reason: string;
}

export type TrackedPaths =
  | { readonly status: "listed"; readonly paths: ReadonlyArray<string> }
  | { readonly status: "unavailable"; readonly reason: string };

/**
 * Extensions a module specifier is allowed to omit.
 *
 * Only these make two differently-named files answer to one import. An asset or
 * a document carries its extension at every reference, so its whole path is its
 * name.
 */
const RESOLVABLE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
] as const;

interface Collision {
  readonly first: string;
  readonly rest: ReadonlyArray<string>;
}

/** The path as a reference to it would be written: without a droppable extension. */
function referenceName(path: string): string {
  const extension = RESOLVABLE_EXTENSIONS.find((candidate) => path.endsWith(candidate));
  return extension === undefined ? path : path.slice(0, -extension.length);
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Every group of tracked paths a case-insensitive filesystem would conflate.
 *
 * Paths are grouped by their reference name folded to lower case, then a group
 * only counts when its members disagree about that name in the original case —
 * which is what separates a genuine collision from the same name under two
 * extensions.
 */
export function findPathCollisions(paths: ReadonlyArray<string>): ReadonlyArray<PathCollision> {
  const groups = new Map<string, Collision>();
  for (const path of paths) {
    const key = referenceName(path).toLowerCase();
    const group = groups.get(key);
    if (group === undefined) {
      groups.set(key, { first: path, rest: [] });
      continue;
    }
    groups.set(key, { first: group.first, rest: [...group.rest, path] });
  }
  return [...groups.values()]
    .filter((group) => new Set([group.first, ...group.rest].map(referenceName)).size > 1)
    .map(describe);
}

function describe(group: Collision): PathCollision {
  const others = group.rest.join(", ");
  const sharesWholePath =
    new Set([group.first, ...group.rest].map((path) => path.toLowerCase())).size === 1;
  if (sharesWholePath) {
    return {
      path: group.first,
      reason: `is the same path as ${others} on a case-insensitive filesystem, where the two cannot both be checked out; rename one so the paths differ by more than letter case`,
    };
  }
  const names = [group.first, ...group.rest]
    .map((path) => `"./${baseName(referenceName(path))}"`)
    .join(" and ");
  return {
    path: group.first,
    reason: `answers to the same import as ${others} on a case-insensitive filesystem, where ${names} name one module; rename one so each module has a name of its own`,
  };
}

/**
 * The tracked paths, from git rather than from a directory walk.
 *
 * A walk on the machine that has the problem cannot report the problem: a
 * case-insensitive filesystem shows one of the two colliding names and hides the
 * other. Git records what was committed, so it is the only source here that
 * still holds both.
 */
export function listTrackedPaths(root: string): TrackedPaths {
  const listed = Bun.spawnSync(["git", "ls-files", "-z"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!listed.success) {
    const stderr = listed.stderr.toString().trim();
    return {
      status: "unavailable",
      reason: stderr === "" ? "`git ls-files` failed" : stderr,
    };
  }
  return {
    status: "listed",
    paths: listed.stdout
      .toString()
      .split("\0")
      .filter((path) => path !== ""),
  };
}

function main(): void {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const tracked = listTrackedPaths(root);
  if (tracked.status === "unavailable") {
    console.error(
      `Could not list tracked files, so path collisions are unknown: ${tracked.reason}`,
    );
    process.exitCode = 1;
    return;
  }
  const collisions = findPathCollisions(tracked.paths);
  if (collisions.length === 0) return;
  for (const collision of collisions) {
    console.error(`${collision.path}: ${collision.reason}`);
  }
  process.exitCode = 1;
}

if (import.meta.main) main();
