const EXPORT_SECRET_VALUE_PATTERN =
  /(?:sk-(?:proj-)?[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~+/=-]{12,}|Basic\s+[A-Za-z0-9+/=]{8,}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/i;
export const EXPORT_SENSITIVE_QUERY_KEYS =
  /^(?:token|access_token|id_token|refresh_token|auth|authorization|signature|sig|x-amz-signature|x-amz-credential|x-amz-security-token|api[_-]?key|key|password|passwd|secret|session|code|jwt)$/i;

const EXPORT_FILE_PATH_PATTERN =
  /(?:^|[\s"'`()[\]{}<>|,;])(?:file:\/\/\/?[^\s"'`<>]+|\/(?:[A-Za-z0-9._-]+\/)+[A-Za-z0-9._-]+|\.\.(?:\/|\\)|[A-Za-z]:\\[^\s"'`<>]*)/i;

/** Shared secret/path filter for every exported string surface (text, labels, notes). */
function extractCandidateUrls(value: string): string[] {
  const candidates = new Set<string>();
  const trimmed = value.trim();
  if (trimmed) candidates.add(trimmed);
  // Scanning from each letter with an unanchored scheme regex retries a long
  // scheme-less word quadratically. Consume each candidate once instead.
  let offset = 0;
  let separator: number;
  while ((separator = value.indexOf("://", offset)) !== -1) {
    let start = separator;
    while (start > offset && /[A-Za-z0-9+.-]/.test(value.charAt(start - 1))) start -= 1;
    while (start < separator && !/[A-Za-z]/.test(value.charAt(start))) start += 1;
    if (start === separator) {
      offset = separator + 3;
      continue;
    }
    let end = separator + 3;
    while (end < value.length && !/[\s"'`<>]/.test(value.charAt(end))) end += 1;
    candidates.add(trimTrailingUrlPunctuation(value.slice(start, end)));
    offset = end;
  }
  return [...candidates];
}

/**
 * Whether `value` carries no credential-shaped text.
 *
 * The path half of `isCanvasShareSafeText` is deliberately left out: a local
 * destination's entire job is to tell the person which file it wrote or will
 * write, and that filter refuses any absolute path so a path can never leave
 * the host. Callers of this still bound the value themselves; what they gain
 * is the same secret scan every other exported string gets.
 */
export function isExportCredentialFreeText(value: string): boolean {
  return !EXPORT_SECRET_VALUE_PATTERN.test(value);
}

export function isCanvasShareSafeText(value: string): boolean {
  if (!isExportCredentialFreeText(value)) return false;
  if (EXPORT_FILE_PATH_PATTERN.test(value)) return false;
  for (const candidate of extractCandidateUrls(value)) {
    try {
      const parsed = new URL(candidate);
      // file: URLs disclose host filesystem locations even without credentials.
      if (parsed.protocol === "file:") return false;
      if (parsed.username || parsed.password) return false;
      for (const key of parsed.searchParams.keys()) {
        if (EXPORT_SENSITIVE_QUERY_KEYS.test(key)) return false;
      }
      // OAuth-style fragments may hide credentials only in the hash.
      if (parsed.hash.includes("=")) {
        const fragmentQuery = parsed.hash.startsWith("#") ? parsed.hash.slice(1) : parsed.hash;
        const fragmentParams = new URLSearchParams(fragmentQuery);
        for (const key of fragmentParams.keys()) {
          if (EXPORT_SENSITIVE_QUERY_KEYS.test(key)) return false;
        }
      }
    } catch {
      // ignore non-URL candidates
    }
  }
  return true;
}

function trimTrailingUrlPunctuation(value: string): string {
  let end = value.length;
  while (end > 0 && "),.;".includes(value.charAt(end - 1))) end -= 1;
  return value.slice(0, end);
}
