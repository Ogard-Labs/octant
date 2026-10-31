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
