import { statSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { ProviderDriverKind } from "@octant/contracts";

/**
 * Whether the person already trusted a Project's folder in the provider's own
 * CLI, so Octant's trust prompt would only ask a second time (maintainer
 * decision, 2026-11-16). Read from the files each CLI keeps its record in:
 *
 * - Claude Code: `projects["<folder>"].hasTrustDialogAccepted` in
 *   `.claude.json` (under `CLAUDE_CONFIG_DIR` when set, else the home folder).
 *   Claude Code's trust of a folder covers the folders inside it, so the
 *   Project's folder or any folder above it counts.
 * - Codex: `[projects."<folder>"]` with `trust_level = "trusted"` in
 *   `config.toml` (under `CODEX_HOME` when set, else `~/.codex`). Codex trusts
 *   the folder it names, so only the Project's own folder counts.
 *
 * Nothing is written, and an unreadable or malformed file is no record. Any
 * other provider keeps no record Octant reads.
 */
export type ProviderCliProjectTrust = (
  driverKind: ProviderDriverKind,
  canonicalRoot: string,
) => boolean;

export function createProviderCliProjectTrust(options: {
  readonly home: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  /** Codex keeps TOML; the host passes its runtime's parser. */
  readonly parseToml: (text: string) => unknown;
  readonly readFile?: (path: string) => string | undefined;
  /** A value that changes when the file does; undefined when it cannot be read. */
  readonly modifiedAt?: (path: string) => string | undefined;
}): ProviderCliProjectTrust {
  const readFile = options.readFile ?? readTextFile;
  const modifiedAt = options.modifiedAt ?? fileModifiedAt;
  // `.claude.json` grows with every folder Claude Code opened, so a parse is
  // kept until the file changes rather than repeated for every session.
  const cache = new Map<string, { readonly at: string; readonly value: unknown }>();
  const parsed = (path: string, parse: (text: string) => unknown): unknown => {
    const at = modifiedAt(path);
    if (at === undefined) return undefined;
    const kept = cache.get(path);
    if (kept !== undefined && kept.at === at) return kept.value;
    const text = readFile(path);
    let value: unknown;
    try {
      value = text === undefined ? undefined : parse(text);
    } catch {
      value = undefined;
    }
    cache.set(path, { at, value });
    return value;
  };
  const configDirectory = (variable: string, fallback: string): string => {
    const value = options.environment[variable];
    return value !== undefined && isAbsolute(value) ? value : fallback;
  };
  return (driverKind, canonicalRoot) => {
    if (driverKind === "claude") {
      const config = parsed(
        join(configDirectory("CLAUDE_CONFIG_DIR", options.home), ".claude.json"),
        JSON.parse,
      );
      const projects = recordAt(config, "projects");
      if (projects === undefined) return false;
      for (let folder = canonicalRoot; ; folder = dirname(folder)) {
        if (recordAt(projects, folder)?.hasTrustDialogAccepted === true) return true;
        if (dirname(folder) === folder) return false;
      }
    }
    if (driverKind === "codex") {
      const config = parsed(
        join(configDirectory("CODEX_HOME", join(options.home, ".codex")), "config.toml"),
        options.parseToml,
      );
      return recordAt(recordAt(config, "projects"), canonicalRoot)?.trust_level === "trusted";
    }
    return false;
  };
}

function recordAt(value: unknown, key: string): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const entry = (value as Record<string, unknown>)[key];
  return typeof entry === "object" && entry !== null && !Array.isArray(entry)
    ? (entry as Record<string, unknown>)
    : undefined;
}

function readTextFile(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function fileModifiedAt(path: string): string | undefined {
  try {
    const stat = statSync(path);
    return `${String(stat.mtimeMs)}:${String(stat.size)}`;
  } catch {
    return undefined;
  }
}

/** The record of this host's own person: their home folder and environment. */
export function hostProviderCliProjectTrust(): ProviderCliProjectTrust {
  return createProviderCliProjectTrust({
    home: homedir(),
    environment: process.env,
    parseToml: (text) => Bun.TOML.parse(text),
  });
}
