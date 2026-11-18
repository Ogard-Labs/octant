import { isIP } from "node:net";
import { ANY_BROWSER_ORIGIN } from "@octant/contracts";
import { originAllowed as sameSiteOriginAllowed } from "@octant/domain";

/**
 * Whether an IP address is outside the globally reachable ranges: this
 * computer, its network, or a block kept for special use. Text that is not an
 * IP address reads as private.
 */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

/**
 * Whether an address names this computer or its network by its own text: an
 * IP literal outside the public ranges, localhost, a name under a suffix kept
 * for private networks, or a bare name with no dot. A public name that
 * resolves to a private address is not caught here.
 */
export function onThisComputerOrNetwork(target: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(normalizeNavigationUrl(target)).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return true;
  }
  const bare =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (isIP(bare) !== 0) return isPrivateAddress(bare);
  return (
    !bare.includes(".") ||
    bare === "localhost" ||
    [".localhost", ".local", ".internal", ".lan", ".home.arpa"].some((suffix) =>
      bare.endsWith(suffix),
    )
  );
}

/**
 * Whether a page-started navigation to `target` is refused as a hop onto this
 * computer or its network. Only http(s) addresses get the decision — a blank
 * page or another scheme is answered by the rules that already governed it.
 *
 * A context approved for exactly one origin keeps local hops to that origin:
 * its whole authority is that one address, which may itself be a local
 * development server. Every wider allowlist — including the any-site one —
 * admits no page-started local hop; only a load the host itself named can
 * follow its own chain there.
 */
export function refusesPageNavigation(
  target: string,
  allowedOrigins: ReadonlyArray<string>,
): boolean {
  try {
    normalizeNavigationUrl(target);
  } catch {
    return false;
  }
  if (!onThisComputerOrNetwork(target)) return false;
  return !(
    allowedOrigins.length === 1 &&
    allowedOrigins[0] !== ANY_BROWSER_ORIGIN &&
    navigationOriginAllowed(target, allowedOrigins)
  );
}

/** The same origin judgment the surfaces' own allowlist check makes, on normalized URLs. */
function navigationOriginAllowed(target: string, allowedOrigins: ReadonlyArray<string>): boolean {
  try {
    return sameSiteOriginAllowed(
      normalizeNavigationUrl(target),
      // The any-site entry is not an address; it passes through as it is.
      allowedOrigins.map((entry) =>
        entry === ANY_BROWSER_ORIGIN ? entry : normalizeNavigationUrl(entry),
      ),
    );
  } catch {
    return false;
  }
}

/** The surfaces' shared reading of a navigation target: schemeless is https, http/https only. */
function normalizeNavigationUrl(value: string): string {
  const url = new URL(value.includes("://") ? value : `https://${value}`);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Unsupported URL.");
  return url.toString();
}

/** Every IANA special-purpose IPv4 block that is not globally reachable. */
function isPrivateIpv4(address: string): boolean {
  const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

/** Judge IPv6 by value, including every form that carries an IPv4 address. */
function isPrivateIpv6(address: string): boolean {
  const words = ipv6Words(address);
  if (words === undefined) return true;
  const [w0 = 0, w1 = 0, w2 = 0, w3 = 0, w4 = 0, w5 = 0, w6 = 0, w7 = 0] = words;
  const carried = (high: number, low: number) =>
    `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0) {
    return w4 === 0 && w5 === 0xffff ? isPrivateIpv4(carried(w6, w7)) : true;
  }
  if (w0 === 0x64 && w1 === 0xff9b) {
    return w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0 ? isPrivateIpv4(carried(w6, w7)) : true;
  }
  if (w0 === 0x2002) return isPrivateIpv4(carried(w1, w2));
  if (w0 === 0x2001 && w1 === 0) {
    return isPrivateIpv4(carried(w2, w3)) || isPrivateIpv4(carried(~w6 & 0xffff, ~w7 & 0xffff));
  }
  // The global unicast allocation is currently 2000::/3. Treat every other
  // unallocated or reserved prefix as private unless handled above as a form
  // that explicitly carries a globally reachable IPv4 address.
  if ((w0 & 0xe000) !== 0x2000) return true;
  return (
    (w0 === 0x100 && w1 === 0 && w2 === 0 && (w3 === 0 || w3 === 1)) ||
    (w0 === 0x2001 && w1 < 0x200) ||
    (w0 === 0x2001 && w1 === 0xdb8) ||
    (w0 === 0x3fff && w1 < 0x1000) ||
    w0 === 0x5f00 ||
    (w0 & 0xfe00) === 0xfc00 ||
    (w0 & 0xffc0) === 0xfe80 ||
    (w0 & 0xffc0) === 0xfec0 ||
    (w0 & 0xff00) === 0xff00
  );
}

function ipv6Words(address: string): ReadonlyArray<number> | undefined {
  let text = address.toLowerCase();
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);
  const lastColon = text.lastIndexOf(":");
  const tail = text.slice(lastColon + 1);
  if (tail.includes(".")) {
    if (isIP(tail) !== 4) return undefined;
    const [a = 0, b = 0, c = 0, d = 0] = tail.split(".").map(Number);
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const parse = (part: string | undefined) =>
    part === undefined || part.length === 0
      ? []
      : part.split(":").map((word) => parseInt(word, 16));
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  const gap = halves.length === 2 ? 8 - head.length - rest.length : 0;
  if (gap < 0) return undefined;
  const words = [...head, ...Array.from({ length: gap }, () => 0), ...rest];
  if (words.length !== 8 || words.some((word) => !(word >= 0 && word <= 0xffff))) {
    return undefined;
  }
  return words;
}
