import { classifyRemoteListenerAddress } from "@octant/domain";

/** The shape `os.networkInterfaces()` returns, reduced to what address choice reads. */
export type NetworkInterfaceMap = Readonly<
  Record<
    string,
    | ReadonlyArray<{
        readonly address: string;
        readonly family: string | number;
        readonly internal: boolean;
      }>
    | undefined
  >
>;

export type PairAddressChoice =
  | { readonly status: "chosen"; readonly address: string }
  | { readonly status: "refused"; readonly message: string };

/**
 * Finds the address other devices reach this computer on: a Tailscale address
 * first, else the one private LAN address. Public, loopback, and link-local
 * addresses are never candidates, and an ambiguous machine is refused with
 * what was found rather than guessed at, because a wrong guess pairs devices
 * to an origin that later moves.
 */
export function choosePairAddress(interfaces: NetworkInterfaceMap): PairAddressChoice {
  const found: { readonly tailscale: string[]; readonly lan: string[] } = {
    tailscale: [],
    lan: [],
  };
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.internal || isLinkLocal(entry.address)) continue;
      const kind = classifyRemoteListenerAddress(entry.address);
      if (kind === "tailscale") found.tailscale.push(entry.address);
      else if (kind === "lan-private") found.lan.push(entry.address);
    }
  }
  const tailscale = preferIpv4(found.tailscale);
  const candidates = tailscale.length > 0 ? tailscale : preferIpv4(found.lan);
  const label = tailscale.length > 0 ? "Tailscale" : "private network";
  const [only] = candidates;
  if (only === undefined) {
    return {
      status: "refused",
      message:
        "No Tailscale or private network address found on this computer. Connect it to Tailscale or your local network, or pass --hostname.",
    };
  }
  if (candidates.length > 1) {
    return {
      status: "refused",
      message: `This computer has more than one ${label} address: ${candidates.join(", ")}. Pass --hostname with the one your other devices reach.`,
    };
  }
  return { status: "chosen", address: only };
}

/** One interface carries both an IPv4 and an IPv6 address; the IPv4 one names it. */
function preferIpv4(addresses: readonly string[]): readonly string[] {
  const unique = [...new Set(addresses)];
  const ipv4 = unique.filter((address) => !address.includes(":"));
  return ipv4.length > 0 ? ipv4 : unique;
}

function isLinkLocal(address: string): boolean {
  const value = address.toLowerCase();
  return value.startsWith("fe80:") || value.startsWith("169.254.");
}
