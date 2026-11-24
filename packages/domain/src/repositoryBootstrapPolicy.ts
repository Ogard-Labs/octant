import type {
  RepositoryBootstrapRemoteSet,
  RepositoryCloneTransport,
} from "@octant/contracts/repository-bootstrap";

const SAFE_USER_PATTERN = /^[A-Za-z0-9._][A-Za-z0-9._-]{0,63}$/;
const SAFE_HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/;
const SAFE_SCP_PATH_PATTERN = /^[A-Za-z0-9._~][A-Za-z0-9._~/-]{0,511}$/;

function hasControlChars(text: string, includeSpace: boolean): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x20 || code === 0x7f || (includeSpace && code === 0x20)) return true;
  }
  return false;
}

/**
 * OS-generated metadata files excluded from the ignored-files candidate list
 * by default so real local configuration files are not buried in noise.
 */
const OS_JUNK_EXACT_LOWERCASE: ReadonlySet<string> = new Set([
  ".ds_store",
  "thumbs.db",
  "desktop.ini",
]);

/**
 * Common repository-local secret and credential file patterns flagged with a
 * warning badge in the bootstrap modal when ticked by the person.
 */
const SENSITIVE_BASENAME_PATTERNS: ReadonlyArray<RegExp> = [
  /^\.env(?:\..+)?$/i,
  /\.(?:pem|key|p12|pfx|jks|keystore|kdbx|p8|der)$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?$/i,
  /^\.(?:npmrc|pypirc|netrc|git-credentials|htpasswd)$/i,
  /^credentials(?:\.[^/]+)?$/i,
  /(?:^|[._-])secrets?(?:[._-]|$)/i,
  /^service[-_]?account.*\.json$/i,
  /^kubeconfig(?:\.[^/]+)?$/i,
];

const NON_SECRET_ENV_TEMPLATE_PATTERN =
  /^\.env\.(?:example|sample|template|dist|defaults|schema)$/i;

export interface DerivedBootstrapRemotes {
  readonly remotes: RepositoryBootstrapRemoteSet;
  readonly repositoryName?: string;
}

/**
 * Derives normalized SSH and HTTPS clone URLs from a repository's `origin`
 * remote URL. Only `https://`, `ssh://`, and SCP-style `user@host:path` forms
 * are accepted; unsafe transports (`file://`, `ext::`, `http://`, `git://`),
 * leading-dash option injection, embedded HTTPS credentials, and control bytes
 * are refused honestly.
 */
export function deriveBootstrapCloneRemotes(
  originUrl: string | undefined,
): DerivedBootstrapRemotes {
  if (originUrl === undefined) {
    return {
      remotes: {
        unavailableReason: "This repository has no origin remote configured.",
      },
    };
  }
  const trimmed = originUrl.trim();
  if (trimmed === "" || trimmed.startsWith("-") || hasControlChars(trimmed, true)) {
    return {
      remotes: {
        unavailableReason: "The origin remote URL is not a supported SSH or HTTPS Git remote.",
      },
    };
  }
  if (/^ext::/i.test(trimmed) || /^file:\/\//i.test(trimmed)) {
    return {
      remotes: {
        originUrl: trimmed,
        unavailableReason:
          "Local and external Git transports cannot be cloned to another computer.",
      },
    };
  }

  // 1. HTTPS remote: https://<host>[:port]/<path>
  if (/^https:\/\//i.test(trimmed)) {
    const parsed = parseHttpsRemote(trimmed);
    if (parsed === undefined) {
      return {
        remotes: {
          originUrl: trimmed,
          unavailableReason: "The HTTPS origin remote URL cannot be cloned safely.",
        },
      };
    }
    const httpsUrl = `https://${parsed.host}${parsed.port === undefined ? "" : `:${parsed.port}`}/${parsed.path}`;
    const sshUrl = parsed.port === undefined ? `git@${parsed.host}:${parsed.path}` : undefined;
    return {
      remotes: {
        originUrl: trimmed,
        httpsUrl,
        ...(sshUrl === undefined ? {} : { sshUrl }),
        defaultTransport: "https",
      },
      ...(parsed.repoName === undefined ? {} : { repositoryName: parsed.repoName }),
    };
  }

  // 2. Explicit ssh:// remote: ssh://[user@]<host>[:port]/<path>
  if (/^ssh:\/\//i.test(trimmed)) {
    const parsed = parseSshSchemeRemote(trimmed);
    if (parsed === undefined) {
      return {
        remotes: {
          originUrl: trimmed,
          unavailableReason: "The SSH origin remote URL cannot be cloned safely.",
        },
      };
    }
    const auth = parsed.user === undefined ? "" : `${parsed.user}@`;
    const portSuffix = parsed.port === undefined ? "" : `:${parsed.port}`;
    const sshUrl = `ssh://${auth}${parsed.host}${portSuffix}/${parsed.path}`;
    // Only derive HTTPS when SSH uses the default port (unspecified or 22);
    // a custom SSH port does not tell us the HTTPS port.
    const httpsUrl =
      parsed.port === undefined || parsed.port === "22"
        ? `https://${parsed.host}/${parsed.path}`
        : undefined;
    return {
      remotes: {
        originUrl: trimmed,
        sshUrl,
        ...(httpsUrl === undefined ? {} : { httpsUrl }),
        defaultTransport: "ssh",
      },
      ...(parsed.repoName === undefined ? {} : { repositoryName: parsed.repoName }),
    };
  }

  // 3. Reject any other scheme (http://, git://, ftp://, etc.)
  if (trimmed.includes("://")) {
    return {
      remotes: {
        originUrl: trimmed,
        unavailableReason: "Only SSH and HTTPS Git remotes are supported.",
      },
    };
  }

  // 4. SCP-style SSH remote: [user@]<host>:<path>
  const scp = parseScpRemote(trimmed);
  if (scp !== undefined) {
    const scpPathPrefix = scp.absolutePath ? "/" : "";
    const sshUrl = `${scp.user}@${scp.host}:${scpPathPrefix}${scp.path}`;
    const httpsUrl = `https://${scp.host}/${scp.path}`;
    return {
      remotes: {
        originUrl: trimmed,
        sshUrl,
        httpsUrl,
        defaultTransport: "ssh",
      },
      ...(scp.repoName === undefined ? {} : { repositoryName: scp.repoName }),
    };
  }

  return {
    remotes: {
      originUrl: trimmed,
      unavailableReason: "Only SSH and HTTPS Git remotes are supported.",
    },
  };
}

export type BootstrapCloneUrlValidation =
  | { readonly ok: true; readonly normalizedUrl: string }
  | { readonly ok: false; readonly message: string };

/**
 * Validates that a clone URL submitted to the receiving host strictly matches
 * the chosen transport and carries no option injection, unsafe protocol,
 * embedded HTTPS credentials, or control characters.
 */
export function validateBootstrapCloneUrl(
  remoteUrl: string,
  transport: RepositoryCloneTransport,
): BootstrapCloneUrlValidation {
  const trimmed = remoteUrl.trim();
  if (trimmed === "" || trimmed.startsWith("-") || hasControlChars(trimmed, true)) {
    return { ok: false, message: "The clone URL is invalid." };
  }
  if (/^ext::/i.test(trimmed) || /^file:\/\//i.test(trimmed)) {
    return { ok: false, message: "Only SSH and HTTPS clone URLs are permitted." };
  }
  if (transport === "https") {
    const parsed = parseHttpsRemote(trimmed);
    if (parsed === undefined) {
      return { ok: false, message: "The HTTPS clone URL is invalid or contains credentials." };
    }
    return {
      ok: true,
      normalizedUrl: `https://${parsed.host}${parsed.port === undefined ? "" : `:${parsed.port}`}/${parsed.path}`,
    };
  }
  if (/^ssh:\/\//i.test(trimmed)) {
    const parsed = parseSshSchemeRemote(trimmed);
    if (parsed === undefined) {
      return { ok: false, message: "The SSH clone URL is invalid." };
    }
    const auth = parsed.user === undefined ? "" : `${parsed.user}@`;
    const portSuffix = parsed.port === undefined ? "" : `:${parsed.port}`;
    return { ok: true, normalizedUrl: `ssh://${auth}${parsed.host}${portSuffix}/${parsed.path}` };
  }
  if (trimmed.includes("://")) {
    return { ok: false, message: "An SSH clone requires an ssh:// or user@host:path URL." };
  }
  const scp = parseScpRemote(trimmed);
  if (scp === undefined) {
    return { ok: false, message: "The SSH clone URL is invalid." };
  }
  const scpPathPrefix = scp.absolutePath ? "/" : "";
  return { ok: true, normalizedUrl: `${scp.user}@${scp.host}:${scpPathPrefix}${scp.path}` };
}

/** True when a POSIX relative path names OS-generated metadata junk excluded by default. */
export function isOsJunkIgnoredFile(relativePath: string): boolean {
  const segments = relativePath.split("/");
  const name = segments.at(-1) ?? "";
  if (name === "") return false;
  const lower = name.toLowerCase();
  if (OS_JUNK_EXACT_LOWERCASE.has(lower)) return true;
  if (name.startsWith("._") && name.length > 2) return true;
  return false;
}

/** True when a repository-relative ignored file path looks like a local secret or credential file. */
export function isBootstrapSensitiveIgnoredPath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  const name = segments.at(-1) ?? "";
  if (name === "") return false;
  if (NON_SECRET_ENV_TEMPLATE_PATTERN.test(name)) return false;
  return SENSITIVE_BASENAME_PATTERNS.some((pattern) => pattern.test(name));
}

export type BootstrapRelativePathValidation =
  | { readonly ok: true; readonly normalized: string; readonly segments: ReadonlyArray<string> }
  | {
      readonly ok: false;
      readonly reason: "invalid-path" | "git-internal-refused";
      readonly message: string;
    };

/**
 * Validates one repository-relative POSIX path for ignored-file enumeration,
 * source reads, and destination landing. Refuses absolute paths, backslashes,
 * drive letters, control bytes, `.`/`..` traversal, and `.git` internals.
 */
export function validateBootstrapRelativePath(
  relativePath: string,
): BootstrapRelativePathValidation {
  if (
    relativePath.length === 0 ||
    relativePath.length > 1024 ||
    relativePath.startsWith("/") ||
    relativePath.endsWith("/") ||
    relativePath.includes("\\") ||
    /^[A-Za-z]:/.test(relativePath) ||
    hasControlChars(relativePath, false)
  ) {
    return { ok: false, reason: "invalid-path", message: "Path must stay inside the repository." };
  }
  const segments = relativePath.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      return { ok: false, reason: "invalid-path", message: "Path traversal is not allowed." };
    }
    if (segment.toLowerCase() === ".git") {
      return {
        ok: false,
        reason: "git-internal-refused",
        message: "Files inside .git cannot be copied.",
      };
    }
  }
  return { ok: true, normalized: segments.join("/"), segments };
}

/**
 * Validates the user-editable destination folder string before expanding `~/`
 * on the receiving host. Rejects control characters, NUL bytes, leading `-`,
 * and `..` traversal segments. On Windows receivers, backslashes are
 * normalized as path separators while keeping traversal checks strict.
 */
export function validateBootstrapDestinationInput(
  destinationPath: string,
  options?: { readonly platform?: string },
):
  | { readonly ok: true; readonly trimmed: string }
  | { readonly ok: false; readonly message: string } {
  const trimmed = destinationPath.trim();
  const isWindows = options?.platform === "win32";
  if (
    trimmed.length === 0 ||
    trimmed.length > 1024 ||
    trimmed.startsWith("-") ||
    hasControlChars(trimmed, false) ||
    (!isWindows && trimmed.includes("\\"))
  ) {
    return { ok: false, message: "Destination folder path is invalid." };
  }
  const normalized = isWindows ? trimmed.replaceAll("\\", "/") : trimmed;
  if (normalized === "~" || normalized === "~/") {
    return { ok: false, message: "Choose a subfolder inside your home folder." };
  }
  if (isWindows && normalized.startsWith("//")) {
    return { ok: false, message: "Network UNC destination paths are not supported." };
  }
  let body: string;
  if (normalized.startsWith("~/")) {
    body = normalized.slice(2);
  } else if (isWindows && /^[A-Za-z]:\//.test(normalized)) {
    body = normalized.slice(3);
  } else if (isWindows && /^[A-Za-z]:/.test(normalized)) {
    return { ok: false, message: "Destination folder path is invalid." };
  } else if (normalized.startsWith("/")) {
    body = normalized.slice(1);
  } else {
    body = normalized;
  }
  if (body.length === 0) {
    return { ok: false, message: "Destination folder path is invalid." };
  }
  const segments = body.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    return { ok: false, message: "Destination folder path cannot contain . or .. segments." };
  }
  return { ok: true, trimmed };
}

/** Classifies sanitized `git clone` stderr into a typed bootstrap failure code. */
export function classifyBootstrapCloneStderr(
  stderr: string,
  transport: RepositoryCloneTransport,
): "host-key-unverified" | "auth-failed" | "clone-failed" {
  if (
    transport === "ssh" &&
    /host key verification failed|remote host identification has changed|offending .* key|known_hosts|are you sure you want to continue connecting/i.test(
      stderr,
    )
  ) {
    return "host-key-unverified";
  }
  if (
    /permission denied \(publickey|authentication failed|could not read username|could not read password|terminal prompts disabled|http(?:s)? (?:401|403)|invalid username or (?:password|token)|bad credentials|access denied|publickey|not logged in/i.test(
      stderr,
    )
  ) {
    return "auth-failed";
  }
  return "clone-failed";
}

/** Derives a safe default folder name from a repository name or project name. */
export function defaultBootstrapFolderName(
  repositoryName: string | undefined,
  fallbackName: string,
): string {
  const candidate = (repositoryName ?? fallbackName).trim().replace(/\.git$/i, "");
  const replaced = candidate.replace(/[^A-Za-z0-9._-]+/g, "-");
  let start = 0;
  let end = replaced.length;
  while (start < end && replaced.charCodeAt(start) === 45) start += 1;
  while (end > start && replaced.charCodeAt(end - 1) === 45) end -= 1;
  const cleaned = replaced.slice(start, end);
  if (cleaned === "" || cleaned === "." || cleaned === "..") return "repository";
  return cleaned.slice(0, 128);
}

interface ParsedRemote {
  readonly user?: string;
  readonly host: string;
  readonly port?: string;
  readonly path: string;
  readonly repoName?: string;
}

function parseHttpsRemote(raw: string): ParsedRemote | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  // Never accept embedded credentials, query strings, or fragments.
  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return undefined;
  }
  if (!SAFE_HOST_PATTERN.test(url.hostname)) return undefined;
  const path = normalizeRemotePath(url.pathname.replace(/^\/+/, ""));
  if (path === undefined) return undefined;
  const repoName = extractRepoName(path);
  return {
    host: url.hostname,
    ...(url.port === "" ? {} : { port: url.port }),
    path,
    ...(repoName === undefined ? {} : { repoName }),
  };
}

function parseSshSchemeRemote(raw: string): ParsedRemote | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== "ssh:") return undefined;
  if (url.password !== "" || url.search !== "" || url.hash !== "") return undefined;
  if (url.username !== "" && !SAFE_USER_PATTERN.test(url.username)) return undefined;
  if (!SAFE_HOST_PATTERN.test(url.hostname)) return undefined;
  const path = normalizeRemotePath(url.pathname.replace(/^\/+/, ""));
  if (path === undefined) return undefined;
  const repoName = extractRepoName(path);
  return {
    ...(url.username === "" ? {} : { user: url.username }),
    host: url.hostname,
    ...(url.port === "" ? {} : { port: url.port }),
    path,
    ...(repoName === undefined ? {} : { repoName }),
  };
}

function parseScpRemote(
  raw: string,
): (ParsedRemote & { readonly user: string; readonly absolutePath: boolean }) | undefined {
  const match = /^([^@:/\s]+)@([^:/\s]+):(.+)$/.exec(raw);
  if (match === null) return undefined;
  const user = match[1] ?? "";
  const host = match[2] ?? "";
  const rawPath = match[3] ?? "";
  if (!SAFE_USER_PATTERN.test(user) || !SAFE_HOST_PATTERN.test(host)) return undefined;
  if (rawPath.startsWith("//") || rawPath.includes("?") || rawPath.includes("#")) return undefined;
  const absolutePath = rawPath.startsWith("/");
  const stripped = absolutePath ? rawPath.slice(1) : rawPath;
  if (!SAFE_SCP_PATH_PATTERN.test(stripped)) return undefined;
  const path = normalizeRemotePath(stripped);
  if (path === undefined) return undefined;
  const repoName = extractRepoName(path);
  return {
    user,
    host,
    path,
    absolutePath,
    ...(repoName === undefined ? {} : { repoName }),
  };
}

function normalizeRemotePath(rawPath: string): string | undefined {
  const trimmed = rawPath.replace(/\/+$/, "");
  if (trimmed === "" || trimmed.startsWith("-")) return undefined;
  const segments = trimmed.split("/");
  if (
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment.includes("\\") ||
        hasControlChars(segment, true),
    )
  ) {
    return undefined;
  }
  return segments.join("/");
}

function extractRepoName(normalizedPath: string): string | undefined {
  const last = normalizedPath
    .split("/")
    .at(-1)
    ?.replace(/\.git$/i, "");
  if (last === undefined || last === "" || last === "." || last === "..") return undefined;
  return last;
}
