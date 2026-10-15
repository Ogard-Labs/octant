import { describe, expect, it } from "vitest";
import { choosePairAddress } from "./pairAddress";

const nic = (address: string, internal = false) => ({ address, family: "x", internal });

describe("choosePairAddress", () => {
  it("chooses the Tailscale address over a private LAN address", () => {
    expect(
      choosePairAddress({
        lo0: [nic("127.0.0.1", true)],
        en0: [nic("192.168.1.20")],
        tailscale0: [nic("100.101.102.103"), nic("fd7a:115c:a1e0::1234")],
      }),
    ).toEqual({ status: "chosen", address: "100.101.102.103" });
  });

  it("chooses the one private LAN address when there is no Tailscale address", () => {
    expect(
      choosePairAddress({ en0: [nic("192.168.1.20"), nic("fe80::1"), nic("203.0.113.9")] }),
    ).toEqual({ status: "chosen", address: "192.168.1.20" });
  });

  it("never chooses a public, loopback, or link-local address", () => {
    const choice = choosePairAddress({
      lo0: [nic("127.0.0.1", true)],
      en0: [nic("203.0.113.9"), nic("169.254.3.4"), nic("fe80::1")],
    });
    expect(choice).toMatchObject({ status: "refused" });
    expect(choice.status === "refused" && choice.message).toBe(
      "No Tailscale or private network address found on this computer. Connect it to Tailscale or your local network, or pass --hostname.",
    );
  });

  it("refuses and lists several private LAN addresses instead of guessing", () => {
    const choice = choosePairAddress({
      en0: [nic("192.168.1.20")],
      docker0: [nic("172.17.0.1")],
    });
    expect(choice).toEqual({
      status: "refused",
      message:
        "This computer has more than one private network address: 192.168.1.20, 172.17.0.1. Pass --hostname with the one your other devices reach.",
    });
  });

  it("refuses several Tailscale addresses and names them as Tailscale", () => {
    const choice = choosePairAddress({
      a: [nic("100.64.0.1")],
      b: [nic("100.64.0.2")],
    });
    expect(choice.status === "refused" && choice.message).toContain("more than one Tailscale");
  });
});
