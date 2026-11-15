/**
 * The secret guard on the host: the protected-file list in force, turned into
 * Seatbelt rules and Bubblewrap covers.
 *
 * Every confined launch that goes through the shared builder carries the list.
 * Full access is not confined at all, so no OS rule reaches it (maintainer
 * decision, 2026-10-31: "softer guard — full access is full access"). The list is host-wide: the
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
  serverProtectedPathPattern,
  type ProtectedFilesChoice,
  type ProtectedFilesLocations,
  type ResolvedProtectedEntry,
  type SecretGuardPlatform,
  windowsGuardPath,
} from "@octant/domain/secret-guard-policy";
import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32 } from "node:path";

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

let serverPattern:
  | {
      readonly choice: ProtectedFilesChoice;
      readonly text: string;
      readonly expression: RegExp;
    }
  | undefined;

/** One search reads thousands of paths, so the list is built once per change to it. */
function serverPatternInForce() {
  if (serverPattern?.choice !== state.choice) {
    const text = serverProtectedPathPattern(state.choice);
    serverPattern = { choice: state.choice, text, expression: new RegExp(text, "imu") };
  }
  return serverPattern;
}

/** Exact host setup passed only to its owned mediation preparation worker. */
export function secretGuardConfiguration(): Readonly<SecretGuardState> {
  return state;
}

/** The list in force, as the expression a person's server is asked to refuse by. */
export function currentServerProtectedPattern(): string {
  return serverPatternInForce().text;
}

/**
 * Whether a path on a person's server is one the list protects. It never
 * reads this host's disk or home, so a server path cannot be judged by what
 * happens to sit at that path here.
 */
export function isProtectedPathOnServer(path: string): boolean {
  return serverPatternInForce().expression.test(path);
}

export function secretGuardPlatform(platform: NodeJS.Platform): SecretGuardPlatform {
  if (platform === "darwin" || platform === "win32") return platform;
  return "linux";
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
  const windows = input.platform === "win32";
  const sshKeys = sshPrivateKeyFiles(windows ? win32.join(home, ".ssh") : join(home, ".ssh"))
    .map((path) => (windows ? windowsGuardPath(path) : path))
    .filter((path) => path !== undefined)
    .map(
      (path): ResolvedProtectedEntry => ({
        ruleId: "ssh-private-keys",
        label: "SSH private keys",
        channel: "ssh-agent",
        ownAccountExempt: false,
        ...(windows ? { foldCase: true as const } : {}),
        kind: "path",
        path,
      }),
    );
  return [...entries, ...sshKeys];
}

export interface SecretGuardMediationPolicy {
  readonly entries: ReadonlyArray<ResolvedProtectedEntry>;
  readonly ownAccountPaths: ReadonlyArray<string>;
  readonly sshCompanionDirectory: string | undefined;
}

/** Original structured rules, before startup enumeration or mount covers. */
export function secretGuardMediationPolicy(input: {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly ownAccountPaths: ReadonlyArray<string>;
}): SecretGuardMediationPolicy {
  const home = input.homeDirectory ?? homedir();
  return {
    entries: resolveProtectedFiles(
      {
        platform: secretGuardPlatform(input.platform),
        home,
        dataDirectory: state.dataDirectory,
        runtimeDirectory: state.runtimeDirectory,
      },
      state.choice,
    ),
    // An enrolled account's canonical forms are fixed for that launch. A later
    // symlink replacement must not transfer its exception to another sign-in.
    ownAccountPaths: uniqueForms(input.ownAccountPaths),
    sshCompanionDirectory: state.choice.removed.includes("ssh-private-keys")
      ? undefined
      : join(home, ".ssh"),
  };
}

/**
 * What Octant's own file tools still refuse at Full access. Full access is
 * full access for secret files too (maintainer decisions, 2026-10-31 and
 * 2026-11-15): Claude Code's file tools read any path there, and Octant's own
 * now read every other group, the person's added paths included. The
 * protected provider-account credentials stay refused at every level, the one
 * thing principle 6 lets Octant hold back from a provider's own app, as the
 * account's sign-in stays out of the instruction files Octant reads for
 * Claude at Full access: each provider's stored sign-in and Octant's managed
 * account homes. A runtime's own sign-in is still left to that runtime
 * through `ownAccountPaths`.
 */
const FULL_ACCESS_PROTECTED_RULES: ReadonlySet<ResolvedProtectedEntry["ruleId"]> = new Set([
  "provider-sign-ins" satisfies BuiltInProtectedFilesId,
]);

/**
 * The refusal for a file tool that names a protected path, or undefined. The
 * OS rule refuses the read anyway; this answers first so the agent and the
 * person read which rule refused it and which channel to use, instead of a
 * bare "Operation not permitted". The path is judged in every form it
 * resolves to, so a link out of the Project to a key is caught.
 *
 * `fullAccess` is a Full access caller's own file tool: there the guard is
 * soft and only the provider sign-ins stay refused (see
 * {@link FULL_ACCESS_PROTECTED_RULES}).
 */
export function secretGuardRefusal(
  path: string,
  options: {
    readonly ownAccountPaths?: ReadonlyArray<string>;
    readonly platform?: NodeJS.Platform;
    readonly homeDirectory?: string;
    readonly fullAccess?: boolean;
  } = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();
  const unjudged = unjudgedPathRefusal(path, platform, homeDirectory);
  if (unjudged !== "judge") return unjudged;
  const listed = secretGuardEntries({ platform, homeDirectory });
  const entries =
    options.fullAccess === true
      ? listed.filter((entry) => FULL_ACCESS_PROTECTED_RULES.has(entry.ruleId))
      : listed;
  const entry = protectedEntryFor(
    pathForms(path, platform),
    withResolvedForms(entries, platform),
    uniqueForms(options.ownAccountPaths ?? [], platform),
  );
  return entry === undefined ? undefined : protectedFileRefusal(entry, homeDirectory);
}

/**
 * Before any rule is read: a relative path answers no (only its caller knows
 * what it is relative to), and on Windows a path the guard cannot spell is
 * refused rather than let through. A share or device path (`\\server\x`,
 * `\\?\C:\x`), a drive-relative one (`C:x`) and a rooted one without a
 * drive (`\Users\x`, the current drive's root) can all name a protected file
 * by a spelling no entry matches, which on this list read as "not protected"
 * until this check existed.
 */
function unjudgedPathRefusal(
  path: string,
  platform: NodeJS.Platform,
  homeDirectory: string,
): string | undefined | "judge" {
  if (platform !== "win32") return path.startsWith("/") ? "judge" : undefined;
  if (windowsGuardPath(path) === undefined) {
    return /^(?:[\\/]|[A-Za-z]:(?![\\/]))/u.test(path) ? WINDOWS_UNSPELLED_PATH : undefined;
  }
  return windowsGuardPath(homeDirectory) === undefined ? WINDOWS_UNSPELLED_HOME : "judge";
}

const WINDOWS_UNSPELLED_PATH =
  "Refused by the secret guard: on Windows it judges only drive-absolute paths such as C:\\Users\\you\\file, so a share, device, or drive-relative path is refused. Name the file by its drive-absolute path instead. The list is in Settings › Permissions › Protected files.";
const WINDOWS_UNSPELLED_HOME =
  "Refused by the secret guard: this Windows home folder is not a drive-absolute path, so the protected-file list cannot be placed and every file tool path is refused. The list is in Settings › Permissions › Protected files.";

/**
 * Whether a path the agent wrote is one the list in force protects: an
 * absolute path, or one under `~/` or `$HOME/`. A relative path answers no,
 * since only its caller knows what it is relative to. Octant Shield asks this
 * to flag and judge a call; it never allows anything.
 */
export function isProtectedSecretPath(
  path: string,
  options: { readonly platform?: NodeJS.Platform; readonly homeDirectory?: string } = {},
): boolean {
  const homeDirectory = options.homeDirectory ?? homedir();
  const home = /^(?:~|\$HOME|\$\{HOME\})(?=\/|$)/.exec(path);
  const absolute = home === null ? path : `${homeDirectory}${path.slice(home[0].length)}`;
  return secretGuardRefusal(absolute, { ...options, homeDirectory }) !== undefined;
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
  const platform = options.platform ?? process.platform;
  const homeDirectory = options.homeDirectory ?? homedir();
  const unjudged = unjudgedPathRefusal(root, platform, homeDirectory);
  if (unjudged !== "judge") return unjudged;
  const entries = withResolvedForms(secretGuardEntries({ platform, homeDirectory }), platform);
  const own = uniqueForms(options.ownAccountPaths ?? [], platform);
  const roots = pathForms(root, platform);
  const inside = protectedEntryFor(roots, entries, own);
  const explain = (entry: ResolvedProtectedEntry) =>
    [
      protectedFileRefusal(entry, homeDirectory),
      `This search would read it from ${JSON.stringify(root)}. The native search cannot enforce protected-file exclusions, so no search results were returned. Search an ordinary subfolder with no protected entry instead; use the named authorized channel for the protected material.`,
    ].join(" ");
  if (inside !== undefined) return explain(inside);
  const exempt = (entry: ResolvedProtectedEntry, location: string) =>
    entry.ownAccountExempt && own.some((owned) => isSameOrInside(location, owned));
  // A pattern entry also reaches a root inside its folder: a search rooted at
  // a browser profile reads the `Cookies` and `logins.json` below it, though
  // the profile folder itself neither matches the pattern nor contains the
  // entry's folder. `levelsBelow` is how many levels of the entry the root
  // still holds (the root itself was judged above).
  const levelsBelow = (entry: ResolvedProtectedEntry & { readonly kind: "names" }, form: string) =>
    isSameOrInside(form, entry.directory) && form !== entry.directory
      ? entry.depth - form.slice(entry.directory.length + 1).split("/").length
      : undefined;
  if (platform === "win32") {
    // No walk on Windows yet: a root at or above any entry's location, or
    // inside a pattern entry's folder with levels of it left, is refused
    // whether or not the file exists, which refuses more searches than the
    // walk would, never fewer.
    const beneath = entries.find((entry) => {
      const location = entry.kind === "path" ? entry.path : entry.directory;
      if (exempt(entry, location)) return false;
      if (roots.some((form) => isSameOrInside(location, form))) return true;
      return entry.kind === "names" && roots.some((form) => (levelsBelow(entry, form) ?? 0) > 0);
    });
    return beneath === undefined ? undefined : explain(beneath);
  }
  const covered = secretGuardLinuxPaths({
    entries: entries.filter((entry) => entry.kind === "path"),
    ownAccountPaths: own,
    withinRoots: roots,
  })
    .filter((path) => roots.some((form) => isSameOrInside(path, form)))
    .sort();
  for (const path of covered) {
    const entry = protectedEntryFor([path], entries, own);
    if (entry === undefined) continue;
    return explain(entry);
  }
  // Pattern entries are walked from wherever the search starts: from the
  // entry's folder when the root holds it, from the root when the root is
  // inside it. A walk that runs out of its budget refuses, because the
  // shared walk used to stop at its limit and answer "nothing found" for a
  // folder as crowded as `~/Library/Application Support`.
  for (const entry of entries) {
    if (entry.kind !== "names" || exempt(entry, entry.directory)) continue;
    for (const form of roots) {
      const start = isSameOrInside(entry.directory, form)
        ? { directory: entry.directory, levels: entry.depth }
        : { directory: form, levels: levelsBelow(entry, form) ?? 0 };
      if (start.levels <= 0) continue;
      const found = patternMatchBeneath(start.directory, start.levels, entry);
      if (found === "found") return explain(entry);
      if (found === "truncated") {
        return [
          protectedFileRefusal(entry, homeDirectory),
          `This search from ${JSON.stringify(root)} could not finish checking for those stores (over ${String(SEARCH_WALK_LIMIT)} entries), so no search results were returned. Search a smaller folder instead.`,
        ].join(" ");
      }
    }
  }
  return undefined;
}

const SEARCH_WALK_LIMIT = 4_096;

/** Whether a file `levels` deep or less below `directory` matches the entry. */
function patternMatchBeneath(
  directory: string,
  levels: number,
  entry: ResolvedProtectedEntry & { readonly kind: "names" },
): "found" | "none" | "truncated" {
  const pattern = new RegExp(`^(?:${entry.name})$`, "u");
  const except = entry.except === undefined ? undefined : new RegExp(`^(?:${entry.except})$`, "u");
  let visited = 0;
  const walk = (current: string, depth: number): "found" | "none" | "truncated" => {
    let children: ReadonlyArray<import("node:fs").Dirent>;
    try {
      children = readdirSync(current, { withFileTypes: true });
    } catch {
      return "none";
    }
    for (const child of children) {
      visited += 1;
      if (visited > SEARCH_WALK_LIMIT) return "truncated";
      if (except?.test(child.name) !== true && pattern.test(child.name)) return "found";
      if (depth < levels && child.isDirectory() && !child.isSymbolicLink()) {
        const below = walk(join(current, child.name), depth + 1);
        if (below !== "none") return below;
      }
    }
    return "none";
  };
  return walk(directory, 1);
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
  platform: NodeJS.Platform = process.platform,
): ReadonlyArray<ResolvedProtectedEntry> {
  return entries.flatMap((entry): ReadonlyArray<ResolvedProtectedEntry> => {
    const location = entry.kind === "path" ? entry.path : entry.directory;
    return pathForms(location, platform).map((form) =>
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
   * `deny-default`: a confined launch, where a re-allow is emitted only for
   * what the launch was granted anyway. `allow-default` is only the person's
   * own-path rules, which are denials alone.
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
function pathForms(
  path: string,
  platform: NodeJS.Platform = process.platform,
): ReadonlyArray<string> {
  if (platform === "win32") return windowsPathForms(path);
  const lexical = normalizePosix(path);
  // Normalizing `link/..` first can erase the symlink the kernel traverses.
  const resolved = realPathOfExistingPrefix(path);
  return resolved === lexical ? [lexical] : [lexical, resolved];
}

function uniqueForms(
  paths: ReadonlyArray<string>,
  platform: NodeJS.Platform = process.platform,
): ReadonlyArray<string> {
  return [...new Set(paths.flatMap((path) => pathForms(path, platform)))];
}

/**
 * A Windows path, native (`C:\\x`) or already in guard form (`/c:/x`), in
 * guard form and under the final path the system resolves its longest
 * existing prefix to, so a junction or link into a protected folder is
 * caught as it is on the other platforms. A path the guard cannot spell has
 * no form; its caller refused it before asking.
 */
function windowsPathForms(path: string): ReadonlyArray<string> {
  const native = /^\/[A-Za-z]:(?:\/|$)/u.test(path) ? `${path.slice(1, 3)}/${path.slice(4)}` : path;
  const lexical = windowsGuardPath(native);
  if (lexical === undefined) return [];
  const resolved = windowsRealForm(native);
  return resolved === undefined || resolved === lexical ? [lexical] : [lexical, resolved];
}

function windowsRealForm(native: string): string | undefined {
  let current = win32.resolve(native);
  const rest: string[] = [];
  for (;;) {
    try {
      return windowsGuardPath(win32.join(realpathSync.native(current), ...rest));
    } catch {
      const parent = win32.dirname(current);
      if (parent === current) return undefined;
      rest.unshift(win32.basename(current));
      current = parent;
    }
  }
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
      const real = realpathSync.native(prefix);
      const rest = segments.slice(index);
      return normalizePosix(rest.length === 0 ? real : `${real}/${rest.join("/")}`);
    } catch {
      // Try a shorter prefix.
    }
  }
  return path;
}
