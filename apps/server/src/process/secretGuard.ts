/**
 * The secret guard on the host: the protected-file list in force, turned into
 * Seatbelt rules and Bubblewrap covers.
 *
 * Every launch that goes through the shared builder carries the list, and at
 * Full access, where Octant otherwise confines nothing, a runtime and its
 * commands still run under a minimal allow-all profile whose only rules are
 * these denials (maintainer decision, 2026-10-31). The list is host-wide: the
 * person's changes in Settings › Permissions › Protected files reach every
 * later launch, which is why it is held here once rather than threaded through
 * each launcher's options.
 */
import type { BuiltInProtectedFilesId } from "@octant/contracts/protected-files";
import {
  NO_PROTECTED_FILES_CHANGES,
  isSameOrInside,
  normalizePosix,
  protectedEntryFor,
  protectedFileRefusal,
  resolveProtectedFiles,
  type ProtectedFilesChoice,
  type ProtectedFilesLocations,
  type ResolvedProtectedEntry,
  type SecretGuardPlatform,
} from "@octant/domain/secret-guard-policy";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface SecretGuardState {
  readonly dataDirectory?: string | undefined;
  readonly runtimeDirectory?: string | undefined;
  readonly choice: ProtectedFilesChoice;
}

let state: SecretGuardState = { choice: NO_PROTECTED_FILES_CHANGES };

/**
 * Where Octant keeps its own secrets, set once the host knows its paths. A
 * launch before that still carries every home-folder rule.
 */
export function configureSecretGuardLocations(input: {
  readonly dataDirectory: string;
  readonly runtimeDirectory?: string | undefined;
}): void {
  state = {
    ...state,
    dataDirectory: input.dataDirectory,
    runtimeDirectory: input.runtimeDirectory ?? state.runtimeDirectory,
  };
}

/** The person's changes, applied to every launch prepared after this call. */
export function applyProtectedFilesChoice(choice: ProtectedFilesChoice): void {
  state = { ...state, choice };
}

export function currentProtectedFilesChoice(): ProtectedFilesChoice {
  return state.choice;
}

export function secretGuardPlatform(platform: NodeJS.Platform): SecretGuardPlatform {
  return platform === "darwin" ? "darwin" : "linux";
}

/** The list in force for a launch whose home folder is `homeDirectory`. */
export function secretGuardEntries(input: {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory?: string | undefined;
}): ReadonlyArray<ResolvedProtectedEntry> {
  const home = input.homeDirectory ?? homedir();
  const locations: ProtectedFilesLocations = {
    platform: secretGuardPlatform(input.platform),
    home,
    dataDirectory: state.dataDirectory,
    runtimeDirectory: state.runtimeDirectory,
  };
  const entries = resolveProtectedFiles(locations, state.choice);
  // A private key with a name of its own (`github_ed25519`) is still a key.
  // It is found by its `.pub` companion, from the folder listing alone; no
  // file in `~/.ssh` is opened.
  if (state.choice.removed.includes("ssh-private-keys" satisfies BuiltInProtectedFilesId)) {
    return entries;
  }
  const sshKeys = sshPrivateKeyFiles(join(home, ".ssh")).map(
    (path): ResolvedProtectedEntry => ({
      ruleId: "ssh-private-keys",
      label: "SSH private keys",
      channel: "ssh-agent",
      ownAccountExempt: false,
      kind: "path",
      path,
    }),
  );
  return [...entries, ...sshKeys];
}

/**
 * The refusal for a file tool that names a protected path, or undefined. The
 * OS rule refuses the read anyway; this answers first so the agent and the
 * person read which rule refused it and which channel to use, instead of a
 * bare "Operation not permitted". The path is judged in every form it
 * resolves to, so a link out of the Project to a key is caught.
 */
export function secretGuardRefusal(
  path: string,
  options: {
    readonly ownAccountPaths?: ReadonlyArray<string>;
    readonly platform?: NodeJS.Platform;
    readonly homeDirectory?: string;
  } = {},
): string | undefined {
  if (!path.startsWith("/")) return undefined;
  const homeDirectory = options.homeDirectory ?? homedir();
  const entries = secretGuardEntries({
    platform: options.platform ?? process.platform,
    homeDirectory,
  });
  const entry = protectedEntryFor(
    pathForms(path),
    withResolvedForms(entries),
    uniqueForms(options.ownAccountPaths ?? []),
  );
  return entry === undefined ? undefined : protectedFileRefusal(entry, homeDirectory);
}

/**
 * The refusal for a search (a grep, a glob, a listing) rooted at `root`, or
 * undefined. A search reads every file beneath its root, so a root at or
 * above an existing protected file is refused, naming that file: a search
 * rooted at `~/.aws` would otherwise read `~/.aws/credentials` through a tool
 * that names only the folder. A root inside a protected folder is refused
 * the same way.
 */
export function secretGuardSearchRefusal(
  root: string,
  options: {
    readonly ownAccountPaths?: ReadonlyArray<string>;
    readonly platform?: NodeJS.Platform;
    readonly homeDirectory?: string;
  } = {},
): string | undefined {
  if (!root.startsWith("/")) return undefined;
  const homeDirectory = options.homeDirectory ?? homedir();
  const entries = withResolvedForms(
    secretGuardEntries({ platform: options.platform ?? process.platform, homeDirectory }),
  );
  const own = uniqueForms(options.ownAccountPaths ?? []);
  const roots = pathForms(root);
  const inside = protectedEntryFor(roots, entries, own);
  if (inside !== undefined) return protectedFileRefusal(inside, homeDirectory);
  const covered = secretGuardLinuxPaths({ entries, ownAccountPaths: own, withinRoots: roots })
    .filter((path) => roots.some((form) => isSameOrInside(path, form)))
    .sort();
  for (const path of covered) {
    const entry = protectedEntryFor([path], entries, own);
    if (entry === undefined) continue;
    return [
      protectedFileRefusal(entry, homeDirectory),
      "This search would read it: search a folder that holds no protected file.",
    ].join(" ");
  }
  return undefined;
}

/**
 * Each entry under its lexical spelling and under the path the kernel
 * resolves it to. A requested path is judged in both forms, and so must the
 * list be: with `~/.aws` a link to another folder, a tool naming the link's
 * target directly otherwise matched nothing, though the Seatbelt rules deny
 * both spellings.
 */
function withResolvedForms(
  entries: ReadonlyArray<ResolvedProtectedEntry>,
): ReadonlyArray<ResolvedProtectedEntry> {
  return entries.flatMap((entry): ReadonlyArray<ResolvedProtectedEntry> => {
    const location = entry.kind === "path" ? entry.path : entry.directory;
    return pathForms(location).map((form) =>
      entry.kind === "path" ? { ...entry, path: form } : { ...entry, directory: form },
    );
  });
}

const SSH_SCAN_LIMIT = 256;

/**
 * Files directly in `~/.ssh` with a `.pub` companion: `ssh-keygen` writes a
 * key pair as `name` and `name.pub`, so the companion names the private key
 * without the host opening it. Name patterns cover `id_*` and the usual key
 * extensions even for files created after launch; this catches the rest that
 * exist at launch.
 */
function sshPrivateKeyFiles(directory: string): ReadonlyArray<string> {
  // Every confined launch builds a profile, Git probes included, so the scan
  // is kept until the folder changes: adding, removing, or renaming a key
  // moves the folder's mtime.
  let mtimeMs: number;
  try {
    mtimeMs = statSync(directory).mtimeMs;
  } catch {
    return [];
  }
  const cached = sshScanCache.get(directory);
  if (cached !== undefined && cached.mtimeMs === mtimeMs) return cached.keys;
  const keys = scanSshPrivateKeyFiles(directory);
  sshScanCache.set(directory, { mtimeMs, keys });
  if (sshScanCache.size > 8) {
    const oldest = sshScanCache.keys().next().value;
    if (oldest !== undefined) sshScanCache.delete(oldest);
  }
  return keys;
}

const sshScanCache = new Map<
  string,
  { readonly mtimeMs: number; readonly keys: ReadonlyArray<string> }
>();

function scanSshPrivateKeyFiles(directory: string): ReadonlyArray<string> {
  let names: ReadonlyArray<string>;
  try {
    names = readdirSync(directory).slice(0, SSH_SCAN_LIMIT);
  } catch {
    return [];
  }
  const present = new Set(names);
  return names
    .filter((name) => !name.endsWith(".pub") && present.has(`${name}.pub`))
    .map((name) => join(directory, name));
}

export interface SecretGuardSeatbeltInput {
  readonly entries: ReadonlyArray<ResolvedProtectedEntry>;
  /**
   * The launching runtime's own account paths. A sign-in entry at or beneath
   * one is not denied, and one beneath a denied sign-in folder is re-allowed.
   */
  readonly ownAccountPaths: ReadonlyArray<string>;
  /**
   * `allow-default`: the minimal Full access profile, where a re-allow adds no
   * reach. `deny-default`: a confined launch, where a re-allow is emitted only
   * for what the launch was granted anyway.
   */
  readonly profile: "allow-default" | "deny-default";
  /** Deny-default only: roots this launch may read, which bound an exception. */
  readonly readableRoots?: ReadonlyArray<string>;
  /** Deny-default only: own paths the launch may also write. */
  readonly ownWriteRoots?: ReadonlyArray<string>;
}

/**
 * The secret-file rules for one Seatbelt profile. Seatbelt applies the last
 * matching rule, so these follow every grant in the profile they join.
 */
export function secretGuardSeatbeltRules(input: SecretGuardSeatbeltInput): ReadonlyArray<string> {
  const own = uniqueForms(input.ownAccountPaths);
  const ownWrite = uniqueForms(input.ownWriteRoots ?? []);
  const readable = uniqueForms(input.readableRoots ?? []);
  // Seatbelt applies the last matching rule, so an exception (an account's own
  // home, public keys, the login keychain) reopens whatever was denied before
  // it. Each exception therefore follows only its own rule's denial, and every
  // rule with no exception is denied after all of them: an exception can
  // reopen the path its rule was written around and nothing another rule
  // protects. The person's own paths come later still (`secretGuardPersonRules`).
  const excepted: string[] = [];
  const plain: string[] = [];
  for (const entry of input.entries) {
    if (entry.ruleId === "added") continue;
    const block = entryRules(entry, own, ownWrite, readable, input.profile);
    if (block.exceptions.length === 0) plain.push(...block.denials);
    else excepted.push(...block.denials, ...block.exceptions);
  }
  return [...new Set([...excepted, ...plain])];
}

/**
 * The paths the person added, denied after every built-in rule and every
 * exception, and after a launch's own extra rules, so nothing reopens them.
 */
export function secretGuardPersonRules(
  entries: ReadonlyArray<ResolvedProtectedEntry>,
): ReadonlyArray<string> {
  return [
    ...new Set(
      entries
        .filter((entry) => entry.ruleId === "added")
        .flatMap((entry) => entryRules(entry, [], [], [], "allow-default").denials),
    ),
  ];
}

function entryRules(
  entry: ResolvedProtectedEntry,
  own: ReadonlyArray<string>,
  ownWrite: ReadonlyArray<string>,
  readable: ReadonlyArray<string>,
  profile: SecretGuardSeatbeltInput["profile"],
): { readonly denials: ReadonlyArray<string>; readonly exceptions: ReadonlyArray<string> } {
  const denials: string[] = [];
  const exceptions: string[] = [];
  if (entry.kind === "path") {
    const forms = pathForms(entry.path);
    if (entry.ownAccountExempt && forms.some((form) => own.some((o) => isSameOrInside(form, o)))) {
      return { denials, exceptions };
    }
    for (const form of forms) {
      denials.push(`(deny file-read* file-write* (subpath "${escapeSeatbeltString(form)}"))`);
    }
    if (!entry.ownAccountExempt) return { denials, exceptions };
    for (const owned of own) {
      if (!forms.some((form) => owned !== form && isSameOrInside(owned, form))) continue;
      if (profile === "allow-default") {
        exceptions.push(
          `(allow file-read* file-write* (subpath "${escapeSeatbeltString(owned)}"))`,
        );
        continue;
      }
      exceptions.push(`(allow file-read* (subpath "${escapeSeatbeltString(owned)}"))`);
      if (ownWrite.some((root) => isSameOrInside(owned, root))) {
        exceptions.push(`(allow file-write* (subpath "${escapeSeatbeltString(owned)}"))`);
      }
    }
    return { denials, exceptions };
  }
  for (const directory of pathForms(entry.directory)) {
    denials.push(
      `(deny file-read* file-write* (regex #"${namesRegex(directory, entry.name, entry.depth)}"))`,
    );
    if (entry.except === undefined) continue;
    const reachable =
      profile === "allow-default" || readable.some((root) => isSameOrInside(directory, root));
    if (!reachable) continue;
    // A confined launch gets the exception back for reading only: write
    // reach under a read-only root is not the exception's to give.
    const operations = profile === "allow-default" ? "file-read* file-write*" : "file-read*";
    exceptions.push(
      `(allow ${operations} (regex #"${namesRegex(directory, entry.except, entry.depth)}"))`,
    );
  }
  return { denials, exceptions };
}

/** The Full access profile: everything allowed, then only the secret files denied. */
export function buildSecretGuardSeatbeltProfile(input: {
  readonly entries: ReadonlyArray<ResolvedProtectedEntry>;
  readonly ownAccountPaths: ReadonlyArray<string>;
  readonly additionalDenyPaths?: ReadonlyArray<string>;
}): string {
  return [
    "(version 1)",
    "(allow default)",
    ...(input.additionalDenyPaths ?? []).flatMap((path) => [
      `(deny file-read* (subpath "${escapeSeatbeltString(path)}"))`,
      `(deny file-write* (subpath "${escapeSeatbeltString(path)}"))`,
    ]),
    ...secretGuardSeatbeltRules({
      entries: input.entries,
      ownAccountPaths: input.ownAccountPaths,
      profile: "allow-default",
    }),
    ...secretGuardPersonRules(input.entries),
  ].join("\n");
}

const LINUX_WALK_LIMIT = 4_096;

/**
 * The existing paths a Bubblewrap launch covers. Bubblewrap mounts over a
 * path, so a protected file that does not exist yet is not covered: it would
 * have to be created as a placeholder in the person's own home folder first.
 * A file created mid-session is covered from the next launch on.
 */
export function secretGuardLinuxPaths(input: {
  readonly entries: ReadonlyArray<ResolvedProtectedEntry>;
  readonly ownAccountPaths: ReadonlyArray<string>;
  /**
   * The capsule's bound roots, when it binds only those: an entry no root
   * reaches is absent from the capsule already, and is not walked.
   */
  readonly withinRoots?: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  const own = uniqueForms(input.ownAccountPaths);
  const roots = input.withinRoots?.map(normalizePosix);
  const reachable = (path: string) =>
    roots === undefined ||
    roots.some((root) => isSameOrInside(path, root) || isSameOrInside(root, path));
  const paths = new Set<string>();
  for (const entry of input.entries) {
    if (!reachable(entry.kind === "path" ? entry.path : entry.directory)) continue;
    if (entry.kind === "path") {
      if (!existsSync(entry.path)) continue;
      if (entry.ownAccountExempt && own.some((owned) => isSameOrInside(entry.path, owned))) {
        continue;
      }
      const inside = entry.ownAccountExempt
        ? own.filter((owned) => owned !== entry.path && isSameOrInside(owned, entry.path))
        : [];
      for (const path of coverExcept(entry.path, inside)) paths.add(path);
      continue;
    }
    const pattern = new RegExp(`^(?:${entry.name})$`, "u");
    const except =
      entry.except === undefined ? undefined : new RegExp(`^(?:${entry.except})$`, "u");
    let visited = 0;
    const walk = (directory: string, depth: number) => {
      if (depth > entry.depth || visited > LINUX_WALK_LIMIT) return;
      let children: ReadonlyArray<import("node:fs").Dirent>;
      try {
        children = readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const child of children) {
        visited += 1;
        const path = join(directory, child.name);
        const excepted = except?.test(child.name) === true;
        if (!excepted && pattern.test(child.name)) paths.add(path);
        else if (child.isDirectory() && !child.isSymbolicLink()) walk(path, depth + 1);
      }
    };
    walk(entry.directory, 1);
  }
  return [...paths];
}

/** A folder's children except the ones on the way to an own path, recursively. */
function coverExcept(path: string, own: ReadonlyArray<string>): ReadonlyArray<string> {
  if (own.length === 0) return [path];
  let children: ReadonlyArray<string>;
  try {
    children = readdirSync(path);
  } catch {
    return [path];
  }
  const covers: string[] = [];
  for (const name of children) {
    const child = join(path, name);
    if (own.includes(child)) continue;
    const beneath = own.filter((owned) => isSameOrInside(owned, child));
    if (beneath.length === 0) covers.push(child);
    else covers.push(...coverExcept(child, beneath));
  }
  return covers;
}

/**
 * Seatbelt's regex filter takes no `{m,n}` interval: measured on macOS 27, a
 * rule with `([^/]+/){0,1}` matched nothing and left the file readable. The
 * folders between are nested optional groups instead.
 */
function namesRegex(directory: string, name: string, depth: number): string {
  let between = "";
  for (let level = 1; level < depth; level += 1) between = `([^/]+/${between})?`;
  return `^${escapeRegex(directory)}/${between}(${name})$`;
}

/** Escapes POSIX extended regex metacharacters, and Seatbelt's string quote. */
function escapeRegex(path: string): string {
  if (path.includes('"')) {
    throw new Error("A protected folder name with a double quote cannot join a Seatbelt profile.");
  }
  return path.replace(/[.[\]()*+?{}|^$\\]/gu, (character) => `\\${character}`);
}

function escapeSeatbeltString(path: string): string {
  return path.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

/** The lexical path and the one the kernel resolves it to, when they differ. */
function pathForms(path: string): ReadonlyArray<string> {
  const lexical = normalizePosix(path);
  const resolved = realPathOfExistingPrefix(lexical);
  return resolved === lexical ? [lexical] : [lexical, resolved];
}

function uniqueForms(paths: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(paths.flatMap((path) => pathForms(path)))];
}

/**
 * The real path of `path`, resolving the longest prefix that exists, so a
 * protected file that does not exist yet is still named where the kernel will
 * look for it (`/var/...` is `/private/var/...` on macOS).
 */
function realPathOfExistingPrefix(path: string): string {
  const segments = path.split("/").filter((segment) => segment !== "");
  for (let index = segments.length; index >= 0; index -= 1) {
    const prefix = `/${segments.slice(0, index).join("/")}`;
    try {
      if (index < segments.length && !statSync(prefix).isDirectory()) return path;
      const real = realpathSync(prefix);
      const rest = segments.slice(index);
      return normalizePosix(rest.length === 0 ? real : `${real}/${rest.join("/")}`);
    } catch {
      // Try a shorter prefix.
    }
  }
  return path;
}
