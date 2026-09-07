import { describe, expect, it } from "vitest";
import { capabilityTransportFor, isLoopbackHostname } from "./capabilityTransport";

describe("capabilityTransportFor", () => {
  it("accepts https to any host", () => {
    expect(capabilityTransportFor(new URL("https://host.tailnet:8443/"))).toEqual({
      status: "accepted",
      transport: "https",
    });
    expect(capabilityTransportFor(new URL("https://10.0.0.2/"))).toEqual({
      status: "accepted",
      transport: "https",
    });
  });

  it("accepts plain http to the Machine on loopback, however loopback is spelled", () => {
    for (const address of [
      "http://127.0.0.1:13773/",
      "http://127.0.0.2/",
      "http://127.1/",
      "http://localhost:13773/",
      "http://LOCALHOST/",
      "http://[::1]:13773/",
      "http://[0:0:0:0:0:0:0:1]/",
    ]) {
      expect(capabilityTransportFor(new URL(address)), address).toEqual({
        status: "accepted",
        transport: "loopback-http",
      });
    }
  });

  it("refuses plain http to any host off loopback and names the host", () => {
    const refusal = capabilityTransportFor(new URL("http://192.168.1.5:13773/"));
    expect(refusal).toMatchObject({
      status: "refused",
      reason: "plain-http-off-loopback",
      host: "192.168.1.5:13773",
    });
    expect(refusal.status === "refused" ? refusal.message : "").toBe(
      "Octant refuses to send this window's capability over plain HTTP to 192.168.1.5:13773. Open the Machine over https://, or on its loopback address.",
    );
    for (const address of [
      "http://octant-host.lan/",
      "http://127.0.0.1.nip.io/",
      "http://[::2]/",
      "http://[::ffff:127.0.0.1]/",
    ]) {
      expect(capabilityTransportFor(new URL(address)).status, address).toBe("refused");
    }
  });

  it("refuses a scheme that is neither https nor http, even on loopback", () => {
    expect(capabilityTransportFor(new URL("ws://127.0.0.1:13773/"))).toMatchObject({
      status: "refused",
      reason: "unsupported-scheme",
    });
    expect(capabilityTransportFor(new URL("ftp://host.lan/"))).toMatchObject({
      status: "refused",
      reason: "unsupported-scheme",
      host: "host.lan",
    });
  });
});

describe("isLoopbackHostname", () => {
  it("covers 127.0.0.0/8, ::1, and localhost, and nothing that merely looks like them", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("127.255.255.255")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("128.0.0.1")).toBe(false);
    expect(isLoopbackHostname("localhost.lan")).toBe(false);
    expect(isLoopbackHostname("app.localhost")).toBe(false);
    expect(isLoopbackHostname("::1")).toBe(false);
  });
});
