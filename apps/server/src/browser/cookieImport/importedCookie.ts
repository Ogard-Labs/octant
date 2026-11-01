import type { ImportedCookie } from "@octant/contracts";

/** More cookies than any real browser profile holds; a bound, not a target. */
export const MAX_IMPORTED_COOKIES = 20_000;
const MAX_NAME_LENGTH = 256;
const MAX_VALUE_LENGTH = 4_096;
const MAX_PATH_LENGTH = 1_024;
const HOSTNAME_PATTERN = /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$/i;
// A name may carry no control character, space, or separator; a value no control
// character or semicolon. Checked by code point so the rule is readable.
const NAME_SEPARATORS = new Set([";", "=", ",", '"', String.fromCharCode(0x5c)]);

function forbiddenName(name: string): boolean {
  return [...name].some((char) => {
    const code = char.charCodeAt(0);
    return code <= 0x20 || code === 0x7f || NAME_SEPARATORS.has(char);
  });
}

function forbiddenValue(value: string): boolean {
  return [...value].some((char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === 0x7f || char === ";";
  });
}

export interface RawCookie {
  /** `host_key` or `host`: a leading dot marks a cookie for the host and its subdomains. */
  readonly host: string;
  readonly name: string;
  readonly value: string;
  readonly path: string;
  /** Seconds since the Unix epoch, or undefined for a session cookie. */
  readonly expiresAtSeconds: number | undefined;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite: ImportedCookie["sameSite"];
}

/**
 * One cookie from another browser, or undefined when it should not be imported.
 *
 * Undefined is a count the person sees as "skipped", never a failure: an
 * expired cookie, a name or value a browser would refuse to store, an address
 * that is not a web host, and anything that would not survive a round trip
 * through the cookie jar are left behind rather than repaired.
 */
export function importedCookieFrom(raw: RawCookie, nowSeconds: number): ImportedCookie | undefined {
  if (raw.expiresAtSeconds !== undefined && raw.expiresAtSeconds <= nowSeconds) return undefined;
  const hostOnly = !raw.host.startsWith(".");
  const host = (hostOnly ? raw.host : raw.host.slice(1)).toLowerCase();
  if (!HOSTNAME_PATTERN.test(host) || host.length > 253) return undefined;
  if (
    raw.name.length === 0 ||
    raw.name.length > MAX_NAME_LENGTH ||
    forbiddenName(raw.name) ||
    raw.value.length > MAX_VALUE_LENGTH ||
    forbiddenValue(raw.value)
  ) {
    return undefined;
  }
  if (!raw.path.startsWith("/") || raw.path.length > MAX_PATH_LENGTH) return undefined;
  // A browser refuses these prefixes unless the cookie is shaped for them, so a
  // cookie that is not would be dropped on import anyway.
  const secure = raw.secure;
  if (raw.name.startsWith("__Secure-") && !secure) return undefined;
  if (raw.name.startsWith("__Host-") && (!secure || !hostOnly || raw.path !== "/")) {
    return undefined;
  }
  return {
    domain: hostOnly ? host : `.${host}`,
    hostOnly,
    name: raw.name,
    value: raw.value,
    path: raw.path,
    secure,
    httpOnly: raw.httpOnly,
    ...(raw.expiresAtSeconds === undefined ? {} : { expiresAt: Math.floor(raw.expiresAtSeconds) }),
    sameSite: raw.sameSite,
  };
}

/**
 * The host a person means by "just this site": a bare host or a pasted address,
 * lower-cased, or undefined when it names no web host.
 */
export function normalizeImportSite(input: string): string | undefined {
  const text = input.trim();
  if (text === "") return undefined;
  let host: string;
  try {
    host = new URL(text.includes("://") ? text : `https://${text}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
  if (host.endsWith(".")) host = host.slice(0, -1);
  return HOSTNAME_PATTERN.test(host) && host.length <= 253 ? host : undefined;
}

/**
 * Whether a cookie stored under `rawHost` is one this site would send: the
 * site's own cookies, and domain cookies of its parent domains. A host-only
 * cookie of a parent is not sent to a subdomain, and a bare top-level domain
 * is never a parent, so neither is imported.
 */
export function cookieHostMatchesSite(rawHost: string, site: string): boolean {
  const hostOnly = !rawHost.startsWith(".");
  const host = (hostOnly ? rawHost : rawHost.slice(1)).toLowerCase();
  if (host === site) return true;
  return !hostOnly && host.includes(".") && site.endsWith(`.${host}`);
}

/**
 * The `host_key` values a site's cookies can be stored under: the site, and each
 * parent with at least two labels, in host-only and domain form. Used to select
 * rows in SQL, so a large profile's row cap never hides the site's own cookies.
 */
export function siteCookieHosts(site: string): ReadonlyArray<string> {
  const labels = site.split(".");
  const hosts: string[] = [];
  for (let start = 0; start < labels.length; start += 1) {
    const host = labels.slice(start).join(".");
    if (start > 0 && !host.includes(".")) break;
    hosts.push(host, `.${host}`);
  }
  return hosts;
}

/** The hosts as an SQL list. They are already held to hostname characters; quotes are doubled regardless. */
export function sqlHostList(hosts: ReadonlyArray<string>): string {
  return hosts.map((host) => `'${host.replaceAll("'", "''")}'`).join(", ");
}
