import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectActionSuggestion } from "@octant/contracts";

/** A manifest larger than this was not written by hand; reading it costs memory for nothing. */
const MAX_SOURCE_BYTES = 1_048_576;
const MAX_FROM_EACH_SOURCE = 12;

/** Install and publish hooks run by the package manager itself, never by a person's click. */
const LIFECYCLE_SCRIPTS = new Set([
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepublish",
  "prepublishOnly",
  "prepack",
  "postpack",
  "publish",
  "postpublish",
]);

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9:_.-]*$/;
const MAKE_TARGET = /^([A-Za-z0-9][A-Za-z0-9_.-]*)[ \t]*:(?![=:])/;

const LOCKFILES: ReadonlyArray<readonly [file: string, manager: string]> = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
];

/**
 * Commands a Project's own files suggest saving as actions: the scripts in its
 * root `package.json` and the targets in its root `Makefile`. Nothing is run or
 * saved here; the person reads each suggestion and confirms the ones they want.
 * A missing, unreadable, symlinked, oversized, or malformed file contributes
 * nothing rather than failing the rest.
 */
export async function suggestProjectActions(
  root: string,
): Promise<ReadonlyArray<ProjectActionSuggestion>> {
  const [manifest, makefile, manager] = await Promise.all([
    readSource(join(root, "package.json")),
    readSource(join(root, "Makefile")),
    packageManager(root),
  ]);
  return [
    ...(manifest === undefined ? [] : scriptSuggestions(manifest, manager)),
    ...(makefile === undefined ? [] : targetSuggestions(makefile)),
  ];
}

function scriptSuggestions(
  manifest: string,
  manager: string,
): ReadonlyArray<ProjectActionSuggestion> {
  let scripts: unknown;
  try {
    const parsed: unknown = JSON.parse(manifest);
    scripts =
      typeof parsed === "object" && parsed !== null && "scripts" in parsed
        ? parsed.scripts
        : undefined;
  } catch {
    return [];
  }
  if (typeof scripts !== "object" || scripts === null) return [];
  return Object.entries(scripts)
    .filter(
      ([name, body]) =>
        typeof body === "string" &&
        SAFE_NAME.test(name) &&
        !LIFECYCLE_SCRIPTS.has(name) &&
        !name.startsWith("pre") &&
        !name.startsWith("post"),
    )
    .slice(0, MAX_FROM_EACH_SOURCE)
    .map(([name]) => ({
      name: titled(name),
      command: `${manager} run ${name}`,
      directory: ".",
      source: "package.json" as const,
    }));
}

function targetSuggestions(makefile: string): ReadonlyArray<ProjectActionSuggestion> {
  const targets = new Set<string>();
  for (const line of makefile.split("\n")) {
    const target = MAKE_TARGET.exec(line)?.[1];
    if (target !== undefined) targets.add(target);
  }
  return [...targets].slice(0, MAX_FROM_EACH_SOURCE).map((target) => ({
    name: titled(target),
    command: `make ${target}`,
    directory: ".",
    source: "Makefile" as const,
  }));
}

function titled(name: string): string {
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`.slice(0, 40);
}

async function packageManager(root: string): Promise<string> {
  for (const [file, manager] of LOCKFILES) {
    if (
      await lstat(join(root, file)).then(
        () => true,
        () => false,
      )
    )
      return manager;
  }
  return "npm";
}

async function readSource(path: string): Promise<string | undefined> {
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.size > MAX_SOURCE_BYTES) return undefined;
    const handle = await open(path, "r");
    try {
      return await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
}
