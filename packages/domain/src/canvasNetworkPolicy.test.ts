import { describe, expect, it } from "vitest";
import {
  canvasNetworkAddressRefusal,
  canvasNetworkUrlRefusal,
  type CanvasNetworkReserved,
} from "./canvasNetworkPolicy";
import { isPublicNetworkAddress } from "./networkAddressPolicy";

const nothingReserved: CanvasNetworkReserved = { addresses: [], hosts: [] };

describe("Canvas network destination rule", () => {
  it("allows a public address over http and https on the scheme's own port", () => {
    expect(canvasNetworkUrlRefusal("https://api.example.com/v1?q=1", nothingReserved)).toEqual({
      kind: "allowed",
      url: "https://api.example.com/v1?q=1",
      host: "api.example.com",
    });
    expect(canvasNetworkUrlRefusal("http://example.com:80/", nothingReserved)).toMatchObject({
      kind: "allowed",
      host: "example.com",
    });
    expect(canvasNetworkAddressRefusal("93.184.216.34", nothingReserved)).toBeUndefined();
    expect(canvasNetworkAddressRefusal("2606:4700:4700::1111", nothingReserved)).toBeUndefined();
    expect(canvasNetworkAddressRefusal("::ffff:93.184.216.34", nothingReserved)).toBeUndefined();
  });

  it("refuses every scheme but http and https", () => {
    for (const url of [
      "file:///etc/passwd",
      "ftp://example.com/",
      "ws://example.com/",
      "data:text/plain,hi",
      "javascript:alert(1)",
      "gopher://example.com/",
    ]) {
      expect([url, canvasNetworkUrlRefusal(url, nothingReserved)]).toEqual([
        url,
        { kind: "refused", reason: "scheme-not-allowed" },
      ]);
    }
  });

  it("refuses a port other than the scheme's own, credentials, and an address it cannot read", () => {
    for (const url of [
      "http://example.com:8080/",
      "https://example.com:8443/",
      "https://example.com:80/",
      "http://example.com:443/",
      "http://example.com:22/",
    ]) {
      expect([url, canvasNetworkUrlRefusal(url, nothingReserved)]).toEqual([
        url,
        { kind: "refused", reason: "port-not-allowed" },
      ]);
    }
    expect(canvasNetworkUrlRefusal("https://user:secret@example.com/", nothingReserved)).toEqual({
      kind: "refused",
      reason: "credentials-in-url",
    });
    expect(canvasNetworkUrlRefusal("not an address", nothingReserved)).toEqual({
      kind: "refused",
      reason: "invalid-url",
    });
    expect(
      canvasNetworkUrlRefusal(`https://example.com/${"a".repeat(2_100)}`, nothingReserved),
    ).toEqual({ kind: "refused", reason: "invalid-url" });
  });

  it("refuses localhost by name, however it is spelled", () => {
    for (const url of [
      "http://localhost/",
      "http://LOCALHOST/",
      "http://localhost./",
      "http://app.localhost/",
      "https://deep.app.localhost./x",
    ]) {
      expect([url, canvasNetworkUrlRefusal(url, nothingReserved)]).toEqual([
        url,
        { kind: "refused", reason: "local-name" },
      ]);
    }
  });

  it.each([
    ["loopback", ["127.0.0.1", "127.255.255.254", "::1"]],
    [
      "private ranges",
      ["10.0.0.1", "172.16.0.1", "172.31.255.255", "192.168.1.1", "fc00::1", "fd12:3456::1"],
    ],
    ["link-local and cloud metadata", ["169.254.169.254", "169.254.0.1", "fe80::1", "febf::1"]],
    ["carrier-grade NAT", ["100.64.0.1", "100.127.255.255"]],
    ["unspecified", ["0.0.0.0", "::"]],
    ["multicast and reserved", ["224.0.0.1", "239.255.255.250", "255.255.255.255", "ff02::1"]],
  ])("refuses %s addresses", (_class, addresses) => {
    for (const address of addresses) {
      expect([address, canvasNetworkAddressRefusal(address, nothingReserved)]).toEqual([
        address,
        "private-address",
      ]);
    }
  });

  it("refuses the IPv4-mapped IPv6 form of every refused class", () => {
    for (const address of [
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "0:0:0:0:0:ffff:7f00:1",
      "::ffff:10.0.0.1",
      "::ffff:172.16.0.1",
      "::ffff:192.168.1.1",
      "::ffff:169.254.169.254",
      "::ffff:a9fe:a9fe",
      "::ffff:100.64.0.1",
      "::ffff:0.0.0.0",
      "::ffff:224.0.0.1",
      "64:ff9b::a9fe:a9fe",
      "2002:7f00:1::1",
    ]) {
      expect([address, canvasNetworkAddressRefusal(address, nothingReserved)]).toEqual([
        address,
        "private-address",
      ]);
    }
  });

  it("refuses a literal private address in the URL before anything resolves", () => {
    for (const url of [
      "http://127.0.0.1/",
      "http://[::1]/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::ffff:10.0.0.1]/",
      // A browser reads these spellings as 127.0.0.1; so does the rule.
      "http://2130706433/",
      "http://0x7f.1/",
    ]) {
      expect([url, canvasNetworkUrlRefusal(url, nothingReserved)]).toEqual([
        url,
        { kind: "refused", reason: "private-address" },
      ]);
    }
  });

  it("refuses what is not an address at all", () => {
    expect(canvasNetworkAddressRefusal("example.com", nothingReserved)).toBe("private-address");
    expect(canvasNetworkAddressRefusal("fe80::1%en0", nothingReserved)).toBe("private-address");
  });

  it("refuses this host's own listeners even at a public address", () => {
    const reserved: CanvasNetworkReserved = {
      addresses: ["93.184.216.34", "2606:4700:4700::1111"],
      hosts: ["octant.example.net"],
    };
    expect(canvasNetworkAddressRefusal("93.184.216.34", reserved)).toBe("octant-address");
    expect(canvasNetworkAddressRefusal("::ffff:93.184.216.34", reserved)).toBe("octant-address");
    expect(canvasNetworkAddressRefusal("2606:4700:4700:0::1111", reserved)).toBe("octant-address");
    expect(canvasNetworkAddressRefusal("93.184.216.35", reserved)).toBeUndefined();
    expect(canvasNetworkUrlRefusal("https://Octant.Example.net./api", reserved)).toEqual({
      kind: "refused",
      reason: "octant-address",
    });
    expect(canvasNetworkUrlRefusal("https://93.184.216.34/", reserved)).toEqual({
      kind: "refused",
      reason: "octant-address",
    });
  });
});

describe("public network addresses", () => {
  it("separates addresses the internet routes from the ones it does not", () => {
    for (const address of ["93.184.216.34", "2606:4700:4700::1111", "198.20.0.1"]) {
      expect([address, isPublicNetworkAddress(address)]).toEqual([address, true]);
    }
    for (const address of ["192.0.2.1", "198.18.0.1", "2001:db8::1", "fec0::1", "not-an-address"]) {
      expect([address, isPublicNetworkAddress(address)]).toEqual([address, false]);
    }
  });
});
