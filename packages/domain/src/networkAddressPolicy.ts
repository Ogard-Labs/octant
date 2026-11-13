import { parseNetworkAddress } from "./safeNetworkPolicy";

/**
 * Whether the internet routes to this address: the one question every fetch
 * the host makes on someone else's behalf (a model's web fetch, a Canvas
 * page's request) asks before it connects. Text that is not an address, and
 * an address with a zone, is not public.
 */
export function isPublicNetworkAddress(address: string): boolean {
  const parsed = parseNetworkAddress(address);
  if (parsed === undefined) return false;
  return parsed.family === 4 ? !isSpecialIpv4(parsed.bytes) : !isSpecialIpv6(parsed.bytes);
}

/**
 * Every block the IANA IPv4 special-purpose registry marks not globally
 * reachable, plus multicast. 192.0.0.0/24 is refused whole: its two
 * reachable exceptions are PCP and TURN anycast, which answer from the
 * nearest server, often the local gateway. 192.88.99.0/24 is refused whole
 * for the same reason: deprecated 6to4 relay anycast around the 6a44 relay
 * address 192.88.99.2, which is not globally reachable.
 */
function isSpecialIpv4(bytes: ReadonlyArray<number>): boolean {
  const [a = 0, b = 0, c = 0] = bytes;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0 && c === 0) || // IETF protocol assignments
    (a === 192 && b === 0 && c === 2) || // documentation
    (a === 192 && b === 88 && c === 99) || // 6to4 and 6a44 relay anycast
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // documentation
    (a === 203 && b === 0 && c === 113) || // documentation
    a >= 224
  );
}

/**
 * Judged on the address's value, not its spelling. Matching text prefixes let
 * `0:0:0:0:0:ffff:7f00:1` through, which connects to loopback, and missed
 * most of fe80::/10. Forms that carry an IPv4 address (NAT64, 6to4, Teredo;
 * the parser already reads an IPv4-mapped address as IPv4) are judged by the
 * address they carry, because that is where the packet goes. The rest follows
 * the IANA IPv6 special-purpose registry's not-globally-reachable blocks.
 */
function isSpecialIpv6(bytes: ReadonlyArray<number>): boolean {
  const word = (index: number) => ((bytes[index * 2] ?? 0) << 8) | (bytes[index * 2 + 1] ?? 0);
  const w0 = word(0);
  const w1 = word(1);
  const w2 = word(2);
  const w3 = word(3);
  const w4 = word(4);
  const w5 = word(5);
  const w6 = word(6);
  const w7 = word(7);
  const carried = (high: number, low: number) =>
    isSpecialIpv4([high >> 8, high & 0xff, low >> 8, low & 0xff]);
  // The rest of ::/64 is unspecified, loopback, IPv4-compatible, or reserved,
  // none of it a public destination.
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0) return true;
  if (w0 === 0x64 && w1 === 0xff9b) {
    // 64:ff9b::/96 is NAT64; 64:ff9b:1::/48 is reserved for local NAT64 use.
    return w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0 ? carried(w6, w7) : true;
  }
  if (w0 === 0x2002) return carried(w1, w2);
  if (w0 === 0x2001 && w1 === 0) {
    // 2001::/32 is Teredo: the server's IPv4 address in plain, the client's
    // inverted in the last 32 bits.
    return carried(w2, w3) || carried(~w6 & 0xffff, ~w7 & 0xffff);
  }
  // 2001::/23 is refused whole, like 192.0.0.0/24: its reachable exceptions
  // are anycast services, AMT, AS112, and overlay identifiers, none of them a
  // page or a package registry.
  return (
    (w0 === 0x100 && w1 === 0 && w2 === 0 && (w3 === 0 || w3 === 1)) || // 100::/64 discard, 100:0:0:1::/64 dummy
    (w0 === 0x2001 && w1 < 0x200) || // 2001::/23 IETF protocol assignments
    (w0 === 0x2001 && w1 === 0xdb8) || // 2001:db8::/32 documentation
    (w0 === 0x3fff && w1 < 0x1000) || // 3fff::/20 documentation
    w0 === 0x5f00 || // 5f00::/16 segment routing SIDs
    (w0 & 0xfe00) === 0xfc00 || // fc00::/7 unique local
    (w0 & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (w0 & 0xffc0) === 0xfec0 || // fec0::/10 site-local
    (w0 & 0xff00) === 0xff00 // ff00::/8 multicast
  );
}
