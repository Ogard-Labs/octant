import type {
  BuiltInProtectedFilesId,
  ProtectedFilesChannel,
} from "@octant/contracts/protected-files";

/**
 * The secret guard: one list of secret files that Octant's own tools never read
 * or write at any guardrail level, and that no runtime, and no command a
 * runtime runs, may read or write below Full access. Full access is no
 * sandbox: there the list is a soft guard (Octant's tools, tags from the
 * Judge and Watcher, redaction) and a shell command can read the files
 * (maintainer decision, 2026-10-31: "softer guard — full access is full
 * access").
 *
 * Friction stays low because the work these files serve goes through a channel
 * instead of the file: SSH through the agent socket, Git over HTTPS through the
 * system credential helper, keys through the credential broker. So the list
 * names what a channel replaces, and leaves readable what tools need to work at
 * all: SSH `config`, `known_hosts`, and public keys stay readable.
 *
 * This module is the list and its meaning. Turning it into Seatbelt rules or
 * Bubblewrap covers is the host's job, because only the host can see which of
 * the files exist.
 */

export type SecretGuardPlatform = "darwin" | "linux";

/** Where an entry's path is rooted. */
export type ProtectedFilesBase = "home" | "data" | "runtime";

export type ProtectedFilesEntry =
  /** A file, or a folder and everything beneath it. */
  | { readonly kind: "path"; readonly base: ProtectedFilesBase; readonly path: string }
  /**
   * Files at most `depth` levels below `directory` whose name matches `name`,
   * a POSIX extended regular expression body (no anchors, no `/`). The same
   * text is used by Seatbelt's regex filter and by a JavaScript `RegExp`, so
   * it stays inside the syntax both accept: no look-around, no back-references.
   */
  | {
      readonly kind: "names";
      readonly base: ProtectedFilesBase;
      readonly directory: string;
      readonly name: string;
      readonly depth: number;
      /**
       * Names, at the same depths, that stay reachable although `name`
       * matches them. Applied only where the launch could reach them anyway,
       * so an exception never widens what a launch may read. The same syntax
       * limits apply as to `name`; Seatbelt also has no `{m,n}` intervals.
       */
      readonly except?: string;
    };

export interface ProtectedFilesRule {
  readonly id: BuiltInProtectedFilesId;
  readonly label: string;
  readonly channel: ProtectedFilesChannel;
  /**
   * Whether a runtime's own account paths are exempt. Only sign-ins are: a
   * runtime may read its own sign-in and no other tool's, and never an SSH key
   * or a cloud credential whatever it was granted.
   */
  readonly ownAccountExempt: boolean;
  readonly entries: ReadonlyArray<ProtectedFilesEntry>;
}

const home = (path: string): ProtectedFilesEntry => ({ kind: "path", base: "home", path });
const names = (
  directory: string,
  name: string,
  depth: number,
  options: { readonly base?: ProtectedFilesBase; readonly except?: string } = {},
): ProtectedFilesEntry => ({
  kind: "names",
  base: options.base ?? "home",
  directory,
  name,
  depth,
  ...(options.except === undefined ? {} : { except: options.except }),
});

/** The login keychain database and its SQLite companions. */
export const LOGIN_KEYCHAIN_NAME = "login\\.keychain-db(-wal|-shm|-journal)?";

/**
 * A file name starting `id_`; its `.pub` companion is the exception. The
 * exception is a separate pattern rather than one expression that excludes
 * `.pub`: Seatbelt's regex filter has no interval syntax, and measured on
 * macOS 27 an alternation of the form `[^/]*[^./][^/][^/][^/]$` matched
 * `id_test.pub`, so the one-expression form denied public keys too.
 */
export const SSH_PRIVATE_KEY_NAME = "id_[^/]*";
export const SSH_PUBLIC_KEY_NAME = "[^/]*\\.pub";

/** One browser engine family's profile stores: cookies, saved passwords, and autofill. */
const PROFILE_STORE_NAME =
  "(Cookies|Login Data|Login Data For Account|Web Data|Safe Browsing Cookies)(-journal|-wal|-shm)?";
/** The other engine family's profile stores: cookies, saved logins, and the key database. */
const PROFILE_LOGIN_STORE_NAME =
  "(cookies\\.sqlite|logins\\.json|key[34]\\.db|signons\\.sqlite)(-wal|-shm)?";

function builtInRules(platform: SecretGuardPlatform): ReadonlyArray<ProtectedFilesRule> {
  const darwin = platform === "darwin";
  return [
    {
      id: "ssh-private-keys",
      label: "SSH private keys",
      channel: "ssh-agent",
      ownAccountExempt: false,
      entries: [
        names(".ssh", SSH_PRIVATE_KEY_NAME, 2, { except: SSH_PUBLIC_KEY_NAME }),
        names(".ssh", "[^/]*\\.(pem|key|p12|pfx|ppk)", 2),
        names(".ssh", "identity", 1),
      ],
    },
    {
      id: "cloud-credentials",
      label: "Cloud command-line credentials",
      channel: "credential-broker",
      ownAccountExempt: false,
      entries: [
        home(".aws/credentials"),
        home(".aws/sso/cache"),
        home(".aws/cli/cache"),
        home(".config/gcloud/credentials.db"),
        home(".config/gcloud/access_tokens.db"),
        home(".config/gcloud/application_default_credentials.json"),
        home(".config/gcloud/legacy_credentials"),
        home(".azure/msal_token_cache.json"),
        home(".azure/msal_token_cache.bin"),
        home(".azure/accessTokens.json"),
        home(".azure/service_principal_entries.json"),
      ],
    },
    {
      id: "cluster-configuration",
      label: "Cluster configuration",
      channel: "credential-broker",
      ownAccountExempt: false,
      entries: [home(".kube/config")],
    },
    {
      id: "container-registry-sign-in",
      label: "Container registry sign-in",
      channel: "credential-broker",
      ownAccountExempt: false,
      entries: [home(".docker/config.json")],
    },
    {
      id: "package-registry-tokens",
      label: "Package registry tokens",
      channel: "credential-broker",
      ownAccountExempt: false,
      entries: [
        home(".npmrc"),
        home(".pypirc"),
        home(".gem/credentials"),
        home(".cargo/credentials"),
        home(".cargo/credentials.toml"),
      ],
    },
    {
      id: "git-credential-files",
      label: "Git and network credential files",
      channel: "git-credential-helper",
      ownAccountExempt: false,
      entries: [home(".git-credentials"), home(".config/git/credentials"), home(".netrc")],
    },
    {
      id: "forge-cli-sign-in",
      label: "Forge command-line sign-in",
      channel: "git-credential-helper",
      ownAccountExempt: false,
      entries: [home(".config/gh/hosts.yml")],
    },
    {
      id: "keychains-and-vaults",
      label: "Keychains and password vaults",
      channel: "keychain-api",
      ownAccountExempt: false,
      entries: darwin
        ? [
            // The login keychain itself stays readable: the Security framework
            // opens it in the calling process, so `git credential-osxkeychain`,
            // `security`, and a runtime's own Keychain sign-in fail without it.
            // Its items stay encrypted and unlock only through that service.
            names("Library/Keychains", "[^/]*", 3, { except: LOGIN_KEYCHAIN_NAME }),
            home(
              "Library/Group Containers/2BUA8C4S2C.com.1password/Library/Application Support/1Password/Data",
            ),
            home("Library/Application Support/1Password"),
            home("Library/Application Support/Bitwarden"),
            home(
              "Library/Containers/com.bitwarden.desktop/Data/Library/Application Support/Bitwarden",
            ),
          ]
        : [home(".local/share/keyrings"), home(".config/1Password"), home(".config/Bitwarden")],
    },
    {
      id: "browser-cookies-and-logins",
      label: "Browser cookies and saved logins",
      channel: "none",
      ownAccountExempt: false,
      entries: darwin
        ? [
            names("Library/Application Support", PROFILE_STORE_NAME, 5),
            names("Library/Application Support/Firefox/Profiles", PROFILE_LOGIN_STORE_NAME, 2),
            home("Library/Cookies"),
            home("Library/Containers/com.apple.Safari/Data/Library/Cookies"),
          ]
        : [
            names(".config", PROFILE_STORE_NAME, 5),
            names(".mozilla/firefox", PROFILE_LOGIN_STORE_NAME, 2),
          ],
    },
    {
      id: "octant-credentials",
      label: "Octant credentials and key files",
      channel: "credential-broker",
      ownAccountExempt: false,
      entries: [
        { kind: "path", base: "data", path: "octant-bridge-secret" },
        { kind: "path", base: "data", path: "remote" },
        { kind: "path", base: "data", path: "integrations" },
        names("", "[^/]*\\.secret", 1, { base: "runtime" }),
      ],
    },
    {
      id: "provider-sign-ins",
      label: "Provider sign-ins",
      channel: "provider-sign-in",
      ownAccountExempt: true,
      entries: [
        home(".claude/.credentials.json"),
        home(".codex/auth.json"),
        home(".local/share/opencode/auth.json"),
        home(".gemini/oauth_creds.json"),
        home(".qwen/oauth_creds.json"),
        home(".pi/agent/auth.json"),
        home(".config/github-copilot/hosts.json"),
        home(".config/github-copilot/apps.json"),
        // Octant's managed account homes, one per provider account. A runtime
        // is launched with its own one re-allowed.
        { kind: "path", base: "data", path: "providers" },
      ],
    },
  ];
}

export function builtInProtectedFiles(
  platform: SecretGuardPlatform,
): ReadonlyArray<ProtectedFilesRule> {
  return builtInRules(platform);
}

export interface ProtectedFilesLocations {
  readonly platform: SecretGuardPlatform;
  readonly home: string;
  /** Octant's data directory; absent where the host has not resolved one. */
  readonly dataDirectory?: string | undefined;
  /** Octant's owner-only runtime directory. */
  readonly runtimeDirectory?: string | undefined;
}

/** What the person changed: paths added, and built-in groups removed after confirming. */
export interface ProtectedFilesChoice {
  readonly added: ReadonlyArray<string>;
  readonly removed: ReadonlyArray<BuiltInProtectedFilesId>;
}

export const NO_PROTECTED_FILES_CHANGES: ProtectedFilesChoice = { added: [], removed: [] };

/** An entry with its base resolved to an absolute location. */
export type ResolvedProtectedEntry = {
  readonly ruleId: BuiltInProtectedFilesId | "added";
  readonly label: string;
  readonly channel: ProtectedFilesChannel;
  readonly ownAccountExempt: boolean;
} & (
  | { readonly kind: "path"; readonly path: string }
  | {
      readonly kind: "names";
      readonly directory: string;
      readonly name: string;
      readonly depth: number;
      readonly except?: string;
    }
);

/** The protected list in force on this host: built-ins not removed, plus what was added. */
export function resolveProtectedFiles(
  locations: ProtectedFilesLocations,
  choice: ProtectedFilesChoice,
): ReadonlyArray<ResolvedProtectedEntry> {
  const removed = new Set(choice.removed);
  const resolved: ResolvedProtectedEntry[] = [];
  for (const rule of builtInRules(locations.platform)) {
    if (removed.has(rule.id)) continue;
    for (const entry of rule.entries) {
      const base = baseDirectory(locations, entry.base);
      if (base === undefined) continue;
      const meta = {
        ruleId: rule.id,
        label: rule.label,
        channel: rule.channel,
        ownAccountExempt: rule.ownAccountExempt,
      };
      if (entry.kind === "path") {
        resolved.push({ ...meta, kind: "path", path: joinPosix(base, entry.path) });
      } else {
        resolved.push({
          ...meta,
          kind: "names",
          directory: joinPosix(base, entry.directory),
          name: entry.name,
          depth: entry.depth,
          ...(entry.except === undefined ? {} : { except: entry.except }),
        });
      }
    }
  }
  for (const added of choice.added) {
    const path = expandProtectedPath(added, locations.home);
    if (path === undefined) continue;
    resolved.push({
      ruleId: "added",
      label: "Added by you",
      channel: "none",
      ownAccountExempt: false,
      kind: "path",
      path,
    });
  }
  return resolved;
}

function baseDirectory(
  locations: ProtectedFilesLocations,
  base: ProtectedFilesBase,
): string | undefined {
  switch (base) {
    case "home":
      return locations.home;
    case "data":
      return locations.dataDirectory;
    case "runtime":
      return locations.runtimeDirectory;
  }
}

/** `~/x` against the home folder; an absolute path as it is; anything else refused. */
export function expandProtectedPath(path: string, homeDirectory: string): string | undefined {
  const trimmed = withoutTrailingSlashes(path.trim());
  if (trimmed.startsWith("~/")) return normalizePosix(joinPosix(homeDirectory, trimmed.slice(2)));
  if (trimmed.startsWith("/") && trimmed.length > 1) return normalizePosix(trimmed);
  return undefined;
}

/**
 * The entry that protects `path`, or undefined. `path` is absolute; pass every
 * form the host resolved it to (the lexical path and its real path) so a link
 * into a protected folder is caught. `ownAccountPaths` are the launching
 * runtime's own sign-in locations, exempt only for sign-in entries.
 */
export function protectedEntryFor(
  paths: ReadonlyArray<string>,
  entries: ReadonlyArray<ResolvedProtectedEntry>,
  ownAccountPaths: ReadonlyArray<string> = [],
): ResolvedProtectedEntry | undefined {
  const forms = paths.map(normalizePosix);
  const own = ownAccountPaths.map(normalizePosix);
  for (const entry of entries) {
    for (const form of forms) {
      if (!entryCovers(entry, form)) continue;
      if (entry.ownAccountExempt && own.some((owned) => isSameOrInside(form, owned))) continue;
      return entry;
    }
  }
  return undefined;
}

function entryCovers(entry: ResolvedProtectedEntry, path: string): boolean {
  if (entry.kind === "path") return isSameOrInside(path, entry.path);
  if (!isInside(path, entry.directory)) return false;
  const relative = path.slice(entry.directory.length + (entry.directory === "/" ? 0 : 1));
  const segments = relative.split("/");
  if (segments.length > entry.depth) return false;
  const name = segments[segments.length - 1] ?? "";
  if (entry.except !== undefined && wholeName(entry.except).test(name)) return false;
  return wholeName(entry.name).test(name);
}

function wholeName(pattern: string): RegExp {
  return new RegExp(`^(?:${pattern})$`, "u");
}

/** The person-facing form of an entry: home-relative where it is. */
export function protectedEntryDisplay(
  entry: ResolvedProtectedEntry,
  homeDirectory: string,
): string {
  const shown = (path: string) =>
    isSameOrInside(path, homeDirectory) && path !== homeDirectory
      ? `~/${path.slice(homeDirectory.length + 1)}`
      : path;
  if (entry.kind === "path") return shown(entry.path);
  return `${shown(entry.directory)}/${describeNamePattern(entry.name)}`;
}

function describeNamePattern(name: string): string {
  if (name === SSH_PRIVATE_KEY_NAME) return "id_* (not .pub)";
  if (name === "[^/]*") return "* (not the login keychain)";
  if (name === PROFILE_STORE_NAME || name === PROFILE_LOGIN_STORE_NAME)
    return "…/cookie and login stores";
  return name
    .replace(/\[\^\/\]\*/gu, "*")
    .replace(/\\\./gu, ".")
    .replace(/[()]/gu, "");
}

const CHANNEL_GUIDANCE: Record<ProtectedFilesChannel, string> = {
  "ssh-agent":
    "Use SSH through your SSH agent instead: the socket in SSH_AUTH_SOCK stays reachable, a password manager's agent included.",
  "git-credential-helper":
    "Git over HTTPS signs in through the system credential helper instead, and a forge command-line tool through its keychain sign-in.",
  "credential-broker":
    "Link the credential in Octant instead: the credential broker hands the runtime the key or a short-lived token.",
  "keychain-api": "Programs reach keychain items through the system keychain service instead.",
  "provider-sign-in":
    "Each runtime reads only its own sign-in. Sign that provider in from Settings › Providers.",
  none: "No agent channel replaces these files.",
};

export function protectedFilesChannelGuidance(channel: ProtectedFilesChannel): string {
  return CHANNEL_GUIDANCE[channel];
}

/**
 * The refusal an agent and the person read when a protected file is asked for:
 * which rule refused it and which channel does the work instead. Never silent.
 */
export function protectedFileRefusal(entry: ResolvedProtectedEntry, homeDirectory: string): string {
  return [
    `Refused by the secret guard: ${protectedEntryDisplay(entry, homeDirectory)} is a protected file (${entry.label}).`,
    "Octant's own tools refuse it at every level, and below Full access no command can open it.",
    protectedFilesChannelGuidance(entry.channel),
    "The list is in Settings › Permissions › Protected files.",
  ].join(" ");
}

/**
 * Credential shapes that identify themselves, so text can be redacted without
 * knowing the value in advance. Each is specific enough that ordinary prose and
 * code do not match it.
 */
const SECRET_SHAPES: ReadonlyArray<RegExp> = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/gu,
  /\bsk-ant-[A-Za-z0-9_-]{16,}/gu,
  /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9][A-Za-z0-9_-]{14,}[A-Za-z0-9]\b/gu,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/gu,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/gu,
  /\bnpm_[A-Za-z0-9]{36}\b/gu,
  /\bpypi-AgE[A-Za-z0-9_-]{40,}\b/gu,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu,
  /\bAIza[A-Za-z0-9_-]{35}\b/gu,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/gu,
  /\blin_api_[A-Za-z0-9][A-Za-z0-9_-]{8,}[A-Za-z0-9]\b/gu,
  /\b(?:sk|rk)_live_[A-Za-z0-9]{16,}\b/gu,
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
  /(?<=\b(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*["']?)[A-Za-z0-9/+=]{40}\b/gu,
  /(?<=\bAuthorization:\s*(?:Bearer|Basic|token)\s+)[A-Za-z0-9._~+/=-]{8,}/giu,
  /(?<=\/\/[^/\s:@]{1,256}:)[^/\s@]{1,256}(?=@)/gu,
  /(?<=_authToken\s*=\s*)[^\s"']{8,}/gu,
];

export const SECRET_REDACTION = "[redacted secret]";

/** Shorter values are too likely to occur in ordinary text to be replaced. */
const MINIMUM_ISSUED_VALUE_LENGTH = 8;

export interface SecretRedaction {
  readonly text: string;
  readonly redacted: boolean;
}

/**
 * Redacts known key formats, and every value the credential broker handed out
 * (`issuedValues`), from text bound for tool output, a transcript, the
 * journal, a log, an export, or diagnostics. Applied at every level.
 */
export function redactSecrets(
  text: string,
  issuedValues: ReadonlyArray<string> = [],
): SecretRedaction {
  let output = text;
  for (const value of [...issuedValues].sort((a, b) => b.length - a.length)) {
    if (value.length < MINIMUM_ISSUED_VALUE_LENGTH) continue;
    output = output.split(value).join(SECRET_REDACTION);
  }
  output = redactPuttyKeys(output);
  for (const shape of SECRET_SHAPES) output = output.replace(shape, SECRET_REDACTION);
  return { text: output, redacted: output !== text };
}

const PUTTY_HEADER = "PuTTY-User-Key-File-";
const PUTTY_MAC = "Private-MAC: ";

/**
 * A PuTTY private key, from its header to the end of its `Private-MAC` line,
 * or to the end of the text when the MAC is missing. Found with `indexOf` in
 * one forward pass: a lazy regular expression spanning the key restarted at
 * every repeated header and took quadratic time on text that never closed it.
 */
function redactPuttyKeys(text: string): string {
  let output = "";
  let cursor = 0;
  for (;;) {
    const start = text.indexOf(PUTTY_HEADER, cursor);
    if (start === -1) return output + text.slice(cursor);
    output += text.slice(cursor, start) + SECRET_REDACTION;
    const mac = text.indexOf(PUTTY_MAC, start + PUTTY_HEADER.length);
    if (mac === -1) return output;
    const lineEnd = text.indexOf("\n", mac);
    cursor = lineEnd === -1 ? text.length : lineEnd;
  }
}

/** A path without its trailing slashes, trimmed in one backward pass. */
function withoutTrailingSlashes(path: string): string {
  let end = path.length;
  while (end > 0 && path.charCodeAt(end - 1) === 47) end -= 1;
  return path.slice(0, end);
}

/** Redacts every string inside a JSON-shaped value, keys left as they are. */
export function redactSecretsInValue<T>(value: T, issuedValues: ReadonlyArray<string> = []): T {
  if (typeof value === "string") return redactSecrets(value, issuedValues).text as T;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item: unknown) => {
      const redacted = redactSecretsInValue(item, issuedValues);
      if (redacted !== item) changed = true;
      return redacted;
    });
    return (changed ? next : value) as T;
  }
  if (typeof value !== "object" || value === null) return value;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const redacted = redactSecretsInValue(item, issuedValues);
    if (redacted !== item) changed = true;
    next[key] = redacted;
  }
  return (changed ? next : value) as T;
}

export function joinPosix(base: string, relative: string): string {
  if (relative === "") return base;
  return base.endsWith("/") ? `${base}${relative}` : `${base}/${relative}`;
}

/** Collapses repeated slashes and `.` segments; resolves `..` lexically. */
export function normalizePosix(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

export function isSameOrInside(path: string, parent: string): boolean {
  return path === parent || isInside(path, parent);
}

function isInside(path: string, parent: string): boolean {
  if (parent === "/") return path !== "/";
  return path.startsWith(`${parent}/`);
}

/** Most words of one command read for paths. */
const MAX_COMMAND_PATH_WORDS = 256;

/**
 * The words of a shell command that read as paths, as the agent wrote them:
 * anything with a slash, or starting `~` or `$HOME`. Quotes are taken off,
 * a `--flag=` or `NAME=` prefix and an upload's `@` (`curl -d @file`) are
 * dropped, and shell operators split words.
 * It reads the text only, so a path a command builds at run time (`cat
 * "$DIR"/key`) is not seen; this is a flag for a person to read, never what
 * stands between a command and a file.
 */
export function commandPathWords(
  command: string,
  options: {
    /**
     * Also plain words that could name a file in the working directory
     * (`token`), for a caller that resolves them there. A flag, an
     * assignment, or a word with `:` is left out.
     */
    readonly bareNames?: boolean;
  } = {},
): ReadonlyArray<string> {
  const words: string[] = [];
  for (const raw of command.split(/[\s;&|<>()`]+/)) {
    if (words.length >= MAX_COMMAND_PATH_WORDS) break;
    const unquoted = raw.replace(/["']/g, "");
    const value = unquoted
      .replace(/^(?:-{1,2}[\w-]+=|[A-Za-z_][A-Za-z0-9_]*=)/, "")
      .replace(/^@/, "");
    if (value.length === 0) continue;
    if (value.includes("/") || value.startsWith("~")) words.push(value);
    else if (options.bareNames === true && /^[\w.][\w.@+-]*$/.test(value) && value === raw) {
      words.push(value);
    }
  }
  return words;
}
