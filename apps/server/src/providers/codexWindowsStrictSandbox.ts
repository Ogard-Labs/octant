/**
 * Windows Strict for Codex: the commands Codex runs are confined by Codex's own
 * elevated Windows sandbox, not by an Octant wall around the whole Codex
 * process (maintainer decision, 2026-11-22; see "Windows Strict" in
 * `docs/architecture.md`). Octant hands that sandbox the thread's writable
 * folders and the secret guard's protected stores as a named permissions
 * profile, and refuses the thread when Codex's sandbox is not set up.
 *
 * Why not Octant's AppContainer around the process: Codex keeps account-wide
 * state under CODEX_HOME (rollouts in shared date folders, thread writer locks,
 * rollout compression), so a process that can write what Codex needs can also
 * write other threads' history. Codex's sandbox never grants its commands
 * write access to CODEX_HOME (`filter_sensitive_write_roots`, codex-rs
 * `windows-sandbox-rs/src/setup.rs`), while the Codex process keeps its home,
 * sign-in and follow-up turns. Only the elevated backend enforces deny-read:
 * the unelevated backend refuses a profile with deny-read paths ("cannot
 * enforce deny-read restrictions directly; refusing to run unsandboxed",
 * codex-rs `sandboxing/src/windows.rs`).
 */
import { readdirSync } from "node:fs";
import {
  isSameOrInside,
  type ResolvedProtectedEntry,
  windowsGuardPath,
} from "@octant/domain/secret-guard-policy";
import type { CodexPermissionProfile } from "./codexDriver";

/** Codex's configuration for the elevated Windows sandbox, passed at launch. */
export const CODEX_WINDOWS_ELEVATED_SANDBOX_ARGS = ["-c", 'windows.sandbox="elevated"'] as const;

/** Why a Windows Strict Codex thread refuses when Codex's own sandbox is not set up. */
export const WINDOWS_STRICT_CODEX_SANDBOX_SETUP_REFUSAL =
  "Windows Strict runs Codex's commands in Codex's own Windows sandbox, and its one-time setup has not been done. Set up the Codex Windows sandbox in Codex (an administrator approves it once), then try again, or turn Strict off for this thread.";

/** Why a Windows Strict Codex thread refuses when this Codex cannot report its sandbox. */
export const WINDOWS_STRICT_CODEX_SANDBOX_UNSUPPORTED_REFUSAL =
  "This Codex cannot confirm that its Windows sandbox is set up, so Windows Strict cannot run it. Update Codex, or turn Strict off for this thread.";

/** Why a Windows Strict Codex thread refuses when the protected stores cannot be listed for Codex. */
const WINDOWS_STRICT_PROTECTED_LIST_REFUSAL =
  "Codex cannot run under Windows Strict: Octant could not hand Codex's sandbox the full list of protected files.";

/** Alternatives above this count are refused rather than sent as one huge glob. */
const MAX_NAME_ALTERNATIVES = 64;

export type CodexWindowsStrictProfile =
  | { readonly status: "ready"; readonly profile: CodexPermissionProfile }
  | { readonly status: "refused"; readonly reason: string };

/**
 * The permissions profile a Windows Strict Codex thread runs under: its
 * folders writable, every protected store denied, the rest of the disk
 * readable as in Codex's own workspace sandbox. A store Codex's globs cannot
 * name refuses the thread rather than leaving it readable.
 */
export function codexWindowsStrictProfile(input: {
  readonly writableRoots: ReadonlyArray<string>;
  readonly protectedEntries: ReadonlyArray<ResolvedProtectedEntry>;
  readonly codexHome: string;
  readonly networkOpen: boolean;
  /** Lists one folder's entry names; tests substitute a fixture. */
  readonly listDirectory?: (path: string) => ReadonlyArray<string>;
}): CodexWindowsStrictProfile {
  const list = input.listDirectory ?? ((path: string) => readdirSync(path));
  const homeForm = windowsGuardPath(input.codexHome);
  if (homeForm === undefined) {
    return { status: "refused", reason: WINDOWS_STRICT_PROTECTED_LIST_REFUSAL };
  }
  // Codex reads `*`, `?`, `[`, `]`, `{` and `}` in a filesystem key as glob
  // syntax and refuses a `write` key that holds them (codex-rs
  // `compile_read_write_glob_path`), with no escape on Windows. A folder named
  // that way cannot be handed over literally, so the thread is refused.
  const unspellable = input.writableRoots.find((root) => /[*?[\]{}]/u.test(root));
  if (unspellable !== undefined) {
    return {
      status: "refused",
      reason: `Windows Strict cannot hand Codex's sandbox the folder ${unspellable}: its name holds a character Codex reads as a pattern. Rename the folder, or turn Strict off for this thread.`,
    };
  }
  const filesystem: Record<string, "write" | "deny"> = {};
  for (const root of input.writableRoots) filesystem[root] = "write";
  let literalDenyUnspellable = false;
  const deny = (path: string, glob = false) => {
    if (!glob && /[*?[\]{}]/u.test(path)) literalDenyUnspellable = true;
    filesystem[path] = "deny";
  };
  try {
    for (const entry of input.protectedEntries) {
      // A Codex home at or inside a store the guard protects for everyone
      // (not a runtime's own sign-in) cannot be carved around: the denial
      // would also reach the sandbox helpers Codex's commands start from.
      // Name patterns deny only matching files, so only a whole denied
      // location (a path, or a folder whose pattern has an exception) counts.
      const location =
        entry.kind === "path"
          ? entry.path
          : entry.except === undefined
            ? undefined
            : entry.directory;
      if (location !== undefined && !entry.ownAccountExempt && isSameOrInside(homeForm, location)) {
        return {
          status: "refused",
          reason: `Codex cannot run under Windows Strict: its home lies inside ${entry.label}, which Strict keeps from commands. Move CODEX_HOME, or turn Strict off for this thread.`,
        };
      }
      if (entry.kind === "path") {
        denyAroundCodexHome(entry.path, homeForm, list, deny);
        continue;
      }
      const directory = nativeFromGuard(entry.directory);
      // A pattern with an exception (SSH private keys, all but `.pub`) has no
      // glob form, so its whole folder is denied. Codex's own sandbox already
      // leaves `.ssh` out of what its commands read (`USERPROFILE_ROOT_EXCLUSIONS`).
      if (entry.except !== undefined) {
        denyAroundCodexHome(entry.directory, homeForm, list, deny);
        continue;
      }
      const names = guardNameGlobs(entry.name);
      if (names === undefined) {
        return { status: "refused", reason: WINDOWS_STRICT_PROTECTED_LIST_REFUSAL };
      }
      // One entry per name and depth: no `**`, which Codex's Windows sandbox
      // expands only with a scan limit set for the whole profile, and no brace
      // group, which Codex does not read as a pattern without another glob
      // character (a top-level `{Cookies,...}` would name one literal file).
      for (let level = 0; level < entry.depth; level += 1) {
        for (const name of names) {
          deny(`${directory}\\${"*\\".repeat(level)}${name}`, true);
        }
      }
    }
  } catch {
    return { status: "refused", reason: WINDOWS_STRICT_PROTECTED_LIST_REFUSAL };
  }
  // The account's own sign-in: the Codex process reads it outside the
  // sandbox, and no command it runs needs it.
  deny(`${nativeFromGuard(homeForm)}\\auth.json`);
  if (literalDenyUnspellable) {
    return { status: "refused", reason: WINDOWS_STRICT_PROTECTED_LIST_REFUSAL };
  }
  return {
    status: "ready",
    profile: {
      extends: ":workspace",
      filesystem,
      ...(input.networkOpen ? { network: { enabled: true } as const } : {}),
    },
  };
}

/**
 * Denies `path`, unless the account's Codex home lies inside it: a deny there
 * would reach the home's sandbox helper folders, which Codex's sandbox users
 * must read to start a command. Then each sibling on the way down is denied
 * instead, and the home itself is left to Codex (its `auth.json` is denied on
 * its own).
 */
function denyAroundCodexHome(
  pathForm: string,
  homeForm: string,
  list: (path: string) => ReadonlyArray<string>,
  deny: (path: string) => void,
): void {
  if (!isSameOrInside(homeForm, pathForm)) {
    deny(nativeFromGuard(pathForm));
    return;
  }
  if (pathForm === homeForm) return;
  const native = nativeFromGuard(pathForm);
  for (const name of list(native)) {
    const childForm = windowsGuardPath(`${native}\\${name}`);
    if (childForm === undefined) throw new Error("unspelled child");
    denyAroundCodexHome(childForm, homeForm, list, deny);
  }
}

/** `/c:/users/p/.ssh` to `C:\users\p\.ssh`. Windows opens either case. */
function nativeFromGuard(form: string): string {
  const drive = form.slice(1, 3).toUpperCase();
  const rest = form.slice(3).replaceAll("/", "\\");
  return rest === "" ? `${drive}\\` : `${drive}${rest}`;
}

/**
 * The file-name globs a secret guard name pattern stands for, or undefined
 * when the pattern has a form Codex's globs cannot carry. The guard's patterns
 * use a small regular-expression subset: literals, `\.`, `.`, `[^/]*`, a
 * character class, and `(a|b)` groups that may be optional. Codex's Windows
 * globs keep `*` within one name and match case-insensitively; a group becomes
 * its expanded alternatives, since an empty brace alternative is not relied on.
 */
export function guardNameGlobs(pattern: string): ReadonlyArray<string> | undefined {
  const parsed = parseAlternatives(pattern, 0);
  if (parsed === undefined || parsed.next !== pattern.length) return undefined;
  return parsed.alternatives.length > MAX_NAME_ALTERNATIVES ? undefined : parsed.alternatives;
}

function parseAlternatives(
  pattern: string,
  start: number,
): { readonly alternatives: ReadonlyArray<string>; readonly next: number } | undefined {
  const alternatives: string[] = [];
  let index = start;
  for (;;) {
    const sequence = parseSequence(pattern, index);
    if (sequence === undefined) return undefined;
    alternatives.push(...sequence.alternatives);
    index = sequence.next;
    if (pattern[index] !== "|") return { alternatives, next: index };
    index += 1;
  }
}

function parseSequence(
  pattern: string,
  start: number,
): { readonly alternatives: ReadonlyArray<string>; readonly next: number } | undefined {
  let alternatives: ReadonlyArray<string> = [""];
  const append = (parts: ReadonlyArray<string>) => {
    alternatives = alternatives.flatMap((prefix) => parts.map((part) => prefix + part));
    return alternatives.length <= MAX_NAME_ALTERNATIVES;
  };
  let index = start;
  while (index < pattern.length) {
    const char = pattern[index] ?? "";
    if (char === "|" || char === ")") break;
    if (pattern.startsWith("[^/]*", index)) {
      if (!append(["*"])) return undefined;
      index += 5;
      continue;
    }
    if (char === "\\") {
      const escaped = pattern[index + 1];
      if (escaped === undefined || isGlobSpecial(escaped) || /[A-Za-z0-9]/u.test(escaped)) {
        return undefined;
      }
      if (!append([escaped])) return undefined;
      index += 2;
      continue;
    }
    if (char === "[") {
      const close = pattern.indexOf("]", index + 1);
      const body = close === -1 ? "" : pattern.slice(index + 1, close);
      if (close === -1 || body === "" || body.startsWith("^") || /[\\[]/u.test(body)) {
        return undefined;
      }
      if (isQuantifier(pattern[close + 1])) return undefined;
      if (!append([`[${body}]`])) return undefined;
      index = close + 1;
      continue;
    }
    if (char === "(") {
      const group = parseAlternatives(pattern, index + 1);
      if (group === undefined || pattern[group.next] !== ")") return undefined;
      index = group.next + 1;
      const optional = pattern[index] === "?";
      if (optional) index += 1;
      else if (isQuantifier(pattern[index])) return undefined;
      if (!append(optional ? ["", ...group.alternatives] : group.alternatives)) return undefined;
      continue;
    }
    if (char === ".") {
      if (isQuantifier(pattern[index + 1])) return undefined;
      if (!append(["?"])) return undefined;
      index += 1;
      continue;
    }
    if (isGlobSpecial(char) || "^$+?*".includes(char)) return undefined;
    if (isQuantifier(pattern[index + 1])) return undefined;
    if (!append([char])) return undefined;
    index += 1;
  }
  return { alternatives, next: index };
}

function isQuantifier(char: string | undefined): boolean {
  return char === "*" || char === "+" || char === "?" || char === "{";
}

/** Characters Codex's Windows globs read as syntax, with no escape on Windows. */
function isGlobSpecial(char: string): boolean {
  return "*?[]{},".includes(char);
}
